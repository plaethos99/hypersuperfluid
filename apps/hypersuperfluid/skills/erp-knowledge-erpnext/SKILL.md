---
name: erp-knowledge-erpnext
description: ERPNext / Frappe data model and screens - doctypes for customers, items, sales, purchasing, invoices, payments, stock and ledgers, their status values and docstatus, and where procedures live in the desk UI. Load when working with an ERPNext connection.
---

# ERPNext knowledge

## Doctypes

| Business object | Doctype | Key fields |
|---|---|---|
| Customers | `Customer` | `customer_name`, `customer_group`, `territory` |
| Suppliers | `Supplier` | `supplier_name`, `supplier_group` |
| Items | `Item` | `item_code`, `item_name`, `item_group`, `stock_uom`, `is_stock_item` |
| Sales orders | `Sales Order` | `customer`, `transaction_date`, `delivery_date`, `grand_total`, `status`, `per_delivered`, `per_billed` |
| Sales invoices | `Sales Invoice` | `customer`, `posting_date`, `due_date`, `grand_total`, `outstanding_amount`, `status`: `Draft`, `Unpaid`, `Overdue`, `Partly Paid`, `Paid`, `Return`, `Credit Note Issued`, `Cancelled` |
| Purchase orders | `Purchase Order` | `supplier`, `transaction_date`, `grand_total`, `status`, `per_received`, `per_billed` |
| Purchase invoices | `Purchase Invoice` | `supplier`, `posting_date`, `due_date`, `grand_total`, `outstanding_amount`, `status` |
| Deliveries / receipts | `Delivery Note`, `Purchase Receipt` | `customer` / `supplier`, `posting_date`, `status` |
| Stock balance | `Bin` | `item_code`, `warehouse`, `actual_qty`, `reserved_qty`, `projected_qty` |
| Stock movements | `Stock Ledger Entry` | `item_code`, `warehouse`, `posting_date`, `actual_qty`, `voucher_type`, `voucher_no` |
| Payments | `Payment Entry` | `party_type`, `party`, `paid_amount`, `posting_date`, `payment_type` |
| General ledger | `GL Entry` | `account`, `debit`, `credit`, `posting_date`, `voucher_type`, `voucher_no` |

Every document has `docstatus`: 0 draft, 1 submitted, 2 cancelled. Reports on real business activity should filter `docstatus = 1`.

Item lines (`Sales Invoice Item`, `Sales Order Item`, ...) are child tables and are not listed by `erp_list_entities`. For line-level questions use a SQL connection to the ERPNext database (`tabSales Invoice Item`) when one is configured, or open the parent document on screen.

On a SQL connection to the ERPNext MariaDB database, each doctype is a table named `tab<Doctype>`, for example `` `tabSales Invoice` ``.

## Common questions

- **Overdue receivables:** `Sales Invoice` with `docstatus = 1`, `outstanding_amount > 0`, `due_date < today`.
- **Stock of an item:** `Bin` filtered by `item_code`, one row per warehouse.
- **Orders to deliver:** `Sales Order` with `docstatus = 1`, `per_delivered < 100`, `status != Closed`.

## Screens (operator mode)

Open any list at `/app/<doctype-slug>` (for example `/app/sales-invoice`), a new form at `/app/<doctype-slug>/new`.

| Task | Irreversible button |
|---|---|
| Sales order, sales invoice, purchase order, purchase invoice, delivery note, purchase receipt, stock entry, payment entry | Submit |
| Cancel a submitted document | Cancel |
| Create an invoice from an order | Create › Sales Invoice (creates a draft; Submit is the irreversible step) |
