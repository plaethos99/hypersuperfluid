"""Odoo connector over the external API (JSON-2 or XML-RPC, see `odoo_transport`).

Only three read calls are made: `ir.model` `search_read`, `fields_get`, and `search_read` on the
target model. The API key should belong to a user whose access rights are read-only.
"""

from __future__ import annotations

from typing import Any

from erp_agent.config import OdooConnection
from erp_agent.connectors.base import EntityPredicate, require_fields, split_truncated
from erp_agent.connectors.odoo_transport import AutoTransport, Json2Transport, OdooTransport, XmlRpcTransport
from erp_agent.errors import QueryRejected
from erp_agent.models import EntityInfo, EntitySchema, FieldInfo, Filter, QueryResult, QuerySpec

_OPERATORS = {
    "=": "=",
    "!=": "!=",
    ">": ">",
    ">=": ">=",
    "<": "<",
    "<=": "<=",
    "in": "in",
    "not in": "not in",
    "like": "=like",
    "ilike": "=ilike",
}


def to_domain(filters: tuple[Filter, ...]) -> list[list[object]]:
    """Translate filters into an Odoo domain (implicit AND).

    `like`/`ilike` map to Odoo's `=like`/`=ilike`, which honour `%` wildcards the same way SQL does.
    Odoo stores empty values as `False`, so the null operators compare with `False`.

    @param filters: Structured filters.
    @returns: Odoo domain list.
    """
    domain: list[list[object]] = []
    for flt in filters:
        match flt.op:
            case "is null":
                domain.append([flt.field, "=", False])
            case "is not null":
                domain.append([flt.field, "!=", False])
            case _:
                domain.append([flt.field, _OPERATORS[flt.op], flt.value])
    return domain


def _flatten(value: object) -> object:
    # Many2one values arrive as [id, display_name]; keep both in a readable form.
    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], int) and isinstance(value[1], str):
        return {"id": value[0], "name": value[1]}
    if value is False:
        return None
    return value


def build_transport(name: str, connection: OdooConnection, api_key: str) -> OdooTransport:
    """Create the transport the connection's `protocol` selects.

    @param name: Connection name.
    @param connection: Odoo connection configuration.
    @param api_key: The bot user's API key.
    @returns: A JSON-2, XML-RPC or auto-detecting transport.
    """

    def xmlrpc() -> XmlRpcTransport:
        return XmlRpcTransport.create(
            name, connection.url, connection.database, connection.username, api_key, connection.timeout_s
        )

    if connection.protocol == "xmlrpc":
        return xmlrpc()
    json2 = Json2Transport.create(name, connection.url, connection.database, api_key, connection.timeout_s)
    if connection.protocol == "json2":
        return json2
    return AutoTransport(json2, xmlrpc)


class OdooConnector:
    """Read-only Odoo connector."""

    kind = "odoo"

    def __init__(self, name: str, transport: OdooTransport, entity_allowed: EntityPredicate) -> None:
        """@param name: Connection name.
        @param transport: Odoo API transport; closed by `close`.
        @param entity_allowed: Model allow predicate."""
        self._name = name
        self._transport = transport
        self._entity_allowed = entity_allowed
        self._schemas: dict[str, EntitySchema] = {}

    def _call(self, model: str, method: str, params: dict[str, object]) -> Any:
        return self._transport.call(model, method, params)

    def list_entities(self, search: str | None, limit: int) -> tuple[EntityInfo, ...]:
        domain: list[object] = [["transient", "=", False]]
        if search:
            domain = [*domain, "|", ["model", "ilike", search], ["name", "ilike", search]]
        # Over-fetch so that denied models do not shrink the page below `limit`.
        records = self._call(
            "ir.model", "search_read", {"domain": domain, "fields": ["model", "name"], "limit": limit * 4}
        )
        allowed = [r for r in records if self._entity_allowed(r["model"])]
        return tuple(EntityInfo(name=r["model"], label=r["name"]) for r in allowed[:limit])

    def describe_entity(self, entity: str) -> EntitySchema:
        if entity in self._schemas:
            return self._schemas[entity]
        if not self._entity_allowed(entity):
            raise QueryRejected(f"{entity} is not readable on {self._name}")
        fields = self._call(entity, "fields_get", {"attributes": ["string", "type", "required", "relation"]})
        schema = EntitySchema(
            entity=entity,
            fields=tuple(
                FieldInfo(
                    name=name,
                    type=str(meta.get("type", "")),
                    label=meta.get("string") or None,
                    required=bool(meta.get("required", False)),
                    relation=meta.get("relation") or None,
                )
                for name, meta in sorted(fields.items())
            ),
        )
        self._schemas = {**self._schemas, entity: schema}
        return schema

    def query(self, spec: QuerySpec) -> QueryResult:
        require_fields(self.describe_entity(spec.entity), spec)
        params: dict[str, object] = {
            "domain": to_domain(spec.filters),
            "limit": spec.limit + 1,
            "offset": spec.offset,
        }
        if spec.fields:
            params["fields"] = list(spec.fields)
        if spec.order_by:
            params["order"] = ", ".join(f"{o.field} {'desc' if o.descending else 'asc'}" for o in spec.order_by)
        records = self._call(spec.entity, "search_read", params)
        rows, truncated = split_truncated(
            [{k: _flatten(v) for k, v in record.items()} for record in records], spec.limit
        )
        columns = spec.fields or (tuple(rows[0].keys()) if rows else ())
        return QueryResult(connection=self._name, entity=spec.entity, columns=columns, rows=rows, truncated=truncated)

    def close(self) -> None:
        self._transport.close()
