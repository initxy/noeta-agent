"""The Project and Session index (`app.db`).

The store is the only thing in the product that knows a Project exists: the
public SDK surface returns `(task_id, last_seq, last_event_time)` per stream
and nothing else, so every question the UI asks — which sessions does this
project have, which project does this task belong to, which tier does this
directory run in — is answered here or not at all.

What these tests hold, and why each one is worth a test rather than a review:

- **the directory is an identity**, so two spellings of one directory collide
  instead of quietly becoming two projects sharing a workspace;
- **a session owns one or more task streams**, in both directions, because
  `fork` mints siblings and the resolvers start from a task id;
- **credentials cannot leave through a read path**, which is a property of the
  return type rather than of the caller's discipline;
- **`version` is monotonic**, which is what an optimistic client resolves
  last-writer-wins by;
- **two threads may write and read at once**, because the engine's post-commit
  subscription fires on worker threads while requests read on the event loop.
"""
from __future__ import annotations

import dataclasses
import os
import sqlite3
import threading
import time
from pathlib import Path

import pytest

from noeta.agent.api import runtime
from noeta.agent.store import db, projects, sessions
from noeta.sdk import McpHttpServerSpec, McpServerSpec
from noeta.agent.store.errors import (
    DuplicateAliasError,
    DuplicateDirectoryError,
    DuplicateTaskStreamError,
    InvalidDirectoryError,
    UnknownProjectError,
    UnknownSessionError,
)


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
    """A project on a real directory, in the LOCAL tier.

    The tier is passed explicitly on purpose: no test may create a project that
    runs in a container, and the store defaulting to `local` is exactly the
    thing that would stop being true silently."""
    directory = tmp_path / name
    directory.mkdir(parents=True, exist_ok=True)
    return projects.create_project(
        conn, name=name, directory=directory, tier="local"
    )


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


