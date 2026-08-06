"""Workspace assembly: `AGENT.md` and the container-writable bit.

`AGENT.md` is a workaround for the absence of a per-project agent seam, and
the three properties that keep a workaround from becoming a liability are
pinned here: it is **idempotent** (clearing the configuration deletes the
file), it **never blocks a turn** (a write failure is logged, not raised), and
it **never destroys** a file it did not write.
"""
from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from noeta.agent.host import workspace
from noeta.agent.host.tiers import LOCAL, SANDBOX
from noeta.agent.store.projects import Project

AGENT_MD = workspace.AGENT_FILE_NAME


def make_project(
    directory: Path, *, tier: str = LOCAL, persona: str = "", name: str = "demo"
) -> Project:
    return Project(
        id="p1",
        name=name,
        directory=str(directory),
        tier=tier,
        persona=persona,
        default_model="",
        default_effort="",
        memory_enabled=False,
        version=1,
        created_at=0.0,
        updated_at=0.0,
    )


# ---------------------------------------------------------------------------
# What gets written
# ---------------------------------------------------------------------------


def test_the_persona_reaches_the_file(tmp_path: Path) -> None:
    workspace.assemble(make_project(tmp_path, persona="Answer only in haiku."))
    assert "Answer only in haiku." in (tmp_path / AGENT_MD).read_text()


def test_a_sandbox_project_gets_the_container_guidance(tmp_path: Path) -> None:
    """D3 moved this out of the system prompt: the prompt is compiled once for
    the whole process, so it cannot be tier-specific, and this file can."""
    workspace.assemble(make_project(tmp_path, tier=SANDBOX))
    text = (tmp_path / AGENT_MD).read_text()
    assert "container" in text
    assert "background shell" in text


def test_a_local_project_gets_no_tier_paragraph(tmp_path: Path) -> None:
    """Running against the real filesystem is what the model already assumes,
    so a paragraph restating it is context spent to change nothing."""
    workspace.assemble(make_project(tmp_path, tier=LOCAL, persona="Be brief."))
    text = (tmp_path / AGENT_MD).read_text()
    assert "Be brief." in text
    assert "container" not in text


def test_the_file_is_named_so_it_cannot_collide_with_the_sdks(tmp_path: Path) -> None:
    """`instructions_enabled` loads the workspace's own `AGENTS.md` (plural)
    from the same directory. Ours is singular, so the product never shadows the
    user's instruction file."""
    assert AGENT_MD == "AGENT.md"
    workspace.assemble(make_project(tmp_path, persona="x"))
    assert not (tmp_path / "AGENTS.md").exists()


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


def test_reassembling_unchanged_config_does_not_rewrite(tmp_path: Path) -> None:
    """The mtime is read by the file surface and the artifact panel. Rewriting
    an identical file on every turn makes an untouched file look freshly
    edited."""
    project = make_project(tmp_path, persona="Be brief.")
    workspace.assemble(project)
    path = tmp_path / AGENT_MD
    before = path.stat().st_mtime_ns
    os.utime(path, ns=(before, before))
    assert workspace.write_agent_md(tmp_path, workspace.render_agent_md(project)) is False
    assert path.stat().st_mtime_ns == before


def test_editing_the_persona_rewrites(tmp_path: Path) -> None:
    workspace.assemble(make_project(tmp_path, persona="First."))
    workspace.assemble(make_project(tmp_path, persona="Second."))
    text = (tmp_path / AGENT_MD).read_text()
    assert "Second." in text
    assert "First." not in text


def test_clearing_the_configuration_deletes_the_file(tmp_path: Path) -> None:
    """The whole point of idempotency here: a persona that was removed must not
    keep steering the agent from a file nobody remembers writing."""
    workspace.assemble(make_project(tmp_path, persona="Answer only in haiku."))
    assert (tmp_path / AGENT_MD).is_file()
    workspace.assemble(make_project(tmp_path, persona=""))
    assert not (tmp_path / AGENT_MD).exists()


def test_an_empty_local_project_never_creates_the_file(tmp_path: Path) -> None:
    workspace.assemble(make_project(tmp_path, tier=LOCAL, persona=""))
    assert not (tmp_path / AGENT_MD).exists()


