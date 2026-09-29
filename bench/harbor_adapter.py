"""A harbor `BaseInstalledAgent` that drives Noeta's headless `noeta run` CLI.

Modelled on harbor's own `pi` agent
(`harbor-framework/harbor:src/harbor/agents/installed/pi.py`): install the CLI
into the sandbox, invoke it once with the task instruction, tee its output to
`/logs/agent/`, and parse token usage back out. The three abstract hooks a
`BaseInstalledAgent` requires — `install`, `run`, `populate_context_post_run` —
are all that is needed.

Two ways this differs from `pi`, both because Noeta reaches its model through a
gateway rather than a passthrough provider:

- **Credentials are gateway env, not a provider passthrough.** Noeta's provider
  is built from `LLM_BASE_URL` / `LLM_API_KEY` (see the product's
  `noeta/agent/host/provider.py`). The adapter forwards those into the sandbox
  on the `run` command — the single most common integration failure is install
  succeeding but `run` having no credentials.
- **The model id is not `provider/model`.** `pi` splits `--model` on the first
  `/` to recover a provider name. Noeta model ids can *contain* a slash, and the
  gateway — not a model prefix — decides routing, so the whole `-m` string is
  passed to `noeta run --model` verbatim.

Reference it from harbor without touching harbor's source:

    harbor run -d terminal-bench-2.0 -a bench.harbor_adapter:Noeta -m opus4.8
    harbor run -d swebench-verified  -a bench.harbor_adapter:Noeta -m opus4.8
"""
from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# Default model. harbor's -m overrides it; this is the default so a
# bare `-a bench.harbor_adapter:Noeta` runs the intended model.
_DEFAULT_MODEL = "opus4.8"

# The package to install into the sandbox. Two paths:
#   - NOETA_WHEEL=/abs/path/to/noeta_agent-*.whl  → upload that local wheel and
#     install it. This is how you benchmark UNRELEASED local code (`uv build
#     --wheel` produces it under dist/). Preferred until noeta-agent is on PyPI.
#   - otherwise install NOETA_AGENT_SPEC from the configured index (e.g.
#     "noeta-agent==0.6.0"). Only works once the package is published.
_LOCAL_WHEEL = os.environ.get("NOETA_WHEEL")
_PACKAGE_SPEC = os.environ.get("NOETA_AGENT_SPEC", "noeta-agent")

# Directory the uploaded wheel lands in inside the sandbox. The wheel keeps its
# original filename there — pip rejects a renamed wheel ("Invalid wheel
# filename") because it parses name-version-tags out of the filename itself.
_REMOTE_WHEEL_DIR = "/tmp/noeta_wheel"

# The working directory Noeta's file/shell tools act on inside the sandbox.
# Most task images use /app, but not all: a handful set a different WORKDIR
# (e.g. /workspace, /app/<subdir>), and pointing Noeta at a non-existent /app
# makes `noeta run` exit 1 ("workspace is not a directory") before the agent
# runs. harbor's own `pi` agent sidesteps this by never naming a directory — it
# execs in the container's default WORKDIR. We do the same: when NOETA_WORKSPACE
# is unset, resolve the workspace to the container's `pwd` at run time (the
# image's WORKDIR) rather than assuming /app. An explicit NOETA_WORKSPACE still
# overrides, for an environment that puts the task somewhere the shell can't
# infer.
_WORKSPACE = os.environ.get("NOETA_WORKSPACE")  # None → use the container's pwd

_OUTPUT_FILENAME = "noeta.json"

# Where install() records the absolute path of the `noeta` entry point it ended
# up with, for run() to read back. On a Python >=3.12 image this is just
# `noeta` on PATH; on an older image (SWE-bench's are conda envs on Python
# 3.9–3.11) install() provisions a private 3.12 environment and writes that
# env's `noeta` path here instead. Decoupling install from run through a file
# keeps run() from having to re-derive which interpreter won.
_REMOTE_BIN_MARKER = "/tmp/noeta_bin"