def test_the_product_tables_land_and_lineage_is_migration_two(conn):
    """A real migration from day one, because the engine's own sqlite file is
    versioned and this one will be too. Migration 2 adds session lineage (fork
    becomes a child session), so a bootstrapped db sits at version 2 with the
    three lineage columns on `sessions`."""
    assert db.schema_version(conn) == 2
    tables = {
        row["name"]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    assert {
        "projects",
        "sessions",
        "session_task_streams",
        "mcp_connectors",
    } <= tables
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(sessions)")}
    assert {"parent_session_id", "source_task_id", "branched_at_seq"} <= columns


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------


def test_project_round_trips_through_create_get_and_list(conn, tmp_path):
    created = projects.create_project(
        conn,
        name="site",
        directory=tmp_path / "site",
        tier="sandbox",
        persona="terse",
        default_model="gpt-5.5",
        default_effort="high",
        memory_enabled=True,
    )

    assert created.directory == str(tmp_path / "site")
    assert created.tier == "sandbox"
    assert created.memory_enabled is True
    assert created.version == 1
    assert projects.get_project(conn, created.id) == created
    assert projects.list_projects(conn) == [created]


def test_get_and_list_answer_empty_rather_than_raising(conn):
    assert projects.get_project(conn, "nope") is None
    assert projects.list_projects(conn) == []


def test_a_second_project_on_the_same_directory_is_a_conflict(conn, tmp_path):
    """Not a duplicate: two projects over one directory would share a workspace
    root, a memory pool and a container name."""
    make_project(conn, tmp_path)

    with pytest.raises(DuplicateDirectoryError) as raised:
        projects.create_project(conn, name="again", directory=tmp_path / "site")

    assert raised.value.directory == str(tmp_path / "site")
    assert len(projects.list_projects(conn)) == 1


def test_the_conflict_survives_a_different_spelling_of_the_same_directory(
    conn, tmp_path
):
    """`realpath` on both sides is what makes the UNIQUE index mean "the same
    directory" rather than "the same string"."""
    project = make_project(conn, tmp_path)
    link = tmp_path / "link"
    os.symlink(tmp_path / "site", link)

    for spelling in (
        f"{tmp_path / 'site'}/",
        str(tmp_path / "site" / "." ),
        str(tmp_path / "other" / ".." / "site"),
        str(link),
    ):
        with pytest.raises(DuplicateDirectoryError):
            projects.create_project(conn, name="again", directory=spelling)
        assert projects.find_project_by_directory(conn, spelling) == project


def test_a_relative_or_empty_directory_is_refused(conn):
    for bad in ("", "   ", "relative/path", "./here"):
        with pytest.raises(InvalidDirectoryError):
            projects.create_project(conn, name="bad", directory=bad)


def test_the_by_directory_lookup_is_total(conn, tmp_path):
    """It answers the execution-tier question inside `seed_start`, so anything
    it cannot normalize is a miss rather than an exception on a hot path."""
    make_project(conn, tmp_path)

    for junk in ("", "relative/path", str(tmp_path / "never-created"), "\0"):
        assert projects.find_project_by_directory(conn, junk) is None


def test_the_by_directory_lookup_is_an_indexed_exact_match(conn, tmp_path):
    """Pinned with the query planner rather than a benchmark: an index probe
    stays an index probe when someone adds a column, a stopwatch does not."""
    make_project(conn, tmp_path)
    plan = " ".join(
        row["detail"]
        for row in conn.execute(
            "EXPLAIN QUERY PLAN SELECT id FROM projects WHERE directory = ?",
            (str(tmp_path / "site"),),
        )
    )

    assert "SCAN" not in plan
    assert "USING INDEX" in plan


def test_updating_a_project_bumps_its_version(conn, tmp_path):
    project = make_project(conn, tmp_path)

    first = projects.update_project(conn, project.id, name="renamed")
    second = projects.update_project(conn, project.id, tier="sandbox")

    assert first.name == "renamed"
    assert second.tier == "sandbox"
    assert first.version == project.version + 1
    assert second.version == first.version + 1
    assert second.updated_at >= project.updated_at


def test_an_empty_patch_neither_writes_nor_bumps(conn, tmp_path):
    """An optimistic client compares versions; a no-op patch that bumped one
    would make every other client's cached row look stale for nothing."""
    project = make_project(conn, tmp_path)

    unchanged = projects.update_project(conn, project.id)

    assert unchanged == project


def test_updating_an_unknown_project_answers_none(conn):
    assert projects.update_project(conn, "nope", name="x") is None
    assert projects.delete_project(conn, "nope") is False


def test_an_unknown_tier_is_refused_by_name(conn, tmp_path):
    with pytest.raises(ValueError):
        projects.create_project(
            conn, name="x", directory=tmp_path / "x", tier="container"
        )
    project = make_project(conn, tmp_path)
    with pytest.raises(ValueError):
        projects.update_project(conn, project.id, tier="container")


def test_deleting_a_project_takes_its_sessions_streams_and_connectors(conn, tmp_path):
    """One DELETE, through `ON DELETE CASCADE` — which is why `connect` turns
    foreign keys on."""
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)
    sessions.add_task_stream(conn, session.id, "task-1")
    projects.create_connector(
        conn, project.id, "docs", transport="http", url="https://mcp.example/docs"
    )

    assert projects.delete_project(conn, project.id) is True

    assert projects.get_project(conn, project.id) is None
    assert sessions.get_session(conn, session.id) is None
    assert sessions.find_task_binding(conn, "task-1") is None
    assert projects.list_connectors(conn, project.id) == []


# ---------------------------------------------------------------------------
# MCP connectors
# ---------------------------------------------------------------------------


SECRET = "sk-live-do-not-leak"


