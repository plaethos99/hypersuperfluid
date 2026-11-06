"""Firecrawl web backend (https://docs.firecrawl.dev, API v2).

Only URLs are sent to Firecrawl. The URL check of `extract_tables` runs first, so internal addresses
are not disclosed to the service unless `allow_private_hosts` is set.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from typing import Any

import httpx

from erp_agent.config import ExtractConfig, WebConfig
from erp_agent.errors import ExtractionError
from erp_agent.extract import Resolver, check_url, system_resolver
from erp_agent.models import CrawlResult, WebPage
from erp_agent.web.base import CrawlSpec
from erp_agent.web.text import clip

_POLL_INTERVAL_S = 2.0
_DEFAULT_RETRY_WAIT_S = 30.0
_RETRY_AFTER = re.compile(r"retry after (\d+)\s*s", re.IGNORECASE)
_ERRORS = {
    401: "Firecrawl rejected the API key",
    402: "the Firecrawl account has no credits left",
    429: "Firecrawl rate limit reached; retry later",
}


def _title(metadata: dict[str, Any]) -> str | None:
    title = metadata.get("title")
    if isinstance(title, list):
        title = title[0] if title else None
    return str(title) if title else None


class FirecrawlWeb:
    """Backend that delegates fetching and crawling to Firecrawl."""

    name = "firecrawl"

    def __init__(
        self,
        extract_config: ExtractConfig,
        web_config: WebConfig,
        client: httpx.Client,
        resolver: Resolver = system_resolver,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """@param extract_config: Private-host policy applied to URLs before they are sent.
        @param web_config: Text and crawl limits, and the Firecrawl API URL.
        @param client: HTTP client carrying the `Authorization: Bearer` header; closed by `close`.
        @param resolver: Host resolver for the public-address check.
        @param sleep: Pause between status polls, injectable for tests.
        @param clock: Monotonic clock for the crawl time limit."""
        self._extract = extract_config
        self._web = web_config
        self._api = web_config.firecrawl.api_url.rstrip("/")
        self._client = client
        self._resolver = resolver
        self._sleep = sleep
        self._clock = clock

    @classmethod
    def create(
        cls,
        extract_config: ExtractConfig,
        web_config: WebConfig,
        api_key: str,
        resolver: Resolver = system_resolver,
    ) -> FirecrawlWeb:
        """@returns: A backend with an authenticated client."""
        client = httpx.Client(
            headers={"Authorization": f"Bearer {api_key}"}, timeout=web_config.crawl_timeout_s, follow_redirects=False
        )
        return cls(extract_config, web_config, client, resolver)

    def _retry_wait(self, response: httpx.Response) -> float:
        # Firecrawl states the wait in Retry-After or in the message ("retry after 43s").
        header = response.headers.get("retry-after", "")
        match = _RETRY_AFTER.search(response.text)
        if header.isdigit():
            wait = float(header)
        elif match:
            wait = float(match.group(1))
        else:
            wait = _DEFAULT_RETRY_WAIT_S
        return min(wait + 1.0, self._web.firecrawl.max_retry_wait_s)

    def _request(self, method: str, url: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        # The API key must only reach the configured API host (paging URLs come from responses).
        if not url.startswith(f"{self._api}/"):
            raise ExtractionError(f"refusing to send the Firecrawl key to {url}")
        attempt = 0
        while True:
            try:
                response = self._client.request(method, url, json=body)
            except httpx.HTTPError as exc:
                raise ExtractionError(f"Firecrawl request failed: {exc}") from exc
            if response.status_code != 429 or attempt >= self._web.firecrawl.max_retries:
                break
            attempt += 1
            self._sleep(self._retry_wait(response))
        if response.is_error:
            reason = _ERRORS.get(response.status_code, f"Firecrawl HTTP {response.status_code}")
            raise ExtractionError(f"{reason}: {response.text[:300]}")
        try:
            payload: dict[str, Any] = response.json()
        except ValueError as exc:
            raise ExtractionError("Firecrawl response is not JSON") from exc
        return payload

    def _page(self, item: dict[str, Any], fallback_url: str, max_chars: int) -> WebPage:
        metadata = item.get("metadata") or {}
        text, truncated = clip(str(item.get("markdown") or ""), max_chars)
        url = str(metadata.get("url") or metadata.get("sourceURL") or fallback_url)
        return WebPage(url=url, title=_title(metadata), text=text, truncated=truncated, source="firecrawl")

    def fetch(self, url: str) -> WebPage:
        check_url(url, self._extract, self._resolver)
        payload = self._request(
            "POST",
            f"{self._api}/v2/scrape",
            {
                "url": url,
                "formats": ["markdown"],
                "onlyMainContent": True,
                "timeout": int(self._extract.timeout_s * 1000),
            },
        )
        data = payload.get("data") or {}
        status = (data.get("metadata") or {}).get("statusCode")
        if isinstance(status, int) and status >= 400:
            raise ExtractionError(f"HTTP {status} from {url}")
        return self._page(data, url, self._web.max_chars)

    def crawl(self, spec: CrawlSpec) -> CrawlResult:
        check_url(spec.url, self._extract, self._resolver)
        body: dict[str, Any] = {
            "url": spec.url,
            "limit": spec.max_pages,
            "maxDiscoveryDepth": spec.max_depth,
            "crawlEntireDomain": False,
            "allowExternalLinks": False,
            "scrapeOptions": {"formats": ["markdown"], "onlyMainContent": True},
        }
        if spec.include_prefixes:
            body["includePaths"] = [f"^{re.escape(p)}" for p in spec.include_prefixes]
        if spec.exclude_prefixes:
            body["excludePaths"] = [f"^{re.escape(p)}" for p in spec.exclude_prefixes]
        job_id = str(self._request("POST", f"{self._api}/v2/crawl", body)["id"])
        status_url = f"{self._api}/v2/crawl/{job_id}"
        deadline = self._clock() + self._web.crawl_timeout_s
        while True:
            status = self._request("GET", status_url)
            if status.get("status") in ("completed", "failed") or self._clock() >= deadline:
                break
            self._sleep(_POLL_INTERVAL_S)
        state = status.get("status")
        stopped = None
        if state == "failed":
            stopped = "Firecrawl reported the crawl as failed"
        elif state != "completed":
            stopped = f"reached the {self._web.crawl_timeout_s:g}s time limit"
            self._cancel(status_url)
        items: list[dict[str, Any]] = list(status.get("data") or [])
        next_url = status.get("next") if state == "completed" else None
        while next_url and len(items) < spec.max_pages:
            chunk = self._request("GET", str(next_url))
            items.extend(chunk.get("data") or [])
            next_url = chunk.get("next")
        pages = tuple(self._page(item, spec.url, self._web.crawl_page_chars) for item in items[: spec.max_pages])
        return CrawlResult(start_url=spec.url, pages=pages, skipped=(), stopped_reason=stopped)

    def _cancel(self, status_url: str) -> None:
        try:
            self._request("DELETE", status_url)
        except ExtractionError:  # cancellation is best effort; the job expires on its own
            return

    def close(self) -> None:
        self._client.close()
