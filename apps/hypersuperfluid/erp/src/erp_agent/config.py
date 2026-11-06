"""Configuration file schema and loader.

Configuration names environment variables for every secret; it never holds a secret itself.
`load_config` fails when the file is invalid; a connection whose secret variables are unset is set aside
in `AppConfig.skipped_connections` so the rest keeps working.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Annotated, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, ValidationError, field_validator

from erp_agent.errors import ConfigError

_CONNECTION_NAME_PATTERN = r"^[a-z][a-z0-9_]{0,31}$"


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class OdooCustomizeAccess(_Frozen):
    """Credentials and limits for the customization tools (`erp-customize`) on one Odoo connection.

    The customization user needs Administration / Settings rights to create fields, views, automation rules
    and server actions, so it is a separate key from the connection's read-only key.
    """

    username: str = Field(description="Login of the customization user; used by XML-RPC only")
    api_key_env: str = Field(description="Variable holding the customization user's API key")
    model_allowlist: tuple[str, ...] = Field(
        default=(), description="fnmatch patterns; when non-empty, only matching models may be customized"
    )
    model_denylist: tuple[str, ...] = Field(
        default=("ir.*", "res.users*", "res.groups*", "base.*", "account.account*", "account.tax*"),
        description="fnmatch patterns of models that are never customized",
    )


class OdooConnection(_Frozen):
    """Odoo through its external API: JSON-2 (Odoo 19+) or XML-RPC (up to Odoo 18)."""

    kind: Literal["odoo"] = "odoo"
    description: str | None = Field(default=None, description="Shown to the model to pick a connection")
    url: str
    database: str
    username: str = Field(description="Login of the bot user; used by XML-RPC only")
    api_key_env: str = Field(description="Variable holding the bot user's API key")
    protocol: Literal["auto", "json2", "xmlrpc"] = Field(
        default="auto", description="auto tries JSON-2 and falls back to XML-RPC when /json/2 does not exist"
    )
    max_rows: int = Field(default=200, ge=1, le=10_000, description="Upper bound on rows per query")
    entity_allowlist: tuple[str, ...] = Field(
        default=(), description="fnmatch patterns; when non-empty, only matching models are readable"
    )
    entity_denylist: tuple[str, ...] = Field(default=(), description="fnmatch patterns that are never readable")
    timeout_s: float = Field(default=30.0, gt=0)
    customize: OdooCustomizeAccess | None = Field(
        default=None, description="Enables the customization tools on this connection; omitted means read-only"
    )

    def secret_env_names(self) -> tuple[str, ...]:
        """@returns: Environment variables this connection needs at runtime. The customization key is optional:
        without it the connection stays usable for reads."""
        return (self.api_key_env,)


ConnectionConfig = OdooConnection
"""Every configured connection is an Odoo database."""


class ExtractConfig(_Frozen):
    """Limits for `extract_tables`."""

    allowed_dirs: tuple[Path, ...] = Field(default=(), description="Local directories files may be read from")
    allow_private_hosts: bool = Field(default=False, description="Allow URLs resolving to private or loopback IPs")
    max_bytes: int = Field(default=20_000_000, ge=1)
    timeout_s: float = Field(default=30.0, gt=0)
    max_tables: int = Field(default=20, ge=1)
    max_rows: int = Field(default=500, ge=1)


class FirecrawlConfig(_Frozen):
    """Firecrawl API access (hosted or self-hosted)."""

    api_key_env: str = "FIRECRAWL_API_KEY"
    api_url: str = "https://api.firecrawl.dev"
    max_retries: int = Field(default=3, ge=0, le=10, description="Retries after HTTP 429 (rate limited)")
    max_retry_wait_s: float = Field(default=65.0, gt=0, description="Longest single wait before a retry")


class WebConfig(_Frozen):
    """Limits and backend for `fetch_page` and `crawl_site`.

    `backend: auto` uses Firecrawl when its key variable is set and the built-in fetcher otherwise;
    `firecrawl` requires the key; `builtin` never calls Firecrawl.
    """

    backend: Literal["auto", "builtin", "firecrawl"] = "auto"
    firecrawl: FirecrawlConfig = FirecrawlConfig()
    max_chars: int = Field(default=20_000, ge=500, description="Characters of text returned by fetch_page")
    crawl_page_chars: int = Field(default=3_000, ge=200, description="Characters of text per crawled page")
    crawl_max_pages: int = Field(default=25, ge=1, le=500)
    crawl_max_depth: int = Field(default=2, ge=0, le=10)
    crawl_max_queued: int = Field(
        default=500, ge=1, le=100_000, description="URLs one built-in crawl may discover; further links are ignored"
    )
    crawl_delay_s: float = Field(default=1.0, ge=0, description="Pause between built-in crawler requests")
    crawl_timeout_s: float = Field(default=180.0, gt=0, description="Wall-clock limit for one crawl")
    user_agent: str = "hypersuperfluid-erp/0.1 (+https://github.com/plaethos99/hypersuperfluid)"


class AuditConfig(_Frozen):
    path: Path = Path("logs/audit.jsonl")


class CustomizeConfig(_Frozen):
    """Where the customization tools keep change sets and exported modules."""

    changeset_dir: Path = Field(default=Path("state/changesets"), description="Planned and applied change sets")
    export_dir: Path = Field(default=Path("state/modules"), description="Data modules built from change sets")


class DockerComposeRunner(_Frozen):
    """Runs module tests in a one-off container of a Docker Compose service (the `odoo` image's entrypoint
    supplies the database connection). The workspace is passed to the compose file as `SUPERFLUID_ADDONS`."""

    kind: Literal["docker_compose"]
    compose_file: Path
    service: str = "odoo"
    database: str = Field(description="Test database; created on first use")
    timeout_s: float = Field(default=1800.0, gt=0)


class CommandRunner(_Frozen):
    """Runs module tests with any command, such as a local `odoo-bin`. `{module}` and `{database}` in `argv`
    are replaced; the command must install or update the module with tests enabled and stop afterwards."""

    kind: Literal["command"]
    argv: tuple[str, ...] = Field(min_length=1)
    database: str
    cwd: Path | None = None
    timeout_s: float = Field(default=1800.0, gt=0)


ModuleRunner = Annotated[DockerComposeRunner | CommandRunner, Field(discriminator="kind")]


class ModuleWorkspace(_Frozen):
    """A Git repository of one client's custom addons."""

    path: Path = Field(description="Repository root; every module is a directory directly under it")
    description: str | None = None
    odoo_version: str = Field(default="18.0", pattern=r"^\d{2}\.\d$")
    author: str | None = Field(default=None, description="Manifest author of new modules")
    license: Literal["LGPL-3", "AGPL-3", "GPL-3", "OPL-1", "Other proprietary"] = "LGPL-3"
    runner: ModuleRunner | None = Field(default=None, description="How odoo_module_test installs and tests")
    push_remote: str | None = Field(default=None, description="Git remote odoo_module_push may push to")
    protected_branches: tuple[str, ...] = Field(
        default=("main", "master", "production", "prod", "live"),
        description="Branches odoo_module_push never pushes to (Odoo.sh production and the like)",
    )


