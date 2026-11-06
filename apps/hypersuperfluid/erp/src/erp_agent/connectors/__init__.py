"""Connector construction from configuration."""

from __future__ import annotations

from collections.abc import Mapping

from erp_agent.config import OdooConnection, read_env
from erp_agent.connectors.base import ErpConnector, pattern_predicate
from erp_agent.connectors.odoo import OdooConnector, build_transport


def build_connector(name: str, config: OdooConnection, environ: Mapping[str, str]) -> ErpConnector:
    """Create the connector for one configured Odoo connection. No network call is made here.

    @param name: Connection name.
    @param config: Validated connection configuration.
    @param environ: Environment holding the secrets.
    @returns: A connector that connects on first use.
    """
    allowed = pattern_predicate(config.entity_allowlist, config.entity_denylist)
    transport = build_transport(name, config, read_env(config.api_key_env, environ))
    return OdooConnector(name, transport, allowed)
