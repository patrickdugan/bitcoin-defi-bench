# LN Markets Python SDK: offline contribution packet

Reviewed on 2026-11-19. Source commit: [`236b2739a05494295561655861b75648fcf98abc`](https://github.com/ln-markets/sdk-python/commit/236b2739a05494295561655861b75648fcf98abc).

## Run

Run `python reproduce.py` from this directory with Python 3.12 or later. The script needs `httpx`, `pydantic` v2, and `websockets` with its `asyncio.client` module. The run used the versions recorded in `provenance.json`. It writes its result to standard output. `observed-results.json` contains the captured output.

Every HTTP request uses `httpx.MockTransport`; the socket is an in-memory queue. All credentials are literal test strings. No request reaches LN Markets, and no account or funds are involved. The exit code is zero when the four expected signature outcomes and the callback timeout reproduce.

## 1. Signatures disagree with transmitted values

The copied REST transport is unchanged. The probe sends a plausible perp order with a free-text label, or a trade lookup with `clientId`, and independently recomputes the HMAC over the HTTP request captured by `httpx`.

| Input | Signature matches captured request |
| --- | --- |
| POST order, `label="cafe"` | Yes |
| POST order, `label="café"` | No |
| GET trade, `clientId="alpha-1"` | Yes |
| GET trade, `clientId="TrueAlpha"` | No |

`BaseClient.request()` calls `json.dumps(..., separators=(",", ":"))` with the default `ensure_ascii=True` when it prepares a body signature. `httpx` sends the Unicode character as UTF-8. LN Markets' [signature contract](https://docs.lnmarkets.com/en/api/#signature) requires a JSON representation matching Node's `JSON.stringify`, which emits the character. For the query case, `re.sub(r"=(True)", "=true", data)` rewrites the beginning of a string identifier; the transmitted identifier retains its uppercase `T`. The analogous `False` substitution has the same issue.

The verified result is a local signature mismatch. Live API rejection was not tested. There is no claim that a request placed a trade or that a production account was affected.

Suggested contribution: replace regex substitution with type-aware query preparation and sign the final query string. Match the documented JSON representation explicitly, with fixtures shared with the TypeScript SDK. Include Unicode labels and string IDs beginning `True` or `False`, while keeping actual Boolean query values covered. Check JavaScript number formatting before claiming full cross-language JSON equivalence.

Source: [REST transport](https://github.com/ln-markets/sdk-python/blob/236b2739a05494295561655861b75648fcf98abc/src/lnmarkets_sdk/rest/v3/_internal/__init__.py), [serialization helpers](https://github.com/ln-markets/sdk-python/blob/236b2739a05494295561655861b75648fcf98abc/src/lnmarkets_sdk/rest/v3/_internal/utils.py), and [PerpOrder/GetPerpTradeParams models](https://github.com/ln-markets/sdk-python/blob/236b2739a05494295561655861b75648fcf98abc/src/lnmarkets_sdk/rest/v3/models/perp.py).

Existing history checked: [PR #11](https://github.com/ln-markets/sdk-python/pull/11) previously addressed Boolean serialization. [PR #37](https://github.com/ln-markets/sdk-python/pull/37) addressed nested integer-valued floats. Both are closed, and the current source retains the cases reproduced here. The open-issues and open-PR collections returned no entries on 2026-11-19.

## 2. An async subscription callback can block its own RPC reply

The stream public API accepts async topic listeners: `TopicListener` returns `None | Awaitable[None]`, and the `on()` overload for a topic accepts that type. The transport's `_receive_loop()` awaits `_on_message()`, which awaits `_emit(topic, data)`, which awaits the listener. A listener that awaits `client.request("ping")` consequently waits for a response that the same receive loop cannot consume until the listener returns.

The probe registers that listener and feeds one subscription frame into an in-memory socket. Its `send()` immediately queues the matching JSON-RPC response. The callback still raises `StreamRequestTimeoutError`. The probe reduces `REQUEST_TIMEOUT_MS` from 10000 to 50 to keep the reproduction quick. It exercises the copied source's original scheduling logic. The queued response becomes readable only after the callback times out.

Suggested contribution: dispatch application callbacks independently from the socket reader, and retain ownership of those tasks through connection shutdown. Forward callback failures to the documented error channel, cancel or drain tasks on close, and specify a bounded queue/backpressure policy for slow callbacks. Add regressions for an async callback making an RPC, slow callbacks while unrelated requests finish, and close with pending callbacks. The exact ordering guarantee should be agreed with maintainers before changing dispatch semantics.

Source: [public listener API](https://github.com/ln-markets/sdk-python/blob/236b2739a05494295561655861b75648fcf98abc/src/lnmarkets_sdk/stream/v1/client/__init__.py), [stream transport](https://github.com/ln-markets/sdk-python/blob/236b2739a05494295561655861b75648fcf98abc/src/lnmarkets_sdk/stream/v1/_internal/__init__.py). [PR #16](https://github.com/ln-markets/sdk-python/pull/16) added the stream API. No open issue or PR covering this appeared in the collections checked on 2026-11-19.

## Probe isolation and limits

The six `rest_*.py` and `stream_*.py` files are source snapshots fetched through GitHub. Their source paths, blob SHAs and local SHA-256 hashes are in `provenance.json`. LN Markets' MIT license is included as `UPSTREAM-LICENSE`.

The environment lacked two optional dependencies, so the harness supplies narrow import substitutes. Tenacity imports use inert placeholders; the REST client is configured with `max_retries=0`, so the retry engine is never called. This packet does not test retry behavior. For the stream probe, standard-library JSON replaces `orjson`. The test frames contain only ASCII strings, and the reproduction concerns coroutine scheduling. The original source snapshots remain unchanged. These substitutes are declared in the harness rather than installed into the environment.

The tests exercise internal transport classes because the observed problems occur there. They do not install the complete SDK distribution or run its full test suite. A proposed upstream patch should be verified with the project's normal dependencies and its existing test runner before submission.

## Related application to our executor

The official [client order ID contract](https://docs.lnmarkets.com/en/api/#client-order-id) gives `/perp` isolated orders a recoverable identity: generate one `clientId` per intended order, persist it before sending, retain it across retries, and fetch the order by that ID after an ambiguous response. A duplicate returns HTTP 409. The older `/futures` routes use `clientId` as a reusable tag. This distinction belongs in an agent trading adapter's contract tests.

The current Python transport retries 429/502/503/504 for every method, whereas the TypeScript transport has `retry: 0`. A gateway status alone does not establish whether a side effect occurred. Treat this as a review question with the maintainers, and test a mock server that commits an order before a gateway timeout. This packet makes no claim that the production backend duplicates orders.
