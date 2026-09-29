"""`LocalDockerSandboxProvider` — the Local family of the `SandboxProvider` seam.

Drives the whole allocate → attach → stop_idle → release flow against the
three-state fake docker and its readiness probe: no daemon, no subprocess, no
socket. What is pinned here is the *wire the provider is coded against* plus the
handful of rules that were each learned the hard way — the credential never
entering the argv, the verb ordering, the two opposite failure paths (a failed
allocate reaps, a failed restart stops back), the project-keyed naming and its
refcounted release, and the stopped-container port reservation.
"""
from __future__ import annotations

import itertools
import subprocess
from collections.abc import Callable, Mapping
from typing import Any

import pytest
from noeta.sdk import MountSpec, SandboxSpec, encode_exec_env_ref

from noeta.agent.host.sandbox_provider import (
    CONTAINER_PREFIX,
    DockerSandboxError,
    LocalDockerSandboxProvider,
    container_id_from_ref,
)
from tests._docker_fake import RUNNING, STOPPED, FakeDocker

IMAGE = "img:latest"


@pytest.fixture(autouse=True)
def _no_ambient_sandbox_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """`SANDBOX_API_KEY` is not a `Settings` field, so the harness's env
    isolation does not strip it — yet the provider reads it straight off
    `os.environ` to decide whether to pass `-e SANDBOX_API_KEY` at all. A
    developer who actually runs a sandbox would otherwise change the baseline
    of every test in this file."""
    monkeypatch.delenv("SANDBOX_API_KEY", raising=False)


def _clock() -> Callable[[], float]:
    """A monotonic clock advancing 10s per read, so the 60s readiness deadline
    is reached in a handful of polls (the injected sleep is a no-op)."""
    counter = itertools.count(0.0, 10.0)
    return lambda: next(counter)


def _provider(
    docker: FakeDocker | Callable[..., "subprocess.CompletedProcess[str]"],
    *,
    probe: Callable[[str, Mapping[str, str]], bool] | None = None,
    pick_port: Callable[[], int] | None = None,
    **kwargs: Any,
) -> LocalDockerSandboxProvider:
    if probe is None:
        assert isinstance(docker, FakeDocker)
        probe = docker.readiness
    return LocalDockerSandboxProvider(
        image=IMAGE,
        run=docker,
        probe=probe,
        pick_port=pick_port or (lambda: 54321),
        sleep=lambda _seconds: None,
        monotonic=_clock(),
        **kwargs,
    )


def _spec(**kwargs: Any) -> SandboxSpec:
    return SandboxSpec(image=IMAGE, **kwargs)


# --------------------------------------------------------------------------
# 41 — the credential never enters the argv
# --------------------------------------------------------------------------


