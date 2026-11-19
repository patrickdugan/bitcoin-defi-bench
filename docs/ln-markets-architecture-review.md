# LN Markets: architecture lessons and contribution opportunities

Reviewed 2026-11-19. This review covers public repositories and published interfaces. The production exchange's matching engine, account ledger, custody implementation, and liquidation engine sit outside the inspected source.

The strongest contribution route is a small Python SDK conformance patch, supported by the [offline reproduction packet](../research/lnmarkets_sdk_conformance/README.md). The architectural lesson applied here is persistent order identity through uncertain execution, implemented in a [development contract suite](../src/tasks/lnmarkets_execution/README.md).

## Source inventory

The [LN Markets organization](https://github.com/ln-markets) exposed 11 public repositories at review time. The source commits below fix the review's scope; a repository's activity-page timestamp can also change for reasons unrelated to source changes.

| Repository | Role | Source reviewed |
| --- | --- | --- |
| [sdk-typescript](https://github.com/ln-markets/sdk-typescript) | Current typed REST v3 and Stream v1 clients | `1c17053b858148cad9dd8245ae9e9849c046c90c` |
| [sdk-python](https://github.com/ln-markets/sdk-python) | Current asynchronous Python clients | `236b2739a05494295561655861b75648fcf98abc` |
| [images](https://github.com/ln-markets/images) | Bitcoin and Lightning container build recipes | `821f63531a2eec5cb7a79da8ae08eb878206579a` |
| [trading-bot](https://github.com/ln-markets/trading-bot) | Example strategies using the older Python API | `27d558f4a7bc5322b6e613804c4f5352fc41e1b8` |
| [rust-secp256k1](https://github.com/ln-markets/rust-secp256k1) | Mirror described as supporting the silent-payments crate | Metadata inspected |
| [bitcoin-cli-ts](https://github.com/ln-markets/bitcoin-cli-ts), [ccxt](https://github.com/ln-markets/ccxt) | Supporting forks | Metadata inspected |
| [api-js](https://github.com/ln-markets/api-js), [api-python](https://github.com/ln-markets/api-python), [umbrel](https://github.com/ln-markets/umbrel) | Archived predecessors | Archive status inspected |
| [.github](https://github.com/ln-markets/.github) | Organization profile | Metadata inspected |

The current SDKs are the appropriate entry point for new work. Their interfaces distinguish market metadata from execution methods and expose stream lifecycle events to applications.

## Lessons for our execution layer

### Persist the meaning of an order before sending it

LN Markets' [current order-ID contract](https://docs.lnmarkets.com/en/api/#client-order-id) gives `/perp` isolated trades a unique `clientId` across markets and trade states. Reuse returns HTTP 409, and a lookup retrieves the associated trade. Legacy `/futures` uses the same field name for a reusable tag. A timeout therefore needs endpoint-aware recovery.

Our application should bind an intent identifier to the exact approved effects before transmission. An uncertain response retains both identity and reserved exposure. Recovery fetches the corresponding trade and compares it with that intent. HTTP 409 identifies a collision; an authoritative lookup supplies the evidence needed to resolve it. A newly generated identifier after uncertainty could create additional exposure.

This extends a rule already present in BitAgent's [wallet-owned broker contract](https://github.com/patrickdugan/BitAgent/blob/d234ff5456f43588eb019dc11b1b39130bcf7a3f/apps/bitagent-launch-kernel/docs/wallet-broker-contract.md): an ambiguous send enters `reconciliation_required`, with the candidate and input reservation preserved. An exchange adapter needs its own interpretation of that rule because its external API can support safe same-ID retries.

### Treat market metadata as part of the action contract

The TypeScript [market model](https://github.com/ln-markets/sdk-typescript/blob/1c17053b858148cad9dd8245ae9e9849c046c90c/src/rest/v3/routes/markets.ts) describes quantity units, step sizes, tick sizes, account limits, and supported margin modes. [New-order types](https://github.com/ln-markets/sdk-typescript/blob/1c17053b858148cad9dd8245ae9e9849c046c90c/src/rest/v3/routes/perp/isolated/new-trade.ts) express alternatives such as margin versus quantity and market versus limit orders.

A BitAgent tool should carry the selected market's constraints into deterministic validation. The host can then reject a proposal with the wrong units or an unsupported size. Runtime validation remains necessary when model-generated JSON enters a typed client.

The [perp response types](https://github.com/ln-markets/sdk-typescript/blob/1c17053b858148cad9dd8245ae9e9849c046c90c/src/rest/v3/routes/perp/types.ts) also represent an unavailable mark-derived P&L with `null`. SystemicRiskBench can use that distinction to test whether a model preserves missing financial evidence. Replacing it with zero would fabricate a known neutral outcome.

### Restore trustworthy observations after reconnecting

The [TypeScript stream README](https://github.com/ln-markets/sdk-typescript/blob/1c17053b858148cad9dd8245ae9e9849c046c90c/README.md) assigns subscription restoration to the application after reconnect. Its [transport](https://github.com/ln-markets/sdk-typescript/blob/1c17053b858148cad9dd8245ae9e9849c046c90c/src/stream/v1/instance.ts) exposes lifecycle events and rejects pending requests when the connection closes.

For Tesseract or an execution host, connection health and reconciled account state need separate fields. The recovery path should authenticate, restore subscriptions, fetch current positions, and account for events missed during the gap. The host can resume new exposure once that recovery meets its freshness policy. A local test should hide an order acceptance during the outage and require recovery of the resulting position.

### Bind venue permissions to the operator's narrower intent

The [REST signature contract](https://docs.lnmarkets.com/en/api/#signature) binds the timestamp, method, path, and serialized request. [Stream authentication](https://docs.lnmarkets.com/en/stream/authentication/) uses its own timestamp-and-nonce payload. [Account permissions](https://docs.lnmarkets.com/en/security/) distinguish reading, trading, and withdrawing.

The model can propose an action while a separate host retains credentials and checks the operator's allowed venue, action, expiry, and cumulative risk. A trading permission may permit more activity than the operator approved. An untrusted announcement or error message should leave those limits intact. Control-Harness can exercise attempted scope escalation while the financial simulator tracks the resulting exposure.

## Reproduced SDK contribution candidates

The [packet](../research/lnmarkets_sdk_conformance/README.md) contains six unchanged MIT-licensed source snapshots, their Git blob and SHA-256 hashes, synthetic probes, and captured results. Source integrity is verified before probes run. The test transport terminates every HTTP request in `httpx.MockTransport`, and its WebSocket is an in-memory queue.

| Probe | Observed result | Contribution |
| --- | --- | --- |
| Order label `cafe` | Signature agrees with the captured request | Positive control |
| Order label `café` | Signature differs from transmitted UTF-8 data | Canonical JSON conformance fixtures |
| Lookup ID `alpha-1` | Signature agrees with the captured request | Positive control |
| Lookup ID `TrueAlpha` | Signature differs after regex changes the signed identifier | Type-aware Boolean encoding and signing of the final query |
| Async topic callback awaiting an RPC | Callback times out while the matching response is queued | Separate socket reading from owned application callback tasks |

The first two failures arise in the pinned [REST transport](https://github.com/ln-markets/sdk-python/blob/236b2739a05494295561655861b75648fcf98abc/src/lnmarkets_sdk/rest/v3/_internal/__init__.py). The callback failure occurs in the [stream transport](https://github.com/ln-markets/sdk-python/blob/236b2739a05494295561655861b75648fcf98abc/src/lnmarkets_sdk/stream/v1/_internal/__init__.py). These are local observations against the inspected source. Effects on deployed accounts remain outside the experiment.

A signing patch should use common fixtures in both SDKs, including number formatting as well as Unicode and Boolean-looking strings. A callback patch needs an explicit ordering policy and a bounded queue, with shutdown cancellation and error forwarding covered by regression tests.

The Python transport's automatic retries on 429/502/503/504 deserve a separate review. Its source applies that policy across HTTP methods. The [TypeScript HTTP transport](https://github.com/ln-markets/sdk-typescript/blob/1c17053b858148cad9dd8245ae9e9849c046c90c/src/rest/v3/instance.ts) disables automatic retries. A mock gateway which returns 504 after an accepted order can test the consequences of each policy. The packet disables retries and therefore provides source inspection, rather than a runtime result, for this question.

## DLC and Spiral connection

LN Markets' [terms, section 5.1](https://cdn.lnmarkets.com/documents/tos/2.0.html) state that deposited bitcoin enters LN Markets' custody. Lightning provides a funding and withdrawal rail. That trust boundary should be explicit whenever Spiral compares settlement architectures.

The company's [2024 DLC Markets announcement](https://blog.lnmarkets.com/latest-strikes-70-january-29th-february-5th-2024/) describes a separate product with browser-side DLC cryptography, PSBT funding, and coordinated contract management. It supplies historical design context; current deployment and market availability were outside this scan.

The related [Pythia oracle](https://github.com/dlc-markets/pythia/tree/1d2987186f16bb0e7cde69f9c7bcb60b3c73d052) offers a more concrete research interface. Its Rust code persists numeric oracle announcements and attestations in PostgreSQL. Its [LN Markets feed](https://github.com/dlc-markets/pythia/blob/1d2987186f16bb0e7cde69f9c7bcb60b3c73d052/packages/pythia/src/pricefeeds/lnm.rs) requests `/v2/oracle/index` for a particular historical minute and checks the returned timestamp.

Current v3 documentation [records removal of the oracle endpoints](https://docs.lnmarkets.com/en/api/#july-17-2026). The v2 route's live availability was untested. A migration review should fix the intended historical observation before selecting a replacement endpoint. Index value, trade price, and candle close carry different meanings. Contract terms should bind the source, timestamp convention, numeric descriptor, and rounding rule alongside the oracle announcement.

For Bitcoin DeFi Bench family 10 and Spiral, a useful next fixture would carry a synthetic historical observation through announcement, attestation, payout calculation, and recovery. A PostgreSQL test can assert that racing calls and process restarts return the same persisted attestation for an event. These tests address the correspondence between the intended observation and settlement. A valid oracle signature alone supplies evidence of the signed statement.

The public source supports this interface-level work. A replacement for LN Markets' internal capital allocation or netting would require requirements and evidence from their team. Spiral's capital-duration models could then measure reserved capital during funding, hedging, settlement, and recovery against an agreed workload.

## Additional infrastructure contribution

The [Bitcoin image recipe](https://github.com/ln-markets/images/blob/821f63531a2eec5cb7a79da8ae08eb878206579a/docker/bitcoin/Dockerfile) verifies downloaded checksums while its signature verification has been removed. The [LND recipe](https://github.com/ln-markets/images/blob/821f63531a2eec5cb7a79da8ae08eb878206579a/docker/lnd/Dockerfile) has release-key import and tag verification commented out. This establishes a provenance gap in the public build recipes. Their role in production deployment is unknown.

A focused contribution could restore authenticated release verification and document the signing-key policy. The same approach can protect the Bitcoin Core binaries used by our regtest campaigns.

## Applied work and verification scope

`src/tasks/lnmarkets_execution/` contains an isolated synthetic execution contract with tests. It is development infrastructure outside the frozen task-family scores. Its README defines its supported order subset and the evidence boundary between a mocked recovery receipt and an exchange trade response.

`research/lnmarkets_sdk_conformance/` preserves the upstream observations. The dedicated [workflow](../.github/workflows/lnmarkets-contract.yml) runs the local execution contract and repeats the pinned SDK probes. Its green result means our contract assertions and recorded upstream observations reproduce. Model inference and exchange integration remain subsequent experiments.

All market observations in this contribution are synthetic. LN Markets' [market-data terms, section 10.3](https://cdn.lnmarkets.com/documents/tos/2.0.html) require authorization for benchmarking with their data. Recorded traces for a later shared evaluation would need that permission.

The practical contribution sequence starts with the signing fixtures and a small upstream patch, followed by callback scheduling tests. Pythia's historical-observation contract gives the deeper research collaboration a precise scope. The present work remains in Patrick's repository for review.