class ModulesConfig(_Frozen):
    """Python module workspaces for the module tools in `erp-customize`."""

    workspaces: dict[str, ModuleWorkspace] = Field(default_factory=dict)

    @field_validator("workspaces")
    @classmethod
    def _check_names(cls, value: dict[str, ModuleWorkspace]) -> dict[str, ModuleWorkspace]:
        bad = [name for name in value if not re.fullmatch(_CONNECTION_NAME_PATTERN, name)]
        if bad:
            raise ValueError(f"workspace names must match {_CONNECTION_NAME_PATTERN}: {bad}")
        return value


class AppConfig(_Frozen):
    """Root of the configuration file."""

    connections: dict[str, ConnectionConfig]
    extract: ExtractConfig = ExtractConfig()
    web: WebConfig = WebConfig()
    audit: AuditConfig = AuditConfig()
    customize: CustomizeConfig = CustomizeConfig()
    modules: ModulesConfig = ModulesConfig()
    _skipped: dict[str, tuple[ConnectionConfig, tuple[str, ...]]] = PrivateAttr(default_factory=dict)

    @property
    def skipped_connections(self) -> Mapping[str, tuple[ConnectionConfig, tuple[str, ...]]]:
        """Connections left out because secret variables they name are unset: name -> (connection, missing)."""
        return MappingProxyType(self._skipped)

    @field_validator("connections")
    @classmethod
    def _check_names(cls, value: dict[str, ConnectionConfig]) -> dict[str, ConnectionConfig]:
        bad = [name for name in value if not re.fullmatch(_CONNECTION_NAME_PATTERN, name)]
        if bad:
            raise ValueError(f"connection names must match {_CONNECTION_NAME_PATTERN}: {bad}")
        return value