def test_every_read_path_scrubs_credentials_to_sorted_name_lists(conn, tmp_path):
    """The raw value must never appear in a projection an API handler can
    reach — and it cannot, because `ConnectorView` has no field to carry it."""
    project = make_project(conn, tmp_path)
    created = projects.create_connector(
        conn,
        project.id,
        "docs",
        transport="http",
        url="https://mcp.example/docs",
        headers={"Authorization": SECRET, "X-Api-Key": SECRET},
        env={"TOKEN": SECRET, "ALT": SECRET},
    )
    listed = projects.list_connectors(conn, project.id)
    fetched = projects.get_connector(conn, project.id, "docs")
    updated = projects.update_connector(conn, project.id, "docs", enabled=False)

    for view in (created, *listed, fetched, updated):
        assert view.header_names == ("Authorization", "X-Api-Key")
        assert view.env_names == ("ALT", "TOKEN")
        assert SECRET not in repr(view)
        assert SECRET not in repr(dataclasses.asdict(view))

    assert not {"headers", "env"} & {
        field.name for field in dataclasses.fields(created)
    }


def test_the_resolver_is_the_one_path_that_sees_credentials(conn, tmp_path):
    project = make_project(conn, tmp_path)
    projects.create_connector(
        conn,
        project.id,
        "docs",
        transport="http",
        url="https://mcp.example/docs",
        headers={"Authorization": SECRET},
        tool_subset=["search"],
    )

    resolved = projects.resolve_connector(conn, project.id, "docs")

    assert resolved.headers == {"Authorization": SECRET}
    assert resolved.tool_subset == ("search",)
    # And the scrubbed projection of that very object still says nothing.
    assert SECRET not in repr(resolved.view())


def test_connector_tokens_are_sorted_enabled_and_scoped_to_one_project(conn, tmp_path):
    """The per-turn token set is computed at seed time, which is what makes a
    config edit apply from the next turn rather than mid-turn."""
    one = make_project(conn, tmp_path, name="one")
    two = make_project(conn, tmp_path, name="two")
    for alias in ("zeta", "alpha"):
        projects.create_connector(
            conn, one.id, alias, transport="http", url="https://mcp.example"
        )
    projects.create_connector(
        conn, one.id, "off", transport="http", url="https://mcp.example", enabled=False
    )
    projects.create_connector(
        conn, two.id, "alpha", transport="http", url="https://other.example"
    )

    tokens = projects.enabled_connector_tokens(conn, one.id)

    assert tokens == (
        projects.connector_token(one.id, "alpha"),
        projects.connector_token(one.id, "zeta"),
    )
    assert projects.enabled_connector_tokens(conn, "unknown") == ()


def test_a_token_resolves_to_its_connector_and_never_raises(conn, tmp_path):
    one = make_project(conn, tmp_path, name="one")
    two = make_project(conn, tmp_path, name="two")
    projects.create_connector(
        conn, one.id, "docs", transport="http", url="https://one.example"
    )
    projects.create_connector(
        conn, two.id, "docs", transport="http", url="https://two.example"
    )
    projects.create_connector(
        conn, one.id, "off", transport="http", url="https://one.example", enabled=False
    )

    # The same alias in two projects stays isolated.
    assert projects.resolve_connector_token(
        conn, projects.connector_token(one.id, "docs")
    ).url == "https://one.example"
    assert projects.resolve_connector_token(
        conn, projects.connector_token(two.id, "docs")
    ).url == "https://two.example"

    # Malformed, unknown, wrong-scope and disabled all degrade to "no server".
    for token in (
        "",
        "no-separator",
        ":docs",
        f"{one.id}:",
        f"{one.id}:missing",
        projects.connector_token("unknown-project", "docs"),
        projects.connector_token(one.id, "off"),
    ):
        assert projects.resolve_connector_token(conn, token) is None


def test_a_connector_alias_is_claimed_once_per_project(conn, tmp_path):
    project = make_project(conn, tmp_path)
    projects.create_connector(
        conn, project.id, "docs", transport="http", url="https://mcp.example"
    )

    with pytest.raises(DuplicateAliasError):
        projects.create_connector(
            conn, project.id, "docs", transport="http", url="https://other.example"
        )


