"""Odoo customization tools: plan, apply, roll back and export change sets of no-code customizations.

A change set lists fields, view extensions, server actions, automation rules and scheduled actions. Planning
validates it against the live database and writes nothing to Odoo; applying creates the records and remembers
their ids, so a change set can be rolled back or exported as a data module that installs on Odoo Online too.
"""
