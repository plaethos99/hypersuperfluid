# Accrual with a scheduled reversal (Odoo 18 and 19, checked in the source)

1. Accounting → Journal Entries → **New**. Journal **Miscellaneous Operations**, Accounting Date = the last day of
   the month, Reference as given. Debit the expense account, credit the accrued-liabilities (current liability)
   account, same amount. Save, read the lines back, then **Post** (approval first).
2. On the posted entry click **Reverse Entry**. Reversal date = the first day of the next month, same journal,
   then **Reverse**.
3. What you see next depends on the date:
   - Reversal date today or earlier: the reversal is posted at once.
   - Reversal date in the future: the reversal opens as a **draft** with "Auto-post: At Date" and no Post button.
     That is the scheduled reversal, done: Odoo's scheduled action posts it once on that date. Do not post it by
     hand, do not create a second reversal, do not delete it.
4. Verify with `erp_query` on `account.move`: the reversal has `reversed_entry_id` = the accrual, the right date,
   and `state` posted or (`state` draft and `auto_post` `at_date`).

Use **Reverse Entry**, not a hand-made opposite entry: only Reverse links the two entries (`reversed_entry_id`),
which is what an auditor and Odoo's reports follow. Report a scheduled reversal as "scheduled to post on <date>".
