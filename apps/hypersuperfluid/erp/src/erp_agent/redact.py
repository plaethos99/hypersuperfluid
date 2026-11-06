"""Removal of configured secret values from text shown to the model or written to the audit log.

Driver and HTTP exceptions are embedded in error messages; some drivers include connection strings
or credentials in that text.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from erp_agent.config import AppConfig

_MIN_SECRET_LENGTH = 4
_MASK = "***"


class Redactor:
    """Replaces every occurrence of known secret values with `***`."""

    def __init__(self, secrets: Iterable[str]) -> None:
        """@param secrets: Secret values; values shorter than 4 characters are ignored."""
        unique = {s for s in secrets if len(s) >= _MIN_SECRET_LENGTH}
        # Longest first, so a URL containing a password is masked as a whole.
        self._secrets = tuple(sorted(unique, key=len, reverse=True))

    def __call__(self, text: str) -> str:
        """@param text: Message that may contain secrets.
        @returns: The message with every secret replaced."""
        for secret in self._secrets:
            text = text.replace(secret, _MASK)
        return text

    @classmethod
    def from_config(cls, config: AppConfig, environ: Mapping[str, str]) -> Redactor:
        """Collect the secret values a configuration references.

        @param config: Validated configuration.
        @param environ: Environment holding the secrets.
        @returns: A redactor for those values.
        """
        values: list[str] = []
        for connection in config.connections.values():
            for name in connection.secret_env_names():
                values.append(environ.get(name, ""))
            if connection.customize is not None:
                values.append(environ.get(connection.customize.api_key_env, ""))
        values.append(environ.get(config.web.firecrawl.api_key_env, ""))
        return cls(values)