def read_env(name: str, environ: Mapping[str, str]) -> str:
    """Read a required environment variable.

    @param name: Variable name.
    @param environ: Environment to read from.
    @returns: The non-empty value.
    @raises ConfigError: When the variable is unset or empty.
    """
    value = environ.get(name, "")
    if not value:
        raise ConfigError(f"environment variable {name} is not set")
    return value


def _resolve_paths(config: AppConfig, base_dir: Path) -> AppConfig:
    def absolute(path: Path) -> Path:
        return (base_dir / path).resolve()

    extract = config.extract.model_copy(
        update={"allowed_dirs": tuple(absolute(p) for p in config.extract.allowed_dirs)}
    )
    audit = config.audit.model_copy(update={"path": absolute(config.audit.path)})
    customize = config.customize.model_copy(
        update={
            "changeset_dir": absolute(config.customize.changeset_dir),
            "export_dir": absolute(config.customize.export_dir),
        }
    )
    workspaces = {}
    for name, workspace in config.modules.workspaces.items():
        runner = workspace.runner
        match runner:
            case DockerComposeRunner():
                runner = runner.model_copy(update={"compose_file": absolute(runner.compose_file)})
            case CommandRunner() if runner.cwd is not None:
                runner = runner.model_copy(update={"cwd": absolute(runner.cwd)})
        workspaces[name] = workspace.model_copy(update={"path": absolute(workspace.path), "runner": runner})
    modules = config.modules.model_copy(update={"workspaces": workspaces})
    return config.model_copy(update={"extract": extract, "audit": audit, "customize": customize, "modules": modules})


def parse_config(data: object, base_dir: Path, environ: Mapping[str, str]) -> AppConfig:
    """Validate configuration data and set aside connections whose secret variables are unset.

    A connection that names an unset secret variable is left out of `connections` and reported in
    `skipped_connections`, so the other connections and the web tools keep working without it.

    @param data: Parsed YAML document.
    @param base_dir: Directory that relative paths resolve against.
    @param environ: Environment the secrets are read from.
    @returns: Validated configuration with absolute paths.
    @raises ConfigError: On schema errors, or when `web.backend: firecrawl` is chosen without its key.
    """
    try:
        config = AppConfig.model_validate(data)
    except ValidationError as exc:
        raise ConfigError(f"invalid configuration:\n{exc}") from exc
    if config.web.backend == "firecrawl" and not environ.get(config.web.firecrawl.api_key_env):
        raise ConfigError(f"environment variables not set: {config.web.firecrawl.api_key_env}")
    skipped: dict[str, tuple[ConnectionConfig, tuple[str, ...]]] = {}
    for name, connection in config.connections.items():
        missing = tuple(sorted(env for env in connection.secret_env_names() if not environ.get(env)))
        if missing:
            skipped[name] = (connection, missing)
    kept = {name: c for name, c in config.connections.items() if name not in skipped}
    resolved = _resolve_paths(config.model_copy(update={"connections": kept}), base_dir)
    resolved._skipped = skipped
    return resolved


def load_config(path: Path, environ: Mapping[str, str] | None = None) -> AppConfig:
    """Load and validate a YAML configuration file.

    @param path: Configuration file.
    @param environ: Environment for secrets; defaults to the process environment.
    @returns: Validated configuration.
    @raises ConfigError: When the file is unreadable, invalid, or references unset variables.
    """
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc
    return parse_config(data, path.parent.resolve(), os.environ if environ is None else environ)