def test_an_unusable_connector_spec_is_refused(conn, tmp_path):
    project = make_project(conn, tmp_path)

    with pytest.raises(ValueError):
        projects.create_connector(conn, project.id, "a", transport="carrier-pigeon")
    with pytest.raises(ValueError):
        projects.create_connector(conn, project.id, "b", transport="http")
    with pytest.raises(ValueError):
        projects.create_connector(conn, project.id, "c", transport="stdio")

    stdio = projects.create_connector(
        conn, project.id, "d", transport="stdio", argv=["uvx", "server"], env={"K": "V"}
    )
    assert stdio.argv == ("uvx", "server")
    assert stdio.env_names == ("K",)


def test_a_connector_needs_a_project(conn):
    with pytest.raises(UnknownProjectError):
        projects.create_connector(
            conn, "nope", "docs", transport="http", url="https://mcp.example"
        )


def test_deleting_a_connector_reports_whether_it_existed(conn, tmp_path):
    project = make_project(conn, tmp_path)
    projects.create_connector(
        conn, project.id, "docs", transport="http", url="https://mcp.example"
    )

    assert projects.delete_connector(conn, project.id, "docs") is True
    assert projects.delete_connector(conn, project.id, "docs") is False
    assert projects.get_connector(conn, project.id, "docs") is None
    assert projects.update_connector(conn, project.id, "docs", enabled=False) is None


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def test_a_session_is_created_with_zero_task_streams(conn, tmp_path):
    """The first message seeds the first stream. A session the user opened and
    never wrote in must not cost a task, a workspace binding or a container."""
    project = make_project(conn, tmp_path)

    session = sessions.create_session(conn, project.id, title="draft")

    assert session.project_id == project.id
    assert session.title == "draft"
    assert session.title_generated is False
    assert session.status == "idle"
    assert session.last_seq == sessions.NO_SEQ
    assert session.version == 1
    assert sessions.list_task_streams(conn, session.id) == []
    assert sessions.latest_task_stream(conn, session.id) is None


def test_a_session_needs_a_project(conn):
    with pytest.raises(UnknownProjectError):
        sessions.create_session(conn, "nope")


def test_sessions_round_trip_and_list_per_project(conn, tmp_path):
    one = make_project(conn, tmp_path, name="one")
    two = make_project(conn, tmp_path, name="two")
    first = sessions.create_session(conn, one.id, title="first")
    second = sessions.create_session(conn, one.id, title="second")
    other = sessions.create_session(conn, two.id)

    listed = sessions.list_sessions(conn, one.id)

    assert sessions.get_session(conn, first.id) == first
    assert {row.id for row in listed} == {first.id, second.id}
    assert sessions.list_sessions(conn, two.id) == [other]
    assert sessions.get_session(conn, "nope") is None


def test_patching_a_session_bumps_its_version(conn, tmp_path):
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)

    renamed = sessions.update_session(
        conn, session.id, title="Refactor the parser", title_generated=True
    )
    pinned = sessions.update_session(conn, session.id, pinned=True, archived=True)

    assert renamed.title == "Refactor the parser"
    assert renamed.title_generated is True
    assert pinned.pinned is True and pinned.archived is True
    assert renamed.version == session.version + 1
    assert pinned.version == renamed.version + 1
    assert sessions.update_session(conn, session.id) == pinned
    assert sessions.update_session(conn, "nope", title="x") is None


def test_archived_sessions_can_be_excluded_from_the_list(conn, tmp_path):
    project = make_project(conn, tmp_path)
    kept = sessions.create_session(conn, project.id)
    gone = sessions.create_session(conn, project.id)
    sessions.update_session(conn, gone.id, archived=True)

    # Newest first, so the archived one still leads the unfiltered list.
    assert [row.id for row in sessions.list_sessions(conn, project.id)] == [
        gone.id,
        kept.id,
    ]
    assert [
        row.id
        for row in sessions.list_sessions(conn, project.id, include_archived=False)
    ] == [kept.id]


