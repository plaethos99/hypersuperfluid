"""Table extraction from web pages and documents (HTML, CSV, XLSX/XLS, PDF).

URLs must resolve to public addresses unless `allow_private_hosts` is set; every redirect hop is
checked, and the request is sent to the checked address (with the original Host header and TLS server
name), so a second DNS answer cannot redirect it. Local files must lie inside `allowed_dirs`; network
(UNC) paths are refused before any filesystem access.
"""

from __future__ import annotations

import io
import ipaddress
import math
import socket
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urljoin, urlparse

import httpx
import numpy as np
import pandas as pd

from erp_agent.config import ExtractConfig
from erp_agent.errors import ExtractionError
from erp_agent.models import ExtractedTable

DocKind = Literal["html", "csv", "excel", "pdf"]
Resolver = Callable[[str], list[str]]

_MAX_REDIRECTS = 5
_EXTENSIONS: dict[str, DocKind] = {
    ".html": "html",
    ".htm": "html",
    ".csv": "csv",
    ".xlsx": "excel",
    ".xls": "excel",
    ".pdf": "pdf",
}
_CONTENT_TYPES: dict[str, DocKind] = {
    "text/html": "html",
    "application/xhtml+xml": "html",
    "text/csv": "csv",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "excel",
    "application/vnd.ms-excel": "excel",
}


def system_resolver(host: str) -> list[str]:
    """@param host: Host name.
    @returns: IP address strings from the system resolver.
    @raises ExtractionError: When the name does not resolve."""
    try:
        return [str(info[4][0]) for info in socket.getaddrinfo(host, None)]
    except socket.gaierror as exc:
        raise ExtractionError(f"cannot resolve {host}: {exc}") from exc


@dataclass(frozen=True)
class _Target:
    url: str
    headers: dict[str, str]
    extensions: dict[str, Any]


def _target(url: str, config: ExtractConfig, resolver: Resolver) -> _Target:
    parsed = urlparse(url)
    host = parsed.hostname
    if parsed.scheme not in ("http", "https") or not host:
        raise ExtractionError(f"only http and https URLs are supported: {url}")
    if config.allow_private_hosts:
        return _Target(url, {}, {})
    addresses = [ipaddress.ip_address(a.split("%", 1)[0]) for a in resolver(host)]
    if not addresses:
        raise ExtractionError(f"cannot resolve {host}")
    if not all(a.is_global for a in addresses):
        raise ExtractionError(f"{host} resolves to a non-public address; set allow_private_hosts")
    pinned = addresses[0]
    port = f":{parsed.port}" if parsed.port else ""
    ip_host = f"[{pinned}]" if pinned.version == 6 else str(pinned)
    extensions: dict[str, Any] = {"sni_hostname": host} if parsed.scheme == "https" else {}
    return _Target(parsed._replace(netloc=f"{ip_host}{port}").geturl(), {"Host": f"{host}{port}"}, extensions)


def check_url(url: str, config: ExtractConfig, resolver: Resolver = system_resolver) -> None:
    """Apply the scheme and public-address checks without fetching.

    @param url: URL to check.
    @param config: Private-host policy.
    @param resolver: Resolves a host name to IP address strings.
    @raises ExtractionError: When the URL is not http(s) or resolves to a non-public address.
    """
    _target(url, config, resolver)


def _kind_from_name(name: str) -> DocKind | None:
    return _EXTENSIONS.get(Path(urlparse(name).path).suffix.lower())


