"""Connector interface, plus helpers shared by connectors."""

from __future__ import annotations

from collections.abc import Callable
from fnmatch import fnmatchcase
from typing import Protocol

from erp_agent.errors import QueryRejected
from erp_agent.models import EntityInfo, EntitySchema, QueryResult, QuerySpec


class ErpConnector(Protocol):
    """Read-only access to one Odoo connection.

    Implementations receive resolved `QuerySpec`s: the limit is already capped and the entity has
    passed the connection's allowlist. Implementations validate field names against the ERP schema
    and never modify ERP data.
    """

    kind: str

    def list_entities(self, search: str | None, limit: int) -> tuple[EntityInfo, ...]:
        """List readable entities.

        @param search: Case-insensitive substring matched against name and label; None lists all.
        @param limit: Maximum entities to return.
        @returns: Matching entities.
        """
        ...

    def describe_entity(self, entity: str) -> EntitySchema:
        """Describe one entity's fields.

        @param entity: Entity name as listed by `list_entities`.
        @returns: The entity's fields.
        @raises QueryRejected: When the entity does not exist.
        """
        ...

    def query(self, spec: QuerySpec) -> QueryResult:
        """Read rows.

        @param spec: Resolved query.
        @returns: At most `spec.limit` rows; `truncated` reports whether more matched.
        @raises QueryRejected: When a field does not exist on the entity.
        """
        ...

    def close(self) -> None:
        """Release network or database resources. Safe to call more than once."""
        ...


def require_fields(schema: EntitySchema, spec: QuerySpec) -> None:
    """Check that every field a query names exists on the entity.

    @param schema: Entity schema from the ERP.
    @param spec: Query to check.
    @raises QueryRejected: Naming the unknown fields.
    """
    names = schema.field_names()
    used = {*spec.fields, *(f.field for f in spec.filters), *(o.field for o in spec.order_by)}
    unknown = sorted(used - names)
    if unknown:
        raise QueryRejected(
            f"unknown field(s) on {schema.entity}: {', '.join(unknown)}; call erp_describe_entity to list valid fields"
        )


EntityPredicate = Callable[[str], bool]


def pattern_predicate(allow: tuple[str, ...], deny: tuple[str, ...]) -> EntityPredicate:
    """Build a case-sensitive entity predicate from fnmatch patterns.

    @param allow: Patterns of which one must match when the tuple is non-empty.
    @param deny: Patterns that must not match; deny wins over allow.
    @returns: Predicate on entity names.
    """

    def allowed(name: str) -> bool:
        if any(fnmatchcase(name, p) for p in deny):
            return False
        return not allow or any(fnmatchcase(name, p) for p in allow)

    return allowed


def split_truncated[T](rows: list[T], limit: int) -> tuple[tuple[T, ...], bool]:
    """Split rows fetched with `limit + 1` into the returned page and a truncation flag.

    @param rows: Rows fetched with one extra row.
    @param limit: Page size.
    @returns: (first `limit` rows, whether an extra row existed).
    """
    return tuple(rows[:limit]), len(rows) > limit