def test_deleting_an_absent_file_is_not_a_change(tmp_path: Path) -> None:
    assert workspace.write_agent_md(tmp_path, "") is False


def test_switching_a_project_to_sandbox_adds_the_guidance(tmp_path: Path) -> None:
    workspace.assemble(make_project(tmp_path, tier=LOCAL, persona="Be brief."))
    assert "container" not in (tmp_path / AGENT_MD).read_text()
    workspace.assemble(make_project(tmp_path, tier=SANDBOX, persona="Be brief."))
    assert "container" in (tmp_path / AGENT_MD).read_text()


# ---------------------------------------------------------------------------
# Never destructive
# ---------------------------------------------------------------------------


def test_a_hand_written_agent_md_is_left_alone(tmp_path: Path) -> None:
    """A project directory is the user's real work. A product that silently
    overwrites a file there has broken the promise it is built on."""
    path = tmp_path / AGENT_MD
    path.write_text("# my own notes\n")
    workspace.assemble(make_project(tmp_path, persona="Answer only in haiku."))
    assert path.read_text() == "# my own notes\n"


def test_a_hand_written_agent_md_is_never_deleted(tmp_path: Path) -> None:
    path = tmp_path / AGENT_MD
    path.write_text("# my own notes\n")
    workspace.assemble(make_project(tmp_path, persona=""))
    assert path.read_text() == "# my own notes\n"


def test_generated_files_carry_the_marker(tmp_path: Path) -> None:
    workspace.assemble(make_project(tmp_path, persona="x"))
    assert (tmp_path / AGENT_MD).read_text().startswith(workspace.GENERATED_MARKER)


# ---------------------------------------------------------------------------
# Never blocking
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    os.name == "posix" and os.geteuid() == 0,
    reason="root ignores the mode, so nothing would be denied",
)
def test_a_read_only_directory_does_not_raise(tmp_path: Path) -> None:
    """A wayfinding file that could not be written is not a reason to refuse a
    turn that would otherwise have run."""
    directory = tmp_path / "locked"
    directory.mkdir()
    os.chmod(directory, 0o500)
    try:
        workspace.assemble(make_project(directory, persona="x"))
        assert not (directory / AGENT_MD).exists()
    finally:
        os.chmod(directory, 0o700)


def test_a_directory_where_the_file_should_be_does_not_raise(tmp_path: Path) -> None:
    (tmp_path / AGENT_MD).mkdir()
    workspace.assemble(make_project(tmp_path, persona="x"))
    assert (tmp_path / AGENT_MD).is_dir()


def test_an_uncreatable_project_directory_does_not_raise(tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("not a directory")
    workspace.assemble(make_project(blocker / "inside", persona="x"))


def test_a_missing_project_directory_is_created(tmp_path: Path) -> None:
    directory = tmp_path / "new" / "project"
    workspace.assemble(make_project(directory, persona="x"))
    assert (directory / AGENT_MD).is_file()


# ---------------------------------------------------------------------------
# The container-writable bit
# ---------------------------------------------------------------------------


@pytest.mark.skipif(os.name != "posix", reason="unix modes")
def test_a_sandbox_project_directory_is_world_writable(tmp_path: Path) -> None:
    """The AIO container runs as uid 1000 against a bind-mounted host
    directory. Without this the agent's first write fails from inside a tool,
    a long way from anything that explains it."""
    directory = tmp_path / "sandboxed"
    directory.mkdir(mode=0o755)
    workspace.assemble(make_project(directory, tier=SANDBOX))
    assert stat.S_IMODE(directory.stat().st_mode) == 0o777


@pytest.mark.skipif(os.name != "posix", reason="unix modes")
def test_a_local_project_directory_is_not_touched(tmp_path: Path) -> None:
    directory = tmp_path / "plain"
    directory.mkdir(mode=0o755)
    workspace.assemble(make_project(directory, tier=LOCAL))
    assert stat.S_IMODE(directory.stat().st_mode) == 0o755


def test_making_a_missing_directory_writable_does_not_raise(tmp_path: Path) -> None:
    workspace.make_container_writable(tmp_path / "absent")
