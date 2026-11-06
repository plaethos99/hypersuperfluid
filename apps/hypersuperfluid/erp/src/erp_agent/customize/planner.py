"""Validate a change set against the live database and turn each change into the record Odoo should create.

Planning reads metadata only. Fields added earlier in the same change set count as existing for later changes,
so a set can add a field, show it on a form and use it in an automation rule. Record values mirror what Odoo's
own forms produce (see `addons/base_automation/models/base_automation.py` in Odoo 18), so a rule created here
looks and behaves like one made in the Automation Rules screen.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from erp_agent.connectors.base import EntityPredicate
from erp_agent.customize.catalog import FieldMeta, ModelInfo, OdooCatalog
from erp_agent.customize.changes import (
    MAIL_TRIGGERS,
    TIME_TRIGGERS,
    ActionSpec,
    AddAutomation,
    AddField,
    AddScheduledAction,
    AddServerAction,
    Change,
    CodeAction,
    ExtendView,
    UpdateFieldAction,
)
from erp_agent.customize.checks import Findings, check_arch, check_code, check_expression, join_domains, parse_domain
from erp_agent.errors import QueryRejected

# Odoo 18 `_get_trigger_specific_field`: accepted types and candidate names, in Odoo's order.
_TRIGGER_FIELDS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "on_stage_set": (("many2one",), ("stage_id", "x_studio_stage_id")),
    "on_tag_set": (("many2many",), ("tag_ids", "x_studio_tag_ids")),
    "on_priority_set": (("selection",), ("priority", "x_studio_priority")),
    "on_state_set": (("selection",), ("state", "x_studio_state")),
    "on_user_set": (("many2one", "many2many"), ("user_id", "user_ids", "x_studio_user_id", "x_studio_user_ids")),
    "on_archive": (("boolean",), ("active", "x_active")),
    "on_unarchive": (("boolean",), ("active", "x_active")),
    "on_time_created": (("datetime",), ("create_date",)),
    "on_time_updated": (("datetime",), ("write_date",)),
}
_SCALAR_UPDATE_TYPES = frozenset(
    {"char", "text", "html", "integer", "float", "monetary", "boolean", "date", "datetime", "selection", "many2one"}
)


@dataclass(frozen=True)
class PlannedChange:
    """What the person reviews for one change."""

    index: int
    kind: str
    model: str
    summary: str
    preview: str | None = None
    rollback_note: str | None = None


@dataclass
class Plan:
    """A validated change set: per-change summaries, findings, and the modules an exported data module needs."""

    changes: list[PlannedChange] = field(default_factory=list)
    findings: Findings = field(default_factory=Findings)
    depends: set[str] = field(default_factory=lambda: {"base"})


def _lines(code: str) -> str:
    count = len(code.strip().splitlines())
    return f"{count} line{'s' if count != 1 else ''}"


class Planner:
    """Checks changes against one database's metadata."""

    def __init__(self, catalog: OdooCatalog, model_allowed: EntityPredicate) -> None:
        """@param catalog: Metadata reads.
        @param model_allowed: Which models the connection lets the agent customize."""
        self._catalog = catalog
        self._model_allowed = model_allowed
        self._planned: dict[str, dict[str, FieldMeta]] = {}

    def _fields(self, model: str) -> dict[str, FieldMeta]:
        return {**self._catalog.fields(model), **self._planned.get(model, {})}

    def _target(self, model: str, where: str, found: Findings) -> ModelInfo | None:
        info = self._catalog.model(model)
        if info is None:
            found.errors.append(f"{where}: model {model} is not installed; find it with erp_list_entities")
            return None
        if not self._model_allowed(model):
            found.errors.append(f"{where}: customizing {model} is not allowed on this connection")
            return None
        if info.transient:
            found.errors.append(f"{where}: {model} is a wizard (transient model); customize the document model")
            return None
        return info

    def plan(self, changes: tuple[Change, ...]) -> Plan:
        """@param changes: Changes in the order they will be applied.
        @returns: The plan; `plan.findings.errors` is empty when the set can be applied."""
        plan = Plan()
        self._planned = {}
        for index, change in enumerate(changes, start=1):
            where = f"change {index} ({change.kind})"
            found = Findings()
            info = self._target(change.model, where, found)
            planned: PlannedChange | None = None
            if info is not None:
                if info.module:
                    plan.depends.add(info.module)
                match change:
                    case AddField():
                        planned = self._plan_field(index, change, info, where, found)
                    case ExtendView():
                        planned = self._plan_view(index, change, where, found, plan.depends)
                    case AddServerAction():
                        planned = self._plan_server_action(index, change, where, found)
                    case AddAutomation():
                        plan.depends.add("base_automation")
                        planned = self._plan_automation(index, change, where, found)
                    case AddScheduledAction():
                        found.extend(check_code(change.code, where))
                        planned = PlannedChange(
                            index, change.kind, change.model,
                            f'Scheduled action "{change.name}" on {change.model} every {change.interval} '
                            f"{change.interval_unit}: runs code ({_lines(change.code)})",
                            preview=change.code,
                        )  # fmt: skip
            plan.findings.extend(found)
            plan.changes.append(
                planned or PlannedChange(index, change.kind, change.model, f"{change.kind} on {change.model}")
            )
        return plan

    def _plan_field(self, index: int, change: AddField, info: ModelInfo, where: str, found: Findings) -> PlannedChange:
        fields = self._fields(change.model)
        if change.name in fields:
            found.errors.append(f"{where}: {change.model} already has a field named {change.name}")
        if change.relation is not None:
            target = self._catalog.model(change.relation)
            if target is None:
                found.errors.append(f"{where}: relation model {change.relation} is not installed")
            elif change.type == "many2many" and any(
                f.type == "many2many" and f.relation == change.relation and f.name.startswith("x_")
                for f in fields.values()
            ):
                found.warnings.append(
                    f"{where}: {change.model} already has a custom many2many to {change.relation}; Odoo gives both "
                    "the same relation table, so they would share their values"
                )
        if change.type == "monetary":
            currency = fields.get("currency_id") or fields.get("x_currency_id")
            if currency is None or currency.relation != "res.currency":
                found.errors.append(f"{where}: a monetary field needs a currency_id field on {change.model}")
        if change.tracking and "message_ids" not in fields:
            found.errors.append(f"{where}: tracking needs a model with a chatter; {change.model} has none")
        if change.required:
            found.warnings.append(
                f"{where}: required applies to existing records too; records with no value fail validation when saved"
            )
        self._planned.setdefault(change.model, {})[change.name] = FieldMeta(
            name=change.name,
            type=change.type,
            label=change.label,
            relation=change.relation,
            selection=tuple(o.value for o in change.selection),
            stored=True,
        )
        detail = f" -> {change.relation}" if change.relation else ""
        options = f" [{', '.join(o.value for o in change.selection)}]" if change.selection else ""
        return PlannedChange(
            index, change.kind, change.model,
            f'Add field "{change.label}" ({change.name}, {change.type}{detail}{options}) to {info.label} '
            f"({change.model})",
            rollback_note=f"Rolling back deletes {change.name} and every value stored in it.",
        )  # fmt: skip

    def _plan_view(
        self, index: int, change: ExtendView, where: str, found: Findings, depends: set[str]
    ) -> PlannedChange | None:
        try:
            parent = self._catalog.view(change.inherit)
            arch = check_arch(change.arch, where)
        except (QueryRejected, ValueError) as exc:
            found.errors.append(f"{where}: {exc}")
            return None
        if parent.model != change.model:
            found.errors.append(f"{where}: view {change.inherit} belongs to {parent.model}, not {change.model}")
            return None
        if parent.xml_id:
            depends.add(parent.xml_id.split(".", 1)[0])
        else:
            found.warnings.append(f"{where}: view {change.inherit} has no XML id, so this change cannot be exported")
        fields = self._fields(change.model)
        unknown = [name for name in arch.fields if name not in fields]
        if unknown:
            found.errors.append(
                f"{where}: the arch adds fields that {change.model} does not have: {', '.join(unknown)}"
            )
        shown = f"; shows {', '.join(arch.fields)}" if arch.fields else ""
        return PlannedChange(
            index, change.kind, change.model,
            f'Extend {parent.type} view "{parent.name}" ({parent.xml_id or parent.id}) with "{change.name}"{shown}',
            preview=change.arch,
        )  # fmt: skip

    def _check_action(self, model: str, action: ActionSpec, where: str, found: Findings) -> str:
        match action:
            case CodeAction():
                found.extend(check_code(action.code, where))
                return f"runs code ({_lines(action.code)})"
            case UpdateFieldAction():
                meta = self._fields(model).get(action.field)
                if meta is None:
                    found.errors.append(f"{where}: {model} has no field {action.field}")
                    return f"sets {action.field}"
                if not meta.stored and not action.compute:
                    found.warnings.append(f"{where}: {action.field} is not stored; setting it may have no effect")
                if action.compute:
                    found.extend(check_expression(action.value, where))
                    return f"sets {action.field} = {action.value} (computed)"
                if meta.type not in _SCALAR_UPDATE_TYPES:
                    found.errors.append(f"{where}: use a code action to change the {meta.type} field {action.field}")
                elif meta.type == "boolean" and action.value.lower() not in ("true", "false"):
                    found.errors.append(f"{where}: {action.field} is a boolean; value must be true or false")
                elif meta.type == "selection" and action.value not in meta.selection:
                    found.errors.append(
                        f"{where}: {action.value!r} is not an option of {action.field}: {', '.join(meta.selection)}"
                    )
                elif meta.type in ("many2one", "integer") and not action.value.lstrip("-").isdigit():
                    found.errors.append(f"{where}: {action.field} needs a numeric value (a record id for many2one)")
                return f"sets {action.field} = {action.value!r}"

    def _plan_server_action(self, index: int, change: AddServerAction, where: str, found: Findings) -> PlannedChange:
        does = self._check_action(change.model, change.action, where, found)
        menu = ", offered in the Action menu" if change.show_in_action_menu else ""
        preview = change.action.code if isinstance(change.action, CodeAction) else None
        return PlannedChange(
            index, change.kind, change.model, f'Server action "{change.name}" on {change.model}{menu}: {does}', preview
        )

    def _check_domain(self, model: str, source: str | None, where: str, found: Findings) -> None:
        if source is None:
            return
        try:
            domain = parse_domain(source, where)
        except ValueError as exc:
            found.errors.append(str(exc))
            return
        fields = self._fields(model)
        unknown = sorted({p.split(".", 1)[0] for p in domain.field_paths} - set(fields) - {"id"})
        if unknown:
            found.errors.append(f"{where}: domain names fields {model} does not have: {', '.join(unknown)}")

    def _plan_automation(self, index: int, change: AddAutomation, where: str, found: Findings) -> PlannedChange:
        fields = self._fields(change.model)
        when = change.trigger.removeprefix("on_").replace("_", " ")
        if change.trigger in _TRIGGER_FIELDS:
            ttypes, names = _TRIGGER_FIELDS[change.trigger]
            meta = next((fields[n] for n in names if n in fields and fields[n].type in ttypes), None)
            if meta is None:
                found.errors.append(f"{where}: {change.trigger} needs one of these fields on {change.model}: {names}")
            elif (
                change.trigger in ("on_state_set", "on_priority_set")
                and str(change.trigger_value) not in meta.selection
            ):
                found.errors.append(
                    f"{where}: {change.trigger_value!r} is not an option of {meta.name}: {', '.join(meta.selection)}"
                )
            elif change.trigger in ("on_stage_set", "on_tag_set") and not str(change.trigger_value).isdigit():
                found.errors.append(f"{where}: {change.trigger} needs the id of the {meta.relation} record")
            if meta is not None and change.trigger_value is not None:
                when = f"{meta.label} is set to {change.trigger_value!r}"
        if change.trigger in MAIL_TRIGGERS and "message_ids" not in fields:
            found.errors.append(f"{where}: {change.trigger} needs a model with a chatter; {change.model} has none")
        if change.date_field is not None:
            date_meta = fields.get(change.date_field)
            if date_meta is None or date_meta.type not in ("date", "datetime"):
                found.errors.append(f"{where}: {change.date_field} is not a date or datetime field of {change.model}")
        unknown = [f for f in change.trigger_fields if f not in fields]
        if unknown:
            found.errors.append(f"{where}: trigger fields not on {change.model}: {', '.join(unknown)}")
        self._check_domain(change.model, change.filter_domain, where, found)
        self._check_domain(change.model, change.before_domain, where, found)
        does = [
            self._check_action(change.model, a, f"{where}, action {i}", found) for i, a in enumerate(change.actions, 1)
        ]
        if change.trigger in TIME_TRIGGERS:
            offset = f"{abs(change.delay)} {change.delay_unit} {'before' if change.delay < 0 else 'after'}"
            when = f"{offset} {change.date_field or change.trigger.removeprefix('on_time_')}"
        if change.trigger == "on_create_or_write" and change.trigger_fields:
            when = f"{', '.join(change.trigger_fields)} change"
        condition = f" and the record matches {change.filter_domain}" if change.filter_domain else ""
        if change.trigger == "on_webhook":
            found.warnings.append(f"{where}: anyone who knows the webhook URL can run this rule; share it carefully")
        previews = [a.code for a in change.actions if isinstance(a, CodeAction)]
        return PlannedChange(
            index, change.kind, change.model,
            f'Automation "{change.name}" on {change.model}: when {when}{condition}, {"; then ".join(does)}',
            preview="\n# ---\n".join(previews) or None,
        )  # fmt: skip


