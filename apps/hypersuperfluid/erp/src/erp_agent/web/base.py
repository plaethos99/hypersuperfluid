"""Web backend interface and crawl request type."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol

from erp_agent.errors import QueryRejected
from erp_agent.models import CrawlResult, WebPage

_PREFIX = re.compile(r"/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*")


def check_prefixes(prefixes: tuple[str, ...]) -> tuple[str, ...]:
    """Validate URL path prefixes supplied by the model.

    @param prefixes: Path prefixes such as `/products/`.
    @returns: The unchanged prefixes.
    @raises QueryRejected: When a prefix does not start with `/` or contains characters that are not
        valid in a URL path.
    """
    for prefix in prefixes:
        if not _PREFIX.fullmatch(prefix):
            raise QueryRejected(f"path prefix {prefix!r} must start with / and contain only URL path characters")
    return prefixes


@dataclass(frozen=True)
class CrawlSpec:
    """A resolved crawl: limits are already capped by configuration."""

    url: str
    max_pages: int
    max_depth: int
    include_prefixes: tuple[str, ...] = ()
    exclude_prefixes: tuple[str, ...] = ()

    def path_allowed(self, path: str) -> bool:
        """@param path: URL path.
        @returns: Whether the path matches the include prefixes (when any) and no exclude prefix."""
        if any(path.startswith(p) for p in self.exclude_prefixes):
            return False
        return not self.include_prefixes or any(path.startswith(p) for p in self.include_prefixes)


class WebBackend(Protocol):
    """Reads web pages and crawls sites. Implementations never send ERP data anywhere."""

    name: str

    def fetch(self, url: str) -> WebPage:
        """Read one page or document.

        @param url: http or https URL.
        @returns: Page text, capped at the configured length.
        @raises ExtractionError: When the page cannot be fetched or converted.
        """
        ...

    def crawl(self, spec: CrawlSpec) -> CrawlResult:
        """Read pages of one site, starting at `spec.url` and staying on that host.

        @param spec: Resolved crawl request.
        @returns: Pages read and URLs skipped.
        @raises ExtractionError: When the start URL is refused or the crawl cannot start.
        """
        ...

    def close(self) -> None:
        """Release HTTP resources."""
        ...
