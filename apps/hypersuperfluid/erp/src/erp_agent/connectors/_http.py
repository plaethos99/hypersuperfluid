"""HTTP helpers shared by REST-based connectors."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx

from erp_agent.errors import ConnectorError, QueryRejected

_MAX_ERROR_BODY = 300


def get(client: httpx.Client, url: str, params: Mapping[str, str | int], connection: str) -> httpx.Response:
    """Send a GET request and translate failures.

    @param client: Configured client (auth, timeout).
    @param url: Absolute URL.
    @param params: Query parameters.
    @param connection: Connection name for error messages.
    @returns: A 2xx response.
    @raises QueryRejected: On 404, meaning the entity or record does not exist.
    @raises ConnectorError: On other HTTP errors and transport failures.
    """
    try:
        response = client.get(url, params=dict(params))
    except httpx.HTTPError as exc:
        raise ConnectorError(f"{connection}: request failed: {exc}") from exc
    if response.status_code == 404:
        raise QueryRejected(f"{connection}: not found: {response.request.url.path}")
    if response.is_error:
        body = response.text[:_MAX_ERROR_BODY]
        raise ConnectorError(f"{connection}: HTTP {response.status_code}: {body}")
    return response


def get_json(client: httpx.Client, url: str, params: Mapping[str, str | int], connection: str) -> Any:
    """GET and decode a JSON body.

    @returns: The decoded JSON value.
    @raises ConnectorError: When the body is not JSON, plus the errors of `get`.
    """
    response = get(client, url, params, connection)
    try:
        return response.json()
    except ValueError as exc:
        raise ConnectorError(f"{connection}: response is not JSON") from exc
