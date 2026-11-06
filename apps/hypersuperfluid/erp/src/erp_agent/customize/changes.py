"""Customization requests the model sends, one type per kind of change.

These are the no-code building blocks every Odoo edition runs, Odoo Online included: custom fields
(`ir.model.fields`), inherited views (`ir.ui.view`), server actions (`ir.actions.server`), automation rules
(`base.automation`) and scheduled actions (`ir.cron`). Shape checks live here; checks against the live
database live in `planner`.
"""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from erp_agent.models import check_entity_name, check_field_name

_CUSTOM_FIELD = re.compile(r"^x_[a-z0-9_]{1,60}$")


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


FieldType = Literal[
    "char", "text", "html", "integer", "float", "monetary", "boolean", "date", "datetime", "selection",
    "many2one", "many2many",
]  # fmt: skip


class SelectionOption(_Frozen):
    value: str = Field(min_length=1, max_length=64, description="Stored value, such as `high`")
    label: str = Field(min_length=1, max_length=128, description="Label users see, such as `High`")


class AddField(_Frozen):
    """A custom field on an existing model. Odoo requires custom field names to start with `x_`."""

    kind: Literal["add_field"]
    model: str = Field(description="Technical model name, such as `sale.order`")
    name: str = Field(description="Technical name starting with x_, such as `x_warranty_end`")
    type: FieldType
    label: str = Field(min_length=1, max_length=128)
    help: str | None = Field(default=None, max_length=1000, description="Tooltip shown to users")
    required: bool = False
    selection: tuple[SelectionOption, ...] = Field(default=(), description="Options of a selection field")
    relation: str | None = Field(default=None, description="Target model of a many2one or many2many field")
    tracking: bool = Field(default=False, description="Log changes in the chatter (models with a chatter only)")

    @field_validator("model", "relation")
    @classmethod
    def _check_model(cls, value: str | None) -> str | None:
        return None if value is None else check_entity_name(value)

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        if not _CUSTOM_FIELD.fullmatch(value):
            raise ValueError(f"custom field names must match x_[a-z0-9_]+ (Odoo requires the x_ prefix): {value!r}")
        return value

    @model_validator(mode="after")
    def _check_type_options(self) -> AddField:
        if self.type == "selection" and not self.selection:
            raise ValueError("a selection field needs at least one option in `selection`")
        if self.type != "selection" and self.selection:
            raise ValueError("`selection` is only for selection fields")
        if self.type in ("many2one", "many2many") and self.relation is None:
            raise ValueError(f"a {self.type} field needs `relation`, the target model")
        if self.type not in ("many2one", "many2many") and self.relation is not None:
            raise ValueError("`relation` is only for many2one and many2many fields")
        values = [o.value for o in self.selection]
        if len(values) != len(set(values)):
            raise ValueError("selection values must be unique")
        return self


class ExtendView(_Frozen):
    """An extension of an existing view, written as Odoo inheritance XML (`<xpath>` or `<data>` of xpaths)."""

    kind: Literal["extend_view"]
    model: str = Field(description="Model the view belongs to; checked against the parent view")
    inherit: str = Field(description="Parent view: XML id such as `sale.view_order_form`, or a numeric view id")
    name: str = Field(min_length=1, max_length=128, description="Name of the new view, such as `Order: warranty`")
    arch: str = Field(min_length=1, max_length=50_000, description="Inheritance XML")
    priority: int = Field(default=99, ge=1, le=1000, description="Applied after parent views with lower numbers")

    @field_validator("model")
    @classmethod
    def _check_model(cls, value: str) -> str:
        return check_entity_name(value)


class CodeAction(_Frozen):
    """Run sandboxed Python (`record`, `records`, `env`, `model`, `UserError`, `datetime`, `log`, ...)."""

    type: Literal["code"]
    code: str = Field(min_length=1, max_length=20_000)


class UpdateFieldAction(_Frozen):
    """Set one field on the record. `value` is a literal, or a Python expression when `compute` is true."""

    type: Literal["update_field"]
    field: str = Field(description="Field on the action's model, such as `priority` or `x_approved`")
    value: str = Field(max_length=2000)
    compute: bool = Field(default=False, description="Evaluate `value` as a Python expression")

    @field_validator("field")
    @classmethod
    def _check_field(cls, value: str) -> str:
        return check_field_name(value)


ActionSpec = Annotated[CodeAction | UpdateFieldAction, Field(discriminator="type")]


