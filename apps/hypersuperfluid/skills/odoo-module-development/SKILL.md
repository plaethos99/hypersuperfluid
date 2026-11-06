---
name: odoo-module-development
description: How a senior Odoo developer builds and changes custom Python modules with the odoo_module_ tools - when a module is justified, the inheritance patterns to use (fields, methods, views, onchange, constraints, computed fields), Odoo 17 and 18 syntax, security, performance, upgrades, tests and the check-test-review-commit loop. Load before writing or changing Odoo Python code.
---

# Odoo module development

Python modules run on Odoo.sh and self-hosted Odoo only; Odoo Online refuses them. Before writing code, check
whether a change set (`odoo-customization` skill) or a standard feature does the job: modules cost the client
maintenance and an upgrade on every Odoo version.

A module is justified for: new business objects with logic, overriding how standard documents behave (confirm,
post, compute), reports, scheduled integrations with outside systems, controllers and portal pages, or anything
that needs real Python (libraries, loops over many records, transactions).

## The loop

1. `odoo_module_workspaces` → pick the client's workspace; `odoo_module_list_files` and `odoo_module_read_file`
   to learn the existing modules before adding one. Extend the client's module when one fits; one module per
   business topic otherwise.
2. New module: `odoo_module_scaffold` (models, access rules, views, menus, test). Existing code: read the file,
   then `odoo_module_write_file` with the full new content.
3. `odoo_module_check` until it reports no errors. Read every warning.
4. `odoo_module_test` installs or updates the module on the test database and runs its tests. Read the error
   blocks; fix and repeat until `passed` is true. Never declare success without a passing run.
5. `odoo_module_diff` → show the person what changed and the test result in the Submit question;
   `odoo_module_commit` after Submit, with a message that says what changed and why.
6. Ship: `odoo_module_push` to a staging branch (Odoo.sh builds it; the client promotes it), or
   `odoo_module_package` for a self-hosted addons folder. Production is never pushed directly.

## Patterns

Always extend, never copy: `_inherit` for models, `inherit_id` + `xpath` for views. Never edit Odoo's own files.

```python
from odoo import _, api, fields, models
from odoo.exceptions import UserError, ValidationError


class SaleOrder(models.Model):
    _inherit = "sale.order"  # margin fields come from sale_margin: list it in depends

    x_margin_alert = fields.Boolean(compute="_compute_margin_alert", store=True)
    warranty_months = fields.Integer(default=12, tracking=True)

    @api.depends("order_line.margin", "amount_untaxed")
    def _compute_margin_alert(self):
        for order in self:
            order.x_margin_alert = order.amount_untaxed and order.margin / order.amount_untaxed < 0.1

    @api.constrains("warranty_months")
    def _check_warranty_months(self):
        for order in self:
            if order.warranty_months < 0:
                raise ValidationError(_("Warranty cannot be negative."))

    def action_confirm(self):
        for order in self:
            if order.x_margin_alert and not self.env.user.has_group("sales_team.group_sale_manager"):
                raise UserError(_("Orders with a margin under 10 percent need a sales manager."))
        return super().action_confirm()
```

- Overrides call `super()` and return its result; loop over `self` (methods receive recordsets).
- `@api.depends` lists every field the compute reads, including related paths; stored computes need it to
  recompute. `@api.constrains` only takes plain field names.
- `@api.model_create_multi` on `create(self, vals_list)` overrides.
- Translatable messages: `_("...")` with `%(name)s` placeholders.
- Field names on standard models: no `x_` prefix needed in modules (that prefix is for UI-created fields); pick
  names that will not clash with future Odoo fields, such as a client prefix.

View extension:

```xml
<record id="view_order_form_warranty" model="ir.ui.view">
    <field name="name">sale.order.form.warranty</field>
    <field name="model">sale.order</field>
    <field name="inherit_id" ref="sale.view_order_form"/>
    <field name="arch" type="xml">
        <xpath expr="//field[@name='payment_term_id']" position="after">
            <field name="warranty_months" invisible="state == 'cancel'"/>
        </xpath>
    </field>
</record>
```

## Odoo 17 and 18 syntax

- Odoo 17+: `attrs` and `states` are gone; write `invisible="state != 'draft'"`, `readonly=...`, `required=...`.
- Odoo 18: `<tree>` is `<list>`, `view_mode` says `list`, the form chatter is `<chatter/>`; `column_invisible` hides
  a list column. Odoo 17 still uses `<tree>` and the `oe_chatter` block.
- `name_get` is replaced by `_compute_display_name` (17+).
- Manifest version is `<odoo version>.<major>.<minor>.<patch>`, such as `18.0.1.2.0`; raise it on every change
  that needs an upgrade (new fields, data, views).

## Security

- Every new model needs lines in `security/ir.model.access.csv` (the check refuses a module without them).
  Give users what their job needs; deletion usually only to managers.
- Record rules (`ir.rule`) for multi-company models: `[('company_id', 'in', company_ids)]`.
- `sudo()` only to read data the user may not see, with a comment saying why; never to write on their behalf
  silently.
- SQL: `self.env.cr.execute(query, params)` or `odoo.tools.SQL`, never string formatting; prefer the ORM.
- Controllers: `auth="user"` unless the route is truly public; validate every input; `csrf=True` for forms.

## Performance

- Batch: `search` once, `read_group` / `_read_group` for totals, write on recordsets, not inside per-record loops
  that search again.
- Store computed fields that are searched, grouped or shown in lists; leave the rest unstored.
- Scheduled jobs process in batches and commit through Odoo's cron mechanisms, never `cr.commit()` in module code.

## Upgrades and data

- Renamed or removed fields with data need a migration script in `migrations/<version>/pre-` or `post-migrate.py`
  (`def migrate(cr, version)`), tested by updating a copy of the client's database.
- `noupdate="1"` for data the client may edit (mail templates, sequences), so upgrades do not overwrite it.
- Never delete client data in an upgrade without the person's explicit agreement.

## Tests

- `TransactionCase` with `@tagged("post_install", "-at_install")`; create the data the test needs in `setUpClass`.
- Test the business rule, not the framework: one test that the rule applies, one that it does not, one for the
  error message.
- `odoo_module_test` runs only the module's own tests (`--test-tags /<module>`).

## Handover

Tell the person, in business words: what the module does, who is affected, how to install it (staging branch or
addons folder plus Apps > Update Apps List > Install), how to roll back (uninstall or revert the commit), and what
needs attention at the next Odoo upgrade.
