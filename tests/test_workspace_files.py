"""The workspace file surface: listing, containment, reading.

`LEDGER §9.13` rows 87-90. The listing rules are pinned against the module
directly — they are file-system behaviour and a `tmp_path` says it better than
a booted server — and the HTTP surface is pinned end to end, because the
containment check is the security boundary of the whole product and it must be
impossible to reach a file outside the project directory *through the API*, not
merely through one function.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from noeta.agent.host import files as files_module
from noeta.agent.host.files import (
    InvalidPathError,
    list_files,
    read_text,
    resolve_within,
    sniff_content_type,
)
from tests.test_api_flow import Api, api, make_api  # noqa: F401 - fixtures by name


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    """A workspace with the shapes that matter: nesting, hidden entries at two
    depths, and the engine's own metadata directory."""
    root = tmp_path / "workspace"
    (root / "src" / "deep").mkdir(parents=True)
    (root / ".noeta").mkdir()
    (root / "src" / ".cache").mkdir()

    (root / "README.md").write_text("hello")
    (root / ".env").write_text("SECRET=1")
    (root / "src" / "main.py").write_text("print()")
    (root / "src" / "deep" / "note.txt").write_text("deep")
    (root / "src" / ".hidden.py").write_text("hidden at depth")
    (root / "src" / ".cache" / "blob").write_text("cached")
    (root / ".noeta" / "events.db").write_text("engine state")
    return root


# ---------------------------------------------------------------------------
# Listing — rows 87-89
# ---------------------------------------------------------------------------


def test_the_listing_is_sorted_recursive_and_free_of_hidden_entries(tree: Path):
    """Row 87. Hidden at **any** depth, which is also what keeps the engine's
    `.noeta` metadata out of the user's file panel."""
    entries = list_files(tree)

    assert [e.path for e in entries] == [
        "README.md",
        "src/deep/note.txt",
        "src/main.py",
    ]
    assert all(e.size > 0 and e.mtime > 0 for e in entries)


def test_a_top_level_symlink_to_an_external_tree_is_not_traversed(
    tree: Path, tmp_path: Path
):
    """Row 88. `os.walk` would not descend a symlink anyway with
    `followlinks=False`; the point is that it is not *listed* either, because
    a link into a mounted tree can name hundreds of thousands of files."""
    outside = tmp_path / "outside"
    (outside / "nested").mkdir(parents=True)
    (outside / "nested" / "secret.txt").write_text("not yours")
    (tree / "linked").symlink_to(outside, target_is_directory=True)

    listed = [e.path for e in list_files(tree)]

    assert not [path for path in listed if path.startswith("linked")]


def test_a_missing_directory_lists_as_empty(tmp_path: Path):
    """Row 89. A project folder that was moved is a recoverable situation; a
    500 in the file panel makes it look like the session is broken."""
    assert list_files(tmp_path / "never-existed") == []


def test_a_file_that_disappears_mid_walk_is_skipped(tree: Path, monkeypatch):
    """Concurrent deletion from inside the container and dangling symlinks are
    both normal. One unreadable entry must cost that entry, not the listing."""
    real_stat = Path.stat

    def flaky(self: Path, *args, **kwargs):
        if self.name == "main.py":
            raise OSError("vanished")
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", flaky)

    assert [e.path for e in list_files(tree)] == ["README.md", "src/deep/note.txt"]


def test_the_listing_is_capped(tmp_path: Path):
    """A project with a `node_modules` in it is not a pathological case, it is
    Tuesday."""
    root = tmp_path / "many"
    root.mkdir()
    for index in range(20):
        (root / f"file-{index:03d}").write_text("x")

    assert len(list_files(root, cap=5)) == 5


# ---------------------------------------------------------------------------
# Containment — row 90
# ---------------------------------------------------------------------------


