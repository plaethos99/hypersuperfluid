"""Confined file access and Git operations inside one module workspace."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from erp_agent.config import ModuleWorkspace
from erp_agent.errors import ConnectorError, QueryRejected

MODULE_NAME = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
_TEXT_SUFFIXES = frozenset(
    {".py", ".xml", ".csv", ".js", ".scss", ".css", ".po", ".pot", ".md", ".rst", ".txt", ".svg", ".json", ".html"}
)
_SKIPPED_PARTS = frozenset({".git", "__pycache__", "node_modules"})
MAX_FILE_BYTES = 512_000
_MAX_OUTPUT = 60_000


def check_module_name(name: str) -> str:
    """@param name: Technical module name.
    @returns: The name.
    @raises QueryRejected: When it is not a valid Odoo module name."""
    if not MODULE_NAME.fullmatch(name):
        raise QueryRejected(
            f"invalid module name {name!r}: use 2-64 characters of a-z, 0-9 and _, starting with a letter"
        )
    return name


@dataclass(frozen=True)
class GitResult:
    returncode: int
    output: str


class Workspace:
    """One workspace: its files and its Git repository."""

    def __init__(self, name: str, config: ModuleWorkspace) -> None:
        """@param name: Workspace name.
        @param config: Resolved workspace configuration."""
        self.name = name
        self.config = config
        self.root = config.path

    def require_repository(self) -> None:
        """@raises QueryRejected: When the workspace path is not a Git repository."""
        if not (self.root / ".git").exists():
            raise QueryRejected(
                f"workspace {self.name} ({self.root}) is not a Git repository; run git init there first"
            )

    def resolve(self, relative: str) -> Path:
        """Resolve a path the model gave, refusing anything outside the workspace or inside `.git`.

        @param relative: Path relative to the workspace root, such as `acme_po/models/purchase_order.py`.
        @returns: The absolute path.
        @raises QueryRejected: On absolute paths, `..`, `.git` or paths outside a module directory.
        """
        posix = PurePosixPath(relative.replace("\\", "/"))
        if posix.is_absolute() or not posix.parts or ".." in posix.parts or ":" in posix.parts[0]:
            raise QueryRejected(f"{relative!r} must be a path inside the workspace, such as my_module/models/x.py")
        if _SKIPPED_PARTS & set(posix.parts):
            raise QueryRejected(f"{relative!r} is not a module file")
        check_module_name(posix.parts[0])
        path = (self.root / Path(*posix.parts)).resolve()
        if not path.is_relative_to(self.root.resolve()):
            raise QueryRejected(f"{relative!r} leaves the workspace")
        return path

    def modules(self) -> list[str]:
        """@returns: Directories directly under the root that hold a `__manifest__.py`."""
        if not self.root.is_dir():
            return []
        return sorted(p.parent.name for p in self.root.glob("*/__manifest__.py"))

    def files(self, module: str | None) -> list[str]:
        """@param module: One module, or None for every module.
        @returns: Text and image files, relative to the root, with `/` separators."""
        names = [check_module_name(module)] if module else self.modules()
        found: list[str] = []
        for name in names:
            base = self.root / name
            if not base.is_dir():
                raise QueryRejected(f"module {name} does not exist in workspace {self.name}")
            for path in sorted(base.rglob("*")):
                if path.is_file() and not (_SKIPPED_PARTS & set(path.relative_to(self.root).parts)):
                    found.append(path.relative_to(self.root).as_posix())
        return found

    def read(self, relative: str) -> str:
        """@returns: The text of one file.
        @raises QueryRejected: When it is missing, binary or too large."""
        path = self.resolve(relative)
        if not path.is_file():
            raise QueryRejected(f"{relative} does not exist")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise QueryRejected(f"{relative} is larger than {MAX_FILE_BYTES} bytes")
        try:
            return path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise QueryRejected(f"{relative} is not a UTF-8 text file") from exc

    def write(self, relative: str, content: str) -> bool:
        """Create or replace one text file of a module.

        @param relative: Path inside a module directory.
        @param content: Full new content.
        @returns: Whether the file existed before.
        @raises QueryRejected: On a file type modules do not hold, or content over the size cap.
        """
        path = self.resolve(relative)
        if path.suffix not in _TEXT_SUFFIXES:
            raise QueryRejected(f"{relative}: only {', '.join(sorted(_TEXT_SUFFIXES))} files can be written")
        data = content.encode("utf-8")
        if len(data) > MAX_FILE_BYTES:
            raise QueryRejected(f"{relative}: content is larger than {MAX_FILE_BYTES} bytes")
        existed = path.exists()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return existed

    def identity(self) -> list[str]:
        """@returns: Git options naming a committer when git knows none (a fresh computer, where `git commit`
        would fail): the workspace author, or Superfluid, at a local address. Empty when an identity is set."""
        options: list[str] = []
        if not self.git("config", "user.name", check=False).output:
            options += ["-c", f"user.name={self.config.author or 'Superfluid'}"]
        if not self.git("config", "user.email", check=False).output:
            options += ["-c", "user.email=superfluid@localhost"]
        return options

    def git(self, *args: str, check: bool = True) -> GitResult:
        """Run git in the workspace.

        @param args: Git arguments.
        @param check: Raise when git fails.
        @returns: Exit code and combined output, capped.
        @raises ConnectorError: When git is missing or fails while `check` is set."""
        self.require_repository()
        try:
            done = subprocess.run(
                ["git", "-C", str(self.root), "-c", "core.quotepath=false", *args],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ConnectorError(f"git {args[0]} failed: {exc}") from exc
        output = (done.stdout + done.stderr).strip()
        if len(output) > _MAX_OUTPUT:
            output = output[:_MAX_OUTPUT] + "\n... (truncated)"
        if check and done.returncode != 0:
            raise ConnectorError(f"git {args[0]} failed: {output[-2000:]}")
        return GitResult(done.returncode, output)