def _read_capped(response: httpx.Response, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    for chunk in response.iter_bytes():
        size += len(chunk)
        if size > max_bytes:
            raise ExtractionError(f"document is larger than {max_bytes} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


@dataclass(frozen=True)
class Fetched:
    """A downloaded HTTP response body."""

    url: str
    status: int
    content_type: str
    body: bytes


def fetch_bytes(
    url: str,
    config: ExtractConfig,
    client: httpx.Client,
    resolver: Resolver = system_resolver,
    raise_for_status: bool = True,
) -> Fetched:
    """Download a URL, following redirects only to hosts that pass the address check.

    @param url: http or https URL.
    @param config: Network limits (private-host policy, size cap, timeout).
    @param client: HTTP client; must not follow redirects itself.
    @param resolver: Resolves a host name to IP address strings.
    @param raise_for_status: Raise on 4xx/5xx; when false the error response is returned.
    @returns: Final URL after redirects, status, content type and body.
    @raises ExtractionError: On a disallowed host, HTTP error, oversize body or transport failure.
    """
    current = url
    for _ in range(_MAX_REDIRECTS + 1):
        target = _target(current, config, resolver)
        try:
            with client.stream(
                "GET", target.url, headers=target.headers, extensions=target.extensions, timeout=config.timeout_s
            ) as response:
                if response.is_redirect:
                    current = urljoin(current, response.headers.get("location", ""))
                    continue
                if response.is_error and raise_for_status:
                    raise ExtractionError(f"HTTP {response.status_code} from {current}")
                content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                body = _read_capped(response, config.max_bytes)
        except httpx.HTTPError as exc:
            raise ExtractionError(f"cannot fetch {current}: {exc}") from exc
        return Fetched(current, response.status_code, content_type, body)
    raise ExtractionError(f"more than {_MAX_REDIRECTS} redirects from {url}")


def document_kind(content_type: str, url: str) -> DocKind | None:
    """@param content_type: Response media type without parameters.
    @param url: Final URL, used for its file extension when the media type is generic.
    @returns: The document kind, or None when unsupported."""
    return _CONTENT_TYPES.get(content_type) or _kind_from_name(url)


def fetch_url(
    url: str, config: ExtractConfig, client: httpx.Client, resolver: Resolver = system_resolver
) -> tuple[bytes, DocKind]:
    """Download a document of a supported kind.

    @param url: http or https URL.
    @param config: Extraction limits.
    @param client: HTTP client; must not follow redirects itself.
    @param resolver: Resolves a host name to IP address strings.
    @returns: (body, document kind).
    @raises ExtractionError: As `fetch_bytes`, and for unsupported content types.
    """
    fetched = fetch_bytes(url, config, client, resolver)
    kind = document_kind(fetched.content_type, fetched.url)
    if kind is None:
        raise ExtractionError(f"unsupported content type {fetched.content_type or 'unknown'} at {fetched.url}")
    return fetched.body, kind


def read_local(path_text: str, config: ExtractConfig) -> tuple[bytes, DocKind]:
    """Read a local document inside one of the allowed directories.

    @param path_text: File path.
    @param config: Extraction limits and allowed directories.
    @returns: (body, document kind).
    @raises ExtractionError: When the path is outside the allowed directories, missing, too large
        or of an unsupported type.
    """
    if path_text.startswith(("\\\\", "//")):
        raise ExtractionError("network paths are not allowed")
    path = Path(path_text).resolve()
    if not any(path.is_relative_to(d) for d in config.allowed_dirs):
        raise ExtractionError(f"{path} is outside the allowed directories")
    kind = _kind_from_name(path.name)
    if kind is None:
        raise ExtractionError(f"unsupported file type: {path.suffix or path.name}")
    try:
        if path.stat().st_size > config.max_bytes:
            raise ExtractionError(f"{path.name} is larger than {config.max_bytes} bytes")
        return path.read_bytes(), kind
    except OSError as exc:
        raise ExtractionError(f"cannot read {path}: {exc}") from exc


def _cell(value: object) -> object:
    if value is None or value is pd.NaT or value is pd.NA:
        return None
    if isinstance(value, np.generic):  # numpy scalars from typed columns
        value = value.item()
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, str | int | float | bool):
        return value
    return str(value)


def _frame_to_table(source: str, name: str, frame: pd.DataFrame, max_rows: int) -> ExtractedTable:
    columns = tuple(str(c) for c in frame.columns)
    records = [
        {col: _cell(v) for col, v in zip(columns, row, strict=True)}
        for row in frame.head(max_rows).itertuples(index=False, name=None)
    ]
    return ExtractedTable(
        source=source, name=name, columns=columns, rows=tuple(records), truncated=len(frame) > max_rows
    )


def _pdf_frames(body: bytes) -> list[tuple[str, pd.DataFrame]]:
    try:
        import pdfplumber
    except ImportError as exc:
        raise ExtractionError("PDF support needs the 'pdf' extra: uv sync --extra pdf") from exc
    frames: list[tuple[str, pd.DataFrame]] = []
    with pdfplumber.open(io.BytesIO(body)) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            for index, table in enumerate(page.extract_tables(), start=1):
                if len(table) < 2:
                    continue
                header = [str(h) if h is not None else f"column_{i}" for i, h in enumerate(table[0], start=1)]
                frames.append((f"page {page_number} table {index}", pd.DataFrame(table[1:], columns=header)))
    return frames


def parse_tables(body: bytes, kind: DocKind) -> list[tuple[str, pd.DataFrame]]:
    """Parse every table in a document.

    @param body: Document bytes.
    @param kind: Document kind.
    @returns: (table name, data frame) pairs in document order.
    @raises ExtractionError: When the document cannot be parsed.
    """
    try:
        match kind:
            case "html":
                text = body.decode("utf-8", errors="replace")
                try:
                    frames = pd.read_html(io.StringIO(text), flavor="lxml")
                except ValueError:  # pandas raises ValueError when the page has no <table>
                    return []
                return [(f"table {i}", f) for i, f in enumerate(frames, start=1)]
            case "csv":
                return [("csv", pd.read_csv(io.BytesIO(body)))]
            case "excel":
                sheets = pd.read_excel(io.BytesIO(body), sheet_name=None)
                return [(str(name), frame) for name, frame in sheets.items()]
            case "pdf":
                return _pdf_frames(body)
    except ExtractionError:
        raise
    except Exception as exc:  # parser libraries raise many unrelated types for malformed input
        raise ExtractionError(f"cannot parse {kind} document: {exc}") from exc


def extract_tables(
    source: str,
    config: ExtractConfig,
    client: httpx.Client,
    resolver: Resolver = system_resolver,
) -> tuple[ExtractedTable, ...]:
    """Extract tables from a URL or an allowed local file.

    @param source: URL (only http and https are accepted) or local path.
    @param config: Extraction limits.
    @param client: HTTP client that does not follow redirects.
    @param resolver: Host resolver used for the public-address check.
    @returns: Up to `config.max_tables` tables of up to `config.max_rows` rows each.
    """
    if "://" in source:
        body, kind = fetch_url(source, config, client, resolver)
    else:
        body, kind = read_local(source, config)
    frames = parse_tables(body, kind)[: config.max_tables]
    return tuple(_frame_to_table(source, name, frame, config.max_rows) for name, frame in frames)
