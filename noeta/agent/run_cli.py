"""``noeta run`` — the headless one-shot entry point.

``python -m noeta.agent`` boots the interactive web server; this is its
non-interactive twin: one prompt, one working directory, one autonomous run to
a terminal ``TaskCompleted``, one JSON line on stdout. It exists so an external
harness (a coding benchmark, a CI check, a script) can drive the ``main`` agent
without the SSE server or a human at an approval prompt.

It is a thin wrapper over ``noeta.sdk.query()``, and it reuses the product's
own two seams rather than re-deriving them:

- **the provider** — ``noeta.agent.host.provider.build_provider(settings)``,
  so the gateway scars (base_url ``/v1`` trimming, Bearer mirroring, prompt-
  cache session affinity) live in exactly one place. Configure it with the same
  ``.env`` / environment variables the server reads.
- **the run recipe** — the three load-bearing settings ``build_client``
  documents: ``permission_mode="bypassPermissions"`` (nothing gated, so the
  driver never parks on an approval no one can answer), ``write_mode="apply"``
  (the SDK default ``"dry_run"`` makes every edit a silent no-op), and
  ``instructions_enabled``/``instructions_discovery`` (read the repo's
  ``AGENTS.md``).

Two deliberate departures from the interactive host, both required for an
unattended run:

- **``ask_user_question`` is stripped from the plugin set by default.** A
  benchmark task instruction is self-contained; the agent must not stop to ask.
  With one-shot ``query()`` (``multi_turn=False``) an unanswered question would
  surface as a ``QueryFailedError`` anyway — stripping the plugin makes that a
  non-event. ``--allow-questions`` restores it.
- **storage is in-memory by default.** A benchmark run is ephemeral and each
  invocation is one task; ``--storage-path`` opts into a durable record.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path
from typing import Any, Sequence

from noeta.agent.config import get_settings
from noeta.agent.host.provider import build_provider
from noeta.agent.models_config import get_default_model
from noeta.presets import main_options
from noeta.sdk import HostConfig, QueryFailedError, query


def _accumulate_usage(result: Sequence[Any]) -> dict[str, int]:
    """Total token usage across the run.

    Every LLM round trip records a ``LLMRequestFinished`` envelope whose
    ``payload.usage`` is a ``Usage`` (``uncached`` / ``cache_read`` /
    ``cache_write`` / ``output`` / ``reasoning_tokens``). Summing them is the
    whole cost picture; a run that somehow recorded none degrades to zeros
    rather than raising, which is the honest answer when the field is absent.
    """
    totals = {
        "uncached": 0,
        "cache_read": 0,
        "cache_write": 0,
        "output": 0,
        "reasoning_tokens": 0,
    }
    for env in result:
        usage = getattr(getattr(env, "payload", None), "usage", None)
        if usage is None:
            continue
        for key in totals:
            totals[key] += int(getattr(usage, key, 0) or 0)
    # `input` is the harbor/pi convention: everything the model read this run,
    # cached prefix included. Kept alongside the raw breakdown so the adapter's
    # `populate_context_post_run` can read one field.
    totals["input"] = totals["uncached"] + totals["cache_read"] + totals["cache_write"]
    return totals


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="noeta",
        description="Noeta headless agent runner.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser(
        "run",
        help="Run the main agent on one prompt in a working directory, headless.",
    )
    run.add_argument("prompt", help="The task instruction for the agent.")
    run.add_argument(
        "--workspace",
        type=Path,
        default=Path.cwd(),
        help="Working directory the agent's file/shell tools act on "
        "(default: current directory).",
    )
    run.add_argument(
        "--model",
        default=None,
        help="Model id (default: the configured default in models.json).",
    )
    run.add_argument(
        "--effort",
        default=None,
        help="Reasoning effort (low|medium|high|xhigh|max). Default: unset, so "
        "the engine picks. Pin it for a controlled, reproducible run — a "
        "benchmark that leaves effort unset scores at an uncontrolled depth.",
    )
    run.add_argument(
        "--storage-path",
        default=":memory:",
        help="Engine storage path; ':memory:' (default) keeps the run "
        "ephemeral, a file path records it durably.",
    )
    run.add_argument(
        "--allow-questions",
        action="store_true",
        help="Keep the ask_user_question tool enabled. Off by default so an "
        "unattended run never parks waiting for an answer.",
    )
    return parser


def _run_query(
    *,
    prompt: str,
    workspace: Path,
    model: str,
    effort: str | None,
    storage_path: str,
    allow_questions: bool,
    provider: Any,
) -> tuple[int, dict[str, Any]]:
    """Drive one headless run and return ``(exit_code, payload)``.

    Provider-injected and settings-free so the offline suite drives it with a
    ``FakeLLMProvider`` exactly as ``build_client`` does — the one parameter
    that separates a benchmark run from a test is the provider. ``main`` is the
    only place that reads the environment to build the real one.
    """
    base = main_options()
    plugins = base.plugins
    if not allow_questions:
        plugins = tuple(p for p in plugins if p != "ask_user_question")

    options = replace(
        base,
        permission_mode="bypassPermissions",
        can_use_tool=None,
        plugins=plugins,
        effort=effort if effort is not None else base.effort,
    )
    host_config = HostConfig(
        storage_path=storage_path,
        write_mode="apply",
        instructions_enabled=True,
        instructions_discovery=True,
    )

    workspace = workspace.expanduser().resolve()
    if not workspace.is_dir():
        return 2, {"error": f"workspace is not a directory: {workspace}"}

    try:
        result = query(
            options,
            prompt,
            provider=provider,
            workspace_dir=workspace,
            model=model,
            host_config=host_config,
        )
        answer = result.answer()
    except QueryFailedError as exc:
        # A run that did not reach a terminal (a failed provider turn, or a
        # question suspend under --allow-questions). A structured failure and a
        # non-zero exit so a harness scores it as a non-completion rather than
        # silently reading an empty answer.
        return 1, {
            "error": "query_failed",
            "status": exc.status,
            "reason": exc.reason,
            "task_id": exc.task_id,
        }

    return 0, {
        "answer": answer,
        "task_id": result.task_id,
        "model": model,
        "effort": effort,
        "usage": _accumulate_usage(result),
    }


def _run(args: argparse.Namespace) -> int:
    settings = get_settings()
    provider_build = build_provider(settings)
    model = args.model or get_default_model(settings).id

    exit_code, payload = _run_query(
        prompt=args.prompt,
        workspace=args.workspace,
        model=model,
        effort=args.effort,
        storage_path=args.storage_path,
        allow_questions=args.allow_questions,
        provider=provider_build.provider,
    )
    print(json.dumps(payload))
    return exit_code


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "run":
        return _run(args)
    return 2  # argparse's required subparser makes this unreachable.


if __name__ == "__main__":
    raise SystemExit(main())
