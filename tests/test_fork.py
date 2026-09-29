"""`fork`: edit that message and try again, keeping the original.

A fork is a **new child session**, not a sibling stream in the same session.
Three claims, and the product is wrong in a different way if any slips:

- **The fork is its own session, nested under its source.** The forked task
  becomes the child's own `root` stream; the child records `parent_session_id`
  (the sidebar-nesting link), `source_task_id` (the parent stream it inherits
  from) and `branched_at_seq` (the anchor). The parent keeps its lone stream —
  a fork writes nothing to it.
- **The child reads as a whole conversation.** Opening it shows the inherited
  history (everything up to the anchor, spliced from the parent stream,
  seq-less) followed by its own turns. A reconnect does not re-send the prefix.
- **The refusals are conflicts, not faults.** A 409 with a stable code renders
  as "start a new session instead"; a 500 renders as "something went wrong".

The engine's anchor is the `seq` of the user-goal `MessagesAppended` — exactly
the `seq` the `user_message` frame already carries, so the client needs no
second addressing scheme for "the bubble I clicked".
"""
from __future__ import annotations

from typing import Any

import httpx

from noeta.agent.store import db, sessions as sessions_store
from tests.test_api_flow import (  # noqa: F401 - fixtures are used by name
    Api,
    api,
    delegating_provider,
    make_api,
    text_provider,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def two_turns(ready: Api) -> tuple[dict, dict, list[Any]]:
    """A session with two finished turns, and its `user_message` frames.

    Two, not one: forking the opening message is refused, so a conversation
    that can be branched at all needs a second bubble to anchor on."""
    project, session = ready.open_session()
    ready.send(session["id"], "first")
    ready.wait_turn(session["id"])
    ready.send(session["id"], "second")
    ready.wait_turn(session["id"])
    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)
    return project, session, [f for f in frames if f.event == "user_message"]


def fork_at(ready: Api, session_id: str, task_id: str, message_seq: int) -> httpx.Response:
    return ready.http.post(
        f"/api/v1/sessions/{session_id}/fork",
        json={"task_id": task_id, "message_seq": message_seq},
    )


def bind_stream(ready: Api, session_id: str, task_id: str) -> None:
    """Record `task_id` as one of this session's streams, behind the server.

    The API's own containment check refuses any task id that is not already a
    stream of this session, and a subtask never is — so this is the only way
    to exercise the *engine's* "not a root task" refusal and prove it reaches
    the client as a coded 409 rather than a 500. A second connection is safe:
    the app database is WAL with a busy timeout, and the row is read back on
    the next request rather than from a cache."""
    conn = db.connect(ready.settings.app_db_path)
    try:
        sessions_store.add_task_stream(conn, session_id, task_id, kind="root")
    finally:
        conn.close()


def settle_child(ready: Api, child_id: str) -> list[Any]:
    """Read a fork's stream until *its own* turn comes to rest, and return the
    frames.

    `Api.wait_turn` cannot serve here, and the reason is a trap worth naming:
    it stops at the first `turn_finished`, which for a fork is now the
    **inherited** prefix's — replayed the instant the stream connects — so it
    returns before the child's own turn has run and every assertion after it is
    a race. The discriminator is the `seq`: inherited frames are seq-less (they
    are another stream's past), the child's own frames carry one. So this waits
    for a `turn_finished` that has a seq."""
    return ready.frames(
        child_id,
        params={"since_seq": 0},
        until=lambda f: f.event in {"turn_finished", "error"} and f.seq is not None,
        timeout=20.0,
    )


# ---------------------------------------------------------------------------
# The child session
# ---------------------------------------------------------------------------


def test_an_edited_message_forks_into_a_child_session(make_api):
    """The pin, end to end.

    Forking mints a *second* session, nested under the source, and returns the
    id of that session plus its root task. The parent is untouched (still its
    lone stream, still its two messages); the child owns the edited turn."""
    ready = make_api(provider=text_provider())
    project, session, messages = two_turns(ready)
    source = messages[1].data["_task"]

    forked = fork_at(ready, session["id"], source, messages[1].seq)

    assert forked.status_code == 201
    body = forked.json()
    child_id = body["session_id"]
    branch = body["task_id"]
    assert child_id != session["id"]
    assert branch != source

    ready.send(child_id, "second, but phrased better", task_id=branch)
    settle_child(ready, child_id)

    # Two sessions now, and the child is nested under its source.
    index = ready.http.get(f"/api/v1/projects/{project['id']}/sessions").json()
    assert len(index["sessions"]) == 2
    child_row = next(s for s in index["sessions"] if s["id"] == child_id)
    parent_row = next(s for s in index["sessions"] if s["id"] == session["id"])
    assert child_row["parent_session_id"] == session["id"]
    assert child_row["branched_at_seq"] == messages[1].seq
    assert parent_row["parent_session_id"] is None

    # The parent keeps its lone root stream — a fork writes nothing to it.
    assert [s["kind"] for s in ready.detail(session["id"])["task_streams"]] == ["root"]
    # The child owns the forked task as its own root.
    child_streams = ready.detail(child_id)["task_streams"]
    assert [(s["task_id"], s["kind"]) for s in child_streams] == [(branch, "root")]


