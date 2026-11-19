from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, SkipValidation, ValidationError
from pydantic.alias_generators import to_camel

type APINetwork = Literal["mainnet", "signet"]
type APIMethod = Literal["GET", "POST", "PUT", "DELETE"]
type UUID = str


class BaseConfig:
    """Base configuration for all Pydantic models."""

    model_config = ConfigDict(
        extra="allow",
        validate_assignment=True,
        str_strip_whitespace=True,
        use_enum_values=True,
        alias_generator=to_camel,
        validate_by_name=True,  # to make `from_` field becomes `from`
    )


class APIAuthContext(BaseModel, BaseConfig):
    """API Authentication context."""

    key: str = Field(..., min_length=1)
    secret: str = Field(..., min_length=1)
    passphrase: str = Field(..., min_length=1)


class APIClientConfig(BaseModel):
    """API Client configuration."""

    model_config = ConfigDict(extra="forbid")

    authentication: APIAuthContext | None = None
    network: APINetwork = "mainnet"
    hostname: str | None = None
    custom_headers: dict[str, str] | None = None
    timeout: float = Field(default=30.0, gt=0, description="Request timeout in seconds")
    max_retries: int = Field(
        default=3,
        ge=0,
        description=(
            "Retry attempts for transient failures (503/502/504/429 and "
            "connection errors). 0 disables retrying."
        ),
    )
    retry_base_delay: float = Field(
        default=1.0,
        gt=0,
        description=(
            "Base backoff delay in seconds. Keep >= the rate-limit window "
            "(1s public / 0.2s auth) so retries never trigger a 429."
        ),
    )
    retry_max_delay: float = Field(
        default=8.0,
        gt=0,
        description="Upper bound in seconds for a single backoff wait.",
    )


class APIError(BaseModel, BaseConfig):
    """API error response model."""

    message: str | None = None
    code: str | None = None
    details: dict[str, Any] | None = None


class APIException(Exception):
    """Base exception for LN Markets API errors."""

    def __init__(self, message: str, error: APIError | None = None):
        super().__init__(message)
        self.error = error


class APIValidationException(APIException):
    """Exception for response validation errors."""

    def __init__(self, message: str, validation_error: ValidationError):
        super().__init__(message)
        self.validation_error = validation_error


class APIHTTPException(APIException):
    """Exception for HTTP errors."""

    def __init__(self, message: str, status_code: int, response: httpx.Response):
        super().__init__(message)
        self.status_code = status_code
        self.response = response


class PaginatedResponse[T](BaseModel, BaseConfig):
    """Generic paginated response with data array and nextCursor."""

    data: list[T] = Field(..., description="Array of items")
    next_cursor: SkipValidation[str] | None = Field(
        default=None,
        description="Cursor for fetching the next page, null if no more pages",
    )


class FromToLimitParams(BaseModel, BaseConfig):
    from_: str | None = Field(
        default=None,
        serialization_alias="from",
        validation_alias="from",
        description="Start date as a string value in ISO format",
    )
    limit: int = Field(
        default=1000,
        ge=1,
        le=1000,
        description="Limit of items to return (max 1000, default 1000)",
    )
    to: str | None = Field(
        default=None, description="End date as a string value in ISO format"
    )
    cursor: str | None = Field(
        default=None, description="Pagination cursor for fetching next page"
    )
