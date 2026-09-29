"""A fake `docker` CLI with **three** container states.

`running` / `stopped` / `absent` must not be collapsed into a boolean. The
distinction is the whole reason this file exists:

- `attach` on a **stopped** container must `docker start` it — the body, the
  write layer, the mounts and, critically, the **port mapping** all survive a
  stop, so restarting restores the same `base_url` and the session comes back.
- `attach` on an **absent** container must report it unrecoverable. A container
  gets its spec only at the `docker run` moment and `attach` holds nothing but
  the durable ref, so once removed it cannot be rebuilt.

A boolean forces one of those two into the other, and both mistakes are silent:
either a recoverable session is declared dead, or a dead one hangs waiting for a
container that will never answer.

The second reason for the three states is the port-reservation trap: a stopped
container binds no port, so a `bind(0)` probe cannot see it, but `docker start`
restores its original mapping exactly. `docker port` reads
`NetworkSettings.Ports` and goes **empty** the moment a container stops, which
is why the reservation scan has to read `HostConfig.PortBindings` instead. This
fake reproduces both behaviours; a fake that answered `docker port` for a
stopped container would hide the bug it exists to catch.

Usage: substitute for `subprocess.run`.

    docker = FakeDocker()
    docker.seed("noeta-sbx-p1", state=STOPPED, host_port=18080)
    monkeypatch.setattr(some_module, "_run", docker)

The readiness probe is the provider's other injected seam, and it is modelled
here too (`FakeDocker.readiness`) so a test expresses "this container never
comes up" as a property of the container rather than wiring a second fake.
"""
from __future__ import annotations

import shlex
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

RUNNING = "running"
STOPPED = "stopped"
ABSENT = "absent"

# Verbs the fake understands. An argv whose first recognised token is not one of
# these raises, so a provider reaching for an unmodelled verb is a loud failure
# rather than a silent empty result.
_VERBS = frozenset({"run", "start", "stop", "rm", "inspect", "port", "ps"})

_NO_SUCH_OBJECT = "Error response from daemon: No such object: {name}"
_NO_SUCH_CONTAINER = "Error response from daemon: No such container: {name}"
_NAME_IN_USE = (
    'Error response from daemon: Conflict. The container name "/{name}" is '
    "already in use"
)


@dataclass
class FakeContainer:
    """One container as the daemon would remember it."""

    name: str
    image: str = "ghcr.io/agent-infra/sandbox:latest"
    state: str = RUNNING
    # The published host port, i.e. the `-p 127.0.0.1:<host_port>:8080` value.
    # It is remembered across a stop, exactly as `HostConfig.PortBindings` is.
    host_port: int | None = None
    # `-e NAME=value` pairs. Note that `-e NAME` (no value) — how the sandbox
    # API key is passed, so it never lands in the argv — records the value read
    # from the subprocess environment, or None when it was not there.
    env: dict[str, str | None] = field(default_factory=dict)
    # `-v src:dst[:ro]` specs, verbatim.
    mounts: tuple[str, ...] = ()
    # Whether an HTTP readiness probe against this container would succeed.
    # Not a docker concept: the seam for the never-ready cases, where allocate
    # must reap the container it just started and a failed restart must leave it
    # stopped rather than removed.
    ready: bool = True
    # The `docker run` argv that created it, for argv assertions.
    run_argv: tuple[str, ...] = ()


@dataclass(frozen=True)
class DockerCall:
    """One invocation: the argv, and the environment it was handed."""

    argv: tuple[str, ...]
    env: dict[str, str] | None

    @property
    def verb(self) -> str:
        for token in self.argv:
            if token in _VERBS:
                return token
        return ""