def test_the_child_replays_inherited_history_then_its_own(make_api):
    """Opening the child reads as one conversation: the shared prefix (up to
    the anchor) followed by the edited turn.

    The prefix lives on the *parent's* stream — the child's event log has only
    its own turn — so the hub splices it in at replay. The inherited frames are
    stamped `_inherited` and carry no `seq`; the edited turn is the child's own,
    seq-bearing stream."""
    ready = make_api(provider=text_provider())
    project, session, messages = two_turns(ready)
    source = messages[1].data["_task"]
    body = fork_at(ready, session["id"], source, messages[1].seq).json()
    child_id, branch = body["session_id"], body["task_id"]

    ready.send(child_id, "second, but phrased better", task_id=branch)
    settle_child(ready, child_id)

    frames = ready.frames(child_id, params={"since_seq": 0}, timeout=5.0)
    said = [f for f in frames if f.event == "user_message"]
    # Inherited "first" (shared prefix), then the edited turn — never the
    # replaced "second".
    assert [f.data["content"] for f in said] == ["first", "second, but phrased better"]

    inherited = [f for f in said if f.data.get("_inherited")]
    own = [f for f in said if not f.data.get("_inherited")]
    assert [f.data["content"] for f in inherited] == ["first"]
    assert [f.data["content"] for f in own] == ["second, but phrased better"]
    # The inherited frames carry no cursor position: they are another stream's
    # past, and must never advance this session's SSE cursor.
    assert all(f.seq is None for f in inherited)
    # The original is still readable in its own session, unchanged.
    parent_said = [
        f.data["content"]
        for f in ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)
        if f.event == "user_message"
    ]
    assert parent_said == ["first", "second"]


def test_the_branch_inherits_the_history_before_its_anchor_and_nothing_after(make_api):
    """What a fork *is*, stated where it is observable: the model's own input.

    The branch folds the conversation through the turn boundary just before
    the anchored message, so the model sees everything that came before it and
    nothing of the turn being replaced. Getting this wrong in either direction
    is invisible on screen and obvious to the model: too little context and it
    answers a question it cannot see, too much and it answers the message the
    user just edited away."""
    seen: list[Any] = []
    ready = make_api(provider=text_provider(seen))
    project, session, messages = two_turns(ready)
    body = fork_at(
        ready, session["id"], messages[1].data["_task"], messages[1].seq
    ).json()
    child_id, branch = body["session_id"], body["task_id"]

    ready.send(child_id, "second, but phrased better", task_id=branch)
    settle_child(ready, child_id)

    shown = [
        block.text
        for message in getattr(seen[-1], "messages", ())
        if getattr(message, "role", "") == "user"
        for block in (getattr(message, "content", ()) or [])
        if getattr(block, "text", None)
    ]
    assert "first" in shown
    assert "second, but phrased better" in shown
    assert "second" not in shown


def test_a_reconnect_does_not_re_send_the_inherited_prefix(make_api):
    """The inherited prefix is spliced on a **full** replay only.

    It is immutable past on another session's stream, carrying no `seq`, so a
    client reconnecting with `since_seq > 0` already has it — re-sending it
    would duplicate frames the client cannot dedup. A resume therefore returns
    only what happened after the cursor, none of it inherited."""
    ready = make_api(provider=text_provider())
    project, session, messages = two_turns(ready)
    body = fork_at(
        ready, session["id"], messages[1].data["_task"], messages[1].seq
    ).json()
    child_id, branch = body["session_id"], body["task_id"]
    ready.send(child_id, "second, but phrased better", task_id=branch)
    own = settle_child(ready, child_id)

    # Resume from the child's own first seq: everything at or before it is gone,
    # and nothing inherited comes back.
    first_own_seq = min(f.seq for f in own if f.seq is not None)
    resumed = ready.frames(
        child_id, params={"since_seq": first_own_seq}, timeout=5.0
    )
    assert not [f for f in resumed if f.data.get("_inherited")]


