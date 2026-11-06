"""Error types raised by the ERP layer.

Every error message is safe to show to the model: none carries credentials or result rows.
"""


class ErpAgentError(Exception):
    """Base class for all errors raised by this package."""


class ConfigError(ErpAgentError):
    """Configuration is invalid or references a missing environment variable."""


class QueryRejected(ErpAgentError):
    """A request was refused before reaching the ERP (unknown field, disallowed model)."""


class ConnectorError(ErpAgentError):
    """The ERP returned an error or could not be reached."""


class ExtractionError(ErpAgentError):
    """A document or page could not be fetched or parsed into tables."""
