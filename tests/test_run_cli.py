"""``noeta run`` — the headless one-shot CLI.

The three things this asserts are the three ways an unattended run silently
breaks:

- **edits must hit disk** — the SDK default ``write_mode="dry_run"`` makes every
  write a no-op, so a test that only checked the answer string would pass
  against a workbench that never wrote anything. The workspace file is the
  proof.
- **a non-completion must exit non-zero** — a harness scores the exit code; a
  failed run that exited 0 with an empty answer would read as a pass.
- **a question must not hang** — with ``ask_user_question`` stripped the agent
  cannot park waiting for input.

Provider-injected exactly like ``build_client``: the offline suite passes a
``FakeLLMProvider`` and never reaches a network.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from noeta.agent.run_cli import _accumulate_usage, _run_query, main
from noeta.sdk import LLMResponse, TextBlock, ToolUseBlock, Usage
from noeta.sdk.testing import FakeLLMProvider

MODEL = "opus4.8"


def _write_then_finish(file_name: str, content: str) -> FakeLLMProvider:
    """Call ``Write`` once, then finish with an answer.

    Routed on request *content* (has a tool call already happened?) rather than
    a positional cursor, mirroring ``tests/test_host_client.py``: the cursor of
    a scripted ``FakeLLMProvider`` races the moment the loop takes a variable
    number of rounds.
    """

    def responder(request: Any) -> LLMResponse:
        already_called = any(
            isinstance(block, ToolUseBlock) or getattr(block, "call_id", None)
            for message in getattr(request, "messages", ())
            for block in getattr(message, "content", ())
        )
        if already_called:
            return LLMResponse(
                stop_reason="end_turn",
                content=(TextBlock(text=f"Done: wrote {file_name}"),),
                usage=Usage(uncached=100, cache_read=5, output=20),
            )
        return LLMResponse(
            stop_reason="tool_use",
            content=(
                ToolUseBlock(
                    call_id="call-1",
                    tool_name="Write",
                    arguments={"file_path": file_name, "content": content},
                ),
            ),
            usage=Usage(uncached=50, output=10),
        )

    return FakeLLMProvider(responder=responder)


def _finish_immediately(text: str) -> FakeLLMProvider:
    return FakeLLMProvider(
        responder=lambda request: LLMResponse(
            stop_reason="end_turn",
            content=(TextBlock(text=text),),
            usage=Usage(uncached=42, output=7),
        )
    )


def test_run_writes_to_disk_and_reports_usage(tmp_path: Path) -> None:
    """A successful run edits the workspace and returns the answer + usage."""
    workspace = tmp_path / "ws"
    workspace.mkdir()

    exit_code, payload = _run_query(
        prompt="Create hello.txt containing hi",
        workspace=workspace,
        model=MODEL,
        effort=None,
        storage_path=":memory:",
        allow_questions=False,
        provider=_write_then_finish("hello.txt", "hi"),
    )

    assert exit_code == 0
    # write_mode="apply" is load-bearing: the file is the proof the edit was
    # not a dry-run no-op.
    assert (workspace / "hello.txt").read_text() == "hi"
    assert payload["answer"] == "Done: wrote hello.txt"
    assert payload["model"] == MODEL
    # effort defaults to unset (engine picks); echoed as None for the record.
    assert payload["effort"] is None
    # Usage summed across both LLMRequestFinished envelopes.
    assert payload["usage"]["output"] == 30  # 10 + 20
    assert payload["usage"]["input"] == 155  # (50) + (100 + 5)


def test_effort_is_pinned_and_echoed(tmp_path: Path) -> None:
    """A pinned --effort is echoed into the payload so a scored run records the
    depth it was measured at (unset effort scores at an uncontrolled depth)."""
    workspace = tmp_path / "ws"
    workspace.mkdir()

    exit_code, payload = _run_query(
        prompt="Create hello.txt containing hi",
        workspace=workspace,
        model=MODEL,
        effort="high",
        storage_path=":memory:",
        allow_questions=False,
        provider=_write_then_finish("hello.txt", "hi"),
    )

    assert exit_code == 0
    assert payload["effort"] == "high"


def test_accumulate_usage_totals_input_from_the_breakdown() -> None:
    """`input` is uncached + cache_read + cache_write, the harbor/pi field."""

    class _Payload:
        usage = Usage(uncached=30, cache_read=8, cache_write=2, output=5)

    class _Env:
        payload = _Payload()

    totals = _accumulate_usage([_Env(), _Env()])
    assert totals["output"] == 10
    assert totals["input"] == 80  # (30 + 8 + 2) * 2


def test_missing_workspace_exits_two(tmp_path: Path) -> None:
    exit_code, payload = _run_query(
        prompt="anything",
        workspace=tmp_path / "does-not-exist",
        model=MODEL,
        effort=None,
        storage_path=":memory:",
        allow_questions=False,
        provider=_finish_immediately("unused"),
    )
    assert exit_code == 2
    assert "workspace is not a directory" in payload["error"]


def test_a_provider_failure_exits_non_zero(tmp_path: Path) -> None:
    """A run that never reaches a terminal exits non-zero with a structured
    failure — never a 0 exit with an empty answer."""
    workspace = tmp_path / "ws"
    workspace.mkdir()

    def boom(request: Any) -> LLMResponse:
        raise RuntimeError("provider exploded")

    exit_code, payload = _run_query(
        prompt="anything",
        workspace=workspace,
        model=MODEL,
        effort=None,
        storage_path=":memory:",
        allow_questions=False,
        provider=FakeLLMProvider(responder=boom),
    )
    assert exit_code == 1
    assert payload["error"] == "query_failed"
    assert "answer" not in payload


def test_main_prints_json_and_returns_exit_code(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`main` wires argv → run and prints exactly one JSON line.

    The provider is stubbed at the seam `main` uses to reach the environment,
    so this exercises the real argparse + print path without a gateway.
    """
    workspace = tmp_path / "ws"
    workspace.mkdir()

    monkeypatch.setattr(
        "noeta.agent.run_cli.get_settings", lambda: object()
    )

    class _Build:
        provider = _finish_immediately("hi from main")

    monkeypatch.setattr(
        "noeta.agent.run_cli.build_provider", lambda settings: _Build()
    )

    exit_code = main(
        ["run", "say hi", "--workspace", str(workspace), "--model", MODEL]
    )

    assert exit_code == 0
    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert payload["answer"] == "hi from main"
    assert payload["model"] == MODEL