class RecordBuilder:
    """Builds the create values for each change at apply time, after earlier changes exist in Odoo."""

    def __init__(self, catalog: OdooCatalog) -> None:
        """@param catalog: Metadata reads of the database being changed."""
        self._catalog = catalog

    def values(self, change: Change) -> tuple[str, dict[str, Any]]:
        """@param change: A change that passed planning.
        @returns: (model to create in, create values)."""
        model_id = self._catalog.require_model(change.model).id
        match change:
            case AddField():
                return "ir.model.fields", self._field(change, model_id)
            case ExtendView():
                parent = self._catalog.view(change.inherit)
                return "ir.ui.view", {
                    "name": change.name,
                    "model": change.model,
                    "inherit_id": parent.id,
                    "mode": "extension",
                    "priority": change.priority,
                    "arch": change.arch,
                }
            case AddServerAction():
                vals = {"name": change.name, "model_id": model_id, **self._action(change.model, change.action)}
                if change.show_in_action_menu:
                    vals |= {"binding_model_id": model_id, "binding_type": "action"}
                return "ir.actions.server", vals
            case AddAutomation():
                return "base.automation", self._automation(change, model_id)
            case AddScheduledAction():
                return "ir.cron", {
                    "name": change.name,
                    "model_id": model_id,
                    "state": "code",
                    "code": change.code,
                    "usage": "ir_cron",
                    "interval_number": change.interval,
                    "interval_type": change.interval_unit,
                    "active": True,
                }

    def _field(self, change: AddField, model_id: int) -> dict[str, Any]:
        vals: dict[str, Any] = {
            "model_id": model_id,
            "name": change.name,
            "ttype": change.type,
            "field_description": change.label,
            "required": change.required,
            "state": "manual",
        }
        if change.help:
            vals["help"] = change.help
        if change.relation:
            vals["relation"] = change.relation
        if change.selection:
            vals["selection_ids"] = [
                [0, 0, {"value": o.value, "name": o.label, "sequence": i}] for i, o in enumerate(change.selection)
            ]
        if change.tracking:
            vals["tracking"] = 100
        return vals

    def _action(self, model: str, action: ActionSpec) -> dict[str, Any]:
        match action:
            case CodeAction():
                return {"state": "code", "code": action.code}
            case UpdateFieldAction():
                vals: dict[str, Any] = {
                    "state": "object_write",
                    "update_path": action.field,
                    "evaluation_type": "equation" if action.compute else "value",
                    "value": action.value,
                }
                meta = self._catalog.fields(model).get(action.field)
                if meta is not None and meta.type == "boolean" and not action.compute:
                    vals["update_boolean_value"] = action.value.lower()
                return vals

    def _automation(self, change: AddAutomation, model_id: int) -> dict[str, Any]:
        vals: dict[str, Any] = {
            "name": change.name,
            "model_id": model_id,
            "trigger": change.trigger,
            "active": True,
            "action_server_ids": [
                [0, 0, {
                    "name": f"{change.name}: action {i}",
                    "model_id": model_id,
                    "usage": "base_automation",
                    **self._action(change.model, action),
                }]
                for i, action in enumerate(change.actions, start=1)
            ],
        }  # fmt: skip
        rule = resolve_trigger(change, self._catalog.fields(change.model))
        if rule.date_field is not None:
            vals["trg_date_id"] = self._catalog.field_ids(change.model, (rule.date_field,))[0]
            vals["trg_date_range"] = change.delay
            vals["trg_date_range_type"] = change.delay_unit
        if rule.watched:
            key = "on_change_field_ids" if change.trigger == "on_change" else "trigger_field_ids"
            vals[key] = [[6, 0, self._catalog.field_ids(change.model, rule.watched)]]
        if rule.selection is not None:
            field_name, value = rule.selection
            selection_id = self._catalog.selection_id(change.model, field_name, value)
            if selection_id is None:
                raise QueryRejected(f"{value!r} is not an option of {change.model}.{field_name}")
            vals["trg_selection_field_id"] = selection_id
        if rule.record_ref is not None:
            vals["trg_field_ref"] = rule.record_ref
        if rule.domain is not None:
            vals["filter_domain"] = rule.domain
        if rule.pre_domain is not None:
            vals["filter_pre_domain"] = rule.pre_domain
        return vals


