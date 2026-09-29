"""`LocalDockerSandboxProvider` — one local Docker AIO Sandbox container per project.

The Local family of the SDK's `SandboxProvider` seam. The SDK owns the protocol,
the durable `exec_env_ref` weld and the reconnect-on-resume; the *runtime* owns
talking to an already-running container; **this module owns who runs `docker`**
— provisioning, naming, mounts, lifecycle and reclamation. That split is
deliberate: provisioning belongs to the deployment, and the library deliberately
ships no provisioner.

## The container's natural key is the PROJECT

All sessions of a project share the project directory as their workspace root,
so a per-session container would bind the same directory into N containers and
let them fight over it. `resolve_container_id` is therefore injected as
`root_task_id -> project id`; the container name is `"noeta-sbx-" + project_id`,
and `handle.sandbox_id` **is** that name.

Two consequences follow, and both are the caller's obligation rather than this
module's:

- The idle reaper's criterion is "no session of this project is running or
  waiting" — one busy session keeps the whole project's container alive. See
  `reaper.py`, which folds exactly that.
- **Session deletion must not call `force_release`.** Another session of the
  same project may still be using the container. Deleting a *project* is what
  releases it.

## Stop vs remove, and why they are not the same reclamation

A container gets its `SandboxSpec` — mounts, env, resource caps — only at the
`docker run` moment, and `attach` holds nothing but the durable ref. So the two
idle levels differ in cost, not just degree: `stop_idle` kills the processes and
hands memory and CPU back to the host while the container body, its write layer,
its mounts and *its port mappings* all survive, so `attach` restores it in
seconds with in-container state intact; the long-TTL `force_release` reclaims
disk, discarding the write layer.

After a `force_release`, `attach` can still bring the session back by *rebuilding*
the container (`_rebuild`) — but only its shape, not its contents. The two
inputs `docker run` needs beyond the deployment-fixed image/caps are both
recoverable: the project id is the container name minus the prefix, and the
project directory (the one `rw` workspace mount) comes from the injected
`resolve_workspace_dir`. So the `/workspace` files survive (they live on the host
mount), while the write layer — installed packages, `/tmp`, running processes —
is gone. When no workspace directory is recoverable (no resolver, or a ref from
another host / a deleted project), the rebuild cannot proceed and `attach`
raises.

The same asymmetry runs through the failure paths, and the two rules are
opposites on purpose:

- a failed **allocate** does `docker rm -f` — that call created the container,
  keeping it is litter;
- a failed **restart** does `docker stop` and **never** `rm` — a transient
  failure must not become permanent loss. Leaving it running-but-unreachable is
  worse still: the next attach would treat it as alive and every exec would
  return a confusing connection error.

## The port-reservation trap

A stopped container binds no port, so a `bind(0)` probe cannot see it — yet
`docker start` restores its original mapping exactly. Hand that port to a new
container and the stopped session can never come back. `allocate` therefore
excludes ports held by *any* container under this prefix, stopped ones included,
read from `HostConfig.PortBindings` (`docker port` reads
`NetworkSettings.Ports`, which the daemon clears the moment a container stops).

## Isolation

Process + mounted-FS only: the container sees the directories mounted in, not
the host root. It is not a full filesystem or network jail.
`--security-opt seccomp=unconfined` is the AIO image's own requirement — its
inner tooling needs syscalls the default seccomp profile blocks.

`run` / `probe` / `pick_port` / `sleep` / `monotonic` are all injected, so the
whole allocate → attach → stop → release flow is driven in tests against a fake
docker with no daemon, no sockets and no subprocess.
"""
from __future__ import annotations

import logging
import os
import socket
import subprocess
import threading
import time
from collections.abc import Callable, Mapping
from typing import Literal

import httpx
from noeta.sdk import (
    MountSpec,
    SandboxHandle,
    SandboxSpec,
    StaticApiKeyAuth,
    decode_exec_env_ref,
)

__all__ = [
    "CONTAINER_PREFIX",
    "DEFAULT_SANDBOX_IMAGE",
    "DockerSandboxError",
    "LocalDockerSandboxProvider",
    "container_id_from_ref",
]

_log = logging.getLogger(__name__)

