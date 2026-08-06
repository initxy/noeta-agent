"""Artifacts: the write path's optimistic lock, and the resolve round trip.

Two properties carry the feature and both are acceptance criteria:

- **an artifact is never collectible before the server resolve confirms it.**
  Our files can live inside a container, so the client's derivation scan can
  only ever propose; `exists` is the server's word and nothing without it earns
  a panel tab.
- **an externally-modified file surfaces a conflict rather than silently
  failing to save.** Under D2 every session of a project shares one directory,
  so a second conversation rewriting the file under an open editor is ordinary,
  not exotic.

The containment check is re-pinned here through the *write* path specifically:
`resolve_within` is already covered as a function, but a write that skipped it
would be the one place a path bug costs data rather than a leaked read.
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import pytest

from noeta.agent.host import files as files_module
from noeta.agent.host.files import (
    FileConflictError,
    normalize_candidate,
    preview_for_path,
    stat_file,
    write_text,
)
from tests.test_api_flow import Api, api, make_api  # noqa: F401 - fixtures by name


# ---------------------------------------------------------------------------
# The write path, against the module
# ---------------------------------------------------------------------------


def test_a_write_replaces_atomically_and_reports_the_new_mtime(tmp_path: Path):
    """The replacement is `write temp + rename`: the agent may be reading this
    file from inside the container at the same moment, and truncate-then-write
    would hand it half a file."""
    target = tmp_path / "note.md"
    target.write_text("before")
    base = target.stat().st_mtime

    time.sleep(0.01)
    result = write_text(target, rel="note.md", content="after", base_mtime=base)

    assert target.read_text() == "after"
    assert result.path == "note.md"
    assert result.size == len("after")
    assert result.mtime == target.stat().st_mtime
    # No temp file left behind, hidden or otherwise.
    assert sorted(p.name for p in tmp_path.iterdir()) == ["note.md"]


def test_a_stale_base_mtime_is_a_conflict(tmp_path: Path):
    """The scenario D2 makes ordinary: another session rewrote the file while
    this editor held it open."""
    target = tmp_path / "note.md"
    target.write_text("v1")
    stale = target.stat().st_mtime - 5.0

    with pytest.raises(FileConflictError) as raised:
        write_text(target, rel="note.md", content="v2", base_mtime=stale)

    assert target.read_text() == "v1", "a refused write must change nothing"
    assert raised.value.base_mtime == stale
    assert raised.value.current_mtime == target.stat().st_mtime


def test_a_new_file_and_a_missing_base_both_always_win(tmp_path: Path):
    """"This file is new" and "I am not tracking versions" are both legitimate,
    and neither can be a conflict — there is nothing to conflict with."""
    fresh = tmp_path / "deep" / "new.md"
    write_text(fresh, rel="deep/new.md", content="hello", base_mtime=1.0)
    assert fresh.read_text() == "hello"

    existing = tmp_path / "existing.md"
    existing.write_text("v1")
    write_text(existing, rel="existing.md", content="v2", base_mtime=None)
    assert existing.read_text() == "v2"


def test_a_rewrite_keeps_the_original_mode(tmp_path: Path):
    """Writes go to the **host** directory, but the container runs as its own
    uid — so an existing file's mode and ownership are carried onto the
    replacement rather than reset to this process's defaults."""
    target = tmp_path / "script.sh"
    target.write_text("echo one")
    os.chmod(target, 0o750)

    write_text(target, rel="script.sh", content="echo two")

    assert target.stat().st_mode & 0o777 == 0o750


def test_the_round_trip_mtime_is_accepted_as_the_next_base(tmp_path: Path):
    """The mtime a save reports is the base for the save after it. If the two
    were derived differently the second save of a session would 409 against
    itself."""
    target = tmp_path / "note.md"
    first = write_text(target, rel="note.md", content="one")
    time.sleep(0.01)
    second = write_text(target, rel="note.md", content="two", base_mtime=first.mtime)

    assert second.mtime >= first.mtime
    assert target.read_text() == "two"


# ---------------------------------------------------------------------------
# Candidate normalization and classification
# ---------------------------------------------------------------------------


