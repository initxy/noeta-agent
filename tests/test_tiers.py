"""The execution-tier decision (D3).

`sandbox_policy` is the entire tier mechanism, so its edges are the whole
contract: it must be **total** (never raise, always answer), keyed on the
*directory* rather than the task id, and deterministic for a session once that
session exists.
"""
from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from noeta.agent.host.tiers import LOCAL, SANDBOX, TierPolicy
from noeta.agent.store import db
from noeta.agent.store.projects import create_project, update_project


@pytest.fixture
def store(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    conn = db.connect(tmp_path / "app.db")
    db.bootstrap(conn)
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture
def make_project(store: sqlite3.Connection, tmp_path: Path) -> Callable[..., object]:
    counter = iter(range(1, 1000))

    def _make(*, tier: str = LOCAL, directory: Path | None = None):
        if directory is None:
            directory = tmp_path / f"project-{next(counter)}"
            directory.mkdir()
        return create_project(
            store, name=directory.name, directory=str(directory), tier=tier
        )

    return _make


# ---------------------------------------------------------------------------
# The decision itself
# ---------------------------------------------------------------------------


def test_a_sandbox_project_wants_a_container(store, make_project) -> None:
    project = make_project(tier=SANDBOX)
    policy = TierPolicy(store)
    assert policy.wants_container("task-not-in-the-db-yet", project.directory) is True


def test_a_local_project_does_not(store, make_project) -> None:
    project = make_project(tier=LOCAL)
    policy = TierPolicy(store)
    assert policy.wants_container("task-not-in-the-db-yet", project.directory) is False


def test_local_is_the_default_tier(store, tmp_path: Path) -> None:
    """A project must opt in to the container, never inherit it — which is also
    what makes the harness rule "no test project defaults to sandbox" hold
    structurally rather than by convention."""
    directory = tmp_path / "plain"
    directory.mkdir()
    project = create_project(store, name="plain", directory=str(directory))
    assert project.tier == LOCAL
    assert TierPolicy(store).wants_container("t", project.directory) is False


def test_the_root_task_id_is_not_consulted(store, make_project) -> None:
    """The id does not exist in any table at the moment the policy is asked —
    it is minted inside `seed_start` — so the answer must not vary with it."""
    project = make_project(tier=SANDBOX)
    policy = TierPolicy(store)
    answers = {policy.wants_container(tid, project.directory) for tid in ("", "a", "b")}
    assert answers == {True}


def test_two_projects_get_their_own_tiers(store, make_project) -> None:
    local = make_project(tier=LOCAL)
    sandboxed = make_project(tier=SANDBOX)
    policy = TierPolicy(store)
    assert policy.wants_container("t", local.directory) is False
    assert policy.wants_container("t", sandboxed.directory) is True


# ---------------------------------------------------------------------------
# Total: every degenerate input answers, none of them raises
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "workspace_dir",
    [None, "", "relative/path", "/nonexistent/directory", "\x00", "~"],
    ids=["none", "empty", "relative", "unclaimed", "nul-byte", "unexpanded-tilde"],
)
def test_an_unusable_workspace_is_local(store, workspace_dir) -> None:
    assert TierPolicy(store).wants_container("t", workspace_dir) is False


def test_a_directory_no_project_claims_is_local(store, tmp_path: Path) -> None:
    orphan = tmp_path / "not-a-project"
    orphan.mkdir()
    assert TierPolicy(store).wants_container("t", str(orphan)) is False


def test_a_failing_store_is_local_not_an_exception(tmp_path: Path) -> None:
    """The policy runs inside `seed_start` on the request thread. Raising there
    fails the whole turn over a tier lookup, which is strictly worse than
    running that turn on the local path."""
    conn = db.connect(tmp_path / "app.db")
    db.bootstrap(conn)
    conn.close()  # every statement now raises ProgrammingError
    assert TierPolicy(conn).wants_container("t", "/anywhere") is False


# ---------------------------------------------------------------------------
# Determinism, and the one thing that is deliberately NOT retroactive
# ---------------------------------------------------------------------------


def test_the_same_directory_always_answers_the_same(store, make_project) -> None:
    project = make_project(tier=SANDBOX)
    policy = TierPolicy(store)
    assert {policy.wants_container("t", project.directory) for _ in range(20)} == {True}


