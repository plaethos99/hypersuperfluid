"""Customization service: plan, apply, roll back, list and export change sets, auditing every call.

Only connections with a `customize` block are served, with that block's own key. Applying and rolling back are
the only calls that write to Odoo; both re-check the change set against the live database first.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from typing import Any

from erp_agent.audit import AuditLog, AuditRecord
from erp_agent.config import AppConfig, OdooConnection, read_env
from erp_agent.connectors.base import pattern_predicate
from erp_agent.connectors.odoo import build_transport
from erp_agent.connectors.odoo_transport import OdooTransport
from erp_agent.customize.catalog import OdooCatalog
from erp_agent.customize.changes import AddAutomation, AddField, Change
from erp_agent.customize.export import ExportedModule, export_module
from erp_agent.customize.planner import Plan, Planner, RecordBuilder
from erp_agent.customize.store import ChangeSet, ChangeSetStore, CreatedRecord, new_id, now
from erp_agent.errors import ConnectorError, ErpAgentError, QueryRejected
from erp_agent.redact import Redactor

TransportFactory = Callable[[str, OdooConnection], OdooTransport]

# Rollback removes dependants before what they depend on; within one change, records go in reverse creation order.
_ROLLBACK_LAST = ("ir.model.fields",)


class CustomizeService:
    """Change sets over the Odoo connections that allow customization."""

    def __init__(
        self,
        config: AppConfig,
        transports: TransportFactory,
        store: ChangeSetStore,
        audit: AuditLog,
        redact: Callable[[str], str] = str,
    ) -> None:
        """@param config: Validated configuration.
        @param transports: Builds the customization user's transport for a connection.
        @param store: Change set storage.
        @param audit: Audit log for every call.
        @param redact: Removes secrets from error messages."""
        self._config = config
        self._transports = transports
        self._store = store
        self._audit = audit
        self._redact = redact
        self._open: dict[str, OdooTransport] = {}
        self._lock = threading.Lock()
        # One write at a time: two applies racing on one database would interleave records.
        self._write_lock = threading.Lock()

    @classmethod
    def from_config(cls, config: AppConfig, environ: Mapping[str, str] | None = None) -> CustomizeService:
        """@param config: Validated configuration.
        @param environ: Environment holding the customization keys; defaults to the process environment.
        @returns: A service whose transports connect lazily."""
        env = os.environ if environ is None else environ
        redactor = Redactor.from_config(config, env)

        def transport(name: str, connection: OdooConnection) -> OdooTransport:
            access = connection.customize
            if access is None:
                raise QueryRejected(f"{name} does not allow customization")
            as_customizer = connection.model_copy(update={"username": access.username})
            return build_transport(name, as_customizer, read_env(access.api_key_env, env))

        return cls(
            config,
            transport,
            ChangeSetStore(config.customize.changeset_dir),
            AuditLog(config.audit.path, redact=redactor),
            redact=redactor,
        )

    def connections(self) -> list[dict[str, Any]]:
        """@returns: Odoo connections with customization enabled."""
        rows = []
        for name, connection in sorted(self._config.connections.items()):
            if isinstance(connection, OdooConnection) and connection.customize is not None:
                rows.append({"name": name, "description": connection.description, "url": connection.url})
        return rows

    def _connection(self, name: str) -> OdooConnection:
        connection = self._config.connections.get(name)
        if not isinstance(connection, OdooConnection) or connection.customize is None:
            usable = ", ".join(c["name"] for c in self.connections()) or "none"
            raise QueryRejected(f"{name!r} is not an Odoo connection with customization enabled; usable: {usable}")
        return connection

    def _transport(self, name: str) -> OdooTransport:
        connection = self._connection(name)
        with self._lock:
            if name not in self._open:
                self._open = {**self._open, name: self._transports(name, connection)}
            return self._open[name]

    def _planner(self, name: str, catalog: OdooCatalog) -> Planner:
        access = self._connection(name).customize
        assert access is not None  # checked by _connection
        return Planner(catalog, pattern_predicate(access.model_allowlist, access.model_denylist))

    @contextmanager
    def _audited(self, tool: str, **params: object) -> Iterator[AuditRecord]:
        try:
            with self._audit.record(tool, **params) as record:
                yield record
        except ErpAgentError as exc:
            message = self._redact(str(exc))
            if message == str(exc):
                raise
            raise type(exc)(message) from exc

    def _check(self, connection: str, changes: tuple[Change, ...]) -> Plan:
        catalog = OdooCatalog(self._transport(connection))
        plan = self._planner(connection, catalog).plan(changes)
        if plan.findings.errors:
            raise QueryRejected(
                "the change set has problems; fix them and plan again:\n- " + "\n- ".join(plan.findings.errors)
            )
        return plan

    def plan(self, connection: str, title: str, changes: tuple[Change, ...]) -> ChangeSet:
        """Validate changes against the live database and store them as a planned change set. Writes nothing to Odoo.

        @param connection: Odoo connection with customization enabled.
        @param title: What the change set does, in the person's words.
        @param changes: Changes in application order.
        @returns: The stored change set.
        @raises QueryRejected: Listing every problem found.
        """
        if not changes:
            raise QueryRejected("a change set needs at least one change")
        with self._audited("odoo_plan_changes", connection=connection, title=title, changes=len(changes)) as rec:
            plan = self._check(connection, changes)
            changeset = ChangeSet(
                id=new_id(),
                connection=connection,
                title=title,
                created_at=now(),
                changes=changes,
                summary=[c.summary for c in plan.changes],
                warnings=plan.findings.warnings,
                depends=sorted(plan.depends),
            )
            self._store.save(changeset)
            rec.extra["changeset"] = changeset.id
            rec.row_count = len(changes)
            return changeset

    def show(self, changeset_id: str) -> ChangeSet:
        """@returns: One stored change set."""
        return self._store.load(changeset_id)

    def list(self, connection: str | None, limit: int) -> list[ChangeSet]:
        """@returns: Change sets, newest first."""
        if limit < 1:
            raise QueryRejected("limit must be at least 1")
        return self._store.list(connection, min(limit, 100))

    def apply(self, changeset_id: str) -> ChangeSet:
        """Create the change set's records in Odoo, in order, saving each created id as it goes.

        A failure stops the run and leaves the change set `failed` with the records created so far, which
        `rollback` removes.

        @param changeset_id: A `planned` change set.
        @returns: The change set, `applied` or `failed`.
        """
        with self._write_lock, self._audited("odoo_apply_changeset", changeset=changeset_id) as rec:
            changeset = self._store.load(changeset_id)
            if changeset.status != "planned":
                raise QueryRejected(f"{changeset_id} is {changeset.status}; only a planned change set can be applied")
            rec.extra["connection"] = changeset.connection
            self._check(changeset.connection, changeset.changes)
            transport = self._transport(changeset.connection)
            catalog = OdooCatalog(transport)
            builder = RecordBuilder(catalog)
            try:
                for index, change in enumerate(changeset.changes, start=1):
                    model, values = builder.values(change)
                    created = transport.call(model, "create", {"vals_list": [values]})
                    record_id = int(created[0] if isinstance(created, list) else created)
                    label = str(values.get("name", model))
                    changeset.created.append(CreatedRecord(change=index, model=model, id=record_id, label=label))
                    self._store.save(changeset)
                    self._read_back(transport, catalog, changeset, change, model, record_id)
            except ErpAgentError as exc:
                changeset.status = "failed"
                changeset.error = self._redact(str(exc))
                self._store.save(changeset)
                rec.extra["outcome_detail"] = "failed"
                rec.row_count = len(changeset.created)
                return changeset
            changeset.status = "applied"
            changeset.applied_at = now()
            self._store.save(changeset)
            rec.row_count = len(changeset.created)
            return changeset

    def _read_back(
        self,
        transport: OdooTransport,
        catalog: OdooCatalog,
        changeset: ChangeSet,
        change: Change,
        model: str,
        record_id: int,
    ) -> None:
        # Confirm the record from Odoo itself, and keep facts the person needs (a webhook's URL).
        extra = {"base.automation": ["url"], "ir.cron": ["ir_actions_server_id"]}.get(model, [])
        rows = transport.call(model, "read", {"ids": [record_id], "fields": ["id", "display_name", *extra]})
        if not rows:
            raise ConnectorError(f"{model} {record_id} was created but cannot be read back")
        row = rows[0]
        last = changeset.created[-1]
        if isinstance(change, AddAutomation) and change.trigger == "on_webhook" and row.get("url"):
            changeset.results[f"change {last.change} webhook url"] = str(row["url"])
        if model == "ir.cron" and row.get("ir_actions_server_id"):
            # Deleting a scheduled action leaves the server action it extends; roll that back after the cron.
            server = row["ir_actions_server_id"]
            server_id = int(server[0] if isinstance(server, list) else server)
            changeset.created.insert(
                len(changeset.created) - 1,
                CreatedRecord(change=last.change, model="ir.actions.server", id=server_id, label=last.label),
            )
        self._store.save(changeset)
        if isinstance(change, AddField):
            catalog.forget(change.model)

    def rollback(self, changeset_id: str) -> ChangeSet:
        """Delete what an applied or failed change set created, newest first; records already gone are skipped.

        @param changeset_id: An `applied` or `failed` change set.
        @returns: The change set, `rolled_back`.
        """
        with self._write_lock, self._audited("odoo_rollback_changeset", changeset=changeset_id) as rec:
            changeset = self._store.load(changeset_id)
            if changeset.status not in ("applied", "failed"):
                raise QueryRejected(f"{changeset_id} is {changeset.status}; only applied or failed sets roll back")
            rec.extra["connection"] = changeset.connection
            transport = self._transport(changeset.connection)
            catalog = OdooCatalog(transport)
            ordered = sorted(
                reversed(changeset.created), key=lambda r: r.model in _ROLLBACK_LAST
            )  # stable: keeps reverse order within each group
            removed = 0
            for record in ordered:
                if record.id not in catalog.existing_ids(record.model, [record.id]):
                    continue
                transport.call(record.model, "unlink", {"ids": [record.id]})
                removed += 1
            changeset.status = "rolled_back"
            changeset.rolled_back_at = now()
            changeset.error = None
            self._store.save(changeset)
            rec.row_count = removed
            return changeset

    def export(self, changeset_id: str, module: str) -> ExportedModule:
        """Write an applied change set as an installable data module (zip).

        @param changeset_id: An `applied` change set; export what has been tried on a database.
        @param module: Technical module name.
        @returns: The module path and warnings.
        """
        with self._audited("odoo_export_changeset", changeset=changeset_id, module=module) as rec:
            changeset = self._store.load(changeset_id)
            if changeset.status != "applied":
                raise QueryRejected(f"{changeset_id} is {changeset.status}; apply and check it before exporting")
            catalog = OdooCatalog(self._transport(changeset.connection))
            exported = export_module(changeset, module, catalog, self._config.customize.export_dir)
            rec.row_count = len(changeset.changes)
            return exported

    def close(self) -> None:
        """Close every transport that was opened."""
        with self._lock:
            transports, self._open = self._open, {}
        for transport in transports.values():
            transport.close()
