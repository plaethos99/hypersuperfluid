"""Live lookups the planner and the applier need: models, fields, views, selection values and XML ids.

Every call is a read (`search_read`, `fields_get`) made with the customization user's key. Results are cached
for the life of one catalog, which is created per plan or apply call so it never serves stale metadata.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from erp_agent.connectors.odoo_transport import OdooTransport
from erp_agent.errors import QueryRejected


@dataclass(frozen=True)
class ModelInfo:
    id: int
    model: str
    label: str
    module: str | None
    transient: bool


@dataclass(frozen=True)
class FieldMeta:
    name: str
    type: str
    label: str
    relation: str | None
    selection: tuple[str, ...]
    stored: bool


@dataclass(frozen=True)
class ViewInfo:
    id: int
    name: str
    model: str
    type: str
    xml_id: str | None


class OdooCatalog:
    """Cached metadata reads over one transport."""

    def __init__(self, transport: OdooTransport) -> None:
        """@param transport: Authenticated transport of the customization user."""
        self._transport = transport
        self._models: dict[str, ModelInfo | None] = {}
        self._fields: dict[str, dict[str, FieldMeta]] = {}

    def _search_read(self, model: str, domain: list[Any], fields: list[str], limit: int = 0) -> list[dict[str, Any]]:
        params: dict[str, object] = {"domain": domain, "fields": fields}
        if limit:
            params["limit"] = limit
        result: list[dict[str, Any]] = self._transport.call(model, "search_read", params)
        return result

    def model(self, name: str) -> ModelInfo | None:
        """@param name: Technical model name.
        @returns: The model, or None when it is not installed."""
        if name not in self._models:
            rows = self._search_read("ir.model", [["model", "=", name]], ["id", "model", "name", "transient"], 1)
            info = None
            if rows:
                row = rows[0]
                data = self._search_read(
                    "ir.model.data", [["model", "=", "ir.model"], ["res_id", "=", row["id"]]], ["module"], 1
                )
                info = ModelInfo(
                    id=int(row["id"]),
                    model=str(row["model"]),
                    label=str(row["name"]),
                    module=str(data[0]["module"]) if data else None,
                    transient=bool(row.get("transient")),
                )
            self._models[name] = info
        return self._models[name]

    def require_model(self, name: str) -> ModelInfo:
        """@raises QueryRejected: When the model is not installed."""
        info = self.model(name)
        if info is None:
            raise QueryRejected(
                f"model {name} is not installed on this database; check the name with erp_list_entities"
            )
        return info

    def fields(self, model: str) -> dict[str, FieldMeta]:
        """@param model: Installed model.
        @returns: Its fields by name."""
        if model not in self._fields:
            raw: dict[str, dict[str, Any]] = self._transport.call(
                model, "fields_get", {"attributes": ["string", "type", "relation", "selection", "store"]}
            )
            self._fields[model] = {
                name: FieldMeta(
                    name=name,
                    type=str(meta.get("type", "")),
                    label=str(meta.get("string") or name),
                    relation=meta.get("relation") or None,
                    selection=tuple(str(option[0]) for option in meta.get("selection") or ()),
                    stored=bool(meta.get("store", True)),
                )
                for name, meta in raw.items()
            }
        return self._fields[model]

    def field_ids(self, model: str, names: tuple[str, ...]) -> list[int]:
        """@param model: Model name.
        @param names: Field names on it.
        @returns: The `ir.model.fields` ids, in the order of `names`.
        @raises QueryRejected: When a field does not exist."""
        if not names:
            return []
        rows = self._search_read(
            "ir.model.fields", [["model", "=", model], ["name", "in", list(names)]], ["id", "name"]
        )
        by_name = {str(r["name"]): int(r["id"]) for r in rows}
        missing = [n for n in names if n not in by_name]
        if missing:
            raise QueryRejected(f"fields not found on {model}: {', '.join(missing)}")
        return [by_name[n] for n in names]

    def trigger_field(self, model: str, ttypes: tuple[str, ...], names: tuple[str, ...]) -> FieldMeta | None:
        """Find the field Odoo's automation rules watch for a trigger, in Odoo's own order of candidates.

        @param model: Model name.
        @param ttypes: Accepted field types.
        @param names: Candidate field names, such as `stage_id` then `x_studio_stage_id`.
        @returns: The first candidate the model has with an accepted type."""
        fields = self.fields(model)
        for name in names:
            meta = fields.get(name)
            if meta is not None and meta.type in ttypes:
                return meta
        return None

    def selection_id(self, model: str, field: str, value: str) -> int | None:
        """@returns: The `ir.model.fields.selection` id of one option, or None."""
        rows = self._search_read(
            "ir.model.fields.selection",
            [["field_id.model", "=", model], ["field_id.name", "=", field], ["value", "=", value]],
            ["id"],
            1,
        )
        return int(rows[0]["id"]) if rows else None

    def forget(self, model: str) -> None:
        """Drop cached fields of `model` after its fields changed.

        @param model: Model name."""
        self._fields.pop(model, None)

    def existing_ids(self, model: str, ids: list[int]) -> set[int]:
        """@returns: The subset of `ids` that still exist (archived records included)."""
        if not ids:
            return set()
        rows = self._transport.call(
            model,
            "search_read",
            {"domain": [["id", "in", ids]], "fields": ["id"], "context": {"active_test": False}},
        )
        return {int(r["id"]) for r in rows}

    def view(self, ref: str) -> ViewInfo:
        """@param ref: XML id such as `sale.view_order_form`, or a numeric view id.
        @returns: The view.
        @raises QueryRejected: When it does not exist."""
        if ref.isdigit():
            view_id, xml_id = int(ref), None
        else:
            module, _, name = ref.partition(".")
            if not module or not name:
                raise QueryRejected(f"view reference {ref!r} must be module.name or a numeric id")
            data = self._search_read(
                "ir.model.data",
                [["module", "=", module], ["name", "=", name], ["model", "=", "ir.ui.view"]],
                ["res_id"],
                1,
            )
            if not data:
                raise QueryRejected(f"no view with XML id {ref}")
            view_id, xml_id = int(data[0]["res_id"]), ref
        rows = self._search_read("ir.ui.view", [["id", "=", view_id]], ["id", "name", "model", "type"], 1)
        if not rows:
            raise QueryRejected(f"view {ref} does not exist")
        if xml_id is None:
            data = self._search_read(
                "ir.model.data", [["model", "=", "ir.ui.view"], ["res_id", "=", view_id]], ["module", "name"], 1
            )
            xml_id = f"{data[0]['module']}.{data[0]['name']}" if data else None
        row = rows[0]
        return ViewInfo(
            id=view_id, name=str(row["name"]), model=str(row["model"]), type=str(row["type"]), xml_id=xml_id
        )