def test_absolute_paths_resolve_for_both_execution_tiers(tmp_path: Path):
    """Tool output names files by absolute path, and which absolute path
    depends on the tier: the host directory for `local`, the container's mount
    target for `sandbox`."""
    root = tmp_path / "project"
    root.mkdir()

    assert normalize_candidate(str(root / "src/app.py"), root) == "src/app.py"
    assert normalize_candidate("/workspace/src/app.py", root) == "src/app.py"
    assert normalize_candidate("./README.md", root) == "README.md"
    assert normalize_candidate(f"file://{root}/README.md", root) == "README.md"


def test_a_candidate_that_names_nothing_here_normalizes_to_empty(tmp_path: Path):
    """The derivation scan reads prose, so junk is the expected input. It is
    reported as "does not exist", never as an error — one bad guess must not
    fail the batch it arrived in."""
    root = tmp_path / "project"
    root.mkdir()

    for junk in ("", "   ", "/etc/passwd", "x" * 600, "we\x00ird"):
        assert normalize_candidate(junk, root) == ""


def test_the_preview_kind_comes_from_the_extension():
    """The **server** owns this table; the client's guess is overwritten. Note
    that `text` and `external` are openable but never collectible."""
    assert preview_for_path("notes/plan.MD") == "markdown"
    assert preview_for_path("data.csv") == "sheet"
    assert preview_for_path("shot.png") == "image"
    assert preview_for_path("report.pdf") == "pdf"
    assert preview_for_path("page.html") == "html"
    assert preview_for_path("main.ts") == "text"
    assert preview_for_path("thing.bin") == "external"


def test_a_directory_is_not_an_artifact(tmp_path: Path):
    """`exists` is true only for a **regular file**: a directory sharing a name
    with a candidate would otherwise open a tab that can never render."""
    (tmp_path / "src").mkdir()

    assert stat_file(tmp_path / "src").exists is False
    assert stat_file(tmp_path / "nope").exists is False


# ---------------------------------------------------------------------------
# The write endpoint
# ---------------------------------------------------------------------------


def _write(api: Api, session_id: str, **body: Any):
    return api.http.put(f"/api/v1/sessions/{session_id}/files/content", json=body)


