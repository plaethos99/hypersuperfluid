"""Info-mode service: resolves model requests, routes them to connectors and audits every call."""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal

import httpx

from erp_agent.audit import AuditLog, AuditRecord
from erp_agent.config import AppConfig, ConnectionConfig
from erp_agent.connectors import build_connector
from erp_agent.connectors.base import ErpConnector
from erp_agent.errors import ErpAgentError, QueryRejected
from erp_agent.extract import Resolver, extract_tables
from erp_agent.models import (
    AggregateRequest,
    AggregateResult,
    CrawlResult,
    EntityInfo,
    EntitySchema,
    ExtractedTable,
    OrderBy,
    QueryRequest,
    QueryResult,
    QuerySpec,
    WebPage,
)
from erp_agent.redact import Redactor
from erp_agent.web import CrawlSpec, WebBackend, build_web_backend, check_prefixes
from erp_agent.web.builtin import BuiltinWeb

ConnectorFactory = Callable[[str, ConnectionConfig], ErpConnector]

AGGREGATE_MAX_ROWS = 20_000
"""Rows `aggregate` reads at most; a larger match must be narrowed with filters."""
_NUMERIC_TYPES = frozenset({"integer", "float", "monetary"})


@dataclass(frozen=True)
class ConnectionSummary:
    """What the model sees about one configured connection."""

    name: str
    kind: str
    description: str | None
    max_rows: int


@dataclass(frozen=True)
class UnavailableConnection:
    """A connection named in the configuration but left out because secret variables it names are unset."""

    name: str
    kind: str
    description: str | None
    missing_settings: tuple[str, ...]


