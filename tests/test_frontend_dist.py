"""Locating the built SPA.

The resolver is tested, not the filesystem: the answer must be right in a wheel
install, where the repo-relative candidate does not exist and the anchor it is
derived from has degenerated into `site-packages`. A test that depends on the
real `web/dist` would pass here and say nothing about that case.
"""
from __future__ import annotations

import pytest

from noeta.agent import main


@pytest.fixture
def candidates(tmp_path, monkeypatch):
    """Redirect both lookup anchors into a temporary tree.

    `main` imports the two anchors by name, so patching them on `main` is what
    the resolver actually reads."""
    package_dir = tmp_path / "site-packages" / "noeta" / "agent"
    app_dir = tmp_path / "checkout"
    monkeypatch.setattr(main, "PACKAGE_DIR", package_dir)
    monkeypatch.setattr(main, "APP_DIR", app_dir)
    return package_dir / "static", app_dir / "web" / "dist"


def _build(directory) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "index.html").write_text("<!doctype html>", encoding="utf-8")


def test_package_relative_wins_over_the_repo_checkout(candidates):
    """Both present — a developer who ran `make web` inside an editable install
    of a wheel that already bundles a build. The bundled one is the one that
    matches the installed code."""
    packaged, checkout = candidates
    _build(packaged)
    _build(checkout)

    assert main._frontend_dist() == packaged


def test_falls_back_to_the_repo_checkout(candidates):
    """The editable-install case: nothing is bundled, `web/dist` is the build."""
    packaged, checkout = candidates
    _build(checkout)

    assert main._frontend_dist() == checkout


def test_no_build_at_all_is_not_an_error(candidates):
    """Booting must not require a built frontend — the backend is usable on its
    own and the browser gets told what to run."""
    assert main._frontend_dist() is None


def test_a_directory_without_index_html_does_not_count(candidates):
    """An empty or half-written `dist/` must fall through, not be mounted as a
    static root that 404s every page."""
    packaged, checkout = candidates
    packaged.mkdir(parents=True)
    _build(checkout)

    assert main._frontend_dist() == checkout
