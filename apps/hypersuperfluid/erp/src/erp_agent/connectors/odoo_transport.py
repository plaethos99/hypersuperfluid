"""Odoo external API transports: JSON-2 (Odoo 19+), XML-RPC (up to Odoo 18), and automatic selection.

Every transport calls `<model>.<method>` with named parameters, so the connector is identical for
both protocols. XML-RPC endpoints are removed in newer Odoo releases (already absent on Odoo 20);
JSON-2 requires an API key rather than a password.
"""

from __future__ import annotations

import threading
import xmlrpc.client
from collections.abc import Callable
from typing import Any, Protocol

import httpx

from erp_agent.errors import ConnectorError, QueryRejected

ProxyFactory = Callable[[str], Any]
"""Creates an XML-RPC proxy for an endpoint URL; injectable for tests."""

_MAX_MESSAGE = 500


class OdooTransport(Protocol):
    """Calls one Odoo model method with named parameters."""

    def call(self, model: str, method: str, params: dict[str, object]) -> Any:
        """@param model: Model name such as `res.partner`.
        @param method: Public model method such as `search_read`.
        @param params: Named method parameters.
        @returns: The decoded return value.
        @raises QueryRejected: When Odoo refuses the request itself (unknown model, bad arguments).
        @raises ConnectorError: On authentication, access, server or transport failures."""
        ...

    def close(self) -> None:
        """Release connections."""
        ...


class Json2Transport:
    """`POST /json/2/<model>/<method>` with `Authorization: bearer <api key>`."""

    def __init__(self, name: str, url: str, database: str, client: httpx.Client) -> None:
        """@param name: Connection name for error messages.
        @param url: Odoo base URL.
        @param database: Sent as `X-Odoo-Database`.
        @param client: Client carrying the Authorization header."""
        self._name = name
        self._url = url.rstrip("/")
        self._database = database
        self._client = client

    @classmethod
    def create(cls, name: str, url: str, database: str, api_key: str, timeout_s: float) -> Json2Transport:
        """@returns: A transport with an authenticated client."""
        client = httpx.Client(
            headers={"Authorization": f"bearer {api_key}", "X-Odoo-Database": database},
            timeout=timeout_s,
            follow_redirects=False,
        )
        return cls(name, url, database, client)

    def post(self, model: str, method: str, params: dict[str, object]) -> httpx.Response:
        """Send one call and return the raw response (used by protocol detection).

        @raises ConnectorError: On transport failure."""
        try:
            return self._client.post(f"{self._url}/json/2/{model}/{method}", json=params)
        except httpx.HTTPError as exc:
            raise ConnectorError(f"{self._name}: cannot reach Odoo: {exc}") from exc

    def decode(self, response: httpx.Response, model: str, method: str) -> Any:
        """Decode a JSON-2 response or raise the matching error.

        @raises QueryRejected: On 404 (unknown model or method) and 422 (invalid arguments).
        @raises ConnectorError: On 401, 403 and other failures."""
        if response.is_success:
            try:
                return response.json()
            except ValueError as exc:
                raise ConnectorError(f"{self._name}: Odoo response is not JSON") from exc
        try:
            message = str(response.json().get("message", ""))[:_MAX_MESSAGE]
        except ValueError:
            message = response.text[:_MAX_MESSAGE]
        status = response.status_code
        if status == 401:
            raise ConnectorError(f"{self._name}: Odoo rejected the API key ({message})")
        if status == 403:
            raise ConnectorError(f"{self._name}: access denied for {model}.{method}: {message}")
        if status in (404, 422):
            raise QueryRejected(f"{self._name}: {model}.{method} refused: {message}")
        raise ConnectorError(f"{self._name}: {model}.{method} failed with HTTP {status}: {message}")

    def call(self, model: str, method: str, params: dict[str, object]) -> Any:
        return self.decode(self.post(model, method, params), model, method)

    def close(self) -> None:
        self._client.close()


