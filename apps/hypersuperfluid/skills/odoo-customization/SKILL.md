---
name: odoo-customization
description: How a senior Odoo consultant turns a business need into custom fields, form changes, automation rules, server actions and scheduled actions with the mcp__customize__ tools - discovery questions, standard-feature-first checks, ready recipes (approvals, reminders, validations, auto-assignment, webhooks), pitfalls and testing. Load before planning any Odoo customization.
---

# Odoo customization

Customizations are built as change sets with the `mcp__customize__` tools. Planning reads the database and writes
nothing; applying needs the person's go and Submit; every change set can be rolled back and exported as a data
module. Everything here runs on Odoo Online, Odoo.sh and self-hosted Odoo 17 and 18 alike.

## 1. Understand the need before building

The person often describes a solution ("add a checkbox") when they have a problem ("big purchases go out without
approval"). Ask, in plain words, only what you cannot find by reading the database:

- **What should happen, and when?** The event (a document is confirmed, a date passes, a field changes) and the
  result (block it, notify someone, fill a field, create an activity).
- **Which documents, and which not?** The condition: amount over a threshold, a customer group, a product type,
  a company.
- **Who is involved?** Who approves, who is notified, and whether anyone may bypass it.
- **What about existing records?** New rules apply from now on; say so when old records matter.

Then read: `erp_describe_entity` for exact field names and selection values, and `erp_query` for a few real
records to check the condition matches what the person expects.

## 2. Standard features first

Recommend configuration over customization when it fits, and say why: it survives upgrades and needs no
maintenance.

| Need | Standard feature (check it is installed and enabled) |
|---|---|
| Purchase approval over an amount | Purchase settings: Purchase Order Approval (two-step, with a minimum amount) |
| Sales discount or margin limits | Sales settings: Discounts; pricelists |
| Credit limit on customers | Accounting settings: Sales Credit Limit |
| Reminders for unpaid invoices | Accounting: Follow-up levels |
| Recurring tasks for people | Activities with activity plans |
| Required fields on a form | Studio, or an automation rule that blocks saving (recipe below) |
| Multi-level approvals of any document | The Approvals app (Enterprise) |

Only when none fits, plan a change set.

## 3. Recipes

Model and field names below are Odoo 17/18; confirm them on the database first.

**Block a confirmation unless approved** (field, form, rule, approve action):

```json
[
  {"kind": "add_field", "model": "purchase.order", "name": "x_approved", "type": "boolean",
   "label": "Manager approved", "tracking": true},
  {"kind": "extend_view", "model": "purchase.order", "inherit": "purchase.purchase_order_form",
   "name": "PO: manager approval",
   "arch": "<xpath expr=\"//field[@name='partner_ref']\" position=\"after\"><field name=\"x_approved\"/></xpath>"},
  {"kind": "add_automation", "model": "purchase.order", "name": "Large POs need approval",
   "trigger": "on_state_set", "trigger_value": "purchase",
   "filter_domain": "[('amount_total', '>', 10000), ('x_approved', '=', False)]",
   "actions": [{"type": "code", "code": "raise UserError('Purchase orders over 10,000 need manager approval.')"}]},
  {"kind": "add_server_action", "model": "purchase.order", "name": "Approve",
   "action": {"type": "update_field", "field": "x_approved", "value": "true"}}
]
```

Who may tick the box matters: in the code, check `env.user.has_group('purchase.group_purchase_manager')` and
raise `UserError` otherwise, or ask the person to restrict the field with Studio.

**Reminder before a date** (`on_time`, negative delay = before):

```json
{"kind": "add_automation", "model": "sale.order", "name": "Warranty ends in 30 days", "trigger": "on_time",
 "date_field": "x_warranty_end", "delay": -30, "delay_unit": "day", "filter_domain": "[('state', '=', 'sale')]",
 "actions": [{"type": "code", "code": "record.activity_schedule('mail.mail_activity_data_todo', summary='Offer a warranty extension', user_id=record.user_id.id or env.uid)"}]}
```

**Validate data on save** (run only when the watched fields change):

```json
{"kind": "add_automation", "model": "res.partner", "name": "Companies need a tax id", "trigger": "on_create_or_write",
 "trigger_fields": ["is_company", "vat"], "filter_domain": "[('is_company', '=', True), ('vat', '=', False)]",
 "actions": [{"type": "code", "code": "raise UserError('Enter the tax id of %s.' % record.name)"}]}
```

**Fill a field automatically** (code action writing on the record):

```json
{"kind": "add_automation", "model": "crm.lead", "name": "Route big leads to the key account team",
 "trigger": "on_create_or_write", "trigger_fields": ["expected_revenue"],
 "filter_domain": "[('expected_revenue', '>=', 50000)]",
 "actions": [{"type": "code", "code": "team = env['crm.team'].search([('name', '=', 'Key Accounts')], limit=1)\nif team:\n    record.team_id = team"}]}
```

**Nightly job** (`model` is the empty recordset of the model):

```json
{"kind": "add_scheduled_action", "model": "account.move", "name": "Flag invoices overdue by 60 days",
 "interval": 1, "interval_unit": "days",
 "code": "late = model.search([('move_type', '=', 'out_invoice'), ('payment_state', 'in', ('not_paid', 'partial')), ('invoice_date_due', '<', datetime.date.today() - datetime.timedelta(days=60))])\nfor move in late:\n    move.message_post(body='Overdue by more than 60 days')"}
```

**Receive data from another system**: an `on_webhook` rule; the apply result holds its URL. The payload is in
`payload`; anyone with the URL can call it, so validate what arrives.

## 4. Pitfalls a reviewer looks for

- **Rules that fire too often**: an `on_create_or_write` rule without `trigger_fields` runs on every save. Name the
  fields that matter.
- **Loops**: a rule that writes a field it also watches. Odoo stops a rule from re-running on the same record in
  one transaction, but two rules can still feed each other; check the chain.
- **`sudo()`** bypasses access rights; use it only to read data the user may not see, never to write on their
  behalf without saying so.
- **Required on existing data**: a required custom field makes every old record without a value fail on its next
  save. Fill old records first, or enforce it with a rule for new ones only.
- **Accounting**: never change posted journal entries, taxes or accounts with automation; propose the accounting
  workflow instead.
- **Selection values and record ids** differ per database: check them on the database you plan on, and re-check
  after exporting to another one.
- **Performance**: avoid `search` over a whole table inside per-record actions; filter with the rule's domain.

## 5. Test, hand over, reuse

1. Plan and apply on a test copy first (a Docker or Odoo.sh staging database) when the person has one.
2. After applying, prove it works: create or update a record that should trigger the rule and one that should
   not, and read the result back.
3. Tell the person what changed, in business words, and how to undo it (`odoo_rollback_changeset`).
4. Export the tried change set with `odoo_export_changeset` to install it on production or reuse it for another
   client (Apps > Import Module; record ids such as stages must be checked there).

## When a change set is not enough

New Python models, overriding core methods (posting, stock valuation), external libraries, custom JavaScript
widgets and website routes need a Python module, which Odoo Online does not allow. Say so plainly, propose the
closest no-code alternative, and suggest Odoo.sh or a self-hosted Odoo when the need is real.
