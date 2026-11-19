"""Internal models, config, and exceptions for stream-v1."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from pydantic.alias_generators import to_camel

type StreamNetwork = Literal["mainnet", "signet"]
type ConnectionState = Literal[
    "disconnected", "connecting", "connected", "reconnecting"
]


class BaseConfig:
    """Base configuration for all pydantic models in stream-v1."""

    model_config = ConfigDict(
        extra="allow",
        validate_assignment=True,
        str_strip_whitespace=True,
        use_enum_values=True,
        alias_generator=to_camel,
        validate_by_name=True,
    )


class StreamAuthContext(BaseModel, BaseConfig):
    """Stream API authentication context."""

    key: str = Field(..., min_length=1)
    secret: str = Field(..., min_length=1)
    passphrase: str = Field(..., min_length=1)


class StreamClientConfig(BaseModel):
    """Stream client configuration."""

    model_config = ConfigDict(extra="forbid")

    network: StreamNetwork = "mainnet"
    hostname: str | None = None
    reconnect_interval: float = Field(
        default=5.0, gt=0, description="Seconds between reconnection attempts"
    )
    reconnect_enabled: bool = True
    max_reconnect_attempts: int = Field(default=5, ge=0)


# ---------------------------------------------------------------------------
# JSON-RPC framing
# ---------------------------------------------------------------------------


class JsonRpcRequestFrame(BaseModel):
    model_config = ConfigDict(extra="forbid")

    jsonrpc: Literal["2.0"] = "2.0"
    id: str
    method: str
    params: Any | None = None


class JsonRpcErrorBody(BaseModel, BaseConfig):
    code: int
    message: str
    data: Any | None = None


class JsonRpcResponseFrame(BaseModel, BaseConfig):
    jsonrpc: Literal["2.0"] = "2.0"
    id: str
    result: Any | None = None
    error: JsonRpcErrorBody | None = None


class JsonRpcSubscriptionParams(BaseModel, BaseConfig):
    topic: str
    data: Any | None = None


class JsonRpcSubscriptionFrame(BaseModel, BaseConfig):
    jsonrpc: Literal["2.0"] = "2.0"
    method: Literal["subscription"]
    params: JsonRpcSubscriptionParams


# ---------------------------------------------------------------------------
# Exceptions (mirror of rest_v3 APIException family)
# ---------------------------------------------------------------------------


class StreamException(Exception):
    """Base exception for stream-v1."""


class StreamDisconnectedError(StreamException):
    """Raised when a method is called on a disconnected client."""

    def __init__(self, method: str) -> None:
        super().__init__(f"Cannot call {method}(): WebSocket is not connected")
        self.method = method


class ReconnectFailedError(StreamException):
    """Raised when reconnection attempts are exhausted."""

    def __init__(self, attempts: int) -> None:
        super().__init__(f"WebSocket reconnect failed after {attempts} attempt(s)")
        self.attempts = attempts


class StreamRequestTimeoutError(StreamException):
    """Raised when a JSON-RPC request times out."""

    def __init__(self, method: str) -> None:
        super().__init__(f"Request timed out after 10s (method: {method})")
        self.method = method


class StreamRpcError(StreamException):
    """Raised when the server returns a JSON-RPC error response."""

    def __init__(self, code: int, message: str, data: object | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.data = data


class StreamValidationException(StreamException):
    """Raised when a payload fails pydantic validation."""

    def __init__(self, message: str, validation_error: ValidationError) -> None:
        super().__init__(message)
        self.validation_error = validation_error


__all__ = [
    "BaseConfig",
    "ConnectionState",
    "JsonRpcErrorBody",
    "JsonRpcRequestFrame",
    "JsonRpcResponseFrame",
    "JsonRpcSubscriptionFrame",
    "JsonRpcSubscriptionParams",
    "ReconnectFailedError",
    "StreamAuthContext",
    "StreamClientConfig",
    "StreamDisconnectedError",
    "StreamException",
    "StreamNetwork",
    "StreamRequestTimeoutError",
    "StreamRpcError",
    "StreamValidationException",
]
