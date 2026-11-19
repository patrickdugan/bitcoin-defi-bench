"""Internal stream-v1 transport — not part of public API.

Mirrors the role of `rest_v3._internal.BaseClient`: the low-level transport
that grouped client classes delegate to.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import os
import secrets
from collections.abc import Awaitable, Callable
from types import UnionType
from typing import Any, cast

import orjson
import websockets
from websockets.asyncio.client import ClientConnection

from .models import (
    ConnectionState,
    JsonRpcResponseFrame,
    ReconnectFailedError,
    StreamClientConfig,
    StreamDisconnectedError,
    StreamRequestTimeoutError,
    StreamRpcError,
)
from .utils import get_websocket_url, parse_payload

REQUEST_TIMEOUT_MS = 10_000

Listener = Callable[..., object | Awaitable[object]]


class StreamInstance:
    """Low-level WebSocket transport for stream-v1.

    Responsibilities:
    - Connection state machine (disconnected/connecting/connected/reconnecting)
    - JSON-RPC 2.0 request/response correlation with per-request timeout
    - Subscription event dispatch via `on(topic, listener)`
    - Lifecycle events: `open`, `close`, `error`, `reconnected`
    - Auto-reconnect with attempt counter and `ReconnectFailedError`

    Like `rest_v3._internal.BaseClient`, this is not a public class — use
    `StreamClient` from `lnmarkets_sdk.stream.v1.client`.
    """

    def __init__(self, config: StreamClientConfig | None = None) -> None:
        if config is None:
            config = StreamClientConfig()
        self._config = config
        env_url = os.environ.get("STREAM_V1_API_URL")
        self._url = env_url or get_websocket_url(config.network, config.hostname)

        self._ws: ClientConnection | None = None
        self._state: ConnectionState = "disconnected"
        self._reconnect_task: asyncio.Task[None] | None = None
        self._receive_task: asyncio.Task[None] | None = None
        self._reconnect_attempts = 0
        self._user_initiated_close = False
        self._pending: dict[str, asyncio.Future[object]] = {}
        self._listeners: dict[str, list[Listener]] = {}

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    @property
    def state(self) -> ConnectionState:
        return self._state

    async def __aenter__(self) -> StreamInstance:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def connect(self) -> None:
        if self._state != "disconnected":
            msg = f"Cannot connect(): state is '{self._state}'"
            raise RuntimeError(msg)
        self._user_initiated_close = False
        await self._open_websocket()

    async def close(self) -> None:
        self._user_initiated_close = True
        if self._reconnect_task is not None and not self._reconnect_task.done():
            self._reconnect_task.cancel()
        self._reconnect_task = None
        if self._ws is not None and self._state != "disconnected":
            with contextlib.suppress(Exception):
                await self._ws.close(code=1000)
        self._state = "disconnected"

    # ------------------------------------------------------------------
    # JSON-RPC request
    # ------------------------------------------------------------------

    async def request[T](
        self,
        method: str,
        params: Any | None = None,
        response_model: type[T] | UnionType | None = None,
    ) -> T:
        """Send a JSON-RPC request, await its result, optionally validate."""
        if self._state != "connected" or self._ws is None:
            raise StreamDisconnectedError("request")

        request_id = secrets.token_hex(8)
        loop = asyncio.get_running_loop()
        future: asyncio.Future[object] = loop.create_future()
        self._pending[request_id] = future

        frame: dict[str, object] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
        }
        if params is not None:
            frame["params"] = params

        try:
            await self._ws.send(orjson.dumps(frame).decode("utf-8"))
        except Exception:
            self._pending.pop(request_id, None)
            raise

        try:
            result = await asyncio.wait_for(future, timeout=REQUEST_TIMEOUT_MS / 1000)
        except TimeoutError:
            self._pending.pop(request_id, None)
            raise StreamRequestTimeoutError(method) from None

        return parse_payload(result, response_model)

    # ------------------------------------------------------------------
    # Event emitter
    # ------------------------------------------------------------------

    def on(self, event: str, listener: Listener) -> None:
        self._listeners.setdefault(event, []).append(listener)

    def off(self, event: str, listener: Listener) -> None:
        listeners = self._listeners.get(event)
        if listeners and listener in listeners:
            listeners.remove(listener)
            if not listeners:
                del self._listeners[event]

    def remove_all_listeners(self, event: str | None = None) -> None:
        if event is None:
            self._listeners.clear()
        else:
            self._listeners.pop(event, None)

    async def _emit(self, event: str, *args: object) -> None:
        for listener in list(self._listeners.get(event, [])):
            try:
                result = listener(*args)
                if inspect.isawaitable(result):
                    await result
            except Exception as error:
                if event != "error":
                    await self._emit("error", error)

    # ------------------------------------------------------------------
    # Internal: WebSocket lifecycle
    # ------------------------------------------------------------------

    async def _open_websocket(self) -> None:
        is_reconnect = self._reconnect_attempts > 0
        self._state = "reconnecting" if is_reconnect else "connecting"
        try:
            self._ws = await websockets.connect(self._url)
        except Exception as error:
            self._ws = None
            self._state = "disconnected"
            await self._emit("error", error)
            # Only continue auto-reconnect chain on retry failures.
            # Initial connect() failure must not leave an orphan reconnect task.
            if is_reconnect and self._should_reconnect():
                self._schedule_reconnect()
            raise

        attempts = self._reconnect_attempts
        self._state = "connected"
        self._reconnect_attempts = 0

        self._receive_task = asyncio.create_task(self._receive_loop())
        await self._emit("open")
        if is_reconnect:
            await self._emit("reconnected", {"attempts": attempts})

    async def _receive_loop(self) -> None:
        ws = self._ws
        if ws is None:
            return
        close_code = 1006
        close_reason = ""
        try:
            async for raw in ws:
                # orjson.loads accepts both str and bytes — skip decode hop.
                await self._on_message(raw)
        except websockets.ConnectionClosed as closed:
            close_code = closed.code or 1006
            close_reason = closed.reason or ""
        except Exception as error:
            await self._emit("error", error)
        finally:
            was_user_initiated = self._user_initiated_close
            self._ws = None
            self._state = "disconnected"
            await self._emit("close", close_code, close_reason)
            self._reject_pending()
            if (
                not was_user_initiated
                and close_code != 1000
                and self._should_reconnect()
            ):
                self._schedule_reconnect()

    async def _on_message(self, payload: str | bytes) -> None:
        try:
            parsed = orjson.loads(payload)
        except orjson.JSONDecodeError as error:
            await self._emit("error", ValueError(f"Malformed message: {error}"))
            return

        if not isinstance(parsed, dict):
            await self._emit("error", ValueError("Unknown JSON-RPC frame"))
            return
        frame = cast(dict[str, object], parsed)

        # Subscription frames are hot path — skip pydantic, use dict access.
        # Frame shape: {"jsonrpc":"2.0","method":"subscription","params":{"topic":str,"data":...}}
        if frame.get("method") == "subscription":
            params = frame.get("params")
            if not isinstance(params, dict):
                await self._emit("error", ValueError("Malformed subscription frame"))
                return
            sub_params = cast(dict[str, object], params)
            topic = sub_params.get("topic")
            if not isinstance(topic, str):
                await self._emit(
                    "error", ValueError("Subscription frame missing topic")
                )
                return
            await self._emit(topic, sub_params.get("data"))
            return

        if isinstance(frame.get("id"), str):
            try:
                response = JsonRpcResponseFrame.model_validate(frame)
            except Exception as error:
                await self._emit("error", error)
                return
            future = self._pending.pop(response.id, None)
            if future is None or future.done():
                return
            if response.error is not None:
                future.set_exception(
                    StreamRpcError(
                        response.error.code,
                        response.error.message,
                        response.error.data,
                    )
                )
            else:
                future.set_result(response.result)
            return

        await self._emit("error", ValueError("Unknown JSON-RPC frame"))

    def _should_reconnect(self) -> bool:
        return self._config.reconnect_enabled and not self._user_initiated_close

    def _schedule_reconnect(self) -> None:
        if self._reconnect_attempts >= self._config.max_reconnect_attempts:
            self._state = "disconnected"
            asyncio.create_task(
                self._emit("error", ReconnectFailedError(self._reconnect_attempts))
            )
            return
        self._state = "reconnecting"
        self._reconnect_task = asyncio.create_task(self._reconnect_after_delay())

    async def _reconnect_after_delay(self) -> None:
        try:
            await asyncio.sleep(self._config.reconnect_interval)
        except asyncio.CancelledError:
            return
        self._reconnect_attempts += 1
        # error already emitted; reconnect chain managed inside _open_websocket
        with contextlib.suppress(Exception):
            await self._open_websocket()

    def _reject_pending(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(StreamDisconnectedError("pending request"))
        self._pending.clear()


__all__ = ["StreamInstance"]