# The product's model catalogue (`models.json`) declares each model's real
# context_window / max_output_tokens. It is NOT bundled into the wheel (it is
# gitignored — it carries deployment-specific ids), so a bare install inside the
# sandbox has no catalogue and `noeta run` degrades every model to conservative
# fallbacks (context 200000, max_output 16384). That silently caps the model's
# output far below the product (the gateway model is 128000), depressing scores
# on tasks that
# need a long answer/edit. To measure the product's real capability, upload the
# catalogue and point the CLI at it via MODELS_CONFIG. Set NOETA_MODELS_CONFIG
# to the local file; unset → the fallbacks apply and a warning is logged.
# The catalogue is pure model metadata (no api_key/url), so uploading it into a
# throwaway container leaks nothing.
_MODELS_CONFIG = os.environ.get("NOETA_MODELS_CONFIG")
_REMOTE_MODELS_CONFIG = "/tmp/noeta_models.json"

# Reasoning effort passed to `noeta run --effort`. Unset means the engine picks
# its own depth — fine for a smoke, but a *scored* run should pin this so the
# number is reproducible and not measured at an uncontrolled (often low) depth.
# Set NOETA_EFFORT=high (or xhigh/max) for a scored run.
_EFFORT = os.environ.get("NOETA_EFFORT")


def _proxy_env() -> dict[str, str]:
    """HTTP(S) proxy vars to forward into the sandbox.

    The container has no proxy of its own: dockerd's proxy only covers image
    pulls, not processes inside the container. Without this, pip reaches
    pythonhosted.org over a slow NAT path (measured ~25x slower — a 400 KB wheel
    took 19 s vs 0.8 s via proxy), so installing noeta-agent's dependency tree
    (psycopg[binary], agent-sandbox, …) blows past harbor's agent-setup timeout.

    Two rewrites make a host proxy usable *inside* a container:

    - A loopback proxy (``127.0.0.1``/``localhost`` — common for a local proxy
      like clash on :7897) is meaningless in the container, where loopback is
      the container itself: pip gets ``Connection refused``. Rewrite it to
      ``NOETA_PROXY`` when set, else drop it so pip falls back to direct egress.
    - ``NO_PROXY`` is carried so the in-container LLM gateway call (an internal
      host) still bypasses the proxy.

    ``NOETA_PROXY`` lets the operator name a container-reachable proxy
    explicitly (e.g. a corp relay ``http://<proxy-host>:<port>``); it overrides
    whatever loopback value the shell exports.
    """
    override = os.environ.get("NOETA_PROXY")
    env: dict[str, str] = {}

    def _fix(value: str) -> str | None:
        if override:
            return override
        if "127.0.0.1" in value or "localhost" in value:
            # Loopback is unreachable from inside the container; without an
            # override, better to go direct than to hang on a dead proxy.
            return None
        return value

    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        raw = os.environ.get(key)
        if not raw:
            continue
        fixed = _fix(raw)
        if fixed:
            env[key] = fixed

    for key in ("NO_PROXY", "no_proxy"):
        value = os.environ.get(key)
        if value:
            env[key] = value
    return env


