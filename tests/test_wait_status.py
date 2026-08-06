"""`wait_status`: the helper the whole Phase 1 suite waits on.

A turn runs on an engine worker thread while the request that started it has
already returned, so no response means "the turn is over" — polling is the
honest way to wait. What is pinned here is the helper's failure mode and its
vocabulary; the send-then-idle turn shape it enables is exercised end to end in
`test_api_flow.py` (the `Api.send` helper).
"""
from __future__ import annotations

import pytest

from tests.conftest import SESSION_STATUSES, wait_status


def test_the_status_vocabulary_is_closed():
    """Exactly `idle` / `running` / `waiting`. Everything downstream — the
    composer's send/steer/stop states, the sidebar activity signals, the idle
    reaper's reclaim criterion — is a function of these three."""
    assert SESSION_STATUSES == {"idle", "running", "waiting"}


def test_an_unknown_expectation_fails_immediately(http):
    """A typo in an expected status must not be discovered fifteen seconds
    later, and must not read as "the session never got there"."""
    with pytest.raises(AssertionError, match="not session statuses"):
        wait_status(http, "s-1", "finished", timeout=0.1)


def test_a_timeout_reports_what_it_saw(http):
    """The message names the last observed state, so a session stuck in
    `waiting` and a session whose endpoint is not answering at all are
    distinguishable from the failure alone."""
    with pytest.raises(AssertionError, match="HTTP 404"):
        wait_status(http, "s-1", "idle", timeout=0.1, interval=0.01)