def test_the_child_is_titled_from_its_parent(make_api):
    """Until its first turn generates a title, the child row is labelled from
    the parent so the sidebar is not a wall of "Untitled"."""
    ready = make_api(provider=text_provider())
    project, session, messages = two_turns(ready)
    ready.http.patch(
        f"/api/v1/sessions/{session['id']}", json={"title": "Investigate the bug"}
    )

    body = fork_at(
        ready, session["id"], messages[1].data["_task"], messages[1].seq
    ).json()

    child_row = ready.detail(body["session_id"])
    assert child_row["title"] == "Investigate the bug (fork)"
    assert child_row["title_generated"] is False


# ---------------------------------------------------------------------------
# The refusals
# ---------------------------------------------------------------------------


def test_forking_the_opening_message_is_a_coded_409(make_api):
    """There is no prior turn to branch from.

    The client renders "start a new session instead" from the code, which it
    can only do if the refusal arrives as a conflict with a stable slug —
    `NotForkableError` is exported from `noeta.sdk` and caught by name, so this
    never degrades into an unnamed 500. No child session is created."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "only message")
    ready.wait_turn(session["id"])
    opening = next(
        f
        for f in ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)
        if f.event == "user_message"
    )

    refused = fork_at(ready, session["id"], opening.data["_task"], opening.seq)

    assert refused.status_code == 409
    assert ready.error(refused)["code"] == "not_forkable"
    # Nothing was created: still one session in the project.
    index = ready.http.get(f"/api/v1/projects/{project['id']}/sessions").json()
    assert len(index["sessions"]) == 1


def test_forking_an_anchor_that_is_not_a_message_at_all_is_a_coded_409(make_api):
    """Worth its own row because the client picks the seq off a rendered frame,
    and not every frame's seq is an anchor: `turn_started` comes from a
    lifecycle envelope, not a message. A UI that computed the anchor from the
    wrong frame produces exactly this request, and it has to fail as a conflict
    rather than branch at some nearby seq the engine guessed at.

    **The engine's predicate is structural, not role-aware** — it accepts any
    `MessagesAppended` that carries content, so an *assistant* bubble's seq is
    accepted and silently branches at the turn boundary before it. Offering
    "edit and retry" on anything but a user bubble is therefore the client's
    mistake to avoid; the engine will not catch it."""
    ready = make_api(provider=text_provider())
    project, session, messages = two_turns(ready)
    opener = next(
        f
        for f in ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)
        if f.event == "turn_started" and f.seq is not None
    )

    refused = fork_at(ready, session["id"], opener.data["_task"], opener.seq)

    assert refused.status_code == 409
    assert ready.error(refused)["code"] == "not_forkable"


def test_a_subtask_is_refused_twice_over(make_api):
    """A subtask is not a root task, and this product refuses it at two
    independent layers — which is worth pinning because they fail differently.

    A subtask id is never one of a session's task streams, so the API's own
    containment check answers **404** before the engine is reached. Bind it
    anyway, as a corrupted row or a future code path might, and the engine's
    own `NotForkableError("not a root task")` surfaces as a coded **409**.
    Neither is a 500, which is the only outcome that would leave a client
    unable to say anything useful."""
    ready = make_api(provider=delegating_provider(background=False))
    project, session = ready.open_session()
    ready.send(session["id"], "delegate please")
    frames = ready.wait_turn(session["id"], timeout=30.0)
    spawned = next(f for f in frames if f.event == "subtask_started")
    subtask = spawned.data["subtask_id"]

    unknown = fork_at(ready, session["id"], subtask, spawned.seq)
    assert unknown.status_code == 404
    assert ready.error(unknown)["code"] == "unknown_task_stream"

    bind_stream(ready, session["id"], subtask)
    refused = fork_at(ready, session["id"], subtask, spawned.seq)

    assert refused.status_code == 409
    assert ready.error(refused)["code"] == "not_forkable"


def test_forking_another_session_s_stream_is_refused(make_api):
    """`task_id` arrives in a request body. Branching a stranger's stream into
    this session would splice two conversations together, and the answer is
    the same as for a task id that does not exist — distinguishing them would
    leak the existence of the other session's stream."""
    ready = make_api(provider=text_provider())
    project, theirs, messages = two_turns(ready)
    mine = ready.create_session(project["id"])

    refused = fork_at(ready, mine["id"], messages[1].data["_task"], messages[1].seq)

    assert refused.status_code == 404
    assert ready.error(refused)["code"] == "unknown_task_stream"


# ---------------------------------------------------------------------------
# Lineage survives the parent
# ---------------------------------------------------------------------------


