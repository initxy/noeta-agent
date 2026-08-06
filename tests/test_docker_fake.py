"""The fake docker's three states.

The fake is harness code, so it is pinned like product code — Phase 1 builds the
sandbox provider against it, and a fake that quietly answers wrong teaches the
provider the wrong lesson.
"""
from __future__ import annotations

import pytest

from tests._docker_fake import ABSENT, RUNNING, STOPPED, FakeDocker

IMAGE = "ghcr.io/agent-infra/sandbox:latest"
NAME = "noeta-sbx-p1"


def _run(docker: FakeDocker, name: str = NAME, port: int = 18080, **kwargs):
    return docker(
        [
            "docker", "run", "-d",
            "--name", name,
            "-p", f"127.0.0.1:{port}:8080",
            "-e", "SANDBOX_API_KEY",
            IMAGE,
        ],
        **kwargs,
    )


def test_the_three_states_are_distinct():
    """`running` / `stopped` / `absent` — never a boolean.

    `attach` needs the stopped-vs-absent distinction to choose between restoring
    the container and reporting it unrecoverable, and collapsing them makes both
    mistakes silent."""
    docker = FakeDocker()

    assert docker.state(NAME) == ABSENT
    _run(docker)
    assert docker.state(NAME) == RUNNING
    docker(["docker", "stop", NAME])
    assert docker.state(NAME) == STOPPED
    docker(["docker", "rm", "-f", NAME])
    assert docker.state(NAME) == ABSENT


def test_inspect_state_running_answers_all_three():
    """`docker inspect -f {{.State.Running}}` is how the provider reads the
    state: a non-zero exit is `absent`, `"true"` is running, anything else is
    stopped."""
    docker = FakeDocker()
    probe = ["docker", "inspect", "-f", "{{.State.Running}}", NAME]

    assert docker(probe).returncode != 0

    _run(docker)
    assert docker(probe).stdout.strip() == "true"

    docker(["docker", "stop", NAME])
    result = docker(probe)
    assert result.returncode == 0
    assert result.stdout.strip() == "false"


def test_start_restores_a_stopped_container_with_its_port():
    """A stop keeps the body, the write layer, the mounts and the port mapping,
    so the durable ref's base URL survives and resume is a restart rather than a
    rebuild."""
    docker = FakeDocker()
    _run(docker, port=18080)
    docker(["docker", "stop", NAME])

    assert docker(["docker", "start", NAME]).returncode == 0
    assert docker.state(NAME) == RUNNING
    assert docker.containers[NAME].host_port == 18080


def test_start_and_stop_on_an_absent_container_fail():
    docker = FakeDocker()

    assert docker(["docker", "start", NAME]).returncode != 0
    assert docker(["docker", "stop", NAME]).returncode != 0
    assert docker(["docker", "rm", NAME]).returncode != 0


def test_docker_port_goes_blind_when_the_container_stops():
    """The trap the reservation scan exists for: `docker port` reads
    `NetworkSettings.Ports`, which the daemon clears on stop even though
    `docker start` will restore the mapping exactly."""
    docker = FakeDocker()
    _run(docker, port=18080)

    assert docker(["docker", "port", NAME, "8080"]).stdout.strip() == "127.0.0.1:18080"

    docker(["docker", "stop", NAME])
    result = docker(["docker", "port", NAME, "8080"])

    assert result.returncode == 0
    assert result.stdout.strip() == ""


def test_port_bindings_still_report_a_stopped_container():
    """`HostConfig.PortBindings` is the static config laid down by
    `docker run -p`, which is exactly what `docker start` restores — so it is
    the only source that can stop a new allocation stealing the port a stopped
    session will come back on."""
    docker = FakeDocker()
    _run(docker, name="noeta-sbx-a", port=18080)
    _run(docker, name="noeta-sbx-b", port=18081)
    docker(["docker", "stop", "noeta-sbx-a"])

    listed = docker(
        ["docker", "ps", "-a", "--filter", "name=noeta-sbx-", "--format", "{{.Names}}"]
    ).stdout.split()
    assert listed == ["noeta-sbx-a", "noeta-sbx-b"]

    bindings = docker(
        [
            "docker", "inspect", "-f",
            "{{range $p, $conf := .HostConfig.PortBindings}}"
            "{{range $conf}}{{.HostPort}} {{end}}{{end}}",
            *listed,
        ]
    ).stdout.split()
    assert sorted(bindings) == ["18080", "18081"]


def test_ps_without_all_hides_stopped_containers():
    docker = FakeDocker()
    _run(docker, name="noeta-sbx-a", port=18080)
    docker(["docker", "stop", "noeta-sbx-a"])

    running = docker(
        ["docker", "ps", "--filter", "name=noeta-sbx-", "--format", "{{.Names}}"]
    ).stdout.split()

    assert running == []


def test_run_refuses_a_name_that_is_already_taken():
    """The daemon refuses, which is why the provider `rm -f`s a stale same-name
    container first. Modelling the refusal is what catches it if it stops."""
    docker = FakeDocker()
    _run(docker)

    result = _run(docker)

    assert result.returncode != 0
    assert "already in use" in result.stderr


def test_a_key_passed_by_name_is_read_from_the_subprocess_environment():
    """`-e SANDBOX_API_KEY` with no `=value`: the secret never enters the argv or
    the host process table, only the subprocess environment."""
    docker = FakeDocker()

    _run(docker, env={"SANDBOX_API_KEY": "s3cret", "PATH": "/usr/bin"})

    argv = docker.argv_for("run")[0]
    assert "-e" in argv and "SANDBOX_API_KEY" in argv
    assert not any("s3cret" in token for token in argv)
    assert docker.containers[NAME].env["SANDBOX_API_KEY"] == "s3cret"


def test_verbs_are_recorded_in_order():
    docker = FakeDocker()
    docker(["docker", "inspect", "-f", "{{.State.Running}}", NAME])
    docker(["docker", "rm", "-f", NAME])
    _run(docker)

    assert docker.verbs == ["inspect", "rm", "run"]


def test_failure_injection():
    """A failing `docker ps` must degrade to "nothing reserved" rather than
    blocking every allocation, so the harness has to be able to break one verb
    without breaking the rest."""
    docker = FakeDocker()
    docker.fail("ps")
    _run(docker)

    assert docker(["docker", "ps", "-a"]).returncode != 0
    assert docker(["docker", "port", NAME, "8080"]).returncode == 0


def test_readiness_is_a_property_of_the_container():
    docker = FakeDocker()
    _run(docker, port=18080)
    base_url = "http://127.0.0.1:18080"

    assert docker.probe(base_url) is True

    docker.containers[NAME].ready = False
    assert docker.probe(base_url) is False

    docker.containers[NAME].ready = True
    docker(["docker", "stop", NAME])
    assert docker.probe(base_url) is False


def test_an_unmodelled_command_is_a_loud_failure():
    docker = FakeDocker()

    with pytest.raises(AssertionError, match="unmodelled docker command"):
        docker(["docker", "logs", NAME])
