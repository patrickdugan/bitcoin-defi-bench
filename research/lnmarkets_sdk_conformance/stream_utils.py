"""Internal utilities for stream-v1."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from datetime import UTC, datetime
from types import UnionType
from typing import Any

from pydantic import TypeAdapter, ValidationError

from .models import StreamAuthContext, StreamNetwork, StreamValidationException


def get_hostname(network: StreamNetwork) -> str:
    """Stream API hostname for the given network."""
    return (
        "stream.signet.lnmarkets.com"
        if network == "signet"
        else "stream.lnmarkets.com"
    )


def get_websocket_url(network: StreamNetwork, hostname: str | None = None) -> str:
    """Full wss:// URL for the given network or explicit hostname."""
    host = hostname or get_hostname(network)
    return f"wss://{host}/v1"


def create_signature(secret: str, timestamp: int, nonce: str) -> str:
    """HMAC-SHA256 signature over `{timestamp}{nonce}`, base64-encoded."""
    payload = f"{timestamp}{nonce}".encode()
    digest = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).digest()
    return base64.b64encode(digest).decode("utf-8")


def generate_auth_params(auth: StreamAuthContext) -> dict[str, str | int]:
    """Build the params object expected by the `authenticate` RPC method."""
    nonce = secrets.token_hex(8)
    timestamp = int(datetime.now(tz=UTC).timestamp() * 1000)
    signature = create_signature(auth.secret, timestamp, nonce)
    return {
        "key": auth.key,
        "signature": signature,
        "timestamp": timestamp,
        "passphrase": auth.passphrase,
        "nonce": nonce,
    }


def parse_payload[T](data: Any, model: type[T] | UnionType | None) -> T | Any:
    """Validate a payload against a pydantic model (or union)."""
    if model is None:
        return data
    try:
        adapter: TypeAdapter[T] = TypeAdapter(model)
        return adapter.validate_python(data)
    except ValidationError as error:
        raise StreamValidationException(
            f"Payload validation failed: {error}", validation_error=error
        ) from error


__all__ = [
    "create_signature",
    "generate_auth_params",
    "get_hostname",
    "get_websocket_url",
    "parse_payload",
]
