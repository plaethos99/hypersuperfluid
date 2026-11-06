"""Module service: every module tool goes through here and is written to the audit log.

Writing files changes the workspace only; Git keeps every earlier state. Committing, discarding and pushing are
the steps that need the person's Submit in Superfluid (approval gate `submitTools`).
"""

from __future__ import annotations

import io
import re
import zipfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any

from erp_agent.audit import AuditLog, AuditRecord
from erp_agent.config import AppConfig
from erp_agent.errors import ErpAgentError, QueryRejected
from erp_agent.modules.checks import check_module
from erp_agent.modules.runner import TestReport, run_tests
from erp_agent.modules.scaffold import ScaffoldRequest, scaffold
from erp_agent.modules.workspace import Workspace, check_module_name

TestRunner = Callable[..., TestReport]
_BRANCH = r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$"
# Git pathspecs that keep Python bytecode (left by a test run in the mounted workspace) out of diffs and commits.
NOT_BYTECODE = (":(exclude,glob)**/__pycache__/**", ":(exclude,glob)**/*.pyc")


class ModuleService:
    """Python module work over the configured workspaces."""

    def __init__(
        self,
        config: AppConfig,
        audit: AuditLog,
        test_runner: TestRunner = run_tests,
        redact: Callable[[str], str] = str,
    ) -> None:
        """@param config: Validated configuration.
        @param audit: Audit log.
        @param test_runner: Runs module tests (replaced in tests).
        @param redact: Removes secrets from error messages."""
        self._config = config
        self._audit = audit
        self._run_tests = test_runner
        self._redact = redact

    @contextmanager
    def _audited(self, tool: str, **params: object) -> Iterator[AuditRecord]:
        try:
            with self._audit.record(tool, **params) as record:
                yield record
        except ErpAgentError as exc:
            message = self._redact(str(exc))
            if message == str(exc):
                raise
            raise type(exc)(message) from exc

    def workspace(self, name: str) -> Workspace:
        """@raises QueryRejected: When no such workspace is configured."""
        config = self._config.modules.workspaces.get(name)
        if config is None:
            known = ", ".join(sorted(self._config.modules.workspaces)) or "none"
            raise QueryRejected(f"unknown module workspace {name!r}; configured: {known}")
        return Workspace(name, config)

    def workspaces(self) -> list[dict[str, Any]]:
        """@returns: Configured workspaces with their modules."""
        rows = []
        for name, config in sorted(self._config.modules.workspaces.items()):
            ws = Workspace(name, config)
            rows.append(
                {
                    "name": name,
                    "description": config.description,
                    "odoo_version": config.odoo_version,
                    "modules": ws.modules(),
                    "can_test": config.runner is not None,
                    "can_push": config.push_remote is not None,
                }
            )
        return rows

    def list_files(self, workspace: str, module: str | None) -> list[str]:
        """@returns: Files of one module or of every module."""
        return self.workspace(workspace).files(module)

    def read_file(self, workspace: str, path: str) -> str:
        """@returns: One file's text."""
        with self._audited("odoo_module_read_file", workspace=workspace, path=path):
            return self.workspace(workspace).read(path)

    def write_file(self, workspace: str, path: str, content: str) -> dict[str, Any]:
        """Create or replace one file; the previous version stays in Git until committed over."""
        with self._audited("odoo_module_write_file", workspace=workspace, path=path, chars=len(content)):
            ws = self.workspace(workspace)
            ws.require_repository()
            existed = ws.write(path, content)
            return {"path": path, "action": "replaced" if existed else "created"}

    def scaffold(self, workspace: str, request: ScaffoldRequest) -> dict[str, Any]:
        """Write a new module skeleton.

        @raises QueryRejected: When the module directory already exists."""
        with self._audited("odoo_module_scaffold", workspace=workspace, module=request.module) as rec:
            ws = self.workspace(workspace)
            ws.require_repository()
            check_module_name(request.module)
            if (ws.root / request.module).exists():
                raise QueryRejected(
                    f"{request.module} already exists in {workspace}; edit it with odoo_module_write_file"
                )
            files = scaffold(request, ws.config.odoo_version, ws.config.author, ws.config.license)
            for path, content in files.items():
                ws.write(path, content)
            rec.row_count = len(files)
            report = check_module(ws.root, request.module, ws.config.odoo_version)
            return {"module": request.module, "files": sorted(files), **self._findings(report.findings)}

    @staticmethod
    def _findings(findings: Any) -> dict[str, Any]:
        return {"ok": not findings.errors, "errors": findings.errors, "warnings": findings.warnings}

    def check(self, workspace: str, module: str) -> dict[str, Any]:
        """Run the static checks on one module."""
        with self._audited("odoo_module_check", workspace=workspace, module=module) as rec:
            ws = self.workspace(workspace)
            report = check_module(ws.root, check_module_name(module), ws.config.odoo_version)
            rec.row_count = len(report.findings.errors)
            return {
                "module": module,
                "files_checked": report.files_checked,
                "new_models": sorted(report.new_models),
                **self._findings(report.findings),
            }

    def test(self, workspace: str, module: str) -> dict[str, Any]:
        """Check, then install or update the module on the workspace's test database with its tests.

        @raises QueryRejected: When the static checks fail or no runner is configured."""
        with self._audited("odoo_module_test", workspace=workspace, module=module) as rec:
            ws = self.workspace(workspace)
            if ws.config.runner is None:
                raise QueryRejected(f"workspace {workspace} has no runner; add one to run tests (see dev/odoo-docker)")
            report = check_module(ws.root, check_module_name(module), ws.config.odoo_version)
            if report.findings.errors:
                raise QueryRejected(
                    "fix the static check errors before installing:\n- " + "\n- ".join(report.findings.errors)
                )
            result = self._run_tests(ws.config.runner, module, ws.root)
            rec.extra["passed"] = result.passed
            rec.row_count = result.tests
            return {"module": module, **asdict(result)}

    def diff(self, workspace: str, module: str | None) -> dict[str, Any]:
        """@returns: Uncommitted changes (Git status and diff, new files included as additions)."""
        ws = self.workspace(workspace)
        scope = [check_module_name(module)] if module else []
        ws.git("add", "--intent-to-add", "--", *(scope or ["."]), *NOT_BYTECODE)
        status = ws.git("status", "--short", "--", *(scope or ["."]), *NOT_BYTECODE).output
        diff = ws.git("diff", "--", *(scope or ["."]), *NOT_BYTECODE).output
        return {"status": status or "(no changes)", "diff": diff}

    def commit(self, workspace: str, module: str, message: str) -> dict[str, Any]:
        """Commit one module's changes.

        @raises QueryRejected: When there is nothing to commit or the message is empty."""
        if not message.strip():
            raise QueryRejected("a commit needs a message that says what changed and why")
        with self._audited("odoo_module_commit", workspace=workspace, module=module) as rec:
            ws = self.workspace(workspace)
            check_module_name(module)
            ws.git("add", "--all", "--", module, *NOT_BYTECODE)
            if not ws.git("diff", "--cached", "--name-only", "--", module).output:
                raise QueryRejected(f"nothing to commit in {module}")
            ws.git(*ws.identity(), "commit", "-m", message, "--", module)
            head = ws.git("log", "-1", "--format=%H %s").output
            rec.extra["commit"] = head.split(" ", 1)[0]
            return {"commit": head}

    def discard(self, workspace: str, module: str) -> dict[str, Any]:
        """Throw away uncommitted changes of one module: tracked files go back to the last commit and new files
        are deleted."""
        with self._audited("odoo_module_discard", workspace=workspace, module=module):
            ws = self.workspace(workspace)
            check_module_name(module)
            ws.git("reset", "-q", "--", module, check=False)
            tracked = ws.git("ls-files", "--", module).output
            if tracked:
                ws.git("checkout", "--", module)
            removed = ws.git("clean", "-fd", "--", module).output
            return {"module": module, "restored": bool(tracked), "removed": removed or "(nothing)"}

    def package(self, workspace: str, module: str) -> dict[str, Any]:
        """Zip one module for a self-hosted server (`addons` folder) or a manual upload."""
        with self._audited("odoo_module_package", workspace=workspace, module=module) as rec:
            ws = self.workspace(workspace)
            files = ws.files(module)
            report = check_module(ws.root, module, ws.config.odoo_version)
            if report.findings.errors:
                raise QueryRejected(
                    "fix the static check errors before packaging:\n- " + "\n- ".join(report.findings.errors)
                )
            out_dir: Path = self._config.customize.export_dir
            out_dir.mkdir(parents=True, exist_ok=True)
            target = out_dir / f"{module}.zip"
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                for rel in files:
                    archive.write(ws.root / rel, rel)
            target.write_bytes(buffer.getvalue())
            rec.row_count = len(files)
            return {"zip_path": str(target), "files": len(files)}

    def push(self, workspace: str, branch: str) -> dict[str, Any]:
        """Push the current commit to a branch of the configured remote, such as an Odoo.sh staging branch.

        @raises QueryRejected: Without a configured remote, on a protected branch, or with uncommitted changes."""
        with self._audited("odoo_module_push", workspace=workspace, branch=branch):
            ws = self.workspace(workspace)
            remote = ws.config.push_remote
            if remote is None:
                raise QueryRejected(f"workspace {workspace} has no push_remote; pushing is not enabled")
            if not re.fullmatch(_BRANCH, branch) or ".." in branch:
                raise QueryRejected(f"invalid branch name {branch!r}")
            if branch in ws.config.protected_branches:
                raise QueryRejected(
                    f"{branch} is protected; push to a staging branch and promote it in Odoo.sh or by your release step"
                )
            if ws.git("status", "--porcelain").output:
                raise QueryRejected("commit or discard the uncommitted changes first")
            output = ws.git("push", remote, f"HEAD:refs/heads/{branch}").output
            return {"remote": remote, "branch": branch, "output": output}
