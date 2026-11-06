---
name: erp-knowledge-netsuite-tally
description: Oracle NetSuite and Tally Prime - record types, screens and operator procedures (CSV Import Assistant, saved searches, global search, periods, vouchers). Load when the user works in NetSuite or Tally; neither has an info-mode connector yet, so answers come from screens, exported reports or a SQL/ODBC source.
---

# NetSuite and Tally knowledge

Neither ERP has a dedicated connector yet (both are on the roadmap). Until then:

- Export the report from the ERP to CSV or XLSX into an allowed folder and read it with `extract_tables`, or
- Read the data from the screen in operator mode, or
- Use a SQL connection where one exists (NetSuite SuiteAnalytics Connect ODBC, Tally ODBC).

## NetSuite

| Business object | Record type |
|---|---|
| Customers / vendors | `customer`, `vendor` |
| Items | `inventoryitem`, `noninventoryitem`, `serviceitem` |
| Sales orders | `salesorder` |
| Invoices | `invoice` |
| Purchase orders | `purchaseorder` |
| Vendor bills | `vendorbill` |
| Payments | `customerpayment`, `vendorpayment` |

SuiteQL (the future connector's query language) reads the `transaction` table, with `type` values such as `SalesOrd`, `CustInvc`, `PurchOrd`, `VendBill`.

Screens: Transactions › Sales › Enter Sales Orders; Transactions › Customers › Create Invoices; Transactions › Purchases › Enter Purchase Orders. **Save** records a transaction; **Approve** in approval workflows is irreversible.

### Operating NetSuite (operator mode)

| Task | Where |
|---|---|
| Vendor bill | Transactions › Payables › Enter Bills |
| Pay bills | Transactions › Payables › Pay Bills |
| Customer payment | Transactions › Customers › Accept Customer Payments |
| Journal entry | Transactions › Financial › Make Journal Entries |
| Accounting periods | Setup › Accounting › Manage Accounting Periods |
| Saved searches | Lists › Search › Saved Searches (or Reports › New Search) |
| CSV import | Setup › Import/Export › Import CSV Records |

- **Role and subsidiary first.** The role (top right) decides what you can see and do; in OneWorld accounts each
  transaction belongs to a **subsidiary**, which limits the customers, vendors, accounts and currencies offered.
- **Global search** (top bar) takes prefixes: `cus: Acme`, `ven: Acme`, `inv: 1043`, `bill: 77`, `je: 512`.
- **CSV Import Assistant**: choose the record type, **Add** or **Update** (or Add or Update), map fields, then
  run. Use an **External ID** column so a re-run updates instead of duplicating. Dates must match the user's
  date-format preference (Home › Set Preferences). Import into production is irreversible: test with a small file
  or in a sandbox first, and read the import's results file (Setup › Import/Export › View CSV Import Status).
- **Saved searches** are the reporting tool: criteria, results columns, summary types; they export to CSV/Excel
  for `extract_tables`. SuiteAnalytics Workbooks (Analytics tab) cover pivots.
- Posting periods: a transaction dated in a closed or locked period is refused or needs an override; report it,
  do not change the date or period without the person's say-so.
- **Mass Update** (Lists › Mass Update) changes many records at once: treat as irreversible and ask first.

## Tally Prime

Masters: Ledgers (parties, expense and income accounts), Groups (Sundry Debtors, Sundry Creditors), Stock Items, Godowns. Transactions are Vouchers.

| Voucher | Key |
|---|---|
| Contra | F4 |
| Payment | F5 |
| Receipt | F6 |
| Journal | F7 |
| Sales | F8 |
| Purchase | F9 |

From the Gateway of Tally, open Vouchers, press the voucher key, fill the fields, and accept with Ctrl+A. Accepting a voucher records it: treat Ctrl+A on a voucher screen as irreversible and ask for approval first. Reports: Display More Reports › Day Book, Outstandings (Receivables/Payables), Stock Summary; these can be exported to Excel for `extract_tables`.

Tally is keyboard-driven; in `computer_use`, prefer key presses over clicks and check the highlighted field after each Enter.
