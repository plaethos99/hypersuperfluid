# Foreign-currency invoice: activate the currency, load rates, invoice, payment (Odoo 18, web client)

Verified end to end on Odoo 18 Community through the screens (a EUR invoice in a USD company, paid at a later rate,
with the exchange difference booked by Odoo).

## 1. Activate the currency

1. Open the currency list through the action (`/odoo/action-base.action_currency_form`); the menu sits under
   Settings > Accounting/Invoicing > Currencies and only shows with multi-currency enabled.
2. Inactive currencies are greyed but still clickable: click the **code cell** of the row (a plain click on a
   greyed row can time out; use the Playwright code tool with `force: true` if it does).
3. Tick **Active**.

## 2. Load the exchange rates (Rates tab of the currency form)

1. **Add a line** per rate and set **Date** in the user's date format.
2. Fill one of the two columns; they are the same rate in two directions:
   - **USD per Unit** (company currency per one foreign unit): 1.10 means 1 EUR = 1.10 USD.
   - **Unit per USD**: the inverse (0.909091 for the same rate). Odoo stores this one as `rate`.
3. A warning that the new rate is "quite far from the previous rate" can appear; read it, and continue only if the
   rate is the one requested.
4. **Critical:** after a rate line is committed, Odoo appends a new line pre-filled with today's date and the
   previous rate. Delete that pending line before saving, or it is stored as a rate for today and silently changes
   every document dated today.
5. Save, then read the rates back (`res.currency.rate`: `name` = date, `company_rate` / `inverse_company_rate`) and
   check that no unintended row exists.

## 3. Invoice in the foreign currency

1. **New** invoice; pick the customer first.
2. Set **Currency** before adding lines: it fixes the prices and the rate for the document.
3. Set **Invoice Date** (the rate of that date applies), press Tab, add the lines (no tax if the task says so),
   set **Customer Reference** on Other Info.
4. Confirm after Submit.

## 4. Payment and exchange difference

1. **Pay** on the posted invoice: the wizard proposes the amount in the invoice currency, the bank journal and today.
2. **Create Payment**. When the payment date's rate differs from the invoice's, Odoo posts the exchange difference in
   the Exchange Difference journal (`EXCH/...`) by itself; never book it by hand.

## 5. Verify

- `account.move`: `currency_id`, `amount_total`, `amount_residual`, `payment_state`.
- `account.partial.reconcile` of the receivable line: `exchange_move_id` points to the exchange difference entry;
  its amount is the foreign amount times the rate change.
