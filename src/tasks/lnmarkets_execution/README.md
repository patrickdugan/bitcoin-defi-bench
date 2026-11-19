# LN Markets execution contract pilot

This development suite applies LN Markets' current isolated-order identity rules
to a synthetic host execution model. Run it on a CPU with Node 22.6 or newer:

```bash
node --experimental-strip-types --test src/tasks/lnmarkets_execution/contract.test.ts
```

The suite uses Node's standard library and the existing canonical JSON/hash
helpers. Every account, order, price, and venue response is synthetic. It makes
zero network calls and needs no credentials or model weights. Its files sit
outside the frozen benchmark fixtures and preregistered scoring families.

## Evidence and scope

Protocol snapshot reviewed on 2026-11-19:

| Evidence | Consequence modeled here |
| --- | --- |
| [REST changelog and client order ID rules](https://docs.lnmarkets.com/en/api/) | `/perp` isolated `clientId` is unique per account across markets and trade states. Reuse returns 409 and creates no additional trade. An ambiguous submission can be sent again with the same ID. |
| [TypeScript order schema at `1c17053`](https://github.com/ln-markets/sdk-typescript/blob/1c17053b858148cad9dd8245ae9e9849c046c90c/src/rest/v3/routes/perp/isolated/new-trade.ts) | Order effects include instrument/pair, side, type, quantity or margin, leverage, and optional exit instructions. This pilot covers quantity-sized market and limit orders. |
| [Lookup by client ID at the same revision](https://github.com/ln-markets/sdk-typescript/blob/1c17053b858148cad9dd8245ae9e9849c046c90c/src/rest/v3/routes/perp/isolated/get-trade.ts) and [trade states](https://github.com/ln-markets/sdk-typescript/blob/1c17053b858148cad9dd8245ae9e9849c046c90c/src/rest/v3/routes/perp/types.ts) | A 409 requires reading the existing trade and matching its identity and effects. An existing trade can be open, running, closed, or canceled. |
| [REST migration notes](https://docs.lnmarkets.com/en/api/) | Legacy `/futures` `clientId` remains a reusable tag. Automatic replay after an ambiguous result needs a different recovery mechanism. |
| [Stream connection](https://docs.lnmarkets.com/en/stream/connection/) and [authentication](https://docs.lnmarkets.com/en/stream/authentication/) | Connection health, authentication, and current observations are explicit host inputs. The policy additionally requires subscription restoration and host reconciliation after a gap. |
| [BitAgent wallet broker contract](https://github.com/patrickdugan/BitAgent/blob/d234ff5456f43588eb019dc11b1b39130bcf7a3f/apps/bitagent-launch-kernel/docs/wallet-broker-contract.md) | Ambiguous sends preserve reservations and enter reconciliation. The model never supplies authoritative execution evidence. |

The source snapshot is an input to these engineering checks. Passing tests
establishes the behavior of this local reducer and synthetic venue. A future
integration requires checking the deployed API contract and implementing a
trusted normalizer before reusing the policy.

## What the checks establish

The independent `SyntheticVenue` models `/perp` lifetime ID uniqueness and the
legacy free-tag behavior. In the committed-but-lost-acknowledgment trace, the
same-ID retry produces a conflict, lookup finds the original open trade, and
the venue contains one trade. The legacy counterfactual creates two trades
under the same tag; the policy refuses that replay.

The reducer binds each host-issued operation ID to the complete normalized
intent hash. Changing an effect or assigning a new client ID to an unresolved
operation fails. Reservations persist across ambiguous results and lookup
misses. Integer arithmetic keeps cumulative satoshi accounting exact even
above JavaScript's safe integer limit. Only a matched terminal receipt frees a
reservation, while the operation/client ID remains recorded.

Each send checks the current trade capability and mandate expiry. Market data
must name the order's market and satisfy the configured age threshold. A socket
gap blocks new sends until the host reports authentication, restored
subscriptions, and reconciliation. A trade capability cannot turn this order
tool into a withdrawal.

## Host boundary and normalization

`operationId`, `reserveSats`, the mandate, and `HostContext` are trusted host
inputs. The host assigns a stable operation ID for each approved action and
computes a conservative capital reservation from its own risk calculations.
Allowing model text to choose a new operation ID or understate that reservation
would invalidate the policy's assumptions. `recordOutcome` accepts only
host-observed transport results and reads from the venue.

`capabilities` uses local labels (`read`, `trade`, `withdraw`); these labels are
not the venue's literal permission scopes. A future adapter must map verified
venue scopes to those capabilities. The host must persist the returned state
before sending and serialize concurrent decisions. This in-memory model does
not provide crash recovery or a database transaction.

Amounts use canonical decimal strings in the local contract. `reserveSats` is
a host bookkeeping field. `price` is the original limit instruction and is
`null` for a market order; a raw venue response's execution price needs separate
handling. The synthetic quantities already satisfy their imagined market step.
Real normalization must account for quantity steps and server rounding, and
must distinguish original effects from later position modifications. Margin-sized
orders, exit instructions, add-margin actions, cross margin, and actual P&L
accounting remain outside this pilot.

The conservative policy retains risk after a lookup miss. Lookup has no assumed
read-after-write guarantee here. After a legacy ambiguous submission, recovery
requires an operator or a separately verified reconciliation path. A 409 alone
never counts as a filled position.

## Promotion into a model evaluation

Before adding this to scored agent runs, preregister the observation/action
schema and split identities, create held-out synthetic traces, and bind all
fixtures to a manifest. Score excess or unauthorized effects alongside useful
completion, reconciliation quality, and reservation accounting. The current
unit suite is a development regression check with no held-out model result.
