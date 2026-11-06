# Odoo Community vs Enterprise: what changes a procedure (Odoo 17-19)

Enterprise is Community plus proprietary modules. Before planning, check which edition the database runs: an
installed `web_enterprise` module (or the Accounting app instead of Invoicing) means Enterprise. When a procedure
needs an Enterprise-only feature on Community, say so and offer the Community way below; never install or enable
modules unasked.

## Accounting

| Need | Enterprise | Community |
|---|---|---|
| Manual journal entry lines | Journal Items tab on the entry | The tab only shows for users with **Show Full Accounting Features** (Settings > Users > the user > Technical). Without it the form has no lines: ask for the group, never grant it yourself |
| Bank reconciliation | Reconciliation widget, statement import (CSV, OFX, CAMT), online bank sync | No widget or import: statement lines entered by hand in the bank journal; match with the journal items list's **Reconcile** action, or register payments against invoices |
| Financial reports (P&L, balance sheet, general ledger, trial balance, aged receivable/payable, tax report) | Accounting > Reporting | Not available: answer from `account.move.line` with the read-only erp tools (sum by account and date) and say the figures are computed, not an Odoo report |
| Payment follow-ups (reminders) | Yes | No |
| Assets, deferred revenue/expense, budgets, consolidation | Yes | No: book manually with journal entries and reversals |
| FX revaluation of open balances | Report and adjustment entry | No tool: compute foreign residual x (closing rate - booked rate) and post an entry dated period end, reversed the next day |
| Bill/expense digitization (OCR, AI) | Yes | No |
| Batch payments, SEPA files | Yes | No |
| Invoices, bills, credit notes, payment terms (installments, early discount), taxes, multi-currency with automatic exchange differences, analytic accounting, check printing | Yes | Yes |

## Customization

| Need | Enterprise | Community |
|---|---|---|
| Studio (point-and-click fields, views, reports, automation) | Yes | No: use the customize change sets (custom fields, view extensions, automation rules, server actions, scheduled actions work on both) or a Python module |
| Python modules | Odoo.sh and self-hosted only (not Odoo Online) | Self-hosted |

## Apps that exist only in Enterprise

Studio, Helpdesk, Field Service, Planning, Appointments, Subscriptions, Rental, Sign, Documents, Knowledge,
Approvals, Spreadsheet (BI), Payroll, Appraisals, Referrals, Quality, PLM, MRP shop floor / work-order tablet,
Master Production Schedule, Barcode, shipping-carrier connectors (FedEx, UPS, DHL), Amazon/eBay connectors,
Marketing Automation, Social Marketing, VoIP, IoT, the mobile apps, and the AI features.

## Common to both

Sales, CRM, Purchase, Inventory (without barcode), Manufacturing (basic), Maintenance, Point of Sale, Website and
eCommerce, Project and basic timesheets, Employees, Time Off, Recruitment, Expenses (without OCR), Fleet, Events,
Surveys, eLearning, Live Chat, Discuss, Email Marketing, Calendar, To-Do.

## Hosting and upgrades

Odoo Online (SaaS) and Odoo.sh are Enterprise. Version upgrades are an Enterprise service; Community upgrades rely on
the community OpenUpgrade scripts or a manual migration.