class AddServerAction(_Frozen):
    """A server action, optionally offered in the model's Action menu so users run it on selected records."""

    kind: Literal["add_server_action"]
    model: str
    name: str = Field(min_length=1, max_length=128)
    action: ActionSpec
    show_in_action_menu: bool = True

    @field_validator("model")
    @classmethod
    def _check_model(cls, value: str) -> str:
        return check_entity_name(value)


Trigger = Literal[
    "on_create_or_write", "on_unlink", "on_archive", "on_unarchive", "on_change", "on_state_set",
    "on_stage_set", "on_user_set", "on_tag_set", "on_priority_set", "on_time", "on_time_created",
    "on_time_updated", "on_message_received", "on_message_sent", "on_webhook",
]  # fmt: skip
TIME_TRIGGERS = frozenset({"on_time", "on_time_created", "on_time_updated"})
UPDATE_TRIGGERS = frozenset(
    {"on_create_or_write", "on_state_set", "on_stage_set", "on_user_set", "on_tag_set", "on_priority_set",
     "on_archive", "on_unarchive"}
)  # fmt: skip
MAIL_TRIGGERS = frozenset({"on_message_received", "on_message_sent"})
DelayUnit = Literal["minutes", "hour", "day", "month"]


class AddAutomation(_Frozen):
    """An automation rule: when `trigger` happens on a record matching `filter_domain`, run `actions`."""

    kind: Literal["add_automation"]
    model: str
    name: str = Field(min_length=1, max_length=128)
    trigger: Trigger
    trigger_fields: tuple[str, ...] = Field(
        default=(), description="on_create_or_write: run only when one of these fields changes; on_change: the fields"
    )
    trigger_value: str | int | None = Field(
        default=None,
        description="on_state_set / on_priority_set: the selection value; on_stage_set / on_tag_set: the record id",
    )
    filter_domain: str | None = Field(default=None, description="Odoo domain the record must match after the event")
    before_domain: str | None = Field(default=None, description="Domain the record matched before an update")
    date_field: str | None = Field(default=None, description="on_time: the date or datetime field to count from")
    delay: int = Field(default=0, ge=-100_000, le=100_000, description="Time triggers: negative means before")
    delay_unit: DelayUnit = "hour"
    actions: tuple[ActionSpec, ...] = Field(min_length=1, max_length=10)

    @field_validator("model")
    @classmethod
    def _check_model(cls, value: str) -> str:
        return check_entity_name(value)

    @field_validator("trigger_fields")
    @classmethod
    def _check_fields(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(check_field_name(f) for f in value)

    @field_validator("date_field")
    @classmethod
    def _check_date_field(cls, value: str | None) -> str | None:
        return None if value is None else check_field_name(value)

    @model_validator(mode="after")
    def _check_trigger_options(self) -> AddAutomation:
        valued = {"on_state_set", "on_stage_set", "on_tag_set", "on_priority_set"}
        if self.trigger in valued and self.trigger_value is None:
            raise ValueError(f"{self.trigger} needs `trigger_value`")
        if self.trigger not in valued and self.trigger_value is not None:
            raise ValueError("`trigger_value` is only for on_state_set, on_stage_set, on_tag_set and on_priority_set")
        if self.trigger == "on_time" and self.date_field is None:
            raise ValueError("on_time needs `date_field`")
        if self.trigger != "on_time" and self.date_field is not None:
            raise ValueError("`date_field` is only for on_time")
        if self.trigger == "on_change":
            if not self.trigger_fields:
                raise ValueError("on_change needs `trigger_fields`")
            if any(a.type != "code" for a in self.actions):
                raise ValueError("on_change rules run code actions only")
        elif self.trigger_fields and self.trigger != "on_create_or_write":
            raise ValueError("`trigger_fields` is only for on_create_or_write and on_change")
        if self.before_domain and self.trigger not in UPDATE_TRIGGERS:
            raise ValueError(f"`before_domain` is only for update triggers: {', '.join(sorted(UPDATE_TRIGGERS))}")
        return self


IntervalUnit = Literal["minutes", "hours", "days", "weeks", "months"]


class AddScheduledAction(_Frozen):
    """Python code that Odoo runs on a schedule (`model` is the model's empty recordset)."""

    kind: Literal["add_scheduled_action"]
    model: str
    name: str = Field(min_length=1, max_length=128)
    code: str = Field(min_length=1, max_length=20_000)
    interval: int = Field(default=1, ge=1, le=10_000)
    interval_unit: IntervalUnit = "days"

    @field_validator("model")
    @classmethod
    def _check_model(cls, value: str) -> str:
        return check_entity_name(value)


Change = Annotated[
    AddField | ExtendView | AddServerAction | AddAutomation | AddScheduledAction, Field(discriminator="kind")
]
