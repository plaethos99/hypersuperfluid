"""Built-in web backend: direct HTTP fetches with the extraction network policy.

Every request goes through `fetch_bytes`, so the public-address check, address pinning, redirect
checks and size cap of `extract_tables` apply. The crawler stays on the start host, obeys
`robots.txt`, and pauses between requests.
"""

from __future__ import annotations

import time
import urllib.robotparser
from collections import deque
from collections.abc import Callable
from urllib.parse import urlparse, urlunparse

import httpx

from erp_agent.config import ExtractConfig, WebConfig
from erp_agent.errors import ExtractionError
from erp_agent.extract import Resolver, document_kind, fetch_bytes, system_resolver
from erp_agent.models import CrawlResult, WebPage
from erp_agent.web.base import CrawlSpec
from erp_agent.web.text import PageText, clip, html_to_text, pdf_to_text

_TEXT_TYPES = frozenset({"text/plain", "text/markdown"})


def _normalize(url: str) -> str:
    parsed = urlparse(url)
    return urlunparse(parsed._replace(fragment="", path=parsed.path or "/"))


class BuiltinWeb:
    """Direct-fetch backend."""

    name = "builtin"

    def __init__(
        self,
        extract_config: ExtractConfig,
        web_config: WebConfig,
        client: httpx.Client,
        resolver: Resolver = system_resolver,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """@param extract_config: Network policy shared with `extract_tables`.
        @param web_config: Text and crawl limits.
        @param client: HTTP client that does not follow redirects; it is not closed here.
        @param resolver: Host resolver for the public-address check.
        @param sleep: Pause function, injectable for tests.
        @param clock: Monotonic clock for the crawl time limit."""
        self._extract = extract_config
        self._web = web_config
        self._client = client
        self._resolver = resolver
        self._sleep = sleep
        self._clock = clock

    def _read(self, url: str) -> tuple[str, PageText]:
        fetched = fetch_bytes(url, self._extract, self._client, self._resolver)
        kind = document_kind(fetched.content_type, fetched.url)
        if kind == "html":
            return fetched.url, html_to_text(fetched.body.decode("utf-8", errors="replace"), fetched.url)
        if kind == "pdf":
            return fetched.url, pdf_to_text(fetched.body)
        if fetched.content_type in _TEXT_TYPES:
            return fetched.url, PageText(None, fetched.body.decode("utf-8", errors="replace"), ())
        raise ExtractionError(
            f"{fetched.content_type or 'unknown content'} at {fetched.url} is not a page; "
            "use extract_tables for CSV and spreadsheets"
        )

    def _page(self, url: str, content: PageText, max_chars: int) -> WebPage:
        text, truncated = clip(content.text, max_chars)
        return WebPage(url=url, title=content.title, text=text, truncated=truncated, source="builtin")

    def fetch(self, url: str) -> WebPage:
        final_url, content = self._read(url)
        return self._page(final_url, content, self._web.max_chars)

    def _robots(self, start: str) -> urllib.robotparser.RobotFileParser:
        parsed = urlparse(start)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        parser = urllib.robotparser.RobotFileParser(robots_url)
        fetched = fetch_bytes(robots_url, self._extract, self._client, self._resolver, raise_for_status=False)
        # A missing robots.txt (4xx) allows everything; a server error (5xx) is treated as a refusal.
        if fetched.status >= 500:
            parser.parse(["User-agent: *", "Disallow: /"])
        elif fetched.status >= 400:
            parser.parse([])
        else:
            parser.parse(fetched.body.decode("utf-8", errors="replace").splitlines())
        return parser

    def _enqueue(
        self,
        links: tuple[str, ...],
        host: str,
        depth: int,
        spec: CrawlSpec,
        seen: set[str],
        queue: deque[tuple[str, int]],
    ) -> bool:
        """Queue unseen same-host links; returns True when the discovered-URL limit stopped it."""
        for link in links:
            if len(seen) >= self._web.crawl_max_queued:
                return True
            candidate = _normalize(link)
            parsed = urlparse(candidate)
            if parsed.netloc != host or candidate in seen or not spec.path_allowed(parsed.path):
                continue
            seen.add(candidate)
            queue.append((candidate, depth))
        return False

    def crawl(self, spec: CrawlSpec) -> CrawlResult:
        start = _normalize(spec.url)
        host = urlparse(start).netloc
        robots = self._robots(start)
        agent = self._web.user_agent
        deadline = self._clock() + self._web.crawl_timeout_s
        queue: deque[tuple[str, int]] = deque([(start, 0)])
        seen = {start}
        pages: list[WebPage] = []
        skipped: list[str] = []
        stopped: str | None = None
        link_limit_hit = False
        while queue:
            if len(pages) >= spec.max_pages:
                stopped = f"reached max_pages={spec.max_pages}"
                break
            if self._clock() >= deadline:
                stopped = f"reached the {self._web.crawl_timeout_s:g}s time limit"
                break
            url, depth = queue.popleft()
            if not robots.can_fetch(agent, url):
                skipped.append(f"{url}: disallowed by robots.txt")
                continue
            self._sleep(max(self._web.crawl_delay_s, float(robots.crawl_delay(agent) or 0)))
            try:
                final_url, content = self._read(url)
            except ExtractionError as exc:
                skipped.append(f"{url}: {exc}")
                continue
            if url == start and urlparse(final_url).netloc != host:
                # The start URL redirected to another host (example.com -> www.example.com): crawl that host.
                host = urlparse(final_url).netloc
                robots = self._robots(final_url)
                seen.add(_normalize(final_url))
            pages.append(self._page(final_url, content, self._web.crawl_page_chars))
            if depth < spec.max_depth:
                link_limit_hit = self._enqueue(content.links, host, depth + 1, spec, seen, queue) or link_limit_hit
        if stopped is None and link_limit_hit:
            stopped = f"stopped collecting links after {self._web.crawl_max_queued} URLs"
        return CrawlResult(start_url=start, pages=tuple(pages), skipped=tuple(skipped), stopped_reason=stopped)

    def close(self) -> None:
        return None