def test_the_status_vocabulary_is_exactly_idle_running_waiting(conn, tmp_path):
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)

    for status in sessions.SESSION_STATUSES:
        assert sessions.advance_session(conn, session.id, status=status).status == status

    with pytest.raises(ValueError):
        sessions.advance_session(conn, session.id, status="finished")
    assert sessions.advance_session(conn, "nope", status="idle") is None


def test_last_seq_advances_and_never_rewinds(conn, tmp_path):
    """Envelopes are committed by workers with no ordering guarantee between
    them, so a late arrival must not rewind the activity high-water mark."""
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)

    assert sessions.advance_session(conn, session.id, last_seq=7).last_seq == 7
    assert sessions.advance_session(conn, session.id, last_seq=3).last_seq == 7
    assert sessions.advance_session(conn, session.id, last_seq=11).last_seq == 11


def test_advancing_a_session_bumps_its_version(conn, tmp_path):
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)

    advanced = sessions.advance_session(
        conn, session.id, status="running", last_seq=0
    )

    assert advanced.version == session.version + 1
    assert sessions.advance_session(conn, session.id) == advanced


def test_deleting_a_session_reports_whether_it_existed(conn, tmp_path):
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)
    sessions.add_task_stream(conn, session.id, "task-1")

    assert sessions.delete_session(conn, session.id) is True
    assert sessions.delete_session(conn, session.id) is False
    assert sessions.find_task_binding(conn, "task-1") is None


# ---------------------------------------------------------------------------
# Session lineage — fork as a child session
# ---------------------------------------------------------------------------


def test_a_fork_child_carries_its_lineage(conn, tmp_path):
    """`fork` creates a child session with the three lineage columns set;
    an ordinary session leaves all three NULL."""
    project = make_project(conn, tmp_path)
    parent = sessions.create_session(conn, project.id, title="Parent")

    child = sessions.create_session(
        conn,
        project.id,
        title="Parent (fork)",
        parent_session_id=parent.id,
        source_task_id="task-root",
        branched_at_seq=12,
    )

    assert child.parent_session_id == parent.id
    assert child.source_task_id == "task-root"
    assert child.branched_at_seq == 12
    # An ordinary session is null on all three, and round-trips through get.
    assert parent.parent_session_id is None
    assert parent.source_task_id is None
    assert parent.branched_at_seq is None
    assert sessions.get_session(conn, child.id) == child


def test_deleting_a_parent_de_nests_its_children(conn, tmp_path):
    """`ON DELETE SET NULL`: a deleted parent must not take its forks with it.
    The child survives with `parent_session_id` cleared, and `source_task_id`
    is left pointing at the (surviving) event log so its history still replays."""
    project = make_project(conn, tmp_path)
    parent = sessions.create_session(conn, project.id, title="Parent")
    child = sessions.create_session(
        conn,
        project.id,
        parent_session_id=parent.id,
        source_task_id="task-root",
        branched_at_seq=3,
    )

    assert sessions.delete_session(conn, parent.id) is True

    survived = sessions.get_session(conn, child.id)
    assert survived is not None
    assert survived.parent_session_id is None
    # The link the hub splices history from is NOT a foreign key, so it stays.
    assert survived.source_task_id == "task-root"
    assert survived.branched_at_seq == 3


# ---------------------------------------------------------------------------
# Task streams — the D5 relation
# ---------------------------------------------------------------------------


def test_a_session_can_own_several_task_streams(conn, tmp_path):
    """The store still supports a `branch` stream as a primitive (root +
    branch), even though the host no longer mints one — `fork` now creates a
    child session whose forked task is its own `root`. The detail response
    lists a session's streams oldest first."""
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)

    root = sessions.add_task_stream(conn, session.id, "task-root")
    branch = sessions.add_task_stream(
        conn,
        session.id,
        "task-branch",
        kind="branch",
        source_task_id="task-root",
        branched_at_seq=12,
    )

    assert root.kind == "root"
    assert root.source_task_id is None and root.branched_at_seq is None
    assert branch.kind == "branch"
    assert branch.source_task_id == "task-root"
    assert branch.branched_at_seq == 12
    assert sessions.list_task_streams(conn, session.id) == [root, branch]
    assert sessions.latest_task_stream(conn, session.id) == branch