def _read(api: Api, session_id: str, path: str) -> dict[str, Any]:
    response = api.http.get(
        f"/api/v1/sessions/{session_id}/files/content", params={"path": path}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_saving_a_file_through_the_session(api: Api):
    project, session = api.open_session()

    created = _write(api, session["id"], path="notes/plan.md", content="# Plan\n")

    assert created.status_code == 200
    assert (Path(project["directory"]) / "notes" / "plan.md").read_text() == "# Plan\n"
    # The success body is byte-identical to what a GET would return, because
    # the client writes it straight into the cache that GET fills.
    assert created.json() == _read(api, session["id"], "notes/plan.md")


def test_a_stale_save_is_409_and_changes_nothing(api: Api):
    """The reference implementation this replaces returned the 409 and the
    client ignored it, so an externally-rewritten file silently failed to save.
    The status is the contract; the recovery is a re-read."""
    project, session = api.open_session()
    target = Path(project["directory"]) / "note.md"
    target.write_text("v1")
    base = _read(api, session["id"], "note.md")["mtime"]

    # Something else rewrites it — another session, or this one's own agent.
    time.sleep(0.01)
    target.write_text("v2 from elsewhere")

    conflict = _write(api, session["id"], path="note.md", content="v3", base_mtime=base)

    assert conflict.status_code == 409
    error = api.error(conflict)
    assert error["code"] == "file_conflict"
    # Optional, and the client works without it — but it saves the "overwrite
    # theirs" path a round trip.
    assert error["current_mtime"] == target.stat().st_mtime
    assert target.read_text() == "v2 from elsewhere"
    # And the recovery path works: re-read, then save against the fresh base.
    fresh = _read(api, session["id"], "note.md")["mtime"]
    assert _write(
        api, session["id"], path="note.md", content="v3", base_mtime=fresh
    ).status_code == 200


def test_every_write_goes_through_the_containment_check(api: Api, tmp_path: Path):
    """`..`, an absolute path, the empty string and a symlink pointing out of
    the workspace are all 400 before a byte is touched. The symlink is the case
    a naive check misses, and the container's own agent can create one at any
    time."""
    project, session = api.open_session()
    secret = tmp_path / "secret.txt"
    secret.write_text("not yours")
    os.symlink(secret, Path(project["directory"]) / "escape")

    for path in ("../secret.txt", str(secret), "", "escape"):
        response = _write(api, session["id"], path=path, content="owned")
        assert response.status_code == 400, path
        assert api.error(response)["code"] == "invalid_path", path

    assert secret.read_text() == "not yours"


def test_a_write_over_the_cap_is_refused(api: Api):
    _, session = api.open_session()

    response = _write(
        api,
        session["id"],
        path="huge.txt",
        content="x" * (files_module.MAX_WRITE_BYTES + 1),
    )

    assert response.status_code == 422
    assert api.error(response)["code"] == "file_too_large"


def test_an_svg_read_raw_cannot_script_this_origin(api: Api):
    """SVG can embed scripts. `image/svg+xml` is what makes `<img src>` render
    it — and inside an `<img>` no script runs — but a human opening the raw URL
    gets a *document*, which without this header would run in the API's own
    origin."""
    project, session = api.open_session()
    (Path(project["directory"]) / "logo.svg").write_text(
        "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"
    )

    response = api.http.get(
        f"/api/v1/sessions/{session['id']}/files/content",
        params={"path": "logo.svg", "mode": "raw"},
    )

    assert response.headers["content-type"] == "image/svg+xml"
    assert response.headers["content-security-policy"] == "sandbox"
    assert response.headers["x-content-type-options"] == "nosniff"


# ---------------------------------------------------------------------------
# The resolve endpoint
# ---------------------------------------------------------------------------


def _resolve(api: Api, session_id: str, paths: list[str]) -> list[dict[str, Any]]:
    response = api.http.post(
        f"/api/v1/sessions/{session_id}/artifacts/resolve", json={"paths": paths}
    )
    assert response.status_code == 200, response.text
    return response.json()["artifacts"]


def test_resolve_overwrites_exists_size_updated_at_and_preview(api: Api):
    """The client guesses; the server decides."""
    project, session = api.open_session()
    (Path(project["directory"]) / "report.md").write_text("# Report\n")

    (row,) = _resolve(api, session["id"], ["report.md"])

    assert row["exists"] is True
    assert row["size"] == len("# Report\n")
    assert row["preview"] == "markdown"
    assert row["updatedAt"] == str(_read(api, session["id"], "report.md")["mtime"])


def test_a_resolved_row_is_keyed_by_the_path_the_client_sent(api: Api):
    """The client folds the response into its candidate list by this string.
    Answering with the *normalized* path would silently drop every candidate
    that needed normalizing — which is most of them, because tool output names
    files by absolute path."""
    project, session = api.open_session()
    (Path(project["directory"]) / "out.md").write_text("hi")

    (row,) = _resolve(api, session["id"], ["/workspace/out.md"])

    assert row["path"] == "/workspace/out.md"
    assert row["exists"] is True


def test_nothing_is_collectible_before_the_round_trip_confirms_it(api: Api):
    """The acceptance criterion. A candidate the scan invented out of a
    paragraph, a traversal attempt, and a directory all come back the same
    way — `exists: false` — and none of them is an error."""
    project, session = api.open_session()
    (Path(project["directory"]) / "src").mkdir()

    rows = _resolve(
        api, session["id"], ["e.g", "../../etc/passwd", "/etc/passwd", "src"]
    )

    assert [row["exists"] for row in rows] == [False] * 4
    assert [row["updatedAt"] for row in rows] == [None] * 4


def test_a_container_absolute_path_resolves_against_the_host_tree(api: Api):
    """A `sandbox` project's tools print container paths. The file lives on the
    host — same tree through the bind mount — so the prefix is translated
    rather than the candidate dropped."""
    project, session = api.open_session()
    (Path(project["directory"]) / "notes").mkdir()
    (Path(project["directory"]) / "notes" / "out.md").write_text("hi")

    (row,) = _resolve(api, session["id"], ["/workspace/notes/out.md"])

    assert row["exists"] is True
    assert row["preview"] == "markdown"


def test_the_batch_is_capped(api: Api):
    """The scan runs over a whole transcript and re-fires whenever the derived
    set changes; uncapped, one panel refresh becomes thousands of stats. Extras
    are dropped rather than failing the batch — the panel degrades, it does not
    break, and an unresolved candidate is never collectible anyway."""
    from noeta.agent.api.artifacts import RESOLVE_CAP

    _, session = api.open_session()
    paths = [f"f{index}.md" for index in range(RESOLVE_CAP + 5)]

    assert len(_resolve(api, session["id"], paths)) == RESOLVE_CAP
