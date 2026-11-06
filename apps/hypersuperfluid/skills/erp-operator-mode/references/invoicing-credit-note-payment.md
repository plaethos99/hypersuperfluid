# Customer invoice, credit note and payment (Odoo 18, web client)

Verified end to end on Odoo 18 Community through the screens. Menus are the same in Enterprise (Accounting app)
and Community (Invoicing app).

## 1. Draft the invoice

1. Invoicing (Accounting) > Customers > Invoices > **New**.
2. **Customer**: click the field, type a few letters, click the exact existing partner in the dropdown.
3. **Invoice Date**: set it explicitly, then press **Tab**.
4. **Add a line**: type the product name in the product cell and pick the existing product; set **Quantity**,
   press **Tab** so Odoo recomputes the line; set **Taxes** by clicking the tax cell and picking the tax.
5. **Customer Reference** (`ref`) is on the **Other Info** tab, not on the lines tab.
6. **Payment Terms** (`invoice_payment_term_id`) sits under the customer; set it before posting.

## 2. Post

- Switching tabs (or pressing Tab out of a field) autosaves; the title then reads `Draft Invoice`.
- **Confirm** posts it and assigns the number (`INV/YYYY/NNNNN`). Ask for Submit first.

## 3. Credit note (partial or full)

1. On the posted invoice click **Credit Note**, enter the reason, click **Reverse**. The refund opens in draft.
2. For a partial credit, click the **Quantity** cell, set the returned quantity, press **Tab** so the total
   recomputes.
3. **Confirm** posts it (`RINV/...`). Odoo reconciles it with the original invoice, whose amount due drops
   accordingly.

## 4. Payment

1. On the posted invoice click **Pay** (Register Payment).
2. Check **Journal**, **Payment Date** and **Amount**. The wizard proposes the amount Odoo computed (the residual,
   the next installment under installment terms, or the discounted amount inside an early-payment window): use it
   unless the task gives a different amount, and stop if the two differ.
3. **Create Payment**. The invoice shows **In Payment** or **Paid**.

## 5. Verify with the read-only erp tools

- `account.move`: `name`, `state`, `payment_state`, `amount_total`, `amount_residual`.
- `account.payment`: `amount`, `date`, `journal_id`, `state`.

## Gotchas

- **Save** on a form counts as a submission for the approval gate. Rather than waiting for Submit just to save a
  draft, let Odoo autosave by switching tabs or pressing Tab.
- **Blank Odoo page, or clicks that wait for an element to be "visible, enabled and stable"**: the browser draws only
  the front tab of a window, and Odoo's web client builds its screens only while drawn. Select your tab
  (`browser_tabs`, action `select`) and reload. If it is still blank and the page's script loaded no modules
  (`odoo.loader.modules` empty), the browser holds stale assets for that address (a recreated or restored
  database): ask the person to clear the site data for that Odoo address, then sign in again.
- Never use **Create** or **Create and edit** in a dropdown: an unmatched product name silently creates a new
  product.
