"""Internal HTTP client - not part of public API."""

import json
import re
from collections.abc import Mapping
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel
from tenacity import (
    AsyncRetrying,
    RetryCallState,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

from .models import APIAuthContext, APIMethod
from .utils import create_auth_headers, flatten_query, prepare_params

# Statuses where the server signals it did NOT process the request, so a retry
# is safe from double-submitting a non-idempotent trade. 503 = "Trading engine
# temporarily unavailable", 502/504 = gateway could not reach upstream,
# 429 = rate limited.
_RETRYABLE_STATUS = frozenset({429, 502, 503, 504})

# Connection-phase transport errors only: the request never reached the server,
# so retrying cannot duplicate a side effect. Read/Write timeouts are excluded
# on purpose — the server may already have processed the request.
_RETRYABLE_EXCEPTIONS = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.PoolTimeout,
)


class _RetryableStatus(Exception):
    """Internal signal: response carries a status code worth retrying."""

    def __init__(self, response: httpx.Response):
        super().__init__(f"Retryable status {response.status_code}")
        self.response = response


class BaseClient:
    """Internal HTTP client for making requests."""

    def __init__(
        self,
        base_url: str,
        timeout: float,
        auth: APIAuthContext | None = None,
        custom_headers: dict[str, str] | None = None,
        max_retries: int = 3,
        retry_base_delay: float = 1.0,
        retry_max_delay: float = 8.0,
    ):
        self.base_url = base_url
        self.timeout = timeout
        self.auth = auth
        self.custom_headers = custom_headers or {}
        self.max_retries = max_retries
        self.retry_base_delay = retry_base_delay
        self._client: httpx.AsyncClient | None = None
        # Exponential backoff with full jitter; `initial` doubles as the floor
        # so the first retry never fires faster than the rate-limit window.
        self._backoff = wait_exponential_jitter(
            initial=retry_base_delay, max=retry_max_delay
        )

    async def __aenter__(self) -> "BaseClient":
        """Enter async context manager."""
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=self.timeout,
            headers={**self.custom_headers},
        )
        return self

    async def __aexit__(self, *_: object) -> None:
        """Exit async context manager."""
        if self._client:
            await self._client.aclose()

    def _wait(self, retry_state: RetryCallState) -> float:
        """Backoff wait, honoring a 429 Retry-After header when present."""
        outcome = retry_state.outcome
        if outcome is not None and outcome.failed:
            exc = outcome.exception()
            if isinstance(exc, _RetryableStatus) and exc.response.status_code == 429:
                retry_after = exc.response.headers.get("Retry-After")
                if retry_after:
                    try:
                        # Never wait less than the base delay so a retry can't
                        # itself trip the rate limit.
                        return max(float(retry_after), self.retry_base_delay)
                    except ValueError:
                        pass  # HTTP-date form unsupported; fall back to backoff.
        return self._backoff(retry_state)

    async def request(
        self,
        method: APIMethod,
        path: str,
        params: BaseModel | Mapping[str, object] | None = None,
        credentials: bool = False,
    ) -> httpx.Response:
        """Make HTTP request and return response, retrying transient failures."""
        if not self._client:
            raise RuntimeError("Client must be used within async context manager")

        params_dict = prepare_params(params)
        if params_dict and method in ("GET", "DELETE"):
            params_dict = flatten_query(params_dict)

        async def _send() -> httpx.Response:
            client = self._client
            if client is None:
                raise RuntimeError("Client must be used within async context manager")

            headers: dict[str, str] = {}
            if credentials:
                if not self.auth:
                    raise ValueError(
                        "Authentication required but no credentials provided"
                    )

                data = ""
                if params_dict:
                    if method in ("GET", "DELETE"):
                        data = f"?{urlencode(params_dict)}"
                        data = re.sub(r"=(True)", "=true", data)
                        data = re.sub(r"=(False)", "=false", data)
                    else:
                        data = json.dumps(params_dict, separators=(",", ":"))
                        headers.update({"Content-Type": "application/json"})

                # Re-signed on every attempt so the timestamp stays fresh across
                # backoff delays (the signature is time-based).
                auth_headers = create_auth_headers(
                    self.auth, method, f"/v3{path}", data
                )
                headers.update(auth_headers)

            # Use httpx native parameter handling
            if method in ("GET", "DELETE"):
                response = await client.request(
                    method, path, params=params_dict, headers=headers or None
                )
            else:
                response = await client.request(
                    method, path, json=params_dict, headers=headers or None
                )

            if response.status_code in _RETRYABLE_STATUS:
                raise _RetryableStatus(response)
            return response

        if self.max_retries <= 0:
            try:
                return await _send()
            except _RetryableStatus as exc:
                return exc.response

        retryer = AsyncRetrying(
            stop=stop_after_attempt(self.max_retries + 1),
            wait=self._wait,
            retry=retry_if_exception_type((*_RETRYABLE_EXCEPTIONS, _RetryableStatus)),
            reraise=True,
        )
        try:
            return await retryer(_send)
        except _RetryableStatus as exc:
            # Retries exhausted: hand the final response to the normal
            # error-parsing path so callers still get an APIException.
            return exc.response
