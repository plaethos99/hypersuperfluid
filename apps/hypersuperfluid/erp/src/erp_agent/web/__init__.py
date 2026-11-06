"""Web page reading and site crawling for info mode."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal

import httpx

from erp_agent.config import AppConfig, read_env
from erp_agent.extract import Resolver, system_resolver
from erp_agent.web.base import CrawlSpec, WebBackend, check_prefixes
from erp_agent.web.builtin import BuiltinWeb
from erp_agent.web.firecrawl import FirecrawlWeb

__all__ = ["CrawlSpec", "WebBackend", "build_web_backend", "check_prefixes", "resolve_backend_name"]


def resolve_backend_name(config: AppConfig, environ: Mapping[str, str]) -> Literal["builtin", "firecrawl"]:
    """Resolve `web.backend: auto` against the environment.

    @param config: Validated configuration.
    @param environ: Environment holding the Firecrawl key, when configured.
    @returns: `firecrawl` when selected explicitly or when `auto` finds the key; otherwise `builtin`.
    """
    backend = config.web.backend
    if backend == "auto":
        return "firecrawl" if environ.get(config.web.firecrawl.api_key_env) else "builtin"
    return backend


def build_web_backend(
    config: AppConfig,
    environ: Mapping[str, str],
    client: httpx.Client,
    resolver: Resolver = system_resolver,
) -> WebBackend:
    """Create the configured web backend.

    @param config: Validated configuration.
    @param environ: Environment holding the Firecrawl key.
    @param client: Redirect-free client used by the built-in backend.
    @param resolver: Host resolver for the public-address check.
    @returns: The resolved backend.
    """
    if resolve_backend_name(config, environ) == "firecrawl":
        api_key = read_env(config.web.firecrawl.api_key_env, environ)
        return FirecrawlWeb.create(config.extract, config.web, api_key, resolver)
    return BuiltinWeb(config.extract, config.web, client, resolver)
