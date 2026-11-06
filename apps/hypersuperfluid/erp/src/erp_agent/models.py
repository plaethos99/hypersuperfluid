"""Immutable data types shared by connectors, the service and the MCP server."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Scalar = str | int | float | bool | None
FilterValue = Scalar | list[str | int | float | bool]

FilterOp = Literal["=", "!=", ">", ">=", "<", "<=", "in", "not in", "like", "ilike", "is null", "is not null"]
"""Comparison operators every connector translates. `like`/`ilike` use `%` as the wildcard."""

_FIELD_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ENTITY_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


def check_field_name(name: str) -> str:
    """Validate an ERP field name.

    @param name: Field name as supplied by the model.
    @returns: The unchanged name.
    @raises ValueError: When the name contains characters outside `[A-Za-z0-9_]`.
    """
    if not _FIELD_NAME.fullmatch(name):
        raise ValueError(f"invalid field name {name!r}")
    return name


def check_entity_name(name: str) -> str:
    """Validate an Odoo model name such as `account.move`.

    @param name: Entity name as supplied by the model.
    @returns: The unchanged name.
    @raises ValueError: When the name contains other characters.
    """
    if not _ENTITY_NAME.fullmatch(name):
        raise ValueError(f"invalid entity name {name!r}")
    return name


class FieldInfo(_Frozen):
    """One field of an ERP entity."""

    name: str
    type: str
    label: str | None = None
    required: bool = False
    relation: str | None = Field(default=None, description="Target entity of a reference field")


class EntityInfo(_Frozen):
    """One readable entity in an ERP catalog."""

    name: str
    label: str | None = None
    description: str | None = None


class EntitySchema(_Frozen):
    """Fields of one entity."""

    entity: str
    label: str | None = None
    fields: tuple[FieldInfo, ...]

    def field_names(self) -> frozenset[str]:
        """@returns: The set of field names in this schema."""
        return frozenset(f.name for f in self.fields)


class Filter(_Frozen):
    """One condition of a structured query; conditions in a query are combined with AND."""

    field: str
    op: FilterOp = "="
    value: FilterValue = None

    @field_validator("field")
    @classmethod
    def _check_field(cls, value: str) -> str:
        return check_field_name(value)

    @model_validator(mode="after")
    def _value_matches_op(self) -> Filter:
        is_list = isinstance(self.value, list)
        if self.op in ("in", "not in") and not (is_list and self.value):
            raise ValueError(f"operator {self.op!r} needs a non-empty list value")
        if self.op not in ("in", "not in") and is_list:
            raise ValueError(f"operator {self.op!r} needs a scalar value")
        if self.op in ("is null", "is not null") and self.value is not None:
            raise ValueError(f"operator {self.op!r} takes no value")
        return self


class OrderBy(_Frozen):
    """One sort key."""

    field: str
    descending: bool = False

    @field_validator("field")
    @classmethod
    def _check_field(cls, value: str) -> str:
        return check_field_name(value)


class QueryRequest(_Frozen):
    """A structured read as requested by the model; `limit` is capped during resolution."""

    entity: str
    fields: tuple[str, ...] = ()
    filters: tuple[Filter, ...] = ()
    order_by: tuple[OrderBy, ...] = ()
    limit: int | None = Field(default=None, ge=1)
    offset: int = Field(default=0, ge=0)

    @field_validator("entity")
    @classmethod
    def _check_entity(cls, value: str) -> str:
        return check_entity_name(value)

    @field_validator("fields")
    @classmethod
    def _check_fields(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(check_field_name(f) for f in value)


class QuerySpec(_Frozen):
    """A resolved query: `limit` is always set and within the connection's cap."""

    entity: str
    fields: tuple[str, ...]
    filters: tuple[Filter, ...]
    order_by: tuple[OrderBy, ...]
    limit: int = Field(ge=1)
    offset: int = Field(ge=0)


class AggregateRequest(_Frozen):
    """Counts and totals of the rows matching `filters`, per distinct combination of `group_by` values."""

    entity: str
    group_by: tuple[str, ...] = Field(default=(), max_length=3)
    sum_fields: tuple[str, ...] = Field(default=(), max_length=10)
    filters: tuple[Filter, ...] = ()

    @field_validator("entity")
    @classmethod
    def _check_entity(cls, value: str) -> str:
        return check_entity_name(value)

    @field_validator("group_by", "sum_fields")
    @classmethod
    def _check_fields(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(check_field_name(f) for f in value)


class AggregateResult(_Frozen):
    """Groups, largest first by the first sum field (else by count), and the totals over every matching row."""

    connection: str
    entity: str
    group_by: tuple[str, ...]
    sum_fields: tuple[str, ...]
    groups: tuple[dict[str, object], ...]
    totals: dict[str, object]


class QueryResult(_Frozen):
    """Rows returned by a query. `truncated` is true when more rows matched than `limit`."""

    connection: str
    entity: str
    columns: tuple[str, ...]
    rows: tuple[dict[str, object], ...]
    truncated: bool

    @property
    def row_count(self) -> int:
        """@returns: Number of rows in `rows`."""
        return len(self.rows)


class WebPage(_Frozen):
    """Readable text of one web page or document."""

    url: str
    title: str | None
    text: str
    truncated: bool
    source: Literal["builtin", "firecrawl"]


class CrawlResult(_Frozen):
    """Pages collected from one site. `skipped` lists URLs not read, each with the reason."""

    start_url: str
    pages: tuple[WebPage, ...]
    skipped: tuple[str, ...]
    stopped_reason: str | None


class ExtractedTable(_Frozen):
    """A table extracted from a document or web page."""

    source: str
    name: str
    columns: tuple[str, ...]
    rows: tuple[dict[str, object], ...]
    truncated: bool
