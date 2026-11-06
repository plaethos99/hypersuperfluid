"""Change sets on disk: one JSON file per set, rewritten after every step so a crash never loses created ids."""

from __future__ import annotations

import os
import re
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from erp_agent.customize.changes import Change
from erp_agent.errors import QueryRejected

_ID = re.compile(r"^cs-\d{8}-\d{6}-[0-9a-f]{6}$")

Status = Literal["planned", "applied", "failed", "rolled_back"]


class CreatedRecord(BaseModel):
    """One record a change set created in Odoo; rollback deletes these in reverse order."""

    model_config = ConfigDict(extra="forbid")

    change: int
    model: str
    id: int
    label: str


class ChangeSet(BaseModel):
    """A planned change set and what happened to it."""

    model_config = ConfigDict(extra="forbid")

    id: str
    connection: str
    title: str
    status: Status = "planned"
    created_at: str
    changes: tuple[Change, ...]
    summary: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    depends: list[str] = Field(default_factory=list)
    created: list[CreatedRecord] = Field(default_factory=list)
    results: dict[str, str] = Field(default_factory=dict, description="Read-back facts such as webhook URLs")
    applied_at: str | None = None
    rolled_back_at: str | None = None
    error: str | None = None


def now() -> str:
    """@returns: The current UTC time in ISO format."""
    return datetime.now(UTC).isoformat(timespec="seconds")


def new_id() -> str:
    """@returns: A sortable, unguessable change set id such as `cs-20261010-142233-3fa9c1`."""
    return f"cs-{datetime.now(UTC):%Y%m%d-%H%M%S}-{secrets.token_hex(3)}"


class ChangeSetStore:
    """Reads and writes change sets in one directory."""

    def __init__(self, directory: Path) -> None:
        """@param directory: Created on first save."""
        self._dir = directory

    def _path(self, changeset_id: str) -> Path:
        if not _ID.fullmatch(changeset_id):
            raise QueryRejected(f"invalid change set id {changeset_id!r}")
        return self._dir / f"{changeset_id}.json"

    def save(self, changeset: ChangeSet) -> None:
        """Write atomically, so a reader never sees half a file.

        @param changeset: Change set to store."""
        path = self._path(changeset.id)
        self._dir.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(changeset.model_dump_json(indent=2), encoding="utf-8")
        os.replace(temporary, path)

    def load(self, changeset_id: str) -> ChangeSet:
        """@raises QueryRejected: When no such change set exists."""
        path = self._path(changeset_id)
        if not path.is_file():
            raise QueryRejected(f"no change set {changeset_id}; list them with odoo_list_changesets")
        return ChangeSet.model_validate_json(path.read_text(encoding="utf-8"))

    def list(self, connection: str | None, limit: int) -> list[ChangeSet]:
        """@param connection: Only this connection's sets, or all when None.
        @param limit: Newest first, at most this many.
        @returns: Change sets."""
        if not self._dir.is_dir():
            return []
        found: list[ChangeSet] = []
        for path in sorted(self._dir.glob("cs-*.json"), reverse=True):
            changeset = ChangeSet.model_validate_json(path.read_text(encoding="utf-8"))
            if connection is None or changeset.connection == connection:
                found.append(changeset)
            if len(found) >= limit:
                break
        return found