class Noeta(BaseInstalledAgent):
    """Noeta as a harbor installed agent."""

    @staticmethod
    def name() -> str:
        return "noeta"

    def get_version_command(self) -> str | None:
        return "noeta --help >/dev/null 2>&1 && echo noeta-installed"

    def parse_version(self, stdout: str) -> str:
        # The CLI has no --version; report a stable marker rather than a number.
        return stdout.strip().splitlines()[-1].strip() if stdout.strip() else "unknown"

    async def install(self, environment: BaseEnvironment) -> None:
        """Install the `noeta` CLI into the sandbox.

        This harbor build's `BaseInstalledAgent` has no `ensure_system_
        dependencies` helper; the documented path is `exec_as_root` for system
        packages and `exec_as_agent` for user-level installs. So we best-effort
        `apt-get` python3 + pip + ripgrep as root (tolerating an image that
        already has them or has no apt), then install the package.
        `--no-cache-dir` keeps the layer small and avoids a stale wheel across
        reruns. ripgrep is required because noeta-sdk >=0.6.9 shells Grep/Glob
        out to `rg`.

        Package source: a local wheel (NOETA_WHEEL) uploaded into the sandbox
        when set — the path that benchmarks unreleased code — else the
        NOETA_AGENT_SPEC index install.
        """
        proxy = _proxy_env()
        await self.exec_as_root(
            environment,
            command=(
                # python3 + pip for the install below, and ripgrep because
                # noeta-sdk >=0.6.9 shells Grep/Glob out to `rg` — without it
                # those tools fail loud and the agent loses file search. Task
                # images generally ship neither; apt-get best-effort covers the
                # common Debian/Ubuntu base, tolerating an image that has them
                # already or has no apt.
                "need=''; "
                "command -v python3 >/dev/null && python3 -m pip --version >/dev/null 2>&1 || need=\"$need python3 python3-pip\"; "
                "command -v rg >/dev/null || need=\"$need ripgrep\"; "
                "if [ -z \"$need\" ]; then echo 'python3+pip+rg present'; "
                "elif command -v apt-get >/dev/null; then "
                "apt-get update && apt-get install -y $need; "
                "else echo \"no apt-get; missing:$need (relying on preinstalled)\"; fi"
            ),
            env=proxy,
        )

        if _LOCAL_WHEEL:
            wheel_path = Path(_LOCAL_WHEEL).expanduser().resolve()
            if not wheel_path.is_file():
                raise RuntimeError(f"NOETA_WHEEL does not exist: {wheel_path}")
            # Keep the wheel's original filename in the sandbox — pip parses
            # name/version/tags out of it and rejects a renamed wheel.
            remote_wheel = f"{_REMOTE_WHEEL_DIR}/{wheel_path.name}"
            await self.exec_as_agent(
                environment,
                command=f"mkdir -p {shlex.quote(_REMOTE_WHEEL_DIR)}",
            )
            await environment.upload_file(wheel_path, remote_wheel)
            target = shlex.quote(remote_wheel)
        else:
            target = shlex.quote(_PACKAGE_SPEC)

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                # noeta-agent requires Python >=3.12. Task images vary:
                #  - TB2 images are mostly Python 3.13, so `python3` works.
                #  - SWE-bench images are conda envs on Python 3.9–3.11, where a
                #    bare `python3 -m pip install` fails ("requires a different
                #    Python: 3.11.x not in '>=3.12'"). There, provision a private
                #    3.12 with `uv` (pip-installed with the image's own python)
                #    and install into a uv venv. uv is used rather than
                #    `conda create -n … python=3.12` because conda's solver peaks
                #    well over the trial container's 4 GB cap and gets OOM-killed;
                #    uv downloads a prebuilt CPython and stays comfortably under.
                # Whichever path wins, write the resulting `noeta` entry point's
                # absolute path to a marker file for run() to read. The agent's
                # own shell tools keep using the container's native python (we
                # never touch PATH), so a SWE-bench verifier still tests against
                # the image's original interpreter.
                #
                # --break-system-packages: some Debian images mark the system
                # Python PEP 668 externally-managed; the sandbox is a throwaway
                # container so overriding is safe. Images without the marker
                # ignore it.
                'pyver=$(python3 -c "import sys;print(sys.version_info[:2]>=(3,12))" 2>/dev/null || echo False); '
                'if [ "$pyver" = "True" ]; then '
                f"  python3 -m pip install --no-cache-dir --break-system-packages {target} && "
                '  bin=$(command -v noeta); '
                "else "
                # Older image: pip-install uv with the image's own python, have
                # uv fetch a prebuilt 3.12 and build a venv, install into it.
                '  python3 -m pip install --no-cache-dir --break-system-packages uv >/dev/null 2>&1 || python3 -m pip install --no-cache-dir uv >/dev/null 2>&1; '
                '  UV=$(command -v uv || echo "$(python3 -c "import sys,os;print(os.path.dirname(sys.executable))")/uv"); '
                '  "$UV" python install 3.12 >/dev/null 2>&1; '
                '  "$UV" venv /opt/noeta312 --python 3.12 >/dev/null 2>&1 && '
                f'  "$UV" pip install --python /opt/noeta312/bin/python --no-cache-dir {target} && '
                '  bin=/opt/noeta312/bin/noeta; '
                "fi; "
                f'printf "%s" "$bin" > {shlex.quote(_REMOTE_BIN_MARKER)}; '
                '"$bin" --help >/dev/null'
            ),
            env=proxy,
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        """Invoke `noeta run` once and tee its JSON to the logs directory.

        The gateway credentials are read from the harbor process environment
        (the same `LLM_BASE_URL` / `LLM_API_KEY` the product server reads) and
        forwarded into the sandbox. `noeta run` writes edits to `_WORKSPACE`
        with `write_mode="apply"` and prints one JSON line the post-run hook
        parses.
        """
        model = self.model_name or _DEFAULT_MODEL

        # Proxy first, then gateway creds. NO_PROXY (carried by _proxy_env)
        # keeps the internal LLM_BASE_URL call off the proxy; any other egress
        # (e.g. a skill fetch) goes through it.
        env: dict[str, str] = _proxy_env()
        for key in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_REQUEST_TIMEOUT"):
            value = self._get_env(key)
            if value is not None:
                env[key] = value

        # Upload the product's model catalogue and point the CLI at it, so the
        # gateway model runs at its real max_output_tokens / context window
        # instead of the sandbox fallback's 16384 / 200000. Without it, long-answer tasks
        # are capped and score low for a reason that is config, not capability.
        if _MODELS_CONFIG:
            catalogue = Path(_MODELS_CONFIG).expanduser().resolve()
            if not catalogue.is_file():
                raise RuntimeError(f"NOETA_MODELS_CONFIG does not exist: {catalogue}")
            await environment.upload_file(catalogue, _REMOTE_MODELS_CONFIG)
            env["MODELS_CONFIG"] = _REMOTE_MODELS_CONFIG

        # Workspace: an explicit NOETA_WORKSPACE wins; otherwise use the
        # container's own working directory (`"$(pwd)"`, the image's WORKDIR) so
        # a task whose WORKDIR is not /app still lands the agent on real files.
        # The shell expands $(pwd) inside the container at run time — do not
        # shell-quote it, or it would be passed to noeta run literally.
        workspace_arg = shlex.quote(_WORKSPACE) if _WORKSPACE else '"$(pwd)"'
        effort_arg = f"--effort {shlex.quote(_EFFORT)} " if _EFFORT else ""
        # install() recorded which `noeta` to use (PATH's, or a private 3.12
        # env's on an older image) in the marker file; fall back to PATH's.
        command = (
            f'NOETA_BIN=$(cat {shlex.quote(_REMOTE_BIN_MARKER)} 2>/dev/null || echo noeta); '
            f'"$NOETA_BIN" run {shlex.quote(instruction)} '
            f"--workspace {workspace_arg} "
            f"--model {shlex.quote(model)} "
            f"{effort_arg}"
            f"2>&1 | tee /logs/agent/{_OUTPUT_FILENAME}"
        )
        await self.exec_as_agent(environment, command=command, env=env)

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Read token usage from the CLI's JSON output.

        `noeta run` prints `{"answer", "task_id", "model", "usage"}`; the tee
        above may prepend tool/log lines, so scan for the last parseable object
        carrying a `usage` key rather than assuming a single clean line. A run
        that produced no parseable usage leaves the context counters at their
        defaults — best-effort, exactly as `pi` tolerates a missing field.
        """
        output_file = self.logs_dir / _OUTPUT_FILENAME
        if not output_file.exists():
            return

        usage: dict[str, Any] | None = None
        for line in output_file.read_text().splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict) and "usage" in payload:
                usage = payload["usage"]

        if not isinstance(usage, dict):
            return

        context.n_input_tokens = int(usage.get("input", 0) or 0)
        context.n_output_tokens = int(usage.get("output", 0) or 0)
        context.n_cache_tokens = int(usage.get("cache_read", 0) or 0)