def test_every_spelling_of_one_directory_answers_the_same(
    store, make_project, tmp_path: Path
) -> None:
    """The store normalizes both sides through `realpath`, so a session resumed
    with a differently-spelled path cannot flip tier."""
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    project = make_project(tier=SANDBOX, directory=real)
    policy = TierPolicy(store)
    for spelling in (str(real), str(link), f"{real}/", f"{real}/./", f"{real}/sub/.."):
        assert policy.wants_container("t", spelling) is True, spelling
    assert project.directory == str(real)


def test_changing_the_tier_changes_what_new_sessions_get(store, make_project) -> None:
    """The policy reads the project row, so an edit is visible immediately —
    to the NEXT `seed_start`.

    Sessions that already exist are unaffected, and not because of anything
    here: the answer is welded into `TaskHostBound` at `seed_start` and every
    later turn fold-resolves it instead of asking again. That weld is what
    makes the policy deterministic across a resume, and it is why the UI has to
    say that switching a tier applies to new sessions only."""
    project = make_project(tier=LOCAL)
    policy = TierPolicy(store)
    assert policy.wants_container("t", project.directory) is False
    update_project(store, project.id, tier=SANDBOX)
    assert policy.wants_container("t", project.directory) is True


def test_tier_for_directory_reports_the_name_not_a_boolean(store, make_project) -> None:
    """The `/health` and project surfaces want the tier itself, and an unknown
    directory has to answer with a tier rather than a `None` every caller then
    has to handle."""
    project = make_project(tier=SANDBOX)
    policy = TierPolicy(store)
    assert policy.tier_for_directory(project.directory) == SANDBOX
    assert policy.tier_for_directory("/unclaimed") == LOCAL
    assert policy.tier_for_directory(None) == LOCAL


# ---------------------------------------------------------------------------
# The container's key — D2's derived placement, and the window it needs
# ---------------------------------------------------------------------------


def test_the_container_is_keyed_on_the_project_from_the_very_first_allocate(
    store: sqlite3.Connection, make_project: Callable[..., object], tmp_path: Path
) -> None:
    """D2 says every session of a project shares one directory, so they share
    one container. The resolver has to answer that from the **first** allocate
    of a session, and at that moment the durable `task -> session -> project`
    row does not exist: provisioning runs inside `seed_start`, and the row is
    written between the seed and the dispatch.

    Missing it is silent. The container is named after the root task, every
    later turn `attach`es to that durable name, and the session keeps a
    container of its own for life — two sessions of one project never share
    one, and the preview panel 404s on a session that is visibly running in a
    container.
    """
    from noeta.agent.host.sandbox import container_id_resolver
    from noeta.agent.host.seeding import SEEDING
    from noeta.agent.store import sessions

    project = make_project(tier=SANDBOX)
    session = sessions.create_session(store, project.id)  # type: ignore[attr-defined]
    resolve = container_id_resolver(store)

    # The first allocate: no binding row yet, and the window is what answers.
    unbound = "task-not-in-any-table-yet"
    assert resolve(unbound) is None
    with SEEDING.project(project.id):  # type: ignore[attr-defined]
        assert resolve(unbound) == project.id  # type: ignore[attr-defined]

    # Every later turn is answered by the durable row, window or no window.
    sessions.add_task_stream(store, session.id, unbound, kind="root")
    assert resolve(unbound) == project.id  # type: ignore[attr-defined]


def test_the_seeding_window_is_thread_local(
    store: sqlite3.Connection, make_project: Callable[..., object]
) -> None:
    """Two requests seeding two sessions concurrently must not see each other's
    project — which is why this is a thread-local and not a process-wide slot."""
    import threading

    from noeta.agent.host.sandbox import container_id_resolver
    from noeta.agent.host.seeding import SEEDING

    project = make_project(tier=SANDBOX)
    resolve = container_id_resolver(store)
    seen: list[object] = []

    with SEEDING.project(project.id):  # type: ignore[attr-defined]
        worker = threading.Thread(target=lambda: seen.append(resolve("task-x")))
        worker.start()
        worker.join()

    assert seen == [None]
