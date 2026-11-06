"""Append-only JSON Lines audit log of tool calls.

Entries record what was asked (tool, connection, entity, parameters), the row count, duration and
outcome. They never record result rows or credentials.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path


@dataclass
class AuditRecord:
    """Mutable holder the caller fills in while a tool call runs; written once when the call ends."""

    row_count: int | None = None
    extra: dict[str, object] = field(default_factory=dict)


class AuditLog:
    """Thread-safe appender for one audit file."""

    def __init__(
        self,
        path: Path,
        clock: Callable[[], float] = time.monotonic,
        redact: Callable[[str], str] = str,
    ) -> None:
        """@param path: File to append to; parent directories are created on first write.
        @param clock: Monotonic clock used for durations.
        @param redact: Applied to error text before it is written."""
        self._path = path
        self._clock = clock
        self._redact = redact
        self._lock = threading.Lock()

    @property
    def path(self) -> Path:
        """@returns: The audit file path."""
        return self._path

    def write(self, entry: Mapping[str, object]) -> None:
        """Append one entry as a JSON line.

        @param entry: JSON-serializable fields; non-serializable values are written with `str()`.
        """
        line = json.dumps(dict(entry), default=str, ensure_ascii=False)
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")

    @contextmanager
    def record(self, tool: str, **params: object) -> Iterator[AuditRecord]:
        """Write one entry when the enclosed block ends, including failures.

        @param tool: Tool name.
        @param params: Request parameters to record.
        @returns: A context manager yielding an `AuditRecord` for the row count.
        """
        started = self._clock()
        holder = AuditRecord()
        outcome, error = "ok", None
        try:
            yield holder
        except Exception as exc:
            outcome, error = "error", self._redact(f"{type(exc).__name__}: {exc}")
            raise
        finally:
            self.write(
                {
                    "ts": datetime.now(UTC).isoformat(),
                    "tool": tool,
                    **params,
                    **holder.extra,
                    "row_count": holder.row_count,
                    "duration_ms": round((self._clock() - started) * 1000, 1),
                    "outcome": outcome,
                    "error": error,
                }
            )
