"""What the sidebar's organisation of sessions rests on.

Pin and archive are server state; unread is not. That split is the whole
design, and each half puts a requirement on this surface that no other test
covers:

- **Pin and archive persist**, and clearing one has to actually clear it — a
  `false` that is silently dropped as "no change" is the classic shape of this
  bug, and the client cannot tell the difference from a successful write.
- **`version` is monotonic and comes back on the write.** The sidebar applies a
  pin optimistically and reconciles afterwards, last-writer-wins **by version,
  not by arrival**: two PATCHes on one row can settle in either order, and
  without a version on the response the older answer overwrites the newer one
  and the row silently reverts a second after the user watched it change.
- **The version is also the activity mark.** Unread is *derived* from
  successive snapshots of the session index — "the agent finished while you
  were elsewhere" — and a turn that starts and finishes between two reads is
  invisible in `status` alone. The engine's own writes advance the same
  counter a pin does, which is what makes "this row moved" answerable at all;
  `updated_at` is monotonic beside it but only as fine as its resolution.
- **Archived sessions stay in the list.** The sidebar renders its Archived
  section from the same response; a server-side filter would leave the client
  unable to show what it filed away.

Nothing here derives unread. That is deliberate and is the point of the design:
a pushed unread flag is a second copy of the truth, and it goes stale the
moment anything else about the row changes — which, on a session, is every
turn.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from noeta.agent.store import db, projects, sessions
from tests.test_api_flow import Api, api, make_api  # noqa: F401 - fixtures by name


@pytest.fixture
def conn(tmp_path: Path):
    """A bootstrapped `app.db` on its own file."""
    connection = db.connect(tmp_path / "app.db")
    db.bootstrap(connection)
    try:
        yield connection
    finally:
        connection.close()


def make_project(conn: sqlite3.Connection, tmp_path: Path, name: str = "site"):
    directory = tmp_path / name
    directory.mkdir(parents=True, exist_ok=True)
    return projects.create_project(conn, name=name, directory=directory, tier="local")


# ---------------------------------------------------------------------------
# The store
# ---------------------------------------------------------------------------


def test_clearing_a_pin_is_a_write_and_not_a_no_op(conn, tmp_path):
    """`pinned=False` must reach the column.

    A patch builder that skips falsy values reads exactly like one that skips
    `None`, and the failure is invisible from the client: the PATCH returns
    200 with the row unchanged, so an unpin appears to work and comes back on
    the next poll."""
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)

    pinned = sessions.update_session(conn, session.id, pinned=True, archived=True)
    assert (pinned.pinned, pinned.archived) == (True, True)

    cleared = sessions.update_session(conn, session.id, pinned=False, archived=False)
    assert (cleared.pinned, cleared.archived) == (False, False)
    assert cleared.version > pinned.version


def test_pin_and_archive_are_independent_columns(conn, tmp_path):
    """The store keeps both; the sidebar decides which section wins.

    Archiving does **not** clear the pin, because unarchiving has to give it
    back — "archived beats pinned" is a rendering rule, and burning it into the
    store would make it lossy."""
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)

    sessions.update_session(conn, session.id, pinned=True)
    archived = sessions.update_session(conn, session.id, archived=True)
    assert (archived.pinned, archived.archived) == (True, True)

    restored = sessions.update_session(conn, session.id, archived=False)
    assert (restored.pinned, restored.archived) == (True, False)


def test_every_write_advances_the_version_and_the_activity_mark(conn, tmp_path):
    """The two fields the client's reconciliation is built on.

    `version` orders two writes that raced; `updated_at` is what a snapshot
    diff reads as "something happened here"."""
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)

    seen_versions = [session.version]
    seen_marks = [session.updated_at]
    for patch in ({"pinned": True}, {"archived": True}, {"title": "renamed"}):
        row = sessions.update_session(conn, session.id, **patch)
        seen_versions.append(row.version)
        seen_marks.append(row.updated_at)

    assert seen_versions == sorted(seen_versions)
    assert len(set(seen_versions)) == len(seen_versions)
    assert seen_marks == sorted(seen_marks)


def test_an_engine_write_advances_the_same_version_a_pin_does(conn, tmp_path):
    """One counter per row, not one per writer.

    The sidebar resolves *any* two states of a row by comparing versions, and
    an engine thread recording a status change is one of the writers. A second
    counter for engine writes would leave the two orderings unable to be
    compared at all."""
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)

    pinned = sessions.update_session(conn, session.id, pinned=True)
    advanced = sessions.advance_session(conn, session.id, status="running")
    assert advanced.version > pinned.version
    # …and the engine's write left the user's field alone.
    assert advanced.pinned is True


def test_the_archived_list_is_a_filter_the_caller_chooses(conn, tmp_path):
    """Both readings exist, because both have a caller.

    The sidebar wants archived rows (it renders a section of them); the
    sandbox reaper and any "what is live here" question do not."""
    project = make_project(conn, tmp_path)
    kept = sessions.create_session(conn, project.id, title="kept")
    filed = sessions.create_session(conn, project.id, title="filed")
    sessions.update_session(conn, filed.id, archived=True)

    everything = {s.id for s in sessions.list_sessions(conn, project.id)}
    active = {
        s.id for s in sessions.list_sessions(conn, project.id, include_archived=False)
    }
    assert everything == {kept.id, filed.id}
    assert active == {kept.id}


# ---------------------------------------------------------------------------
# Over HTTP — what the sidebar actually consumes
# ---------------------------------------------------------------------------


def test_a_session_row_carries_the_version_the_client_reconciles_by(api: Api):
    project = api.create_project()
    session = api.create_session(project["id"], title="one")

    listed = api.http.get(f"/api/v1/projects/{project['id']}/sessions").json()
    row = next(s for s in listed["sessions"] if s["id"] == session["id"])
    assert isinstance(row["version"], int)
    assert (row["pinned"], row["archived"]) == (False, False)


def test_patching_a_pin_returns_the_row_at_its_new_version(api: Api):
    """The response is the reconciliation input, so it has to be the *new* state.

    Returning the pre-write row — or the row without its version — leaves the
    client unable to tell a slow answer for an old edit from a fresh one, which
    is precisely the case the whole protocol exists for."""
    project = api.create_project()
    session = api.create_session(project["id"], title="one")
    before = api.detail(session["id"])

    pinned = api.http.patch(
        f"/api/v1/sessions/{session['id']}", json={"pinned": True}
    ).json()
    assert pinned["pinned"] is True
    assert pinned["version"] > before["version"]

    unpinned = api.http.patch(
        f"/api/v1/sessions/{session['id']}", json={"pinned": False}
    ).json()
    assert unpinned["pinned"] is False
    assert unpinned["version"] > pinned["version"]


def test_interleaved_writes_are_totally_ordered_by_version(api: Api):
    """Whatever order the answers come back in, the versions order them."""
    project = api.create_project()
    first = api.create_session(project["id"], title="one")
    second = api.create_session(project["id"], title="two")

    responses = [
        api.http.patch(f"/api/v1/sessions/{first['id']}", json={"pinned": True}).json(),
        api.http.patch(
            f"/api/v1/sessions/{second['id']}", json={"archived": True}
        ).json(),
        api.http.patch(f"/api/v1/sessions/{first['id']}", json={"pinned": False}).json(),
    ]
    on_first = [r["version"] for r in responses if r["id"] == first["id"]]
    assert on_first == sorted(on_first) and len(set(on_first)) == len(on_first)


def test_an_archived_session_is_still_listed_and_still_pinned(api: Api):
    """The sidebar renders its Archived section from this response.

    Filtering server-side would leave the client with a section it cannot
    populate — and it would make unarchiving a verb with no subject."""
    project = api.create_project()
    session = api.create_session(project["id"], title="one")

    api.http.patch(f"/api/v1/sessions/{session['id']}", json={"pinned": True})
    api.http.patch(f"/api/v1/sessions/{session['id']}", json={"archived": True})

    listed = api.http.get(f"/api/v1/projects/{project['id']}/sessions").json()
    row = next(s for s in listed["sessions"] if s["id"] == session["id"])
    assert (row["pinned"], row["archived"]) == (True, True)


def test_a_turn_advances_the_same_counter_a_pin_does(api: Api):
    """The evidence unread is derived from, end to end.

    The sidebar learns about background sessions by re-reading this index, so a
    turn that starts and finishes between two reads shows up as `idle` →
    `idle`. What distinguishes "nothing happened" from "a whole turn happened"
    is the row's version — which the engine's own writes advance, on the same
    counter a pin uses. A second counter for engine activity would leave the
    two orderings incomparable, and a timestamp alone is only as fine as its
    resolution.
    """
    project = api.create_project()
    session = api.create_session(project["id"], title="one")
    before = api.detail(session["id"])

    assert api.send(session["id"], "hello").status_code == 202
    api.wait_turn(session["id"])

    listed = api.http.get(f"/api/v1/projects/{project['id']}/sessions").json()
    row = next(s for s in listed["sessions"] if s["id"] == session["id"])
    assert row["version"] > before["version"]
    # The activity mark is monotonic too, but only the version is guaranteed
    # to be *distinct* between two writes.
    assert row["updated_at"] >= before["updated_at"]


def test_patching_a_session_that_is_gone_is_a_404_not_a_silent_create(api: Api):
    """An optimistic client retries against the id it holds; a 404 is how it
    learns the row is gone rather than resurrecting it."""
    response = api.http.patch("/api/v1/sessions/nope", json={"pinned": True})
    assert response.status_code == 404
    assert api.error(response)["code"]
