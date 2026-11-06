"""Proxy bypass list repair for HTTP clients.

DeepSeek Harness hands the processes it starts a `NO_PROXY` list that names IPv6 loopback both bare (`::1`) and
bracketed (`[::1]`) whenever a proxy is configured. httpx rejects the bracketed form ("Invalid port: ':1]'") the
moment a client is created, so erp-mcp rewrites bracketed IPv6 entries to their bare form before building any client.
"""

from __future__ import annotations

from collections.abc import MutableMapping

NO_PROXY_NAMES = ("NO_PROXY", "no_proxy")


def normalize_no_proxy(value: str) -> str:
    """Rewrite bracketed IPv6 entries (`[::1]`) of a comma-separated bypass list to their bare form.

    @param value: A `NO_PROXY` value.
    @returns: The same entries in order, bracketed IPv6 hosts unwrapped and duplicates dropped.
    """
    entries: list[str] = []
    for raw in value.split(","):
        entry = raw.strip()
        if entry.startswith("[") and entry.endswith("]") and ":" in entry:
            entry = entry[1:-1]
        if entry and entry not in entries:
            entries.append(entry)
    return ",".join(entries)


def repair_no_proxy(environ: MutableMapping[str, str]) -> None:
    """Normalize `NO_PROXY` and `no_proxy` in place so httpx can parse them.

    @param environ: The process environment that httpx reads (normally `os.environ`).
    """
    for name in NO_PROXY_NAMES:
        value = environ.get(name)
        if value is not None:
            environ[name] = normalize_no_proxy(value)
