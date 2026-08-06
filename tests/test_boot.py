"""Booting: the product must come up on a machine that has nothing.

No `.env`, no `models.json`, no credentials, no Docker, no login. That is the
first-run promise, and it is the one thing a rewrite can break without anybody
noticing until a new machine tries it.
"""
from __future__ import annotations

import httpx
import pytest

from noeta.agent.config import VERSION, Settings
from noeta.agent.main import create_app


def test_boots_clean_room(monkeypatch, tmp_path, serve):
    """An empty working directory is a complete, working configuration.

    `Settings()` is built with its real `.env` lookup intact and simply finds
    nothing — which is exactly what `python -m noeta.agent` does on a fresh
    machine. `models.json` is missing too, so the model list degrades rather
    than the process failing."""
    monkeypatch.chdir(tmp_path)

    settings = Settings()

    assert settings.llm_provider == "auto"
    assert settings.effective_provider == "mock"
    assert settings.llm_api_key == ""

    server = serve(settings)
    with httpx.Client(base_url=server.base_url, timeout=10.0) as client:
        health = client.get("/api/v1/health").json()
        assert health["status"] == "ok"
        assert health["provider"] == "mock"
        assert health["version"] == VERSION
        payload = client.get("/api/v1/models").json()

    assert payload["provider"] == "mock"
    assert len(payload["models"]) == 1, "the fallback model list is exactly one model"


def test_health_reports_the_resolved_provider(http, live_server):
    """`provider` is what the process will actually talk to, not what was
    configured — the whole point is seeing at a glance that a machine with no
    credentials is on the offline mock rather than silently failing to reach a
    gateway.

    The key SET is compared as a whole: the SPA types this response with
    required fields, so a dropped key is a client-side type that lies, and an
    added one is wire surface nobody agreed to. The two machine-dependent
    values (`sandbox_available`, `data_dir`) are asserted by type and by
    provenance rather than by value — a developer with Docker running must not
    get a different verdict from one without."""
    response = http.get("/api/v1/health")

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "status",
        "version",
        "provider",
        "sandbox_available",
        "data_dir",
    }
    assert body["status"] == "ok"
    assert body["provider"] == "mock"
    assert body["version"] == VERSION
    assert isinstance(body["sandbox_available"], bool)
    assert body["data_dir"] == str(live_server.settings.data_path)
    # Never blank: an empty string would render as "mock · v" in the shell.
    assert VERSION


def test_auto_resolves_to_the_gateway_when_both_credentials_are_present(
    make_settings, serve
):
    settings = make_settings(
        llm_provider="auto",
        llm_base_url="https://gateway.example/api",
        llm_api_key="secret",
    )
    server = serve(settings)

    with httpx.Client(base_url=server.base_url, timeout=10.0) as client:
        assert client.get("/api/v1/health").json()["provider"] == "openai"


def test_explicit_gateway_without_credentials_fails_at_boot(make_settings):
    """`auto` degrading to the mock is the feature; naming the gateway and not
    supplying it is a typo, and failing at boot beats failing on the first turn."""
    settings = make_settings(llm_provider="openai", llm_base_url="", llm_api_key="")

    with pytest.raises(RuntimeError, match="LLM_PROVIDER=openai"):
        create_app(settings)


def test_unknown_api_path_404s_as_json(http):
    """The SPA fallback must never answer for `/api/…`.

    If it did, a typo in a fetch URL would return `index.html` with status 200
    and the client would parse HTML as data — a failure that looks like a
    parsing bug anywhere except where it is."""
    response = http.get("/api/v1/does-not-exist")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    # …and in the contract's envelope (§5.6), not FastAPI's `{"detail": …}`.
    # Every handler-raised error already is one; a client that needs a second
    # parser for "no such route" has two parsers for one API.
    assert response.json()["error"]["code"] == "unknown_endpoint"


def test_retired_keys_do_not_break_construction(monkeypatch):
    """`extra="ignore"` is load-bearing: a developer `.env` left over from the
    previous product must not stop the new one from booting. There is no global
    sandbox switch any more — the execution tier is a per-project property — so
    a stale `SANDBOX_ENABLED` is simply ignored rather than silently obeyed."""
    monkeypatch.setenv("SANDBOX_ENABLED", "true")
    monkeypatch.setenv("ADMIN_USERS", "someone")
    monkeypatch.setenv("SESSION_SECRET", "leftover")

    settings = Settings(_env_file=None)

    assert not hasattr(settings, "sandbox_enabled")
    assert not hasattr(settings, "admin_users")
    assert settings.effective_provider == "mock"
