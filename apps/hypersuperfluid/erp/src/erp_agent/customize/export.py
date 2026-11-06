"""Export a change set as an Odoo data module: a manifest plus one XML data file, zipped.

A data module holds no Python, so Odoo Online installs it too (Apps > Import Module, `base_import_module`).
Records refer to models, fields and selection values through `search` attributes instead of database ids, so the
module installs on another database of the same Odoo version. Stage and tag ids are database-specific; the
exporter keeps them and warns.
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

from lxml import etree

from erp_agent.customize.catalog import OdooCatalog
from erp_agent.customize.changes import (
    ActionSpec,
    AddAutomation,
    AddField,
    AddScheduledAction,
    AddServerAction,
    CodeAction,
    ExtendView,
    UpdateFieldAction,
)
from erp_agent.customize.planner import resolve_trigger
from erp_agent.customize.store import ChangeSet
from erp_agent.errors import QueryRejected

_MODULE_NAME = re.compile(r"^[a-z][a-z0-9_]{2,59}$")


@dataclass(frozen=True)
class ExportedModule:
    """Where the module was written and what a reviewer should know before installing it."""

    module: str
    zip_path: Path
    files: tuple[str, ...]
    warnings: tuple[str, ...]


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:40] or "item"


def _search(model: str) -> str:
    return repr([("model", "=", model)])


class _Writer:
    def __init__(self, catalog: OdooCatalog) -> None:
        self._catalog = catalog
        self.root = etree.Element("odoo")
        self.warnings: list[str] = []
        self._ids: set[str] = set()

    def record(self, model: str, base: str) -> etree._Element:
        xml_id = _slug(base)
        candidate, n = xml_id, 2
        while candidate in self._ids:
            candidate, n = f"{xml_id}_{n}", n + 1
        self._ids.add(candidate)
        return etree.SubElement(self.root, "record", id=candidate, model=model)

    @staticmethod
    def field(record: etree._Element, name: str, text: str | None = None, **attrs: str) -> etree._Element:
        element = etree.SubElement(record, "field", {"name": name, **attrs})
        if text is not None:
            element.text = text
        return element

    def add_field(self, change: AddField) -> None:
        rec = self.record("ir.model.fields", f"field_{change.model}_{change.name}")
        self.field(rec, "model_id", search=_search(change.model))
        self.field(rec, "name", change.name)
        self.field(rec, "ttype", change.type)
        self.field(rec, "field_description", change.label)
        self.field(rec, "state", "manual")
        self.field(rec, "required", eval=repr(change.required))
        if change.help:
            self.field(rec, "help", change.help)
        if change.relation:
            self.field(rec, "relation", change.relation)
        if change.selection:
            options = [
                (0, 0, {"value": o.value, "name": o.label, "sequence": i}) for i, o in enumerate(change.selection)
            ]
            self.field(rec, "selection_ids", eval=repr(options))
        if change.tracking:
            self.field(rec, "tracking", eval="100")

    def extend_view(self, change: ExtendView) -> None:
        parent = self._catalog.view(change.inherit)
        if parent.xml_id is None:
            raise QueryRejected(f"view {change.inherit} has no XML id, so the module could not refer to it")
        rec = self.record("ir.ui.view", f"view_{change.name}")
        self.field(rec, "name", change.name)
        self.field(rec, "model", change.model)
        self.field(rec, "inherit_id", ref=parent.xml_id)
        self.field(rec, "mode", "extension")
        self.field(rec, "priority", eval=str(change.priority))
        arch = self.field(rec, "arch", type="xml")
        arch.append(etree.fromstring(change.arch.encode("utf-8"), parser=etree.XMLParser(resolve_entities=False)))

    def action_fields(self, rec: etree._Element, model: str, action: ActionSpec) -> None:
        match action:
            case CodeAction():
                self.field(rec, "state", "code")
                self.field(rec, "code", action.code)
            case UpdateFieldAction():
                self.field(rec, "state", "object_write")
                self.field(rec, "update_path", action.field)
                self.field(rec, "evaluation_type", "equation" if action.compute else "value")
                self.field(rec, "value", action.value)
                meta = self._catalog.fields(model).get(action.field)
                if meta is not None and meta.type == "boolean" and not action.compute:
                    self.field(rec, "update_boolean_value", action.value.lower())

    def server_action(self, change: AddServerAction) -> None:
        rec = self.record("ir.actions.server", f"action_{change.name}")
        self.field(rec, "name", change.name)
        self.field(rec, "model_id", search=_search(change.model))
        if change.show_in_action_menu:
            self.field(rec, "binding_model_id", search=_search(change.model))
            self.field(rec, "binding_type", "action")
        self.action_fields(rec, change.model, change.action)

    def automation(self, change: AddAutomation) -> None:
        rule = resolve_trigger(change, self._catalog.fields(change.model))
        rec = self.record("base.automation", f"automation_{change.name}")
        self.field(rec, "name", change.name)
        self.field(rec, "model_id", search=_search(change.model))
        self.field(rec, "trigger", change.trigger)
        if rule.date_field is not None:
            self.field(rec, "trg_date_id", search=repr([("model", "=", change.model), ("name", "=", rule.date_field)]))
            self.field(rec, "trg_date_range", eval=str(change.delay))
            self.field(rec, "trg_date_range_type", change.delay_unit)
        if rule.watched:
            key = "on_change_field_ids" if change.trigger == "on_change" else "trigger_field_ids"
            self.field(rec, key, search=repr([("model", "=", change.model), ("name", "in", list(rule.watched))]))
        if rule.selection is not None:
            field_name, value = rule.selection
            domain = [("field_id.model", "=", change.model), ("field_id.name", "=", field_name), ("value", "=", value)]
            self.field(rec, "trg_selection_field_id", search=repr(domain))
        if rule.record_ref is not None:
            self.field(rec, "trg_field_ref", eval=str(rule.record_ref))
            self.warnings.append(
                f'automation "{change.name}" refers to record id {rule.record_ref}; check it on the target database'
            )
        if rule.domain is not None:
            self.field(rec, "filter_domain", rule.domain)
        if rule.pre_domain is not None:
            self.field(rec, "filter_pre_domain", rule.pre_domain)
        rule_id = rec.get("id", "")
        for i, action in enumerate(change.actions, start=1):
            act = self.record("ir.actions.server", f"{rule_id}_action_{i}")
            self.field(act, "name", f"{change.name}: action {i}")
            self.field(act, "model_id", search=_search(change.model))
            self.field(act, "usage", "base_automation")
            self.field(act, "base_automation_id", ref=rule_id)
            self.action_fields(act, change.model, action)

    def scheduled_action(self, change: AddScheduledAction) -> None:
        rec = self.record("ir.cron", f"cron_{change.name}")
        self.field(rec, "name", change.name)
        self.field(rec, "model_id", search=_search(change.model))
        self.field(rec, "state", "code")
        self.field(rec, "code", change.code)
        self.field(rec, "usage", "ir_cron")
        self.field(rec, "interval_number", eval=str(change.interval))
        self.field(rec, "interval_type", change.interval_unit)
        self.field(rec, "active", eval="True")


def _manifest(module: str, changeset: ChangeSet) -> str:
    depends = sorted(set(changeset.depends) | {"base"})
    title = changeset.title.replace("\\", "\\\\").replace('"', '\\"')
    return (
        "{\n"
        f'    "name": "{title}",\n'
        '    "version": "1.0",\n'
        '    "summary": "Customizations built with Superfluid",\n'
        f'    "description": "Change set {changeset.id}",\n'
        f'    "depends": {depends!r},\n'
        '    "data": ["data/customizations.xml"],\n'
        '    "license": "LGPL-3",\n'
        '    "installable": True,\n'
        "}\n"
    )


def export_module(changeset: ChangeSet, module: str, catalog: OdooCatalog, export_dir: Path) -> ExportedModule:
    """Write `<export_dir>/<module>.zip` holding `<module>/__manifest__.py` and `<module>/data/customizations.xml`.

    @param changeset: Change set to export.
    @param module: Technical module name, such as `acme_po_approval`.
    @param catalog: Metadata of the database the change set was planned on.
    @param export_dir: Output directory.
    @returns: The written module.
    @raises QueryRejected: On an invalid module name or a view without an XML id.
    """
    if not _MODULE_NAME.fullmatch(module):
        raise QueryRejected("module names are 3-60 characters of a-z, 0-9 and _, starting with a letter")
    writer = _Writer(catalog)
    for change in changeset.changes:
        match change:
            case AddField():
                writer.add_field(change)
            case ExtendView():
                writer.extend_view(change)
            case AddServerAction():
                writer.server_action(change)
            case AddAutomation():
                writer.automation(change)
            case AddScheduledAction():
                writer.scheduled_action(change)
    xml = etree.tostring(writer.root, pretty_print=True, xml_declaration=True, encoding="utf-8")
    files = {
        f"{module}/__init__.py": b"",
        f"{module}/__manifest__.py": _manifest(module, changeset).encode("utf-8"),
        f"{module}/data/customizations.xml": xml,
    }
    export_dir.mkdir(parents=True, exist_ok=True)
    zip_path = export_dir / f"{module}.zip"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    zip_path.write_bytes(buffer.getvalue())
    return ExportedModule(module=module, zip_path=zip_path, files=tuple(files), warnings=tuple(writer.warnings))
