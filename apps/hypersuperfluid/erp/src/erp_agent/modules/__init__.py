"""Python module tools: scaffold, edit, check, test, review and ship custom Odoo modules in a Git workspace.

A workspace is a Git repository of one client's custom addons. Files are only read and written inside it; every
change is reviewed as a Git diff, tested by installing the module on a test database, and kept or discarded with
Git. Odoo's own source is never edited: customization happens by inheritance in these modules.
"""