class FakeDocker:
    """Stands in for `subprocess.run(["docker", …])`."""

    def __init__(self) -> None:
        self.containers: dict[str, FakeContainer] = {}
        self.calls: list[DockerCall] = []
        #: Every readiness probe attempt, as `(base_url, headers)`. Lets a test
        #: assert that the container credential rides on the probe as well as
        #: on the container itself.
        self.probe_calls: list[tuple[str, dict[str, str]]] = []
        #: The `ready` a `docker run` gives a freshly created container. Flip it
        #: to False for "allocate starts a container that never comes up",
        #: which cannot be expressed by seeding — the container does not exist
        #: until the run creates it.
        self.ready_by_default = True
        self._failures: dict[str, tuple[int, str]] = {}

    # -- inspection helpers ------------------------------------------------

    def state(self, name: str) -> str:
        """The three-state answer. `absent` is a state, not a missing value."""
        container = self.containers.get(name)
        return container.state if container else ABSENT

    @property
    def verbs(self) -> list[str]:
        """Every verb in call order — for asserting sequences such as "the
        first verb is `inspect` and the last two are `rm` then `run`"."""
        return [call.verb for call in self.calls]

    def argv_for(self, verb: str) -> list[tuple[str, ...]]:
        return [call.argv for call in self.calls if call.verb == verb]

    def container_at(self, host_port: int) -> FakeContainer | None:
        """Whichever container published `host_port`, stopped ones included —
        the reservation scan has to see them."""
        for container in self.containers.values():
            if container.host_port == host_port:
                return container
        return None

    # -- scenario setup ----------------------------------------------------

    def seed(self, name: str, **attrs: Any) -> FakeContainer:
        """Pre-create a container: a leftover from a crashed prior process, an
        idle-stopped one, or the reuse path's already-running one."""
        container = FakeContainer(name=name, **attrs)
        self.containers[name] = container
        return container

    def fail(self, verb: str, *, returncode: int = 1, stderr: str = "docker failed") -> None:
        """Make `verb` fail from now on. Used for "a failing `docker ps` must
        degrade to 'nothing reserved'" and for a failed `docker start`."""
        self._failures[verb] = (returncode, stderr)

    def probe(self, base_url: str) -> bool:
        """Whether a readiness probe against `base_url` would succeed.

        The provider polls `GET <base_url>/v1/sandbox`; this resolves that URL
        back to a container so a test can express "never becomes ready" as a
        property of the container rather than of a separate HTTP mock."""
        port = base_url.rstrip("/").rsplit(":", 1)[-1]
        if not port.isdigit():
            return False
        container = self.container_at(int(port))
        return bool(container and container.state == RUNNING and container.ready)

    @property
    def readiness(self) -> Callable[[str, Mapping[str, str]], bool]:
        """A probe in the shape the provider injects: `(base_url, headers)`.

        The provider polls with the container's auth headers, so recording the
        headers here is what lets a test assert the credential reaches the
        probe and not only the container."""

        def _probe(base_url: str, headers: Mapping[str, str] = {}) -> bool:
            self.probe_calls.append((base_url, dict(headers)))
            return self.probe(base_url)

        return _probe

    # -- the subprocess.run substitute -------------------------------------

    def __call__(self, argv: list[str] | tuple[str, ...], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        argv = tuple(argv)
        env = kwargs.get("env")
        call = DockerCall(argv=argv, env=dict(env) if env else None)
        self.calls.append(call)

        verb = call.verb
        if not verb:
            raise AssertionError(f"unmodelled docker command: {shlex.join(argv)}")
        if verb in self._failures:
            returncode, stderr = self._failures[verb]
            return self._result(argv, returncode, "", stderr)

        args = list(argv[argv.index(verb) + 1 :])
        handler = getattr(self, f"_do_{verb}")
        return handler(argv, args, call)

    # -- verbs -------------------------------------------------------------

    def _do_run(self, argv, args: list[str], call: DockerCall):
        name = _option(args, "--name")
        assert name, f"`docker run` without --name: {shlex.join(argv)}"
        if name in self.containers:
            # The real daemon refuses; the provider is expected to `rm -f` a
            # stale same-name container first, and this is what catches it if
            # it stops doing so.
            return self._result(argv, 125, "", _NAME_IN_USE.format(name=name))

        env: dict[str, str | None] = {}
        for spec in _options(args, "-e"):
            key, sep, value = spec.partition("=")
            # `-e NAME` with no `=value` means "read it from my environment" —
            # the credential never enters the argv or the host process table.
            env[key] = value if sep else (call.env or {}).get(key)

        container = FakeContainer(
            name=name,
            image=args[-1] if args else "",
            state=RUNNING,
            host_port=_published_port(args),
            env=env,
            mounts=tuple(_options(args, "-v")),
            ready=self.ready_by_default,
            run_argv=tuple(argv),
        )
        self.containers[name] = container
        return self._result(argv, 0, f"{name}-container-id\n", "")

    def _do_start(self, argv, args: list[str], call: DockerCall):
        name = _first_positional(args)
        container = self.containers.get(name)
        if container is None:
            return self._result(argv, 1, "", _NO_SUCH_CONTAINER.format(name=name))
        # `docker start` restores the published port mapping exactly, which is
        # why the durable base_url inside an exec_env_ref stays valid.
        container.state = RUNNING
        return self._result(argv, 0, f"{name}\n", "")

    def _do_stop(self, argv, args: list[str], call: DockerCall):
        name = _first_positional(args)
        container = self.containers.get(name)
        if container is None:
            return self._result(argv, 1, "", _NO_SUCH_CONTAINER.format(name=name))
        # Body, write layer, mounts and port bindings all survive.
        container.state = STOPPED
        return self._result(argv, 0, f"{name}\n", "")

    def _do_rm(self, argv, args: list[str], call: DockerCall):
        name = _first_positional(args)
        if name not in self.containers:
            return self._result(argv, 1, "", _NO_SUCH_CONTAINER.format(name=name))
        del self.containers[name]
        return self._result(argv, 0, f"{name}\n", "")

    def _do_inspect(self, argv, args: list[str], call: DockerCall):
        template = _option(args, "-f") or _option(args, "--format") or ""
        names = [a for a in args if not a.startswith("-") and a != template]
        if "State.Running" in template:
            render = lambda c: "true" if c.state == RUNNING else "false"  # noqa: E731
        elif "PortBindings" in template:
            # The static config laid down by `docker run -p`, which survives a
            # stop — unlike NetworkSettings.Ports, which `docker port` reads.
            render = lambda c: f"{c.host_port} " if c.host_port else ""  # noqa: E731
        else:
            raise AssertionError(f"unmodelled inspect template: {template!r}")

        lines: list[str] = []
        errors: list[str] = []
        for name in names:
            container = self.containers.get(name)
            if container is None:
                errors.append(_NO_SUCH_OBJECT.format(name=name))
                continue
            lines.append(render(container))
        stdout = "".join(f"{line}\n" for line in lines)
        return self._result(argv, 1 if errors else 0, stdout, "\n".join(errors))

    def _do_port(self, argv, args: list[str], call: DockerCall):
        name = _first_positional(args)
        container = self.containers.get(name)
        if container is None:
            return self._result(argv, 1, "", _NO_SUCH_CONTAINER.format(name=name))
        # Empty for a stopped container: this reads NetworkSettings.Ports, which
        # the daemon clears on stop even though the mapping will be restored.
        if container.state != RUNNING or container.host_port is None:
            return self._result(argv, 0, "", "")
        return self._result(argv, 0, f"127.0.0.1:{container.host_port}\n", "")

    def _do_ps(self, argv, args: list[str], call: DockerCall):
        include_stopped = "-a" in args or "--all" in args
        prefix = ""
        for spec in _options(args, "--filter"):
            key, _, value = spec.partition("=")
            if key == "name":
                prefix = value
        names = sorted(
            c.name
            for c in self.containers.values()
            if c.name.startswith(prefix) and (include_stopped or c.state == RUNNING)
        )
        return self._result(argv, 0, "".join(f"{n}\n" for n in names), "")

    @staticmethod
    def _result(argv, returncode: int, stdout: str, stderr: str):
        return subprocess.CompletedProcess(list(argv), returncode, stdout, stderr)


# --- argv parsing -----------------------------------------------------------


def _options(args: list[str], flag: str) -> list[str]:
    return [args[i + 1] for i, token in enumerate(args) if token == flag and i + 1 < len(args)]


def _option(args: list[str], flag: str) -> str | None:
    values = _options(args, flag)
    return values[0] if values else None


def _first_positional(args: list[str]) -> str:
    for token in args:
        if not token.startswith("-"):
            return token
    return ""


def _published_port(args: list[str]) -> int | None:
    """The host port out of `-p 127.0.0.1:<host>:8080` (or `-p <host>:8080`)."""
    for spec in _options(args, "-p"):
        parts = spec.split(":")
        if len(parts) >= 2 and parts[-2].isdigit():
            return int(parts[-2])
    return None