#: The stock open-source AIO Sandbox image.
DEFAULT_SANDBOX_IMAGE = "ghcr.io/agent-infra/sandbox:latest"

#: Container name = `CONTAINER_PREFIX + container_id`, and that whole string is
#: `handle.sandbox_id`. `container_id_from_ref` strips the prefix back off, so
#: the two are one convention with two directions — change them together.
CONTAINER_PREFIX = "noeta-sbx-"

#: The single port every AIO service fronts inside the container.
_CONTAINER_PORT = 8080

#: The readiness endpoint: a 2xx here means the container's API is up.
_READY_PATH = "/v1/sandbox"

#: `docker inspect -f` template pulling the host ports out of a container's
#: **static** port bindings, one line per container. NOT `docker port`: that
#: reads `NetworkSettings.Ports`, which is empty the moment a container stops,
#: while `HostConfig.PortBindings` is the configuration `docker run -p` laid
#: down and `docker start` restores — which is exactly the port that must be
#: protected from a new container (see the module docstring).
_PORT_BINDINGS_FMT = (
    "{{range $p, $conf := .HostConfig.PortBindings}}"
    "{{range $conf}}{{.HostPort}} {{end}}{{end}}"
)

#: How many times `allocate` re-picks a host port before giving up. A collision
#: is low-probability; exhausting the retries means the port space is abnormal,
#: which is worth reporting rather than silently squatting.
_PORT_PICK_ATTEMPTS = 10

#: How long one readiness attempt waits before being counted a failure.
_PROBE_TIMEOUT_S = 2.0

#: The container's state on THIS machine. `absent` is a state, not a missing
#: value: `attach` has to tell "stopped, bring it back" from "gone, and a
#: local-Docker container cannot be reached from another machine".
ContainerState = Literal["running", "stopped", "absent"]

#: A `subprocess.run`-shaped callable, injected so tests fake docker.
DockerRunner = Callable[..., "subprocess.CompletedProcess[str]"]

#: `(base_url, headers) -> bool` — one readiness attempt, injected.
ReadinessProbe = Callable[[str, Mapping[str, str]], bool]


class DockerSandboxError(RuntimeError):
    """A `docker` provisioning, readiness or attach failure."""


def container_id_from_ref(exec_env_ref: str, *, prefix: str = CONTAINER_PREFIX) -> str:
    """Recover the container id (the project id) from a durable `exec_env_ref`.

    `sandbox_id == prefix + container_id`, so stripping the prefix inverts the
    naming. Returns `""` for a ref that carries no sandbox id — the shape an
    attach-one-shared-container backend produces."""
    _, sandbox_id = decode_exec_env_ref(exec_env_ref)
    return sandbox_id.removeprefix(prefix) if sandbox_id else ""


def _pick_free_port() -> int:
    """Bind an ephemeral loopback port, release it, and return the number.

    There is a small TOCTOU window — something else could take the port before
    `docker run` binds it — which surfaces as a `DockerSandboxError` the caller
    can retry. Good enough for a single-user local daemon."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _default_probe(base_url: str, headers: Mapping[str, str]) -> bool:
    """One readiness attempt: `GET <base_url>/v1/sandbox` → 2xx?

    `trust_env=False` is not a style choice. The container is addressed at
    127.0.0.1, and an ambient `HTTP(S)_PROXY` that routes a loopback call makes
    it hang rather than fail — which reads as "the container never became
    ready" for the full 60s timeout, on every allocate."""
    try:
        with httpx.Client(trust_env=False, timeout=_PROBE_TIMEOUT_S) as client:
            response = client.get(base_url + _READY_PATH, headers=dict(headers))
    except (httpx.HTTPError, OSError):
        return False
    return 200 <= response.status_code < 300


