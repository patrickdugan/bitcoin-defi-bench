"""Offline probes against fetched LN Markets Python SDK transport source.

The optional dependency import stubs isolate code paths: REST retries are disabled
and orjson is replaced with stdlib JSON for callback-scheduling reproduction.
No network sockets are opened.
"""
import asyncio
import base64
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import sys
import types

import httpx

from verify_source import verify

verify()

ROOT = Path(__file__).parent


def load(name, filename, package=False):
    spec = importlib.util.spec_from_file_location(
        name, ROOT / filename,
        submodule_search_locations=[] if package else None,
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def fake_package(name):
    module = types.ModuleType(name)
    module.__path__ = []
    sys.modules[name] = module


# The disabled retry path still imports these names and constructs a wait object.
tenacity = types.ModuleType("tenacity")
for name in ("AsyncRetrying", "RetryCallState", "retry_if_exception_type", "stop_after_attempt"):
    setattr(tenacity, name, lambda *a, **kw: None)
tenacity.wait_exponential_jitter = lambda *a, **kw: lambda state: 0
sys.modules["tenacity"] = tenacity

fake_package("audit_rest")
rest_models = load("audit_rest.models", "rest_models.py")
rest_utils = load("audit_rest.utils", "rest_utils.py")
rest_base = load("audit_rest", "rest_base.py", package=True)


def digest(payload):
    return base64.b64encode(hmac.new(b"test-secret", payload.encode(), hashlib.sha256).digest()).decode()


async def signing_probe(method, path, params):
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={})
    auth = rest_models.APIAuthContext(key="test-key", secret="test-secret", passphrase="test-passphrase")
    client = rest_base.BaseClient("https://offline.invalid/v3", timeout=1, auth=auth, max_retries=0)
    client._client = httpx.AsyncClient(base_url=client.base_url, transport=httpx.MockTransport(handler))
    try:
        await client.request(method, path, params, credentials=True)
    finally:
        await client._client.aclose()
    request = requests[0]
    wire = request.content.decode() if method == "POST" else "?" + request.url.query.decode()
    payload = request.headers["lnm-access-timestamp"] + method.lower() + request.url.path + wire
    actual = request.headers["lnm-access-signature"]
    return {"method": method, "params": params, "wire_data": wire, "signature_matches_wire": actual == digest(payload)}


# This replacement leaves the transport's event scheduling and request logic intact.
orjson = types.ModuleType("orjson")
orjson.loads = json.loads
orjson.dumps = lambda value: json.dumps(value).encode()
orjson.JSONDecodeError = json.JSONDecodeError
sys.modules["orjson"] = orjson
fake_package("audit_stream")
stream_models = load("audit_stream.models", "stream_models.py")
stream_utils = load("audit_stream.utils", "stream_utils.py")
stream_base = load("audit_stream", "stream_base.py", package=True)
stream_base.REQUEST_TIMEOUT_MS = 50


class Socket:
    def __init__(self):
        self.frames = asyncio.Queue()
        self.sent = []
    def __aiter__(self):
        return self
    async def __anext__(self):
        return await self.frames.get()
    async def send(self, payload):
        sent = json.loads(payload)
        self.sent.append(sent)
        await self.frames.put(json.dumps({"jsonrpc": "2.0", "id": sent["id"], "result": "pong"}))


async def listener_probe():
    client = stream_base.StreamInstance(stream_models.StreamClientConfig(reconnect_enabled=False))
    socket = Socket()
    client._ws = socket
    client._state = "connected"
    errors = []
    values = []
    done = asyncio.Event()
    async def listener(_data):
        try:
            values.append(await client.request("ping"))
        except Exception as error:
            errors.append(type(error).__name__)
        finally:
            done.set()
    client.on("futures/inverse/btc_usd/ticker", listener)
    task = asyncio.create_task(client._receive_loop())
    await socket.frames.put(json.dumps({"jsonrpc":"2.0", "method":"subscription", "params":{"topic":"futures/inverse/btc_usd/ticker", "data":{"lastPrice":100}}}))
    await asyncio.wait_for(done.wait(), 1)
    client._user_initiated_close = True
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    return {"sent_rpc_methods":[x["method"] for x in socket.sent], "callback_results": values, "callback_errors": errors, "timeout_ms": stream_base.REQUEST_TIMEOUT_MS}


async def main():
    order = {"instrument": "inverse_perp", "pair": "btc_usd", "type": "market", "side": "buy", "margin": 1000, "leverage": 1}
    report = {"source_commit":"236b2739a05494295561655861b75648fcf98abc", "signing":[
        await signing_probe("POST", "/perp/isolated/trade", {**order, "label":"cafe"}),
        await signing_probe("POST", "/perp/isolated/trade", {**order, "label":"café"}),
        await signing_probe("GET", "/perp/isolated/trade", {"clientId":"alpha-1"}),
        await signing_probe("GET", "/perp/isolated/trade", {"clientId":"TrueAlpha"}),
    ], "stream_callback":await listener_probe()}
    assert [probe["signature_matches_wire"] for probe in report["signing"]] == [True, False, True, False]
    assert report["stream_callback"]["callback_errors"] == ["StreamRequestTimeoutError"]
    assert report["stream_callback"]["callback_results"] == []
    print(json.dumps(report, ensure_ascii=False, indent=2))


asyncio.run(main())
