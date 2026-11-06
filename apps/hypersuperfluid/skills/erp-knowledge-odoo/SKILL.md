---
name: erp-knowledge-odoo
description: Odoo data model and screens - which models hold customers, sales, purchases, invoices, payments and stock, their key fields and state values, and where procedures live in the web client. Load when working with an Odoo connection.
---

# Odoo knowledge

Field names differ slightly between Odoo versions; confirm with `erp_describe_entity`. The connector talks JSON-2 to Odoo 19 and later (XML-RPC is removed on Odoo 20) and XML-RPC to older versions; the tools behave the same either way.

## Models

| Business object | Model | Key fields |
|---|---|---|
| Customers, vendors, contacts | `res.partner` | `name`, `customer_rank` (> 0 = customer), `supplier_rank` (> 0 = vendor), `vat`, `email`, `country_id` |
| Products | `product.product` (variant), `product.template` | `default_code` (internal reference), `name`, `list_price`, `standard_price`, `type` |
| Sales orders | `sale.order`, lines `sale.order.line` | `name`, `partner_id`, `date_order`, `amount_total`, `state`: `draft`, `sent`, `sale`, `cancel` |
| Purchase orders | `purchase.order`, lines `purchase.order.line` | `name`, `partner_id`, `date_order`, `amount_total`, `state`: `draft`, `sent`, `to approve`, `purchase`, `done`, `cancel` |
| Invoices, bills, credit notes, journal entries | `account.move`, lines `account.move.line` | `move_type`: `out_invoice`, `out_refund`, `in_invoice`, `in_refund`, `entry`; `state`: `draft`, `posted`, `cancel`; `payment_state`: `not_paid`, `partial`, `in_payment`, `paid`, `reversed`; `amount_total`, `amount_residual`, `invoice_date`, `invoice_date_due`, `currency_id` |
| Payments | `account.payment` | `partner_id`, `amount`, `payment_type` (`inbound`, `outbound`), `date` |
| Stock on hand | `stock.quant` | `product_id`, `location_id`, `quantity`, `reserved_quantity` |
| Transfers (receipts, deliveries) | `stock.picking`, moves `stock.move` | `picking_type_id`, `state`: `draft`, `waiting`, `confirmed`, `assigned`, `done`, `cancel` |
| Manufacturing orders | `mrp.production` | `product_id`, `product_qty`, `state` |
| Employees | `hr.employee` | personal data; query only when needed |

Relations (`many2one`) come back as `{"id": ..., "name": ...}`. Filter them by id: `{"field": "partner_id", "op": "=", "value": 42}`.

## Common questions

- **Overdue customer invoices:** `account.move` with `move_type = out_invoice`, `state = posted`, `payment_state in [not_paid, partial]`, `invoice_date_due < today`.
- **Open vendor bills:** same with `move_type = in_invoice`.
- **Stock of an item:** `stock.quant` filtered by `product_id`, internal locations only (location names usually start with the warehouse code, for example `WH/Stock`).
- **Confirmed sales not yet invoiced:** `sale.order` with `state = sale` and `invoice_status = to invoice`.

## Screens (operator mode)

| Task | Menu path | Irreversible button |
|---|---|---|
| Quotation / sales order | Sales › Orders › Quotations › New | Confirm |
| Purchase order | Purchase › Orders › Requests for Quotation › New | Confirm Order |
| Customer invoice | Accounting › Customers › Invoices › New | Confirm (posts) |
| Vendor bill | Accounting › Vendors › Bills › New | Confirm (posts) |
| Register payment | open posted invoice › Register Payment | Create Payment |
| Receive goods | Inventory › Receipts › open transfer | Validate |
| Deliver goods | Inventory › Deliveries › open transfer | Validate |

## Importing CSV or Excel files (operator mode)

Odoo's import is the same screen for every list; work through it directly instead of probing the page with scripts.

1. Open the list the records belong in. The list sets the record type, so invoices imported from the Bills list become vendor bills:

   | Records | Open this list | Model |
   |---|---|---|
   | Customers | Accounting › Customers › Customers | `res.partner` |
   | Vendors | Accounting › Vendors › Vendors | `res.partner` |
   | Products | Accounting › Customers › Products (or Sales / Inventory › Products) | `product.template` |
   | Customer invoices | Accounting › Customers › Invoices | `account.move`, `out_invoice` |
   | Vendor bills | Accounting › Vendors › Bills | `account.move`, `in_invoice` |

2. Click the gear (cog) icon beside the list title in the breadcrumb, then **Import records**. Take a page snapshot and click by the element's name; do not guess coordinates.
3. Click **Upload File** and give the file to the browser's file-upload tool.
4. Odoo maps the columns by header: technical field names (`partner_id`, `invoice_line_ids/product_id`) and field labels both map automatically. Fix only columns shown as unmapped.
5. Click **Test**. "Everything seems valid" means ready; otherwise fix the rows or mappings it lists and test again.
6. **Import** commits the records: confirm with the person first, then click it and read the count Odoo reports.

Invoices and bills with several lines put the header columns on the first row only; following rows with empty header columns are more lines of the same document. Imported invoices and bills stay in draft until someone confirms them. Import files in dependency order: partners and products before the documents that refer to them.
