---
name: erp-knowledge-sap
description: SAP S/4HANA and ECC data model and screens - core tables (KNA1, LFA1, MARA, VBAK, EKKO, BKPF, ACDOCA ...), OData services, and SAP GUI transaction codes for sales, purchasing, inventory and finance. Load when working with an SAP connection or SAP GUI.
---

# SAP knowledge

## Access paths

- **OData v4 connection:** S/4HANA A2X APIs published as OData v4 (for example Purchase Order `API_PURCHASEORDER_2`). Many older S/4HANA APIs are OData v2 only; v2 support is on the roadmap, so for those use SQL or the screen.
- **SQL connection:** a HANA or replica database. Tables below are the classic data model; S/4HANA keeps most of them and adds `ACDOCA`.
- **Screen:** SAP GUI (desktop, through `computer_use`) or Fiori (web, through the browser tool).

## Tables

| Business object | Tables | Key fields |
|---|---|---|
| Customer master | `KNA1` (general), `KNB1` (company code), `KNVV` (sales area) | `KUNNR`, `NAME1`, `LAND1` |
| Vendor master | `LFA1`, `LFB1` | `LIFNR`, `NAME1` |
| Business partner (S/4) | `BUT000` | `PARTNER` |
| Material master | `MARA` (general), `MAKT` (descriptions), `MARC` (plant) | `MATNR`, `MTART`, `MAKTX` |
| Stock | `MARD` (storage location) | `MATNR`, `WERKS`, `LGORT`, `LABST` (unrestricted) |
| Sales orders | `VBAK` (header), `VBAP` (items) | `VBELN`, `KUNNR`, `ERDAT`, `NETWR`, `WAERK` |
| Deliveries | `LIKP`, `LIPS` | `VBELN` |
| Billing documents | `VBRK`, `VBRP` | `VBELN`, `FKDAT`, `NETWR` |
| Purchase orders | `EKKO` (header), `EKPO` (items) | `EBELN`, `LIFNR`, `BEDAT` |
| Accounting documents | `BKPF` (header), `BSEG` (items); S/4: `ACDOCA` (universal journal) | `BUKRS`, `BELNR`, `GJAHR`, `BUDAT` |
| Company codes | `T001` | `BUKRS`, `BUTXT`, `WAERS` |

Keys are zero-padded strings: customer `0000012345`, material numbers padded to 18 or 40 characters. Always filter by `MANDT` (client) on SQL connections that hold several clients.

## Transaction codes (operator mode)

| Task | Create | Change | Display | Irreversible step |
|---|---|---|---|---|
| Sales order | `VA01` | `VA02` | `VA03` | Save |
| Outbound delivery | `VL01N` | `VL02N` | `VL03N` | Post Goods Issue |
| Billing document | `VF01` | `VF02` | `VF03` | Save |
| Purchase order | `ME21N` | `ME22N` | `ME23N` | Save |
| Goods receipt / movements | `MIGO` | | | Post |
| Vendor invoice | `MIRO` (logistics), `FB60` (FI) | | | Post |
| Customer invoice (FI) | `FB70` | | | Post |
| Incoming payment | `F-28` | | | Post |
| Material master | `MM01` | `MM02` | `MM03` | Save |

In SAP GUI, Save and Post are irreversible; reversal needs its own transaction. Read the status bar at the bottom after every Enter: messages starting with `E` are errors, `W` warnings.
