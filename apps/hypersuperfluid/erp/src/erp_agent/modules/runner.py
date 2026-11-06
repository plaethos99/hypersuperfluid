"""Install or update a module on a test database with its tests, then read Odoo's log into a short report."""

from __future__ import annotations

import contextlib
import os
import re
import subprocess
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from erp_agent.config import CommandRunner, DockerComposeRunner, ModuleRunner
from erp_agent.errors import ConnectorError

_LOG_LINE = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2},[0-9]+ [0-9]+ "
    r"(?P<level>[A-Z]+) (?P<db>\S+) (?P<logger>\S+): "
)
_SUMMARY = re.compile(r"(\d+) failed, (\d+) error\(s\) of (\d+) tests")
_MAX_BLOCK = 4000
_MAX_BLOCKS = 15
_TAIL_LINES = 40
# After a timeout: how long to wait for the output pipes once the command is stopped. A process the command started
# (a Docker container, a grandchild) can hold them open long after; the run is abandoned rather than waited for.
_DRAIN_S = 10.0


@dataclass
class TestReport:
    """What happened when the module was installed with its tests."""

    passed: bool
    exit_code: int
    tests: int | None = None
    failed: int | None = None
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    tail: str = ""
    command: str = ""


def build_command(runner: ModuleRunner, module: str, workspace: Path) -> tuple[list[str], dict[str, str], Path | None]:
    """@param runner: Configured runner.
    @param module: Module to install or update.
    @param workspace: Workspace root (mounted as the addons directory for Docker).
    @returns: argv, extra environment, working directory."""
    match runner:
        case DockerComposeRunner():
            # PYTHONDONTWRITEBYTECODE: the workspace is mounted into the container, so Python would otherwise leave
            # __pycache__ folders in the client's addons repository. The container gets its own name so a run that
            # outlives its timeout can be removed (stopping `docker compose` does not stop the container).
            argv = [
                "docker", "compose", "-f", str(runner.compose_file), "run", "--rm", "-T",
                "--name", f"superfluid-test-{uuid.uuid4().hex[:12]}",
                "-e", "PYTHONDONTWRITEBYTECODE=1", runner.service,
                "odoo", "-d", runner.database, "-i", module, "-u", module, "--test-enable",
                "--test-tags", f"/{module}", "--stop-after-init", "--log-level=info",
            ]  # fmt: skip
            return argv, {"SUPERFLUID_ADDONS": str(workspace)}, runner.compose_file.parent
        case CommandRunner():
            argv = [part.replace("{module}", module).replace("{database}", runner.database) for part in runner.argv]
            return argv, {"SUPERFLUID_ADDONS": str(workspace)}, runner.cwd


def parse_log(log: str, module: str) -> tuple[list[str], list[str], int | None, int | None]:
    """Collect error blocks (with their tracebacks), relevant warnings and the test summary from an Odoo log.

    @param log: Combined output of the Odoo process.
    @param module: Module under test; its own warnings are reported.
    @returns: (error blocks, warnings, tests run, tests failed or errored)."""
    errors: list[str] = []
    warnings: list[str] = []
    tests = failed = None
    block: list[str] | None = None
    for line in log.splitlines():
        match = _LOG_LINE.match(line)
        if match is None:
            if block is not None:
                block.append(line)
            continue
        if block is not None:
            errors.append("\n".join(block)[:_MAX_BLOCK])
            block = None
        level, logger = match["level"], match["logger"]
        message = line[match.end() :]
        summary = _SUMMARY.search(message)
        if summary:  # one summary per test phase (at_install, post_install): add them up
            failed = (failed or 0) + int(summary[1]) + int(summary[2])
            tests = (tests or 0) + int(summary[3])
        if level in ("ERROR", "CRITICAL"):
            block = [f"{logger}: {message}"]
        elif level == "WARNING" and (
            f"addons.{module}" in logger
            or "no access rules" in message
            or "invalid module names" in message
            or module in message
        ):
            warnings.append(f"{logger}: {message}"[:500])
    if block is not None:
        errors.append("\n".join(block)[:_MAX_BLOCK])
    return errors[:_MAX_BLOCKS], warnings[:_MAX_BLOCKS], tests, failed


def _abandon(process: subprocess.Popen[str], argv: list[str]) -> None:
    """Stop a test run that outlived its timeout: the command, its named Docker container if it has one (stopping
    `docker compose run` leaves the container running, holding the database and the output pipes), and the wait
    for output after a short grace period."""
    process.kill()
    if "--name" in argv:
        name = argv[argv.index("--name") + 1]
        # The run is reported as stopped either way; a container left behind exits on its own.
        with contextlib.suppress(OSError, subprocess.TimeoutExpired):
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=60, check=False)  # noqa: S607
    # If something still holds the pipes, leave them to subprocess's daemon reader threads: closing a pipe a thread
    # is reading blocks (on Windows) until that read returns, which is the wait being abandoned.
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.communicate(timeout=_DRAIN_S)


def run_tests(
    runner: ModuleRunner, module: str, workspace: Path, environ: Mapping[str, str] | None = None
) -> TestReport:
    """Install or update `module` with tests enabled and report the result.

    @param runner: Configured runner.
    @param module: Module name.
    @param workspace: Workspace root.
    @param environ: Base environment; defaults to the process environment.
    @returns: The report; `passed` needs exit code 0, no errors in the log and no failed tests.
    @raises ConnectorError: When the command cannot start or exceeds its timeout."""
    argv, extra, cwd = build_command(runner, module, workspace)
    env = {**(os.environ if environ is None else environ), **extra}
    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as exc:
        raise ConnectorError(f"cannot run {argv[0]}: is it installed and on PATH? ({exc})") from exc
    try:
        stdout, stderr = process.communicate(timeout=runner.timeout_s)
    except subprocess.TimeoutExpired as exc:
        _abandon(process, argv)
        raise ConnectorError(
            f"the test run exceeded {runner.timeout_s:.0f} s and was stopped; a test that hangs (waiting for a lock, "
            "a browser tour, an endless loop) is the usual cause"
        ) from exc
    log = stdout + "\n" + stderr
    errors, warnings, tests, failed = parse_log(log, module)
    if f"invalid module names, ignored: {module}" in log or f"module {module}: not installable" in log:
        errors.insert(0, f"Odoo did not find {module} in its addons path; check the workspace mount")
    tail = "\n".join(log.strip().splitlines()[-_TAIL_LINES:])
    return TestReport(
        passed=process.returncode == 0 and not errors and not failed,
        exit_code=process.returncode,
        tests=tests,
        failed=failed,
        errors=errors,
        warnings=warnings,
        tail=tail,
        command=" ".join(argv),
    )