def test_containment_is_judged_after_realpath(tree: Path, tmp_path: Path):
    """Row 90, and the case a naive check misses.

    Both sides are realpath'd, so a symlink *inside* the workspace pointing
    outside it is rejected — and the container's own agent can create one at
    any time."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("not yours")
    (tree / "escape").symlink_to(outside / "secret.txt")

    for rejected in ("", "   ", "../outside/secret.txt", str(outside / "secret.txt"), "escape"):
        with pytest.raises(InvalidPathError):
            resolve_within(tree, rejected)

    assert resolve_within(tree, "src/main.py") == (tree / "src" / "main.py").resolve()


def test_a_hidden_file_is_still_addressable_by_path(tree: Path):
    """Pruning is a listing rule, not an access rule: `AGENTS.md`-adjacent
    dotfiles are legitimately readable when the user names one."""
    assert resolve_within(tree, ".env").name == ".env"


def test_the_workspace_root_itself_is_not_a_file(tree: Path):
    with pytest.raises(InvalidPathError):
        resolve_within(tree, ".")


def test_a_nul_byte_is_rejected(tree: Path):
    """`ValueError` from the OS layer would be an unhandled 500; the path
    surface answers 400 for every unusable path in one place."""
    with pytest.raises(InvalidPathError):
        resolve_within(tree, "src/main\x00.py")


# ---------------------------------------------------------------------------
# Reading and sniffing
# ---------------------------------------------------------------------------


def test_text_is_clipped_and_says_so(tmp_path: Path):
    big = tmp_path / "big.txt"
    big.write_text("x" * 300)

    read = read_text(big, rel="big.txt", clip=100)

    assert read.truncated is True
    assert len(read.content) == 100
    assert read.mtime > 0


def test_undecodable_bytes_read_as_replacement_text(tmp_path: Path):
    """A file the agent wrote in another encoding must render as
    mostly-readable text, not as a 500."""
    binary = tmp_path / "weird.txt"
    binary.write_bytes(b"ok \xff\xfe end")

    assert "ok" in read_text(binary, rel="weird.txt").content


def test_content_types_are_sniffed_from_magic_bytes():
    """Never guessed from the extension: the extension is the agent's to
    choose, and a `.png` holding text would be served as an image the browser
    refuses to render."""
    assert sniff_content_type(b"\x89PNG\r\n\x1a\n rest") == "image/png"
    assert sniff_content_type(b"\xff\xd8\xff rest") == "image/jpeg"
    assert sniff_content_type(b"GIF89a rest") == "image/gif"
    assert sniff_content_type(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert sniff_content_type(b"%PDF-1.7") == "application/pdf"
    assert sniff_content_type(b"<svg xmlns='...'></svg>") == "image/svg+xml"
    assert sniff_content_type("hello".encode()) == files_module.TEXT_CONTENT_TYPE
    assert sniff_content_type(b"\x00\x01\x02\xff") == files_module.DEFAULT_CONTENT_TYPE


# ---------------------------------------------------------------------------
# Through the API
# ---------------------------------------------------------------------------


def test_the_file_surface_is_not_gated_on_the_execution_tier(api: Api):
    """A `local` project has files too.

    The old surface returned an empty list whenever the sandbox was off, which
    made the file panel look broken for exactly the tier that needs no
    container at all."""
    project = api.create_project(tier="local")
    session = api.create_session(project["id"])
    (Path(project["directory"]) / "note.md").write_text("hi")

    listed = api.http.get(f"/api/v1/sessions/{session['id']}/files").json()

    assert listed == {"files": [{"path": "note.md", "size": 2, "mtime": listed["files"][0]["mtime"]}]}


def test_reading_a_file_through_the_session(api: Api):
    project = api.create_project()
    session = api.create_session(project["id"])
    (Path(project["directory"]) / "src").mkdir()
    (Path(project["directory"]) / "src" / "main.py").write_text("print('hi')\n")

    read = api.http.get(
        f"/api/v1/sessions/{session['id']}/files/content",
        params={"path": "src/main.py", "mode": "text"},
    ).json()

    assert read["path"] == "src/main.py"
    assert read["content"] == "print('hi')\n"
    assert read["truncated"] is False
    assert read["mtime"] > 0


def test_raw_mode_returns_the_exact_bytes_with_a_sniffed_type(api: Api):
    from tests.test_sse import PNG_BYTES

    project = api.create_project()
    session = api.create_session(project["id"])
    (Path(project["directory"]) / "pixel.bin").write_bytes(PNG_BYTES)

    response = api.http.get(
        f"/api/v1/sessions/{session['id']}/files/content",
        params={"path": "pixel.bin", "mode": "raw"},
    )

    assert response.content == PNG_BYTES
    # Sniffed, not guessed from `.bin`.
    assert response.headers["content-type"] == "image/png"


def test_an_escaping_path_is_400_and_a_missing_one_is_404(api: Api, tmp_path: Path):
    project = api.create_project()
    session = api.create_session(project["id"])
    secret = tmp_path / "secret.txt"
    secret.write_text("not yours")
    os.symlink(secret, Path(project["directory"]) / "escape")

    for path in ("../secret.txt", str(secret), "escape", ""):
        response = api.http.get(
            f"/api/v1/sessions/{session['id']}/files/content", params={"path": path}
        )
        assert response.status_code == 400, path
        assert api.error(response)["code"] == "invalid_path", path

    missing = api.http.get(
        f"/api/v1/sessions/{session['id']}/files/content", params={"path": "nope.txt"}
    )
    assert missing.status_code == 404
    assert api.error(missing)["code"] == "unknown_file"


def test_a_project_directory_that_disappeared_lists_as_empty(api: Api):
    import shutil

    project = api.create_project()
    session = api.create_session(project["id"])
    shutil.rmtree(project["directory"])

    response = api.http.get(f"/api/v1/sessions/{session['id']}/files")

    assert response.status_code == 200
    assert response.json() == {"files": []}
