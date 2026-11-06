"""Generate a complete, installable module skeleton: manifest, models, access rules, views, menus and a test.

The output follows the conventions of the workspace's Odoo version (Odoo 18: `<list>` views and `<chatter/>`;
Odoo 17: `<tree>` and the `oe_chatter` block), so a fresh scaffold passes `odoo_module_check` and installs.
"""

from __future__ import annotations

import re
from html import escape
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from erp_agent.models import check_entity_name

_FIELD = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
_MODEL = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
_RESERVED = frozenset({"id", "display_name", "create_uid", "create_date", "write_uid", "write_date"})


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Option(_Frozen):
    value: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=128)


ScaffoldFieldType = Literal[
    "char", "text", "html", "integer", "float", "monetary", "boolean", "date", "datetime", "selection",
    "many2one", "many2many",
]  # fmt: skip


class FieldSpec(_Frozen):
    name: str
    type: ScaffoldFieldType
    label: str = Field(min_length=1, max_length=128)
    required: bool = False
    help: str | None = Field(default=None, max_length=500)
    relation: str | None = None
    selection: tuple[Option, ...] = ()

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        if not _FIELD.fullmatch(value) or value in _RESERVED:
            raise ValueError(f"invalid field name {value!r}: snake_case, not one of {sorted(_RESERVED)}")
        return value

    @field_validator("relation")
    @classmethod
    def _check_relation(cls, value: str | None) -> str | None:
        return None if value is None else check_entity_name(value)

    @model_validator(mode="after")
    def _check_options(self) -> FieldSpec:
        if (self.type == "selection") != bool(self.selection):
            raise ValueError("`selection` options are required for selection fields and only for them")
        if (self.type in ("many2one", "many2many")) != (self.relation is not None):
            raise ValueError("`relation` is required for many2one and many2many fields and only for them")
        return self


class ModelSpec(_Frozen):
    name: str = Field(description="New model's technical name, such as acme.warranty.claim")
    description: str = Field(min_length=1, max_length=128, description="Human name, such as Warranty Claim")
    fields: tuple[FieldSpec, ...] = ()
    chatter: bool = Field(default=False, description="Messages, followers and activities (needs mail)")
    menu: bool = Field(default=True, description="Add a menu entry with list and form views")

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        if not _MODEL.fullmatch(value):
            raise ValueError(f"invalid model name {value!r}: dotted lowercase, such as acme.warranty.claim")
        return value

    @model_validator(mode="after")
    def _unique_fields(self) -> ModelSpec:
        names = [f.name for f in self.fields]
        if len(names) != len(set(names)):
            raise ValueError(f"{self.name}: field names must be unique")
        return self