def test_deleting_the_parent_de_nests_the_child_and_keeps_its_history(make_api):
    """Deleting a parent must not take its forks with it, and must not lose the
    child's inherited history.

    `parent_session_id` is `ON DELETE SET NULL`, so the child de-nests to the
    top level rather than cascading away. `source_task_id` is not a foreign
    key, and `delete_session` leaves the event log intact, so the child still
    splices its inherited prefix from the (now parent-less) source stream."""
    ready = make_api(provider=text_provider())
    project, session, messages = two_turns(ready)
    source = messages[1].data["_task"]
    body = fork_at(ready, session["id"], source, messages[1].seq).json()
    child_id, branch = body["session_id"], body["task_id"]
    ready.send(child_id, "second, but phrased better", task_id=branch)
    settle_child(ready, child_id)

    assert ready.http.delete(f"/api/v1/sessions/{session['id']}").status_code in (
        200,
        204,
    )

    # The child survived and de-nested.
    index = ready.http.get(f"/api/v1/projects/{project['id']}/sessions").json()
    ids = {s["id"] for s in index["sessions"]}
    assert child_id in ids and session["id"] not in ids
    child_row = next(s for s in index["sessions"] if s["id"] == child_id)
    assert child_row["parent_session_id"] is None

    # Its inherited history still replays from the surviving event log.
    said = [
        f.data["content"]
        for f in ready.frames(child_id, params={"since_seq": 0}, timeout=5.0)
        if f.event == "user_message"
    ]
    assert said == ["first", "second, but phrased better"]


# ---------------------------------------------------------------------------
# D6 (reversed) — rewind is exposed as "undo last turn"
# ---------------------------------------------------------------------------


def rewind_at(
    ready: Api, session_id: str, task_id: str, message_seq: int
) -> httpx.Response:
    return ready.http.post(
        f"/api/v1/sessions/{session_id}/rewind",
        json={"task_id": task_id, "message_seq": message_seq},
    )


def test_rewind_is_exposed(api: Api):
    """D6 reversed: `rewind` ships as "undo last turn". Asserted against the
    served schema so the claim is "the route exists", alongside `fork` so a
    schema read returning nothing could not pass."""
    routes = set(api.http.get("/openapi.json").json()["paths"])

    assert "/api/v1/sessions/{session_id}/rewind" in routes
    assert "/api/v1/sessions/{session_id}/fork" in routes


def test_rewind_rebases_in_place_no_child_session(make_api):
    """The pin: undo re-bases THIS session's stream and creates no child.

    A 200 with the (unchanged) stream id, the project still has one session,
    and a fresh replay from seq 0 no longer shows the undone turn — the durable
    `rewind` frame the fold truncates on lands on the stream."""
    ready = make_api(provider=text_provider())
    project, session, messages = two_turns(ready)
    stream = messages[1].data["_task"]

    rewound = rewind_at(ready, session["id"], stream, messages[1].seq)

    assert rewound.status_code == 200
    assert rewound.json()["task_id"] == stream
    # No child: still exactly one session in the project.
    index = ready.http.get(f"/api/v1/projects/{project['id']}/sessions").json()
    assert len(index["sessions"]) == 1
    # The stream carries a `rewind` frame whose target is before the undone
    # message, and a fresh replay no longer shows the second user bubble.
    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)
    rewind_frames = [f for f in frames if f.event == "rewind"]
    assert len(rewind_frames) == 1
    assert rewind_frames[0].data["target_seq"] < messages[1].seq


def test_rewinding_a_non_user_anchor_is_a_coded_409(make_api):
    """A seq that is not a user message on the stream is a conflict with a
    stable slug (`not_rewindable`), not an unnamed 500 — the product
    pre-validates because the SDK raises a bare `RuntimeError` here."""
    ready = make_api(provider=text_provider())
    _, session, messages = two_turns(ready)
    stream = messages[1].data["_task"]

    refused = rewind_at(ready, session["id"], stream, messages[1].seq + 100_000)

    assert refused.status_code == 409
    assert ready.error(refused)["code"] == "not_rewindable"


def test_rewinding_another_session_s_stream_is_refused(make_api):
    """Same containment as fork: a `task_id` that is not this session's stream
    is a 404 `unknown_task_stream`, never a peek at another session."""
    ready = make_api(provider=text_provider())
    project, theirs, messages = two_turns(ready)
    mine = ready.create_session(project["id"])

    refused = rewind_at(ready, mine["id"], messages[1].data["_task"], messages[1].seq)

    assert refused.status_code == 404
    assert ready.error(refused)["code"] == "unknown_task_stream"
