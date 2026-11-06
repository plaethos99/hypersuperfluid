---
name: erp-knowledge-dynamics
description: Microsoft Dynamics 365 Business Central and Finance & Operations - OData API entity sets for customers, vendors, items, sales, purchasing and ledger entries, connection URL layout, and screens. Load when working with a Dynamics 365 connection.
---

# Dynamics 365 knowledge

## Business Central (API v2.0)

Connection `url`: `https://api.businesscentral.dynamics.com/v2.0/<tenant>/<environment>/api/v2.0/companies(<company-id>)`, with `metadata_url` set to `.../api/v2.0/$metadata`, because entity sets live under a company while the metadata document lives at the API root.

| Business object | Entity set | Key fields |
|---|---|---|
| Customers | `customers` | `number`, `displayName`, `balanceDue`, `blocked` |
| Vendors | `vendors` | `number`, `displayName`, `balance` |
| Items | `items` | `number`, `displayName`, `inventory`, `unitPrice`, `unitCost` |
| Sales orders | `salesOrders` | `number`, `customerNumber`, `orderDate`, `totalAmountIncludingTax`, `status` |
| Sales invoices | `salesInvoices` | `number`, `customerNumber`, `invoiceDate`, `dueDate`, `totalAmountIncludingTax`, `remainingAmount`, `status` (`Draft`, `Open`, `Paid`, `Canceled`, `Corrective`) |
| Purchase orders | `purchaseOrders` | `number`, `vendorNumber`, `orderDate`, `status` |
| Purchase invoices | `purchaseInvoices` | `number`, `vendorNumber`, `invoiceDate`, `dueDate`, `status` |
| G/L entries | `generalLedgerEntries` | `postingDate`, `accountNumber`, `debitAmount`, `creditAmount`, `documentNumber` |
| Chart of accounts | `accounts` | `number`, `displayName`, `category` |

Authentication: Microsoft Entra ID app registration with `oauth2_client_credentials`, scope `https://api.businesscentral.dynamics.com/.default`.

## Finance & Operations

Connection `url`: `https://<environment>.operations.dynamics.com/data`. Entity sets are data entities such as `CustomersV3`, `VendorsV2`, `ReleasedProductsV2`, `SalesOrderHeadersV2`, `SalesOrderLines`, `PurchaseOrderHeadersV2`, `GeneralJournalAccountEntries`. Most carry `dataAreaId` (legal entity); filter on it. The `$metadata` document is large; the connector downloads it once per server start.

Scope: `https://<environment>.operations.dynamics.com/.default`.

## Screens (operator mode)

Business Central: use the search (Alt+Q, "Tell me") to open a page by name, for example "Sales Orders". Irreversible actions: **Post**, **Release**, **Send**, **Approve**.

Finance & Operations: navigate with the module menu or the search bar. Irreversible actions: **Post**, **Confirm**, **Invoice**, **Submit** (workflow).