def test_the_api_key_rides_in_the_environment_and_never_in_the_argv(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Asserted three ways: the argv carries the NAME only, no token contains
    the secret, and the value reaches the subprocess environment. `docker run`
    lands in the host process table, so a `-e KEY=value` there is a credential
    leak to every other process on the machine."""
    monkeypatch.setenv("SANDBOX_API_KEY", "s3cr3t")
    docker = FakeDocker()
    provider = _provider(docker)

    handle = provider.allocate(
        "task-abc",
        _spec(
            mounts=(
                MountSpec(source="/host/ws", target="/workspace", mode="rw"),
                MountSpec(source="/opt/skills", target="/skills", mode="ro"),
            ),
            resources={"memory": "1g", "cpus": "2"},
        ),
    )

    assert handle.base_url == "http://127.0.0.1:54321"
    assert handle.sandbox_id == "noeta-sbx-task-abc"
    assert handle.workdir == "/workspace"
    assert handle.auth.connect_headers() == {"X-AIO-API-Key": "s3cr3t"}

    argv = docker.argv_for("run")[0]
    assert "-e" in argv and "SANDBOX_API_KEY" in argv
    assert not any("s3cr3t" in token for token in argv)
    assert docker.containers["noeta-sbx-task-abc"].env["SANDBOX_API_KEY"] == "s3cr3t"
    # The readiness probe is authenticated too — an unauthenticated 401 would
    # otherwise read as "not ready yet" for the whole 60s.
    assert docker.probe_calls[0] == (
        "http://127.0.0.1:54321",
        {"X-AIO-API-Key": "s3cr3t"},
    )


def test_run_argv_carries_the_name_port_mounts_and_resource_caps() -> None:
    docker = FakeDocker()
    provider = _provider(docker)

    provider.allocate(
        "task-abc",
        _spec(
            mounts=(
                MountSpec(source="/host/ws", target="/workspace", mode="rw"),
                MountSpec(source="/opt/skills", target="/skills", mode="ro"),
            ),
            resources={"memory": "1g", "cpus": "2"},
        ),
    )

    argv = docker.argv_for("run")[0]
    assert argv[argv.index("--name") + 1] == "noeta-sbx-task-abc"
    assert "127.0.0.1:54321:8080" in argv
    assert "/host/ws:/workspace" in argv
    assert "/opt/skills:/skills:ro" in argv
    assert argv[argv.index("--memory") + 1] == "1g"
    assert argv[argv.index("--cpus") + 1] == "2"
    # The AIO image's inner tooling needs syscalls the default profile blocks.
    assert "seccomp=unconfined" in argv
    assert argv[-1] == IMAGE
    # With no key configured the flag is absent entirely rather than passed
    # empty — an empty `-e SANDBOX_API_KEY` would make the container think it
    # has auth configured.
    assert "SANDBOX_API_KEY" not in argv


# --------------------------------------------------------------------------
# 42 — verb ordering
# --------------------------------------------------------------------------


def test_the_first_verb_is_inspect_and_the_last_two_are_rm_then_run() -> None:
    """`inspect` first because the reuse decision has to come before anything
    destructive; `rm` immediately before `run` because a leftover container of
    the same name makes the run fail on the name."""
    docker = FakeDocker()

    _provider(docker).allocate("task-abc", _spec())

    verbs = docker.verbs
    assert verbs[0] == "inspect"
    assert verbs[-2:] == ["rm", "run"]


def test_a_stale_same_name_container_is_removed_before_the_run() -> None:
    docker = FakeDocker()
    # A leftover from a crashed prior process: stopped, so the reuse path does
    # not take it, and it would collide on the name.
    docker.seed("noeta-sbx-p1", state=STOPPED, host_port=40000)

    handle = _provider(
        docker, resolve_container_id={"task-1": "p1"}.get, pick_port=lambda: 54321
    ).allocate("task-1", _spec())

    assert handle.base_url == "http://127.0.0.1:54321"
    assert docker.state("noeta-sbx-p1") == RUNNING
    assert len(docker.argv_for("run")) == 1


def test_a_failed_docker_run_raises() -> None:
    docker = FakeDocker()
    docker.fail("run")

    with pytest.raises(DockerSandboxError, match="docker run failed"):
        _provider(docker).allocate("task-abc", _spec())


# --------------------------------------------------------------------------
# 43 — a never-ready allocate raises AND reaps
# --------------------------------------------------------------------------


def test_a_never_ready_allocate_raises_and_reaps_what_it_started() -> None:
    """This call created the container, so keeping it is litter — and the next
    allocate would then have to `rm` it anyway. The opposite rule applies to a
    failed restart; see below."""
    docker = FakeDocker()
    docker.ready_by_default = False

    with pytest.raises(DockerSandboxError, match="did not become ready"):
        _provider(docker).allocate("task-abc", _spec())

    assert docker.state("noeta-sbx-task-abc") == "absent"


# --------------------------------------------------------------------------
# 44 — a never-ready restart raises and stops BACK, never removes
# --------------------------------------------------------------------------


def test_a_restart_that_never_comes_up_is_stopped_back_not_removed() -> None:
    """`attach` holds no `SandboxSpec`, so a removed container cannot be
    rebuilt and a transient failure would become permanent loss. Leaving it
    running-but-unreachable is worse still: the next attach would treat it as
    alive and every exec would return a confusing connection error."""
    docker = FakeDocker()
    provider = _provider(docker, resolve_container_id={"task-1": "p1"}.get)
    handle = provider.allocate("task-1", _spec())
    ref = encode_exec_env_ref(handle.base_url, handle.sandbox_id)
    provider.stop_idle("p1")
    docker.containers["noeta-sbx-p1"].ready = False
    docker.calls.clear()

    with pytest.raises(DockerSandboxError, match="did not become ready"):
        provider.attach(ref)

    assert docker.state("noeta-sbx-p1") == STOPPED
    assert "rm" not in docker.verbs


def test_a_failed_docker_start_also_leaves_the_container_stopped() -> None:
    docker = FakeDocker()
    provider = _provider(docker, resolve_container_id={"task-1": "p1"}.get)
    handle = provider.allocate("task-1", _spec())
    ref = encode_exec_env_ref(handle.base_url, handle.sandbox_id)
    provider.stop_idle("p1")
    docker.fail("start")

    with pytest.raises(DockerSandboxError, match="docker start failed"):
        provider.attach(ref)

    assert docker.state("noeta-sbx-p1") == STOPPED


# --------------------------------------------------------------------------
# 45 — attach on an absent container: rebuild when recoverable, else raise
# --------------------------------------------------------------------------


def test_attach_rebuilds_an_absent_container_when_the_workspace_is_recoverable() -> None:
    """The reaper's level 2 removes a long-idle container, yet every later turn
    resumes through `attach`. When the project's directory is recoverable, attach
    re-runs the container at the same name and port rather than declaring the
    session dead — the `/workspace` files survive on the host mount, only the
    write layer is gone."""
    docker = FakeDocker()
    provider = _provider(
        docker,
        resolve_container_id={"task-1": "p1"}.get,
        resolve_workspace_dir={"p1": "/host/ws"}.get,
    )
    handle = provider.allocate("task-1", _spec())
    ref = encode_exec_env_ref(handle.base_url, handle.sandbox_id)

    provider.force_release("p1")
    assert docker.state("noeta-sbx-p1") == "absent"
    docker.calls.clear()

    rebuilt = provider.attach(ref)

    # Same name and port, so the durable ref's base_url stays valid.
    assert rebuilt.base_url == handle.base_url
    assert rebuilt.sandbox_id == "noeta-sbx-p1"
    run_argv = docker.argv_for("run")[-1]
    assert "/host/ws:/workspace" in run_argv
    assert "127.0.0.1:54321:8080" in run_argv
    assert docker.state("noeta-sbx-p1") == RUNNING


def test_attach_on_an_absent_container_raises_when_the_workspace_is_unknown() -> None:
    """No workspace resolver (or a project the store does not know) is the
    genuinely unrecoverable case — a foreign ref or a deleted project. Rebuilding
    against a directory it cannot name is worse than a clear error."""
    docker = FakeDocker()
    ref = encode_exec_env_ref("http://127.0.0.1:54321", "noeta-sbx-gone")

    with pytest.raises(DockerSandboxError, match="cannot be rebuilt"):
        _provider(docker).attach(ref)
    # Nothing was run: the provider stops at the missing-workspace guard.
    assert "run" not in docker.verbs


def test_attach_rejects_a_ref_that_carries_no_sandbox_id() -> None:
    """A separate failure from "absent": a bare base_url is the shape an
    attach-one-shared-container backend produces, and this provider cannot
    name a container from it at all."""
    with pytest.raises(DockerSandboxError, match="no sandbox id"):
        _provider(FakeDocker()).attach("http://127.0.0.1:54321")


def test_attach_reconnects_to_a_running_container_without_restarting_it() -> None:
    docker = FakeDocker()
    provider = _provider(docker)
    handle = provider.allocate("task-abc", _spec())

    attached = provider.attach(
        encode_exec_env_ref(handle.base_url, handle.sandbox_id)
    )

    assert attached.base_url == handle.base_url
    assert attached.sandbox_id == handle.sandbox_id
    assert "start" not in docker.verbs


def test_container_id_from_ref_inverts_the_naming() -> None:
    ref = encode_exec_env_ref("http://127.0.0.1:54321", CONTAINER_PREFIX + "p1")

    assert container_id_from_ref(ref) == "p1"
    # A ref with no sandbox id decodes to the empty string, not an error.
    assert container_id_from_ref("http://127.0.0.1:54321") == ""


# --------------------------------------------------------------------------
# 46 — naming by the project, and reuse
# --------------------------------------------------------------------------


def test_two_root_tasks_of_one_project_share_a_container_and_one_docker_run() -> None:
    """Under D2 all sessions of a project share the project directory, so a
    second container would bind the same directory twice and let two agents
    fight over it."""
    docker = FakeDocker()
    provider = _provider(
        docker, resolve_container_id={"task-1": "p1", "task-2": "p1"}.get
    )

    first = provider.allocate("task-1", _spec())
    second = provider.allocate("task-2", _spec())

    assert first.sandbox_id == second.sandbox_id == "noeta-sbx-p1"
    assert second.base_url == first.base_url
    assert len(docker.argv_for("run")) == 1


def test_an_unresolvable_task_falls_back_to_a_per_task_container() -> None:
    """Allocation runs inside `seed_start`, before the task↔session binding is
    committed, so the resolver legitimately misses. A per-task container is
    wasteful and never wrong; sinking the turn would be neither."""
    docker = FakeDocker()

    handle = _provider(docker, resolve_container_id={}.get).allocate(
        "task-zzz", _spec()
    )

    assert handle.sandbox_id == "noeta-sbx-task-zzz"


def test_a_resolver_that_raises_also_degrades_to_the_task_id() -> None:
    def boom(_root_task_id: str) -> str:
        raise RuntimeError("store is down")

    handle = _provider(FakeDocker(), resolve_container_id=boom).allocate(
        "task-zzz", _spec()
    )

    assert handle.sandbox_id == "noeta-sbx-task-zzz"


def test_a_running_container_that_fails_the_probe_is_rebuilt() -> None:
    """Running is not the same as reachable. A half-dead container must be torn
    down and rebuilt rather than handed out — a handle to it would fail every
    single exec with a connection error."""
    docker = FakeDocker()
    docker.seed("noeta-sbx-p1", state=RUNNING, host_port=40000, ready=False)
    provider = _provider(
        docker, resolve_container_id={"task-1": "p1"}.get, pick_port=lambda: 54321
    )

    handle = provider.allocate("task-1", _spec())

    assert handle.base_url == "http://127.0.0.1:54321"
    assert len(docker.argv_for("run")) == 1


# --------------------------------------------------------------------------
# 47 — refcounted release
# --------------------------------------------------------------------------


def test_release_removes_only_when_the_last_root_lets_go() -> None:
    """The SDK calls release at ANY root task's terminal state. Removing on the
    first one would tear down a container the project's other conversations are
    still executing in."""
    docker = FakeDocker()
    provider = _provider(
        docker, resolve_container_id={"task-1": "p1", "task-2": "p1"}.get
    )
    provider.allocate("task-1", _spec())
    provider.allocate("task-2", _spec())

    provider.release("task-1")
    assert docker.state("noeta-sbx-p1") == RUNNING

    provider.release("task-2")
    assert docker.state("noeta-sbx-p1") == "absent"


def test_force_release_ignores_the_refcount_and_later_releases_are_no_ops() -> None:
    docker = FakeDocker()
    provider = _provider(
        docker, resolve_container_id={"task-1": "p1", "task-2": "p1"}.get
    )
    provider.allocate("task-1", _spec())
    provider.allocate("task-2", _spec())

    provider.force_release("p1")
    assert docker.state("noeta-sbx-p1") == "absent"

    # Idempotent: the per-root releases that follow must not raise.
    provider.release("task-1")
    provider.release("task-2")


def test_release_after_a_restart_falls_back_to_the_resolved_container() -> None:
    """The refcounts are in memory only. After a restart the resolver's answer
    is the fallback — containers are not reused across restarts anyway, so a
    leftover is stale by construction."""
    docker = FakeDocker()
    resolver = {"task-1": "p1"}.get
    _provider(docker, resolve_container_id=resolver).allocate("task-1", _spec())

    _provider(docker, resolve_container_id=resolver).release("task-1")

    assert docker.state("noeta-sbx-p1") == "absent"


# --------------------------------------------------------------------------
# 48 — after a restart the port is recovered, not re-picked
# --------------------------------------------------------------------------


def test_after_a_restart_the_port_comes_from_docker_port_not_a_new_pick() -> None:
    docker = FakeDocker()
    resolver = {"task-1": "p1", "task-2": "p1"}.get
    original = _provider(docker, resolve_container_id=resolver).allocate(
        "task-1", _spec()
    )

    # A new provider instance: the in-memory handles are gone, the container is
    # still up, and this instance would pick a different port if it rebuilt.
    revived = _provider(
        docker, resolve_container_id=resolver, pick_port=lambda: 60001
    ).allocate("task-2", _spec())

    assert revived.base_url == original.base_url == "http://127.0.0.1:54321"
    assert revived.sandbox_id == "noeta-sbx-p1"
    assert len(docker.argv_for("run")) == 1


# --------------------------------------------------------------------------
# 49 — stop_idle keeps the body and the port mapping
# --------------------------------------------------------------------------


def test_stop_idle_keeps_the_container_and_its_port_mapping() -> None:
    docker = FakeDocker()
    provider = _provider(docker, resolve_container_id={"task-1": "p1"}.get)
    provider.allocate("task-1", _spec())

    assert provider.stop_idle("p1") is True
    assert docker.state("noeta-sbx-p1") == STOPPED
    assert docker.containers["noeta-sbx-p1"].host_port == 54321


def test_stop_idle_answers_false_when_there_was_nothing_running() -> None:
    """The reaper reads the answer, so a False here is what keeps it from
    logging a reclamation that did not happen and from issuing empty stops."""
    docker = FakeDocker()
    provider = _provider(docker, resolve_container_id={"task-1": "p1"}.get)
    provider.allocate("task-1", _spec())

    assert provider.stop_idle("p1") is True
    assert provider.stop_idle("p1") is False
    assert provider.stop_idle("never-existed") is False


def test_attach_brings_a_stopped_container_back_at_the_same_url() -> None:
    """The mandatory continue-a-conversation path. `docker start` restores the
    port mapping exactly, so the base_url welded into the durable ref stays
    valid and there is no rebuild — which is what keeps in-container state."""
    docker = FakeDocker()
    provider = _provider(docker, resolve_container_id={"task-1": "p1"}.get)
    handle = provider.allocate("task-1", _spec())
    ref = encode_exec_env_ref(handle.base_url, handle.sandbox_id)
    provider.stop_idle("p1")

    attached = provider.attach(ref)

    assert attached.base_url == handle.base_url
    assert attached.sandbox_id == handle.sandbox_id
    assert docker.state("noeta-sbx-p1") == RUNNING
    assert docker.verbs.count("start") == 1
    assert len(docker.argv_for("run")) == 1


def test_live_handle_reports_the_running_container_without_probing() -> None:
    docker = FakeDocker()
    provider = _provider(docker, resolve_container_id={"task-1": "p1"}.get)
    provider.allocate("task-1", _spec())

    assert provider.live_handle("p1").base_url == "http://127.0.0.1:54321"

    provider.stop_idle("p1")
    assert provider.live_handle("p1") is None
    assert provider.live_handle("never-existed") is None


def test_live_handle_recovers_the_port_after_a_restart() -> None:
    docker = FakeDocker()
    resolver = {"task-1": "p1"}.get
    _provider(docker, resolve_container_id=resolver).allocate("task-1", _spec())

    revived = _provider(docker, resolve_container_id=resolver, pick_port=lambda: 60001)

    assert revived.live_handle("p1").base_url == "http://127.0.0.1:54321"


# --------------------------------------------------------------------------
# 50 — a new allocation must not steal a stopped container's port
# --------------------------------------------------------------------------


def test_a_new_allocation_skips_the_port_a_stopped_container_will_come_back_on(
) -> None:
    """A stopped container binds no port, so `bind(0)` cannot see it — but
    `docker start` restores the mapping exactly. Hand the port to a new
    container and the stopped project can never come back up."""
    docker = FakeDocker()
    ports = iter([54321, 54322])
    provider = _provider(
        docker,
        pick_port=lambda: next(ports),
        resolve_container_id={"task-1": "p1", "task-2": "p2"}.get,
    )
    first = provider.allocate("task-1", _spec())
    provider.stop_idle("p1")

    second = provider.allocate("task-2", _spec())

    assert first.base_url == "http://127.0.0.1:54321"
    assert second.base_url == "http://127.0.0.1:54322"
    # And the stopped project really does come back on its own port.
    ref = encode_exec_env_ref(first.base_url, first.sandbox_id)
    assert provider.attach(ref).base_url == "http://127.0.0.1:54321"


def test_the_reservation_scan_reads_port_bindings_not_docker_port() -> None:
    """`docker port` reads `NetworkSettings.Ports`, which the daemon clears the
    moment a container stops. Reading it here would report the stopped
    container as holding nothing and hand its port straight out."""
    docker = FakeDocker()
    ports = iter([54321, 54322])
    provider = _provider(
        docker,
        pick_port=lambda: next(ports),
        resolve_container_id={"task-1": "p1", "task-2": "p2"}.get,
    )
    provider.allocate("task-1", _spec())
    provider.stop_idle("p1")
    docker.calls.clear()

    provider.allocate("task-2", _spec())

    inspects = [argv for argv in docker.argv_for("inspect")]
    assert any("HostConfig.PortBindings" in " ".join(argv) for argv in inspects)
    assert "port" not in docker.verbs


def test_a_failing_docker_ps_degrades_to_nothing_reserved() -> None:
    """Better an unlikely port collision than one docker hiccup blocking every
    allocation."""
    docker = FakeDocker()
    docker.fail("ps")

    handle = _provider(docker).allocate("task-abc", _spec())

    assert handle.base_url == "http://127.0.0.1:54321"


def test_exhausting_the_port_retries_reports_clearly() -> None:
    """Ten collisions in a row means the port space is abnormal — say so rather
    than silently squatting on a reserved port."""
    docker = FakeDocker()
    docker.seed("noeta-sbx-p1", state=STOPPED, host_port=54321)

    with pytest.raises(DockerSandboxError, match="no free host port"):
        _provider(docker, resolve_container_id={"task-2": "p2"}.get).allocate(
            "task-2", _spec()
        )


# --------------------------------------------------------------------------
# 51 — the three states are not a boolean
# --------------------------------------------------------------------------


def test_attach_treats_stopped_and_absent_as_different_outcomes() -> None:
    """The whole reason the fake models three states. Collapsing them makes
    both mistakes silent: a recoverable session declared dead, or a dead one
    waiting on a container that will never answer. Here no workspace resolver is
    wired, so absent stays unrecoverable — the rebuild path is covered
    separately."""
    docker = FakeDocker()
    provider = _provider(docker, resolve_container_id={"task-1": "p1"}.get)
    handle = provider.allocate("task-1", _spec())
    ref = encode_exec_env_ref(handle.base_url, handle.sandbox_id)

    provider.stop_idle("p1")
    assert docker.state("noeta-sbx-p1") == STOPPED
    assert provider.attach(ref).base_url == handle.base_url  # restored

    provider.force_release("p1")
    assert docker.state("noeta-sbx-p1") == "absent"
    with pytest.raises(DockerSandboxError, match="cannot be rebuilt"):
        provider.attach(ref)


def test_a_docker_that_is_not_installed_never_escapes_the_teardown_paths() -> None:
    """`release` and `stop_idle` run on shutdown and on a background thread. A
    missing docker binary must not turn either into a crash."""

    def missing(_argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        raise FileNotFoundError("docker")

    provider = _provider(missing, probe=lambda _url, _headers: True)

    provider.release("task-1")
    provider.force_release("p1")