class ScaffoldRequest(_Frozen):
    module: str
    title: str = Field(min_length=1, max_length=128)
    summary: str = Field(default="", max_length=300)
    depends: tuple[str, ...] = ("base",)
    models: tuple[ModelSpec, ...] = ()

    @field_validator("depends")
    @classmethod
    def _check_depends(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        for name in value:
            if not re.fullmatch(r"^[a-z][a-z0-9_]*$", name):
                raise ValueError(f"invalid dependency {name!r}")
        return value


def _class_name(model: str) -> str:
    return "".join(part.capitalize() for part in re.split(r"[._]", model))


def _ident(model: str) -> str:
    return model.replace(".", "_")


def _field_line(spec: FieldSpec, chatter: bool) -> str:
    kind = {"html": "Html", "many2one": "Many2one", "many2many": "Many2many", "datetime": "Datetime"}.get(
        spec.type, spec.type.capitalize()
    )
    args: list[str] = []
    if spec.type == "selection":
        args.append(repr([(o.value, o.label) for o in spec.selection]))
    if spec.relation:
        args.append(repr(spec.relation))
    args.append(f"string={spec.label!r}")
    if spec.required:
        args.append("required=True")
        if spec.type == "selection":
            args.append(f"default={spec.selection[0].value!r}")
    if spec.type == "monetary":
        args.append('currency_field="currency_id"')
    if spec.help:
        args.append(f"help={spec.help!r}")
    if chatter and spec.type not in ("html", "text", "many2many"):
        args.append("tracking=True")
    return f"    {spec.name} = fields.{kind}({', '.join(args)})"


def _model_fields(model: ModelSpec) -> tuple[FieldSpec, ...]:
    extra: list[FieldSpec] = []
    names = {f.name for f in model.fields}
    if "name" not in names:
        extra.append(FieldSpec(name="name", type="char", label="Name", required=True))
    if any(f.type == "monetary" for f in model.fields) and "currency_id" not in names:
        extra.append(FieldSpec(name="currency_id", type="many2one", label="Currency", relation="res.currency"))
    return (*extra, *model.fields)


def _python(model: ModelSpec) -> str:
    lines = ["from odoo import fields, models", "", "", f"class {_class_name(model.name)}(models.Model):"]
    lines.append(f"    _name = {model.name!r}")
    lines.append(f"    _description = {model.description!r}")
    if model.chatter:
        lines.append('    _inherit = ["mail.thread", "mail.activity.mixin"]')
    lines.append('    _order = "id desc"')
    lines.append("")
    for spec in _model_fields(model):
        line = _field_line(spec, model.chatter and spec.name != "currency_id")
        if spec.name == "currency_id":
            line = line[:-1] + ", default=lambda self: self.env.company.currency_id)"
        lines.append(line)
    return "\n".join(lines) + "\n"


def _test_value(spec: FieldSpec) -> str | None:
    return {
        "char": '"Test"', "text": '"Test"', "html": '"<p>Test</p>"', "integer": "1", "float": "1.0",
        "monetary": "10.0", "boolean": "True", "date": '"2026-01-15"', "datetime": '"2026-01-15 10:00:00"',
        "selection": repr(spec.selection[0].value) if spec.selection else None,
    }.get(spec.type)  # fmt: skip


def _test(module: str, models: tuple[ModelSpec, ...]) -> str:
    lines = [
        "from odoo.tests import TransactionCase, tagged",
        "",
        "",
        '@tagged("post_install", "-at_install")',
        f"class Test{_class_name(module)}(TransactionCase):",
    ]
    if not models:
        lines += ["    def test_module_installed(self):", f'        self.assertTrue(self.env["ir.module.module"]'
                  f'.search([("name", "=", {module!r}), ("state", "=", "installed")]))']  # fmt: skip
    for index, model in enumerate(models):
        lines += [""] if index else []
        lines += [f"    def test_create_{_ident(model.name)}(self):", "        values = {}"]
        for spec in _model_fields(model):
            if not spec.required:
                continue
            if spec.type == "many2one":
                lines += [
                    f"        related = self.env[{spec.relation!r}].search([], limit=1)",
                    "        if not related:",
                    f'            self.skipTest("no {spec.relation} record to link")',
                    f"        values[{spec.name!r}] = related.id",
                ]
            elif (value := _test_value(spec)) is not None:
                lines.append(f"        values[{spec.name!r}] = {value}")
        lines += [
            f"        record = self.env[{model.name!r}].create(values)",
            "        self.assertTrue(record.exists())",
        ]
    return "\n".join(lines) + "\n"


def _access(models: tuple[ModelSpec, ...]) -> str:
    rows = ["id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink"]
    for model in models:
        ident = _ident(model.name)
        rows.append(f"access_{ident}_user,{model.name} user,model_{ident},base.group_user,1,1,1,0")
        rows.append(f"access_{ident}_manager,{model.name} manager,model_{ident},base.group_system,1,1,1,1")
    return "\n".join(rows) + "\n"


def _views(model: ModelSpec, major: int, module: str) -> str:
    ident = _ident(model.name)
    fields = _model_fields(model)
    label = escape(model.description)
    list_tag = "list" if major >= 18 else "tree"
    list_fields = "\n".join(
        f'                <field name="{f.name}"{' column_invisible="True"' if f.name == "currency_id" else ""}/>'
        for f in fields
        if f.type not in ("html", "text", "many2many")
    )
    # The record name is the form's title; the currency only drives monetary fields, so it stays hidden.
    form_fields = "\n".join(
        f'                        <field name="{f.name}"{' invisible="1"' if f.name == "currency_id" else ""}/>'
        for f in fields
        if f.name != "name"
    )
    title = (
        '                    <div class="oe_title">\n'
        '                        <h1><field name="name" placeholder="Name"/></h1>\n'
        "                    </div>\n"
    )
    if not model.chatter:
        chatter = ""
    elif major >= 18:
        chatter = "\n                <chatter/>"
    else:
        chatter = (
            '\n                <div class="oe_chatter">\n                    <field name="message_follower_ids"/>'
            '\n                    <field name="activity_ids"/>\n                    <field name="message_ids"/>'
            "\n                </div>"
        )
    action = ""
    if model.menu:
        action = f"""
    <record id="{ident}_action" model="ir.actions.act_window">
        <field name="name">{label}</field>
        <field name="res_model">{model.name}</field>
        <field name="view_mode">{list_tag},form</field>
    </record>

    <menuitem id="{ident}_menu" name="{label}" parent="{module}_menu_root" action="{ident}_action"/>
"""
    return f"""<?xml version="1.0" encoding="utf-8"?>
<odoo>
    <record id="{ident}_view_{list_tag}" model="ir.ui.view">
        <field name="name">{model.name}.{list_tag}</field>
        <field name="model">{model.name}</field>
        <field name="arch" type="xml">
            <{list_tag}>
{list_fields}
            </{list_tag}>
        </field>
    </record>

    <record id="{ident}_view_form" model="ir.ui.view">
        <field name="name">{model.name}.form</field>
        <field name="model">{model.name}</field>
        <field name="arch" type="xml">
            <form>
                <sheet>
{title}                    <group>
{form_fields}
                    </group>
                </sheet>{chatter}
            </form>
        </field>
    </record>

    <record id="{ident}_view_search" model="ir.ui.view">
        <field name="name">{model.name}.search</field>
        <field name="model">{model.name}</field>
        <field name="arch" type="xml">
            <search>
                <field name="name"/>
            </search>
        </field>
    </record>
{action}</odoo>
"""


def scaffold(request: ScaffoldRequest, odoo_version: str, author: str | None, license_: str) -> dict[str, str]:
    """Build every file of a new module.

    @param request: What the module holds.
    @param odoo_version: Workspace Odoo version, such as `18.0`.
    @param author: Manifest author, or None.
    @param license_: Manifest license.
    @returns: Relative path -> content.
    """
    module = request.module
    major = int(odoo_version.split(".")[0])
    depends = list(dict.fromkeys(request.depends or ("base",)))
    if any(m.chatter for m in request.models) and "mail" not in depends:
        depends.append("mail")
    files: dict[str, str] = {}
    data: list[str] = []
    if request.models:
        files[f"{module}/models/__init__.py"] = "".join(f"from . import {_ident(m.name)}\n" for m in request.models)
        for model in request.models:
            files[f"{module}/models/{_ident(model.name)}.py"] = _python(model)
        files[f"{module}/security/ir.model.access.csv"] = _access(request.models)
        data.append("security/ir.model.access.csv")
        for model in request.models:
            files[f"{module}/views/{_ident(model.name)}_views.xml"] = _views(model, major, module)
        if any(m.menu for m in request.models):
            files[f"{module}/views/menus.xml"] = (
                '<?xml version="1.0" encoding="utf-8"?>\n<odoo>\n'
                f'    <menuitem id="{module}_menu_root" name="{escape(request.title)}" sequence="90"/>\n</odoo>\n'
            )
            data.append("views/menus.xml")
        data += [f"views/{_ident(m.name)}_views.xml" for m in request.models]
    files[f"{module}/__init__.py"] = "from . import models\n" if request.models else ""
    manifest = {
        "name": request.title,
        "version": f"{odoo_version}.1.0.0",
        "summary": request.summary,
        "author": author or "",
        "license": license_,
        "depends": depends,
        "data": data,
        "installable": True,
        "application": False,
    }
    body = ",\n".join(f"    {k!r}: {v!r}" for k, v in manifest.items())
    files[f"{module}/__manifest__.py"] = "{\n" + body + ",\n}\n"
    files[f"{module}/tests/__init__.py"] = f"from . import test_{module}\n"
    files[f"{module}/tests/test_{module}.py"] = _test(module, request.models)
    return files
