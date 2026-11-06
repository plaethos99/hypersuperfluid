"""Download vendor reference documentation for the bot's computer (`erp-docs fetch`).

Sources are listed in `docs/sources.yaml`. Pages are saved as Markdown under a git-ignored folder
(default `docs/vendor/`) with an `INDEX.md` of sources, download dates and failures. Vendor
documentation stays on the machine that downloads it; it is never committed.
"""

from __future__ import annotations

import argparse
import os
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import httpx
import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from erp_agent.config import AppConfig, load_config
from erp_agent.errors import ConfigError, ErpAgentError
from erp_agent.models import WebPage
from erp_agent.web import CrawlSpec, WebBackend, build_web_backend, check_prefixes

# Documentation pages are much longer than chat answers; keep whole pages.
_DOC_MAX_CHARS = 2_000_000
_SLUG = re.compile(r"[^a-z0-9]+")


class DocSource(BaseModel):
    """One documentation source."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    system: str = Field(pattern=r"^[a-z0-9-]+$")
    title: str
    url: str
    crawl: bool = False
    max_pages: int = Field(default=10, ge=1, le=100)
    include_prefixes: tuple[str, ...] = ()
    login_required: bool = Field(default=False, description="Listed for manual download; not fetched")


class DocSources(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    sources: tuple[DocSource, ...]


@dataclass(frozen=True)
class FetchOutcome:
    """Result of one source: saved files, or the reason nothing was saved."""

    source: DocSource
    files: tuple[Path, ...]
    error: str | None


def load_sources(path: Path) -> DocSources:
    """@param path: sources YAML file.
    @returns: Validated sources.
    @raises ConfigError: When the file is unreadable or invalid."""
    try:
        return DocSources.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))
    except (OSError, yaml.YAMLError, ValidationError) as exc:
        raise ConfigError(f"invalid documentation sources {path}: {exc}") from exc


def slug(text: str) -> str:
    """@param text: Title or URL.
    @returns: A lowercase file-name stem of letters, digits and hyphens (at most 80 characters)."""
    return _SLUG.sub("-", text.lower()).strip("-")[:80] or "page"


def _write_page(folder: Path, name: str, page: WebPage, source: DocSource, fetched: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{name}.md"
    header = (
        f"<!-- source: {page.url} | system: {source.system} | fetched: {fetched} | via: {page.source} -->\n\n"
        f"# {page.title or source.title}\n\n"
    )
    path.write_text(header + page.text + "\n", encoding="utf-8")
    return path


def fetch_source(source: DocSource, backend: WebBackend, dest: Path, fetched: str) -> FetchOutcome:
    """Download one source (a page, or a small crawl) into `dest/<system>/`.

    @returns: The files written, or the error that prevented it.
    """
    folder = dest / source.system
    try:
        if not source.crawl:
            page = backend.fetch(source.url)
            return FetchOutcome(source, (_write_page(folder, slug(source.title), page, source, fetched),), None)
        spec = CrawlSpec(
            url=source.url,
            max_pages=source.max_pages,
            max_depth=3,
            include_prefixes=check_prefixes(source.include_prefixes),
        )
        result = backend.crawl(spec)
        files = tuple(
            _write_page(folder, f"{slug(source.title)}--{slug(page.url.split('://', 1)[-1])}", page, source, fetched)
            for page in result.pages
        )
        return FetchOutcome(source, files, None if files else "crawl returned no pages")
    except ErpAgentError as exc:
        return FetchOutcome(source, (), str(exc))


def write_system_index(
    folder: Path, system: str, outcomes: Sequence[FetchOutcome], manual: Sequence[DocSource], fetched: str
) -> Path:
    """Write `<system>/INDEX.md` listing that system's pages, failures and login-only sources.

    @returns: The index path.
    """
    lines = [f"# {system} documentation (downloaded {fetched})", ""]
    for outcome in outcomes:
        if outcome.error:
            lines.append(f"- FAILED {outcome.source.title} <{outcome.source.url}>: {outcome.error}")
        for path in outcome.files:
            lines.append(f"- [{outcome.source.title}]({path.name}) <{outcome.source.url}>")
    lines += [f"- LOGIN REQUIRED, download manually: {s.title} <{s.url}>" for s in manual]
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "INDEX.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def write_root_index(dest: Path) -> Path:
    """Write `INDEX.md` linking every system folder that has an index, so partial refreshes keep the rest.

    @returns: The index path.
    """
    systems = sorted(p.parent.name for p in dest.glob("*/INDEX.md"))
    lines = [
        "# Vendor documentation",
        "",
        "Not committed to git. Refresh with `uv run erp-docs fetch [--only ...]`.",
        "",
    ]
    lines += [f"- [{system}]({system}/INDEX.md)" for system in systems]
    path = dest / "INDEX.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def fetch_all(
    sources: DocSources,
    backend: WebBackend,
    dest: Path,
    only: frozenset[str] = frozenset(),
    report: Callable[[str], None] = print,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> tuple[FetchOutcome, ...]:
    """Download every selected source and refresh the per-system and top-level indexes.

    @param only: Systems to include; empty means all.
    @returns: One outcome per fetched source (login-only sources are listed, not fetched).
    """
    fetched = now().strftime("%Y-%m-%d")
    selected = [s for s in sources.sources if not only or s.system in only]
    outcomes: list[FetchOutcome] = []
    for source in (s for s in selected if not s.login_required):
        outcome = fetch_source(source, backend, dest, fetched)
        status = f"FAILED: {outcome.error}" if outcome.error else f"{len(outcome.files)} file(s)"
        report(f"  {source.system:<13} {source.title[:60]:<60} {status}")
        outcomes.append(outcome)
    for system in sorted({s.system for s in selected}):
        write_system_index(
            dest / system,
            system,
            [o for o in outcomes if o.source.system == system],
            [s for s in selected if s.system == system and s.login_required],
            fetched,
        )
    write_root_index(dest)
    return tuple(outcomes)


def _backend_config(config: AppConfig) -> AppConfig:
    web = config.web.model_copy(update={"max_chars": _DOC_MAX_CHARS, "crawl_page_chars": _DOC_MAX_CHARS})
    return config.model_copy(update={"web": web})


def main(argv: list[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    """Command-line entry point `erp-docs`.

    @param argv: Arguments; defaults to `sys.argv[1:]`.
    @param environ: Environment; defaults to the process environment plus `<repo>/.env`.
    @returns: Process exit code (1 when every source failed).
    """
    from erp_agent.mcp_server import load_environment

    root = Path.cwd()
    parser = argparse.ArgumentParser(prog="erp-docs", description="Download vendor reference documentation")
    parser.add_argument("command", choices=("fetch",))
    parser.add_argument("--sources", type=Path, default=root / "docs" / "sources.yaml")
    parser.add_argument("--dest", type=Path, default=root / "docs" / "vendor")
    parser.add_argument("--config", type=Path, default=root / "config" / "erp-agent.yaml")
    parser.add_argument("--env-file", type=Path, default=root / ".env")
    parser.add_argument("--only", default="", help="comma-separated systems, e.g. odoo")
    args = parser.parse_args(argv)
    try:
        env = load_environment(
            args.env_file if args.env_file.is_file() else None, os.environ if environ is None else environ
        )
        config = load_config(args.config, env) if args.config.is_file() else AppConfig(connections={})
        sources = load_sources(args.sources)
    except ErpAgentError as exc:
        parser.exit(2, f"erp-docs: {exc}\n")
    client = httpx.Client(
        follow_redirects=False, timeout=config.extract.timeout_s, headers={"User-Agent": config.web.user_agent}
    )
    backend = build_web_backend(_backend_config(config), env, client)
    print(f"Downloading documentation with the {backend.name} backend into {args.dest}")
    try:
        only = frozenset(s.strip() for s in args.only.split(",") if s.strip())
        outcomes = fetch_all(sources, backend, args.dest, only)
    finally:
        backend.close()
        client.close()
    failed = sum(1 for o in outcomes if o.error)
    print(f"Done: {len(outcomes) - failed} saved, {failed} failed. See {args.dest / 'INDEX.md'}")
    return 1 if outcomes and failed == len(outcomes) else 0


def cli() -> None:
    """Console-script wrapper that exits with main's code."""
    raise SystemExit(main())