def test_binding_a_task_stream_bumps_the_session_version(conn, tmp_path):
    """The session detail response lists its streams, so a client that read the
    session between the two writes could not tell the states apart."""
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)

    sessions.add_task_stream(conn, session.id, "task-root")

    assert sessions.get_session(conn, session.id).version == session.version + 1


def test_a_task_stream_belongs_to_exactly_one_session(conn, tmp_path):
    project = make_project(conn, tmp_path)
    first = sessions.create_session(conn, project.id)
    second = sessions.create_session(conn, project.id)
    sessions.add_task_stream(conn, first.id, "task-root")

    with pytest.raises(DuplicateTaskStreamError):
        sessions.add_task_stream(conn, second.id, "task-root")
    with pytest.raises(UnknownSessionError):
        sessions.add_task_stream(conn, "nope", "task-other")


def test_a_branch_without_a_source_is_refused(conn, tmp_path):
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)

    with pytest.raises(ValueError):
        sessions.add_task_stream(conn, session.id, "t", kind="branch")
    with pytest.raises(ValueError):
        sessions.add_task_stream(conn, session.id, "t", kind="root", source_task_id="x")
    with pytest.raises(ValueError):
        sessions.add_task_stream(conn, session.id, "t", kind="subtask")


def test_the_reverse_index_answers_session_and_project_for_a_task(conn, tmp_path):
    """The memory-root resolver and the container-id resolver are both handed a
    task id on an engine thread and have nothing else to start from."""
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)
    sessions.add_task_stream(conn, session.id, "task-root")
    sessions.add_task_stream(
        conn, session.id, "task-branch", kind="branch", source_task_id="task-root"
    )

    for task_id in ("task-root", "task-branch"):
        binding = sessions.find_task_binding(conn, task_id)
        assert binding.task_id == task_id
        assert binding.session_id == session.id
        assert binding.project_id == project.id


def test_the_reverse_index_is_total(conn):
    """A miss is what sends memory to the `_quarantine` pool — better no recall
    than another project's — so it answers `None` rather than raising."""
    for task_id in ("", "unknown-task"):
        assert sessions.find_task_binding(conn, task_id) is None


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------


def test_two_threads_may_write_at_once(conn, tmp_path):
    """One connection is shared across threads, and one connection has one
    transaction: without serialization the second thread's `BEGIN IMMEDIATE`
    lands inside the first thread's and raises "cannot start a transaction
    within a transaction"."""
    per_thread = 25
    start = threading.Barrier(2)
    failures: list[BaseException] = []

    def write(prefix: str) -> None:
        start.wait()
        for index in range(per_thread):
            try:
                projects.create_project(
                    conn, name=prefix, directory=tmp_path / f"{prefix}-{index}"
                )
            except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
                failures.append(exc)

    threads = [
        threading.Thread(target=write, args=(prefix,), name=f"writer-{prefix}")
        for prefix in ("a", "b")
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30.0)

    assert failures == []
    assert len(projects.list_projects(conn)) == 2 * per_thread


def test_a_reader_never_observes_a_half_written_session(conn, tmp_path):
    """The engine's post-commit subscription writes `last_seq` / `status` on
    worker threads while an HTTP request reads the same row."""
    project = make_project(conn, tmp_path)
    session = sessions.create_session(conn, project.id)
    updates = 200
    failures: list[BaseException] = []

    def advance() -> None:
        for seq in range(updates):
            try:
                sessions.advance_session(
                    conn,
                    session.id,
                    status="running" if seq % 2 else "waiting",
                    last_seq=seq,
                )
            except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
                failures.append(exc)

    writer = threading.Thread(target=advance, name="writer")
    writer.start()
    seen: list[int] = []
    # Bounded by a deadline as well as by the writer: a broken lock must make
    # this test FAIL rather than hang, or the next person to break it gets a
    # stalled suite instead of a message.
    deadline = time.monotonic() + 30.0
    while (writer.is_alive() or len(seen) < 2) and time.monotonic() < deadline:
        row = sessions.get_session(conn, session.id)
        assert row is not None
        assert row.status in sessions.SESSION_STATUSES
        seen.append(row.last_seq)
    writer.join(timeout=30.0)

    assert not writer.is_alive()
    assert failures == []
    # Monotonic under concurrent writes, and it actually got all the way there.
    assert seen == sorted(seen)
    assert sessions.get_session(conn, session.id).last_seq == updates - 1