class XmlRpcTransport:
    """`execute_kw` over XML-RPC with username and API key (or password)."""

    def __init__(
        self, name: str, url: str, database: str, username: str, api_key: str, proxy_factory: ProxyFactory
    ) -> None:
        """@param name: Connection name for error messages.
        @param url: Odoo base URL.
        @param database: Database name.
        @param username: Login of the bot user.
        @param api_key: API key or password.
        @param proxy_factory: Creates XML-RPC proxies."""
        self._name = name
        self._url = url.rstrip("/")
        self._database = database
        self._username = username
        self._api_key = api_key
        self._proxy_factory = proxy_factory
        self._uid: int | None = None
        self._models: Any = None
        # xmlrpc.client reuses one HTTP connection per proxy, which is not safe across threads.
        self._lock = threading.Lock()

    @classmethod
    def create(
        cls, name: str, url: str, database: str, username: str, api_key: str, timeout_s: float
    ) -> XmlRpcTransport:
        """@returns: A transport using `xmlrpc.client` with a socket timeout."""

        def factory(endpoint: str) -> Any:
            transport_cls = xmlrpc.client.SafeTransport if endpoint.startswith("https") else xmlrpc.client.Transport
            transport = transport_cls()
            transport.timeout = timeout_s  # type: ignore[attr-defined]
            return xmlrpc.client.ServerProxy(endpoint, transport=transport, allow_none=True)

        return cls(name, url, database, username, api_key, factory)

    def call(self, model: str, method: str, params: dict[str, object]) -> Any:
        with self._lock:
            return self._call_locked(model, method, params)

    def _call_locked(self, model: str, method: str, params: dict[str, object]) -> Any:
        if self._uid is None:
            try:
                uid = self._proxy_factory(f"{self._url}/xmlrpc/2/common").authenticate(
                    self._database, self._username, self._api_key, {}
                )
            except (OSError, xmlrpc.client.Error) as exc:
                raise ConnectorError(f"{self._name}: cannot reach Odoo: {exc}") from exc
            if not uid:
                raise ConnectorError(f"{self._name}: Odoo rejected the credentials for {self._username}")
            self._uid = int(uid)
            self._models = self._proxy_factory(f"{self._url}/xmlrpc/2/object")
        args, kwargs = _positional(params)
        try:
            return self._models.execute_kw(self._database, self._uid, self._api_key, model, method, args, kwargs)
        except xmlrpc.client.Fault as exc:
            raise ConnectorError(f"{self._name}: {model}.{method} failed: {exc.faultString[:_MAX_MESSAGE]}") from exc
        except (OSError, xmlrpc.client.Error) as exc:
            raise ConnectorError(f"{self._name}: cannot reach Odoo: {exc}") from exc

    def close(self) -> None:
        with self._lock:
            self._uid = None
            self._models = None


_POSITIONAL = ("ids", "vals_list")
"""Named parameters that XML-RPC must send positionally. Odoo's `call_kw` takes record ids from `args[0]`
for record methods (`read`, `unlink`) and inspects `args[0]` for `create`; JSON-2 accepts both by name."""


def _positional(params: dict[str, object]) -> tuple[list[object], dict[str, object]]:
    args = [params[name] for name in _POSITIONAL if name in params]
    return args, {k: v for k, v in params.items() if k not in _POSITIONAL}


def _json2_missing(response: httpx.Response) -> bool:
    # A server without JSON-2 answers 404 from its generic router (HTML); a JSON-2 server answers
    # errors as JSON objects with a "name" field.
    if response.status_code != 404:
        return False
    try:
        return "name" not in response.json()
    except ValueError:
        return True


class AutoTransport:
    """Uses JSON-2 when the server has it and XML-RPC otherwise; decided on the first call."""

    def __init__(self, json2: Json2Transport, xmlrpc_factory: Callable[[], OdooTransport]) -> None:
        """@param json2: JSON-2 transport tried first.
        @param xmlrpc_factory: Creates the XML-RPC transport when JSON-2 is absent."""
        self._json2 = json2
        self._xmlrpc_factory = xmlrpc_factory
        self._chosen: OdooTransport | None = None
        self._lock = threading.Lock()

    @property
    def protocol(self) -> str | None:
        """@returns: `json2`, `xmlrpc`, or None before the first call."""
        if self._chosen is None:
            return None
        return "json2" if self._chosen is self._json2 else "xmlrpc"

    def call(self, model: str, method: str, params: dict[str, object]) -> Any:
        with self._lock:
            chosen = self._chosen
            if chosen is None:
                response = self._json2.post(model, method, params)
                if _json2_missing(response):
                    self._chosen = self._xmlrpc_factory()
                    self._json2.close()
                    chosen = self._chosen
                else:
                    self._chosen = self._json2
                    return self._json2.decode(response, model, method)
        return chosen.call(model, method, params)

    def close(self) -> None:
        with self._lock:
            chosen = self._chosen
        (chosen or self._json2).close()
