---
name: erp-knowledge-oracle
description: Oracle Fusion Cloud ERP (Financials, Procurement, SCM) and Oracle E-Business Suite R12 - work areas and navigation, data loads (FBDI, ADFdi spreadsheets), scheduled processes, reports (OTBI, BI Publisher), key tables and the irreversible steps. Load when the user works in Oracle Fusion or EBS.
---

# Oracle Fusion Cloud ERP and E-Business Suite

There is no Oracle connector. Work through the screens the person is signed in to (Fusion is a web application:
use the browser tools; EBS Forms may need `computer_use`), through files the person exports, or through a SQL
client already configured on this computer (EBS only).

## Fusion: finding your way

- **Navigator** (menu icon, top left) lists the work areas: Payables › Invoices, Receivables › Billing,
  General Ledger › Journals, Procurement › Purchase Orders, Period Close, Setup and Maintenance.
- Each work area has a **Tasks** panel (icon on the right edge): Create Invoice, Manage Invoices, Create Journal
  and so on. Most work starts there, not in the Navigator.
- Organisation model: **Ledger** (chart of accounts, calendar, currency) → **Legal entity** → **Business unit**
  (BU). Payables and Receivables work happens inside a BU; choose the right one before entering data.
- **Tools › Scheduled Processes**: every import, accounting and close program runs here. Check a process's
  status, then its **log** and **output** files. "Succeeded" with rejected rows still needs the output read.
- **Setup and Maintenance** (functional setup tasks): read only unless the person asks for a setup change.

## Fusion: loading data

| Tool | When | How |
|---|---|---|
| **FBDI** (file-based data import) | bulk loads: invoices, journals, suppliers, customers, items | Download the XLSM template for the object from Oracle's "File-Based Data Imports" guide, fill it, press **Generate CSV File** (makes a ZIP), then run **Load Interface File for Import** in Scheduled Processes (choose the import process, upload the ZIP), then the object's import program |
| **ADFdi spreadsheet** | tens to hundreds of rows typed by a person | Tasks › Create Journal in Spreadsheet, Create Invoice in Spreadsheet; needs the Oracle ADF Desktop Integration Excel add-in installed |
| Screen entry | a few records | Tasks › Create … |

Import programs to know: **Import Payables Invoices**, **Import AutoInvoice** (Receivables), **Import Journals**
(General Ledger), **Import Suppliers**. Rows that fail stay in the interface tables: read the import program's
output, fix the data (corrections spreadsheet or a new file), and import again. Never reload a file that partly
succeeded without checking which rows already went in: duplicates are easy to create.

## Fusion: accounting and close

- Payables invoices: **Validate** (checks holds, tax, matching) → approval workflow → **Create Accounting**.
  Holds block payment; read the hold reason before releasing anything.
- Payments: **Submit Payment Process Request**; the payment file goes to the bank. Irreversible.
- Receivables: transactions are **Complete** before they post; AutoInvoice creates them from the interface.
- General Ledger: journals are **Posted** (irreversible; reverse with a reversing journal, never edit).
- Subledger Accounting: **Create Accounting** turns subledger transactions into journal entries; run it in
  Draft mode first when unsure.
- Period Close work area: Manage Accounting Periods opens and closes periods per ledger and per subledger.
  Closing a period is irreversible for practical purposes; ask first.

## Fusion: reports and data

- **OTBI** (Reports and Analytics, Analytics catalog): real-time subject areas for ad-hoc analysis.
- **BI Publisher** (BIP): formatted reports; custom SQL runs only inside a BIP **data model**. There is no direct
  database access in Fusion Cloud, so "run this SQL" means a BIP data model or an OTBI analysis.
- Account Inquiry and Account Monitor (General Ledger) for balances; Smart View / Financial Reporting Center for
  financial statements.
- Table names for BIP SQL: `AP_INVOICES_ALL`, `AP_INVOICE_LINES_ALL`, `POZ_SUPPLIERS`, `POZ_SUPPLIER_SITES_ALL_M`,
  `RA_CUSTOMER_TRX_ALL`, `HZ_PARTIES`, `HZ_CUST_ACCOUNTS`, `GL_JE_HEADERS`, `GL_JE_LINES`,
  `GL_CODE_COMBINATIONS`, `GL_BALANCES`, `XLA_AE_HEADERS`, `XLA_AE_LINES`, `PO_HEADERS_ALL`, `PO_LINES_ALL`.

## E-Business Suite R12

- Screens are reached through a **responsibility** (Payables Manager, General Ledger Super User…); the
  responsibility decides the operating unit and the menu. Forms are Java-based; use `computer_use` and read each
  field back.
- Batch work runs as **concurrent requests** (View › Requests): Payables Open Interface Import, Journal Import,
  AutoInvoice, Create Accounting, Payables Transfer to General Ledger.
- Data loads go through the **open interface tables** (for example `AP_INVOICES_INTERFACE`) and the matching
  import request, or through Web ADI spreadsheets.
- Many sites allow read-only SQL through SQL Developer or SQL*Plus. Use the person's configured connection, read
  only, and set the operating unit context (`mo_global.set_policy_context`) before querying `_ALL` tables by org.

## Irreversible steps (ask first)

Post a journal, close a period, validate and account an invoice, release a hold, submit a payment process
request or payment batch, complete a Receivables transaction, approve in a workflow, run a mass update or an
import into production. Show what will be committed, then wait for the person's **Submit**.