def test_a_failed_write_leaves_no_half_row(conn, tmp_path):
    """`writing` is all-or-nothing: the connector INSERT that raises must not
    leave the row the following SELECT would read."""
    project = make_project(conn, tmp_path)
    projects.create_connector(
        conn, project.id, "docs", transport="http", url="https://mcp.example"
    )

    with pytest.raises(DuplicateAliasError):
        projects.create_connector(
            conn, project.id, "docs", transport="http", url="https://other.example"
        )

    assert [view.url for view in projects.list_connectors(conn, project.id)] == [
        "https://mcp.example"
    ]
    assert conn.in_transaction is False


# ---------------------------------------------------------------------------
# `LEDGER §9.11` 77 — the shapes the resolver hands the engine
# ---------------------------------------------------------------------------


def test_the_resolver_builds_the_two_spec_shapes_and_never_leaks_the_token(
    conn, tmp_path
):
    """Row 77: what `HostConfig.mcp_server_resolver` returns, both transports.

    The token is *our* addressing scheme — `"<project>:<alias>"` — and the
    engine builds tool names from whatever `alias` the spec carries. A spec
    answering with the scoped token would name every tool
    `mcp__<uuid>:docs__search`, which is the kind of thing nobody notices until
    a model is looking at it.

    `tool_subset` is a **tuple** and `argv` prepends the command to its args:
    both are shapes the engine reads positionally, so a list or a missing head
    fails somewhere far from here.
    """
    project = make_project(conn, tmp_path)
    projects.create_connector(
        conn,
        project.id,
        "docs",
        transport="http",
        url="https://mcp.example/docs",
        headers={"Authorization": "Bearer s3cret"},
        tool_subset=["search", "fetch"],
    )
    projects.create_connector(
        conn,
        project.id,
        "local-fs",
        transport="stdio",
        argv=["uvx", "mcp-server-fs", "--root", "/tmp"],
        env={"FS_MODE": "ro"},
    )

    resolve = runtime.mcp_resolver(conn)

    http = resolve(projects.connector_token(project.id, "docs"))
    assert isinstance(http, McpHttpServerSpec)
    assert http.alias == "docs"
    assert http.url == "https://mcp.example/docs"
    assert http.headers == {"Authorization": "Bearer s3cret"}
    assert http.tool_subset == ("search", "fetch")

    stdio = resolve(projects.connector_token(project.id, "local-fs"))
    assert isinstance(stdio, McpServerSpec)
    assert stdio.alias == "local-fs"
    assert stdio.argv == ("uvx", "mcp-server-fs", "--root", "/tmp")
    assert stdio.env == {"FS_MODE": "ro"}
    assert stdio.tool_subset == ()


def test_the_resolver_is_total_and_one_bad_row_costs_one_server(conn, tmp_path):
    """A malformed, unknown, disabled or wrong-scope token resolves to `None`.

    Raising here would sink the whole turn over one row of configuration, so
    the resolver is total by construction — including when the *store itself*
    fails, which is the case a table of bad tokens cannot reach."""
    project = make_project(conn, tmp_path)
    resolve = runtime.mcp_resolver(conn)

    for token in ("", "no-separator", f"{project.id}:missing"):
        assert resolve(token) is None

    broken = sqlite3.connect(":memory:")
    broken.close()
    assert runtime.mcp_resolver(broken)("anything:at-all") is None