class LocalDockerSandboxProvider:
    """Provision per-project AIO containers on the local Docker daemon.

    `image` / `memory` / `cpus` / `extra_run_args` are the deployment-fixed
    `docker run` shape; the per-session mounts arrive on the `SandboxSpec` the
    SDK's manager assembles (it appends the workspace mount itself — do not add
    it here). `api_key_env` names the environment variable holding the
    container's key; the value is read at provisioning time, passed **by name**
    into `docker run`, and never recorded."""

    def __init__(
        self,
        *,
        image: str = DEFAULT_SANDBOX_IMAGE,
        api_key_env: str = "SANDBOX_API_KEY",
        memory: str | None = "2g",
        cpus: str | None = "2",
        workdir: str = "/workspace",
        container_prefix: str = CONTAINER_PREFIX,
        extra_run_args: tuple[str, ...] = ("--security-opt", "seccomp=unconfined"),
        docker_bin: str = "docker",
        health_timeout_s: float = 60.0,
        health_interval_s: float = 0.5,
        run: DockerRunner | None = None,
        probe: ReadinessProbe | None = None,
        pick_port: Callable[[], int] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        resolve_container_id: Callable[[str], str | None] | None = None,
        resolve_workspace_dir: Callable[[str], str | None] | None = None,
    ) -> None:
        self._image = image or DEFAULT_SANDBOX_IMAGE
        self._api_key_env = api_key_env
        self._memory = memory
        self._cpus = cpus
        self._workdir = workdir
        self._prefix = container_prefix
        self._extra_run_args = tuple(extra_run_args)
        self._docker = docker_bin
        self._health_timeout_s = health_timeout_s
        self._health_interval_s = health_interval_s
        self._run: DockerRunner = run or self._default_run
        self._probe: ReadinessProbe = probe or _default_probe
        self._pick_port = pick_port or _pick_free_port
        self._sleep = sleep
        self._monotonic = monotonic
        # root task id -> container id. Under D2 that is the PROJECT id, so
        # every session of a project lands in one container. A missing or
        # failing resolver degrades to the root task id: a per-task container,
        # which is wasteful but never wrong.
        self._resolve_container_id = resolve_container_id
        # container id (= project id) -> that project's directory on disk. The
        # one input `attach` needs to rebuild an absent container's workspace
        # mount, which the durable ref does not carry. `None` (unset, or a miss)
        # keeps `attach` on its hard-error path — see `_rebuild`.
        self._resolve_workspace_dir = resolve_workspace_dir
        self._lock = threading.Lock()
        #: root task id -> container id, written by allocate, read by release.
        self._cid_by_root: dict[str, str] = {}
        #: container id -> the root tasks referencing it. This IS the refcount.
        self._roots_by_cid: dict[str, set[str]] = {}
        #: container id -> live handle, so a project's later tasks skip the
        #: `docker port` recovery.
        self._handle_by_cid: dict[str, SandboxHandle] = {}

    # -- SandboxProvider --------------------------------------------------- #

    def allocate(self, root_task_id: str, spec: SandboxSpec) -> SandboxHandle:
        """Provision (or reuse) this project's container and return a live handle.

        The reuse path comes first because a project's second session must land
        in the *same* container: if one of that name is already running, take
        the cached handle — or, after a process restart, recover its host port
        with `docker port` and rebuild one — then **probe**. A probe that fails,
        or a port that cannot be recovered, means the container is stale or
        half-dead, so the call falls through and rebuilds."""
        container_id = self._container_id_for(root_task_id)
        name = self._container_name(container_id)
        headers = StaticApiKeyAuth(self._api_key_env).connect_headers()
        with self._lock:
            self._cid_by_root[root_task_id] = container_id
            self._roots_by_cid.setdefault(container_id, set()).add(root_task_id)
            cached = self._handle_by_cid.get(container_id)

        if self._is_running(name):
            handle = cached or self._recovered_handle(name)
            if handle is not None and self._probe(handle.base_url, headers):
                with self._lock:
                    self._handle_by_cid[container_id] = handle
                _log.info("reusing sandbox %s at %s", name, handle.base_url)
                return handle
            # Running, but unreachable or with an unrecoverable port mapping —
            # fall through and rebuild it.

        port = self._pick_unreserved_port()
        base_url = f"http://127.0.0.1:{port}"
        # Best-effort removal of a stale same-name container (a leftover from a
        # crashed prior process, or an idle-stopped one whose spec has since
        # changed) so `docker run` does not collide on the name.
        self._rm(name)
        result = self._run(
            self._run_argv(name=name, port=port, spec=spec),
            capture_output=True,
            text=True,
            check=False,
            env=self._run_env(),
        )
        if result.returncode != 0:
            raise DockerSandboxError(
                f"docker run failed for {name!r}: {result.stderr.strip()}"
            )
        self._await_ready(base_url, headers, name=name)
        _log.info("provisioned sandbox %s at %s", name, base_url)
        handle = self._handle(base_url, name)
        with self._lock:
            self._handle_by_cid[container_id] = handle
        return handle

    def release(self, root_task_id: str) -> None:
        """Reference-count decrement; only the container's LAST root removes it.

        The SDK calls release at *any* root task's terminal state, and under D2
        one container is shared by every session of a project — so removing on
        the first release would tear down a container other conversations are
        still using.

        After a process restart the counts are gone. Then the resolver's answer
        is the fallback: remove by resolved container id. Containers are not
        reused across restarts (shutdown's teardown backstop dismantles them),
        so a leftover is stale by construction."""
        with self._lock:
            container_id = self._cid_by_root.pop(root_task_id, None)
            if container_id is None:
                container_id = self._container_id_for(root_task_id)
            roots = self._roots_by_cid.get(container_id)
            if roots is not None:
                roots.discard(root_task_id)
                if roots:
                    return  # still referenced by another root task
            self._roots_by_cid.pop(container_id, None)
            self._handle_by_cid.pop(container_id, None)
        self._rm(self._container_name(container_id))

    def attach(self, exec_env_ref: str) -> SandboxHandle:
        """Reconnect to the container named by a durable ref.

        **This is the mandatory path for continuing a conversation**: from the
        second turn on the driver resumes rather than seeds, so it attaches and
        never allocates. "The container is stopped" therefore has to be
        recoverable rather than an error — `docker start` restores the port
        mapping exactly, so the `base_url` inside the ref needs no
        re-resolution.

        "The container is *absent*" is the harder case: the idle reaper's level
        2 removed it (or it is a foreign ref). When the workspace resolver can
        name this project's directory, `attach` rebuilds it at the same name and
        port — see `_rebuild`; the `/workspace` files survive on the host mount,
        only the container's own write layer is gone. When it cannot, the ref is
        genuinely unrecoverable here and the call raises."""
        base_url, sandbox_id = decode_exec_env_ref(exec_env_ref)
        if not sandbox_id:
            raise DockerSandboxError(
                f"exec_env_ref {exec_env_ref!r} carries no sandbox id to attach"
            )
        state = self._state(sandbox_id)
        if state == "absent":
            return self._rebuild(sandbox_id, base_url)
        if state == "stopped":
            self._restart(sandbox_id, base_url)
        return self._handle(base_url, sandbox_id)

    # -- product-side lifecycle (not part of the SDK protocol) ------------- #

    def force_release(self, container_id: str) -> None:
        """Remove the container outright, bypassing the refcount.

        Two callers: deleting a *project*, and the idle reaper's level 2. Never
        session deletion — under D2 a sibling session of the same project may
        still be using the container."""
        with self._lock:
            for root in self._roots_by_cid.pop(container_id, set()):
                self._cid_by_root.pop(root, None)
            self._handle_by_cid.pop(container_id, None)
        self._rm(self._container_name(container_id))

    def stop_idle(self, container_id: str) -> bool:
        """Idle reclamation, level 1: stop the container but keep it.

        The refcount is untouched — what stops is the container process, not
        the project↔container binding. Returns whether it actually stopped
        something, so the reaper neither logs a reclamation twice nor issues
        empty `docker stop`s against containers that are already down."""
        name = self._container_name(container_id)
        if self._state(name) != "running":
            return False
        # allocate and live_handle both probe before trusting the cache, so
        # keeping a handle to a stopped container would not cause misuse — but
        # there is no reason to keep it.
        with self._lock:
            self._handle_by_cid.pop(container_id, None)
        if not self._stop(name):
            return False
        _log.info("stopped idle sandbox %s (container kept for restart)", name)
        return True

    def live_handle(self, container_id: str) -> SandboxHandle | None:
        """This project's running container's handle, or `None` when there is none.

        No readiness probe: the caller (the preview surface's lazy-mount
        fallback) exposes unreachability itself. After a process restart,
        requeued tasks take the `attach` path and fire no allocate listener, so
        a live container can exist with nothing registered against it."""
        name = self._container_name(container_id)
        with self._lock:
            cached = self._handle_by_cid.get(container_id)
        if not self._is_running(name):
            return None
        return cached if cached is not None else self._recovered_handle(name)

    # -- helpers ----------------------------------------------------------- #

    def _container_id_for(self, root_task_id: str) -> str:
        """root task id → container id, total and never raising.

        A resolver that raises (a store read failing on an engine thread) or
        answers `None` (allocation runs inside `seed_start`, before the
        task↔session binding is committed) degrades to a per-task container.
        Wasteful, never wrong — and far better than sinking the turn."""
        if self._resolve_container_id is not None:
            try:
                resolved = self._resolve_container_id(root_task_id)
            except Exception:  # noqa: BLE001 - degrade to a per-task container
                _log.warning(
                    "resolve_container_id failed for %s", root_task_id, exc_info=True
                )
                resolved = None
            if resolved:
                return resolved
        return root_task_id

    def _container_name(self, container_id: str) -> str:
        # Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]; a project id is a uuid
        # hex string and a task id is `task-<hex>`, so both are already safe.
        return f"{self._prefix}{container_id}"

    def _handle(self, base_url: str, name: str) -> SandboxHandle:
        # `auth` is a live strategy, never a key: `StaticApiKeyAuth` reads the
        # environment at connect time, so the credential is never held on a
        # handle and never crosses into the durable ref.
        return SandboxHandle(
            base_url=base_url,
            sandbox_id=name,
            auth=StaticApiKeyAuth(self._api_key_env),
            workdir=self._workdir,
        )

    def _recovered_handle(self, name: str) -> SandboxHandle | None:
        """Rebuild a handle for a running container whose port we have to re-read.

        The path a process restart takes: the in-memory handles are gone but
        the container is still up, so the mapped host port comes back off
        `docker port` rather than being re-picked."""
        port = self._mapped_port(name)
        if port is None:
            return None
        return self._handle(f"http://127.0.0.1:{port}", name)

    def _mapped_port(self, name: str) -> int | None:
        """A *running* container's mapped host port, via `docker port`.

        Output looks like `127.0.0.1:32768`, possibly several lines; take the
        first. `None` when unparseable or empty — including for a stopped
        container, whose `NetworkSettings.Ports` the daemon has cleared."""
        result = self._run(
            [self._docker, "port", name, str(_CONTAINER_PORT)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        line = result.stdout.strip().splitlines()[0]
        try:
            return int(line.rsplit(":", 1)[1])
        except (IndexError, ValueError):
            return None

    def _run_argv(self, *, name: str, port: int, spec: SandboxSpec) -> list[str]:
        argv = [
            self._docker,
            "run",
            "-d",
            "--name",
            name,
            "-p",
            f"127.0.0.1:{port}:{_CONTAINER_PORT}",
        ]
        # The key is passed BY NAME only — `-e SANDBOX_API_KEY`, no `=value`.
        # Docker reads the value out of this process's environment (seeded in
        # `_run_env`), so the credential never lands in the argv or the host
        # process table. It still shows in `docker inspect`, which is accepted:
        # the container genuinely needs it, and that is a container-scoped
        # surface rather than the host command line.
        if os.environ.get(self._api_key_env):
            argv += ["-e", "SANDBOX_API_KEY"]
        for mount in spec.mounts:
            argv += ["-v", self._mount_arg(mount)]
        for key, value in spec.env.items():
            argv += ["-e", f"{key}={value}"]
        memory = spec.resources.get("memory", self._memory)
        cpus = spec.resources.get("cpus", self._cpus)
        if memory:
            argv += ["--memory", str(memory)]
        if cpus:
            argv += ["--cpus", str(cpus)]
        argv += list(self._extra_run_args)
        argv.append(spec.image or self._image)
        return argv

    def _run_env(self) -> dict[str, str] | None:
        """The subprocess environment for `docker run`, seeding the key by name.

        The configured variable may be spelled differently from the one the
        container expects, so the value is re-bound to `SANDBOX_API_KEY` here —
        which is what the `-e SANDBOX_API_KEY` pass-through then picks up.
        `None` when no key is configured, so the run simply inherits the
        ambient environment."""
        api_key = os.environ.get(self._api_key_env)
        if not api_key:
            return None
        return {**os.environ, "SANDBOX_API_KEY": api_key}

    @staticmethod
    def _mount_arg(mount: MountSpec) -> str:
        # Local docker expresses every mount as `-v source:target[:ro]`. `kind`
        # is transparent to `-v`; nas / pvc are a distributed-backend concern
        # and never reach here.
        arg = f"{mount.source}:{mount.target}"
        if mount.mode == "ro":
            arg += ":ro"
        return arg

    def _await_ready(
        self,
        base_url: str,
        headers: Mapping[str, str],
        *,
        name: str,
        reap_on_timeout: bool = True,
    ) -> None:
        """Poll readiness until it passes, or raise on timeout.

        `reap_on_timeout` is the difference between the two failure paths. A
        failed allocate reaps the container *it just created*. A failed restart
        must not — that container is the session's only one, and `attach` holds
        no `SandboxSpec` to rebuild it from; `_restart` stops it back instead."""
        deadline = self._monotonic() + self._health_timeout_s
        while self._monotonic() < deadline:
            if self._probe(base_url, headers):
                return
            self._sleep(self._health_interval_s)
        if reap_on_timeout:
            self._rm(name)
        raise DockerSandboxError(
            f"sandbox container {name!r} did not become ready at {base_url} "
            f"within {self._health_timeout_s:.0f}s"
        )

    def _restart(self, name: str, base_url: str) -> None:
        """`docker start` an idle-stopped container back into service.

        On any failure the container is left **stopped**, never removed: attach
        carries no spec, so removing it turns a possibly transient failure into
        permanent loss, and leaving it running-but-unreachable is worse — the
        next attach would treat it as alive."""
        result = self._run(
            [self._docker, "start", name],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            # The likeliest cause is the original host port having been taken
            # by something else; `allocate`'s reservation scan only protects it
            # from this machine's other sandbox containers.
            raise DockerSandboxError(
                f"docker start failed for idle-stopped {name!r}: "
                f"{result.stderr.strip()}"
            )
        headers = StaticApiKeyAuth(self._api_key_env).connect_headers()
        try:
            self._await_ready(base_url, headers, name=name, reap_on_timeout=False)
        except DockerSandboxError:
            self._stop(name)
            raise
        _log.info("restarted idle-stopped sandbox %s at %s", name, base_url)

    def _rebuild(self, name: str, base_url: str) -> SandboxHandle:
        """Re-`docker run` an absent container at its original name and port.

        The reaper's level 2 removes a long-idle container, and every later turn
        resumes through `attach` — so without this the session is dead. A rebuild
        is possible because the two things `docker run` needs beyond the
        deployment-fixed shape are both recoverable: the project id is the name
        with the prefix stripped, and its directory (the one `rw` workspace
        mount) comes from `resolve_workspace_dir`. A miss there — no resolver, or
        a project the store does not know — is the genuinely unrecoverable case
        (a foreign ref, or a deleted project), and it keeps the hard error.

        The port is **reused**, not re-picked: the durable ref welds `base_url`
        and the SDK trusts it across a resume, exactly as the `stopped` path
        relies on `docker start` restoring the mapping. A removed container has
        released its port, so it is normally free; if something else has taken
        it, `docker run` fails and the error surfaces rather than silently
        moving the container to a port the ref cannot name.

        Only `/workspace` survives (it is a host mount); the container's own
        write layer — installed packages, `/tmp`, running processes — is gone
        with the removed container. That is inherent to a rebuild, not a
        shortcoming of this path."""
        container_id = name.removeprefix(self._prefix)
        workspace = (
            self._resolve_workspace_dir(container_id)
            if self._resolve_workspace_dir is not None
            else None
        )
        if not workspace:
            raise DockerSandboxError(
                f"sandbox container {name!r} is gone and cannot be rebuilt: no "
                "workspace directory for it on this host (the container was "
                "reclaimed and its project is unknown here, or the ref is from "
                "another machine — a local-Docker container cannot be "
                "reconnected across hosts)"
            )
        try:
            port = int(base_url.rsplit(":", 1)[1])
        except (IndexError, ValueError) as exc:
            raise DockerSandboxError(
                f"cannot rebuild {name!r}: no port in base_url {base_url!r}"
            ) from exc
        spec = SandboxSpec(
            image=self._image,
            mounts=(
                MountSpec(source=workspace, target=self._workdir, mode="rw"),
            ),
        )
        # Best-effort removal of any half-dead same-name leftover so `docker run`
        # does not collide on the name — the same guard `allocate` uses.
        self._rm(name)
        result = self._run(
            self._run_argv(name=name, port=port, spec=spec),
            capture_output=True,
            text=True,
            check=False,
            env=self._run_env(),
        )
        if result.returncode != 0:
            raise DockerSandboxError(
                f"rebuild of absent sandbox {name!r} failed: {result.stderr.strip()}"
            )
        headers = StaticApiKeyAuth(self._api_key_env).connect_headers()
        self._await_ready(base_url, headers, name=name)
        _log.info("rebuilt reclaimed sandbox %s at %s", name, base_url)
        return self._handle(base_url, name)

    def _rm(self, name: str) -> None:
        """`docker rm -f`, best effort: a missing docker never raises here."""
        try:
            self._run(
                [self._docker, "rm", "-f", name],
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception as exc:  # noqa: BLE001 - daemon down / docker missing
            _log.warning("docker rm %s failed: %s", name, exc)

    def _stop(self, name: str) -> bool:
        """`docker stop`, keeping the container. Failure logs and returns False."""
        try:
            result = self._run(
                [self._docker, "stop", name],
                capture_output=True,
                text=True,
                check=False,
            )
        except Exception as exc:  # noqa: BLE001 - daemon down / docker missing
            _log.warning("docker stop %s failed: %s", name, exc)
            return False
        if result.returncode != 0:
            _log.warning("docker stop %s failed: %s", name, result.stderr.strip())
            return False
        return True

    def _state(self, name: str) -> ContainerState:
        """All three states from one `docker inspect -f {{.State.Running}}`.

        Container missing → non-zero exit; present → 0 plus `true` / `false`.
        Collapsing stopped and absent into one boolean makes both mistakes
        silent: either a recoverable session is declared dead, or a dead one
        waits on a container that will never answer."""
        result = self._run(
            [self._docker, "inspect", "-f", "{{.State.Running}}", name],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return "absent"
        return "running" if result.stdout.strip() == "true" else "stopped"

    def _is_running(self, name: str) -> bool:
        return self._state(name) == "running"

    def _pick_unreserved_port(self) -> int:
        """A host port that is neither bound nor statically reserved.

        See the module docstring: a stopped container binds no port, so the
        `bind(0)` probe cannot see it, yet `docker start` restores its original
        mapping. Grab that port and the stopped session can never come back."""
        reserved = self._reserved_ports()
        port = self._pick_port()
        for _ in range(_PORT_PICK_ATTEMPTS):
            if port not in reserved:
                return port
            port = self._pick_port()
        raise DockerSandboxError(
            f"no free host port after {_PORT_PICK_ATTEMPTS} attempts "
            f"(reserved by existing sandbox containers: {sorted(reserved)})"
        )

    def _reserved_ports(self) -> set[int]:
        """Host ports statically held by this machine's sandbox containers.

        A failed docker query is read as "nothing reserved": an unlikely port
        collision is a far better failure than one docker hiccup blocking every
        allocation."""
        names = self._sandbox_container_names()
        if not names:
            return set()
        result = self._run(
            [self._docker, "inspect", "-f", _PORT_BINDINGS_FMT, *names],
            capture_output=True,
            text=True,
            check=False,
        )
        # A container removed between `ps` and `inspect` makes the exit code
        # non-zero; the lines that did parse are still good, so use them.
        ports: set[int] = set()
        for token in result.stdout.split():
            try:
                ports.add(int(token))
            except ValueError:
                continue
        return ports

    def _sandbox_container_names(self) -> list[str]:
        """Every container under this prefix — `-a`, so stopped ones count."""
        result = self._run(
            [
                self._docker,
                "ps",
                "-a",
                "--filter",
                f"name={self._prefix}",
                "--format",
                "{{.Names}}",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return []
        return result.stdout.split()

    @staticmethod
    def _default_run(
        argv: list[str], **kwargs: object
    ) -> "subprocess.CompletedProcess[str]":
        return subprocess.run(argv, **kwargs)  # noqa: S603 - operator-configured