class InfoService:
    """Read-only operations over all configured connections. Connectors are created on first use."""

    def __init__(
        self,
        config: AppConfig,
        factory: ConnectorFactory,
        audit: AuditLog,
        http_client: httpx.Client,
        resolver: Resolver | None = None,
        redact: Callable[[str], str] = str,
        web: WebBackend | None = None,
    ) -> None:
        """@param config: Validated configuration.
        @param factory: Builds a connector for a connection name and configuration.
        @param audit: Audit log for every call.
        @param http_client: Client for `extract_tables`; must not follow redirects.
        @param resolver: Host resolver for the public-address check; None uses DNS.
        @param redact: Removes secrets from error messages before they leave the service.
        @param web: Backend for `fetch_page` and `crawl_site`; None uses the built-in fetcher."""
        self._config = config
        self._factory = factory
        self._audit = audit
        self._http = http_client
        self._resolver = resolver
        self._redact = redact
        if web is None:
            web = (
                BuiltinWeb(config.extract, config.web, http_client)
                if resolver is None
                else BuiltinWeb(config.extract, config.web, http_client, resolver)
            )
        self._web = web
        self._connectors: dict[str, ErpConnector] = {}
        self._lock = threading.Lock()

    @classmethod
    def from_config(cls, config: AppConfig, environ: Mapping[str, str] | None = None) -> InfoService:
        """Create a service that builds real connectors from the environment.

        @param config: Validated configuration.
        @param environ: Environment for secrets; defaults to the process environment.
        @returns: A service whose connectors connect lazily.
        """
        env = os.environ if environ is None else environ
        redactor = Redactor.from_config(config, env)
        client = httpx.Client(
            follow_redirects=False,
            timeout=config.extract.timeout_s,
            headers={"User-Agent": config.web.user_agent},
        )
        return cls(
            config,
            lambda name, connection: build_connector(name, connection, env),
            AuditLog(config.audit.path, redact=redactor),
            client,
            redact=redactor,
            web=build_web_backend(config, env, client),
        )

    def _connection(self, name: str) -> ConnectionConfig:
        connection = self._config.connections.get(name)
        if connection is None:
            known = ", ".join(sorted(self._config.connections)) or "none"
            raise QueryRejected(f"unknown connection {name!r}; configured: {known}")
        return connection

    def _connector(self, name: str) -> ErpConnector:
        connection = self._connection(name)
        with self._lock:
            if name not in self._connectors:
                self._connectors = {**self._connectors, name: self._factory(name, connection)}
            return self._connectors[name]

    @contextmanager
    def _audited(self, tool: str, **params: object) -> Iterator[AuditRecord]:
        try:
            with self._audit.record(tool, **params) as record:
                yield record
        except ErpAgentError as exc:
            message = self._redact(str(exc))
            if message == str(exc):
                raise
            raise type(exc)(message) from exc

    def list_connections(self) -> tuple[ConnectionSummary, ...]:
        """@returns: Summaries of every configured connection, sorted by name."""
        return tuple(
            ConnectionSummary(
                name=name,
                kind=c.kind,
                description=c.description,
                max_rows=c.max_rows,
            )
            for name, c in sorted(self._config.connections.items())
        )

    def list_unavailable_connections(self) -> tuple[UnavailableConnection, ...]:
        """@returns: Connections set aside at load because their secret variables are unset, sorted by name."""
        return tuple(
            UnavailableConnection(name=name, kind=c.kind, description=c.description, missing_settings=missing)
            for name, (c, missing) in sorted(self._config.skipped_connections.items())
        )

    def resolve_query(self, connection: str, request: QueryRequest) -> QuerySpec:
        """Apply the connection's row cap to a model request.

        @param connection: Connection name.
        @param request: Model request.
        @returns: A spec whose limit is `min(request.limit, max_rows)`, or `max_rows` when unset.
        """
        cap = self._connection(connection).max_rows
        return QuerySpec(
            entity=request.entity,
            fields=request.fields,
            filters=request.filters,
            order_by=request.order_by,
            limit=min(request.limit or cap, cap),
            offset=request.offset,
        )

    def list_entities(self, connection: str, search: str | None, limit: int) -> tuple[EntityInfo, ...]:
        """@param connection: Connection name.
        @param search: Substring to match, or None.
        @param limit: Requested count, capped at the connection's `max_rows`.
        @returns: Matching entities."""
        if limit < 1:
            raise QueryRejected("limit must be at least 1")
        cap = min(limit, self._connection(connection).max_rows)
        with self._audited("erp_list_entities", connection=connection, search=search) as rec:
            entities = self._connector(connection).list_entities(search, cap)
            rec.row_count = len(entities)
            return entities

    def describe_entity(self, connection: str, entity: str) -> EntitySchema:
        """@param connection: Connection name.
        @param entity: Entity name.
        @returns: The entity's fields."""
        with self._audited("erp_describe_entity", connection=connection, entity=entity) as rec:
            schema = self._connector(connection).describe_entity(entity)
            rec.row_count = len(schema.fields)
            return schema

    def query(self, connection: str, request: QueryRequest) -> QueryResult:
        """@param connection: Connection name.
        @param request: Structured read.
        @returns: Rows, capped at the connection's `max_rows`."""
        spec = self.resolve_query(connection, request)
        with self._audited(
            "erp_query", connection=connection, entity=spec.entity, spec=spec.model_dump(mode="json")
        ) as rec:
            result = self._connector(connection).query(spec)
            rec.row_count = result.row_count
            rec.extra["truncated"] = result.truncated
            return result

    def aggregate(self, connection: str, request: AggregateRequest) -> AggregateResult:
        """Count and total every matching row, so the model never adds figures up itself.

        Rows are read page by page (the connection's `max_rows` each) and summed as decimals.

        @param connection: Connection name.
        @param request: Grouping, numeric fields to total, and filters.
        @returns: One group per distinct `group_by` combination, and the totals over all of them.
        @raises QueryRejected: On a non-numeric sum field, or more than `AGGREGATE_MAX_ROWS` matching rows.
        """
        connector = self._connector(connection)
        cap = self._connection(connection).max_rows
        with self._audited(
            "erp_aggregate", connection=connection, entity=request.entity, request=request.model_dump(mode="json")
        ) as rec:
            types = {f.name: f.type for f in connector.describe_entity(request.entity).fields}
            not_numeric = [f for f in request.sum_fields if f in types and types[f] not in _NUMERIC_TYPES]
            if not_numeric:
                raise QueryRejected(f"sum_fields must be numeric; not numeric: {', '.join(not_numeric)}")
            fields = tuple(dict.fromkeys(("id", *request.group_by, *request.sum_fields)))
            # Per group: its group_by values, and running [count, *sums].
            groups: dict[str, tuple[dict[str, object], list[Decimal]]] = {}
            totals = [Decimal(0)] * len(request.sum_fields)
            scanned = 0
            while True:
                spec = QuerySpec(
                    entity=request.entity,
                    fields=fields,
                    filters=request.filters,
                    order_by=(OrderBy(field="id"),),
                    limit=cap,
                    offset=scanned,
                )
                page = connector.query(spec)
                for row in page.rows:
                    values = [Decimal(str(row.get(f) or 0)) for f in request.sum_fields]
                    key = json.dumps([row.get(f) for f in request.group_by], sort_keys=True, default=str)
                    _, running = groups.setdefault(
                        key, ({f: row.get(f) for f in request.group_by}, [Decimal(0)] * (1 + len(values)))
                    )
                    running[:] = [a + b for a, b in zip(running, [Decimal(1), *values], strict=True)]
                    totals = [t + v for t, v in zip(totals, values, strict=True)]
                scanned += page.row_count
                if scanned > AGGREGATE_MAX_ROWS:
                    raise QueryRejected(f"more than {AGGREGATE_MAX_ROWS} rows match; narrow the filters")
                if not page.truncated:
                    break
            out = [
                {**head, "count": int(count), **dict(zip(request.sum_fields, map(float, sums), strict=True))}
                for head, (count, *sums) in groups.values()
            ]
            first = request.sum_fields[0] if request.sum_fields else "count"
            out.sort(key=lambda g: g[first], reverse=True)  # type: ignore[arg-type,return-value]
            rec.row_count = scanned
            return AggregateResult(
                connection=connection,
                entity=request.entity,
                group_by=request.group_by,
                sum_fields=request.sum_fields,
                groups=tuple(out),
                totals={"count": scanned, **dict(zip(request.sum_fields, map(float, totals), strict=True))},
            )

    def extract_tables(self, source: str) -> tuple[ExtractedTable, ...]:
        """@param source: URL or allowed local path.
        @returns: Extracted tables."""
        with self._audited("extract_tables", source=source) as rec:
            if self._resolver is None:
                tables = extract_tables(source, self._config.extract, self._http)
            else:
                tables = extract_tables(source, self._config.extract, self._http, self._resolver)
            rec.row_count = sum(len(t.rows) for t in tables)
            return tables

    @property
    def web_backend(self) -> str:
        """@returns: Name of the active web backend (`builtin` or `firecrawl`)."""
        return self._web.name

    def fetch_page(self, url: str) -> WebPage:
        """@param url: http or https URL.
        @returns: The page's main text, capped at `web.max_chars`."""
        with self._audited("fetch_page", url=url, backend=self._web.name) as rec:
            page = self._web.fetch(url)
            rec.row_count = len(page.text)
            return page

    def resolve_crawl(
        self,
        url: str,
        max_pages: int | None,
        max_depth: int | None,
        include_prefixes: tuple[str, ...],
        exclude_prefixes: tuple[str, ...],
    ) -> CrawlSpec:
        """Apply the configured crawl caps to a model request.

        @returns: A spec with `max_pages` in 1..`web.crawl_max_pages` and `max_depth` in 0..`web.crawl_max_depth`.
        @raises QueryRejected: On a page count below 1, a negative depth, or an invalid path prefix.
        """
        web = self._config.web
        if max_pages is not None and max_pages < 1:
            raise QueryRejected("max_pages must be at least 1")
        if max_depth is not None and max_depth < 0:
            raise QueryRejected("max_depth must not be negative")
        return CrawlSpec(
            url=url,
            max_pages=min(max_pages or web.crawl_max_pages, web.crawl_max_pages),
            max_depth=web.crawl_max_depth if max_depth is None else min(max_depth, web.crawl_max_depth),
            include_prefixes=check_prefixes(include_prefixes),
            exclude_prefixes=check_prefixes(exclude_prefixes),
        )

    def crawl_site(
        self,
        url: str,
        max_pages: int | None = None,
        max_depth: int | None = None,
        include_prefixes: tuple[str, ...] = (),
        exclude_prefixes: tuple[str, ...] = (),
    ) -> CrawlResult:
        """@param url: Start page; the crawl stays on its host.
        @returns: Pages read (text capped at `web.crawl_page_chars`) and URLs skipped."""
        spec = self.resolve_crawl(url, max_pages, max_depth, include_prefixes, exclude_prefixes)
        with self._audited(
            "crawl_site", url=url, backend=self._web.name, max_pages=spec.max_pages, max_depth=spec.max_depth
        ) as rec:
            result = self._web.crawl(spec)
            rec.row_count = len(result.pages)
            rec.extra["skipped"] = len(result.skipped)
            return result

    def close(self) -> None:
        """Close every connector that was created, the web backend and the HTTP client."""
        with self._lock:
            connectors, self._connectors = self._connectors, {}
        for connector in connectors.values():
            connector.close()
        self._web.close()
        self._http.close()