@dataclass(frozen=True)
class TriggerRule:
    """An automation rule's trigger settings by field name; the applier turns names into ids, the exporter into
    XML `search` attributes."""

    watched: tuple[str, ...] = ()
    date_field: str | None = None
    selection: tuple[str, str] | None = None
    record_ref: int | None = None
    domain: str | None = None
    pre_domain: str | None = None


def resolve_trigger(change: AddAutomation, fields: dict[str, FieldMeta]) -> TriggerRule:
    """Derive the settings Odoo's Automation Rules form computes for a trigger (Odoo 18 `_compute_*` methods).

    The trigger's own condition (such as `state = 'sale'` for "State is set to") is ANDed with the requested
    `filter_domain`, because setting `filter_domain` replaces the condition Odoo would compute.

    @param change: A planned automation rule.
    @param fields: Fields of its model.
    @returns: The trigger settings.
    @raises QueryRejected: When the model lacks the field the trigger watches.
    """
    watched = change.trigger_fields
    date_field = change.date_field
    selection: tuple[str, str] | None = None
    record_ref: int | None = None
    condition: str | None = None
    before: str | None = None
    if change.trigger in _TRIGGER_FIELDS:
        ttypes, names = _TRIGGER_FIELDS[change.trigger]
        meta = next((fields[n] for n in names if n in fields and fields[n].type in ttypes), None)
        if meta is None:
            raise QueryRejected(f"{change.model} has no field for {change.trigger}; it needs one of {names}")
        if change.trigger in TIME_TRIGGERS:
            date_field = meta.name
        else:
            watched = (meta.name,)
        value = change.trigger_value
        match change.trigger:
            case "on_state_set" | "on_priority_set":
                selection = (meta.name, str(value))
                condition = repr([(meta.name, "=", str(value))])
            case "on_stage_set":
                record_ref = int(str(value))
                condition = repr([(meta.name, "=", record_ref)])
            case "on_tag_set":
                record_ref = int(str(value))
                condition = repr([(meta.name, "in", [record_ref])])
                before = repr([(meta.name, "not in", [record_ref])])
            case "on_user_set":
                condition = repr([(meta.name, "!=", False)])
            case "on_archive":
                condition = repr([(meta.name, "=", False)])
            case "on_unarchive":
                condition = repr([(meta.name, "=", True)])
    return TriggerRule(
        watched=watched,
        date_field=date_field,
        selection=selection,
        record_ref=record_ref,
        domain=join_domains(condition, change.filter_domain),
        pre_domain=join_domains(before, change.before_domain),
    )
