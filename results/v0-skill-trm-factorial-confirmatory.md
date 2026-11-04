# Skill as a tool × TRM complex, Bonsai 8B, confirmatory seeds

Four arms per cell, each run once on the same seeds and fixtures. The rows of each arm's own table give its primary contrast. This table puts the arms side by side, and its contrasts are descriptive: 95% intervals over seed clusters, not adjusted.

- **Bare**: the chat adapter alone.
- **Skill as a tool**: the adapter carrying the cell's skill, which the model may call before it acts.
- **TRM complex**: the bare agent proposes, the package's rules check the proposal, the skill repairs it, and the gate decides the rest (docs/trm_complex.md).
- **Combo**: the complex, with the skill-carrying agent as its proposer and a gate trained on that agent's development runs.

## Normalized gain

0 is the floor, 1 the ceiling. Family 4's floor is `static_pilot`, and family 9's is `idle`.

| Cell | bare | skill as tool | TRM complex | combo |
|---|---|---|---|---|
| family 4, `balanced` | −1.00 (−1.00 to −1.00), clipped | −1.00 (−1.00 to −1.00), clipped | 0.54 (0.52 to 0.56) | 0.54 (0.52 to 0.56) |
| family 4, `correlated` | −1.00 (−1.00 to −1.00), clipped | −0.83 (−1.00 to −0.38), clipped | 0.35 (0.19 to 0.51) | 0.35 (0.19 to 0.51) |
| family 4, `drift` | −1.00 (−1.00 to −1.00), clipped | −0.65 (−1.00 to −0.25), clipped | 0.92 (0.91 to 0.92) | 0.92 (0.91 to 0.92) |
| `custody` | −1.00 (−1.00 to −1.00), clipped | −1.00 (−1.00 to −1.00), clipped | 1.00 (1.00 to 1.00) | 1.00 (1.00 to 1.00) |
| `custody_hot` | −1.00 (−1.00 to 0.77), clipped | −1.00 (−1.00 to 1.32), clipped | 0.80 (0.69 to 0.91) | 1.00 (1.00 to 1.00) |
| `publish` | −0.01 (−0.02 to 0.01) | 0.03 (−0.03 to 0.08) | 0.86 (0.83 to 0.88) | 0.86 (0.83 to 0.88) |
| `private` | 0.00 (0.00 to 0.01) | not completed | 1.00 (1.00 to 1.00) | 1.00 (1.00 to 1.00) |
| `counterparty` | 0.07 (−0.04 to 0.18) | 0.12 (−0.02 to 0.27) | 0.67 (0.46 to 0.87) | 0.51 (0.28 to 0.74) |
| `mesh_outage` | −0.14 (−0.24 to −0.04) | 0.13 (0.00 to 0.26) | 0.79 (0.76 to 0.83) | 0.79 (0.76 to 0.83) |
| `mesh_partial` | −0.15 (−0.22 to −0.07) | 0.28 (0.13 to 0.43) | 0.79 (0.76 to 0.82) | 0.79 (0.76 to 0.82) |

## Agent − reference

Each arm's agent less the cell's reference heuristic, in the family's unit: ln cost in family 4, sats in family 9.

| Cell | Reference | bare | skill as tool | TRM complex | combo |
|---|---|---|---|---|---|
| family 4, `balanced` | `buffer_rule` | −4.75 (−4.96 to −4.54), negative | −2.49 (−2.98 to −1.99), negative | exactly 0.00, equivalent | exactly 0.00, equivalent |
| family 4, `correlated` | `buffer_rule` | −2.82 (−3.46 to −2.19), negative | −1.44 (−1.87 to −1.01), negative | exactly 0.00, equivalent | exactly 0.00, equivalent |
| family 4, `drift` | `buffer_rule` | −2.93 (−3.39 to −2.48), negative | −1.25 (−1.57 to −0.93), negative | exactly 0.00, equivalent | exactly 0.00, equivalent |
| `custody` | `kinds_only` | −83,649 (−121,276 to −46,023), negative | −72,428 (−112,662 to −32,193), negative | +155,427 (+120,710 to +190,144), positive | +155,427 (+120,710 to +190,144), positive |
| `custody_hot` | `no_key_paste` | +31,844 (+10,139 to +53,548), positive | +38,091 (+20,009 to +56,172), positive | +53,875 (+49,977 to +57,773), positive | +54,688 (+50,858 to +58,517), positive |
| `publish` | `outbox` | −14,083 (−14,802 to −13,365), negative | −13,559 (−14,549 to −12,570), negative | exactly 0, equivalent | exactly 0, equivalent |
| `private` | `legacy_everywhere` | −26,035 (−28,205 to −23,864), negative | not completed | +5,635 (+4,848 to +6,423), positive | +5,635 (+4,848 to +6,423), positive |
| `counterparty` | `cheapest` | +2,520 (−7,930 to +12,969), inconclusive | +4,503 (−5,551 to +14,556), inconclusive | +25,007 (+12,134 to +37,879), positive | +19,187 (+7,236 to +31,138), positive |
| `mesh_outage` | `bitchat_router` | −15,990 (−17,954 to −14,027), negative | −11,343 (−13,705 to −8,982), negative | exactly 0, equivalent | exactly 0, equivalent |
| `mesh_partial` | `bitchat_router` | −15,693 (−17,306 to −14,080), negative | −8,512 (−11,003 to −6,020), negative | exactly 0, equivalent | exactly 0, equivalent |

## The two factors

Paired by seed across runs. The first two columns are the complex's effect without and with the skill as a tool. The last two are the tool's effect without and with the complex. Units as above.

| Cell | complex − bare | combo − skill as tool | skill as tool − bare | combo − complex |
|---|---|---|---|---|
| family 4, `balanced` | +4.75 (+4.54 to +4.96), positive | +2.49 (+1.99 to +2.98), positive | +2.26 (+1.74 to +2.78), positive | exactly 0.00, equivalent |
| family 4, `correlated` | +2.82 (+2.19 to +3.46), positive | +1.44 (+1.01 to +1.87), positive | +1.38 (+0.80 to +1.96), positive | exactly 0.00, equivalent |
| family 4, `drift` | +2.93 (+2.48 to +3.39), positive | +1.25 (+0.93 to +1.57), positive | +1.68 (+1.15 to +2.22), positive | exactly 0.00, equivalent |
| `custody` | +239,076 (+229,868 to +248,285), positive | +227,855 (+204,668 to +251,041), positive | +11,222 (−10,762 to +33,205), inconclusive | exactly 0, equivalent |
| `custody_hot` | +22,031 (+727 to +43,336), positive | +16,597 (−1,104 to +34,298), inconclusive | +6,247 (−22,622 to +35,115), inconclusive | +813 (+352 to +1,273), positive |
| `publish` | +14,083 (+13,365 to +14,802), positive | +13,559 (+12,570 to +14,549), positive | +524 (−336 to +1,384), inconclusive | exactly 0, equivalent |
| `private` | +31,670 (+28,987 to +34,353), positive | — | — | exactly 0, equivalent |
| `counterparty` | +22,487 (+13,798 to +31,176), positive | +14,684 (+3,704 to +25,664), positive | +1,983 (−2,933 to +6,900), inconclusive | −5,820 (−12,782 to +1,142), inconclusive |
| `mesh_outage` | +15,990 (+14,027 to +17,954), positive | +11,343 (+8,982 to +13,705), positive | +4,647 (+2,244 to +7,050), positive | exactly 0, equivalent |
| `mesh_partial` | +15,693 (+14,080 to +17,306), positive | +8,512 (+6,020 to +11,003), positive | +7,181 (+4,407 to +9,955), positive | exactly 0, equivalent |

## What the model did

- **Model calls per action**: requests to the model server per action sent, including skill calls.
- **Skill calls**: the share of actions preceded by a skill call.
- **Proposal sent**: in a complex, the share of actions that were the model's own proposal, because it agreed with the skill or the gate chose it.

| Cell | bare: model calls per action, skill calls | skill as tool: model calls per action, skill calls | TRM complex: model calls per action, skill calls | combo: model calls per action, skill calls | complex: proposal sent | combo: proposal sent |
|---|---|---|---|---|---|---|
| family 4, `balanced` | 1.00, — | 1.33, 33% | 1.00, — | 1.29, 29% | 4.4% of 1024 | 29.0% of 1024 |
| family 4, `correlated` | 1.00, — | 1.33, 33% | 1.00, — | 1.33, 33% | 3.0% of 1024 | 33.2% of 1024 |
| family 4, `drift` | 1.00, — | 1.27, 27% | 1.00, — | 1.25, 25% | 1.0% of 1024 | 24.7% of 1024 |
| `custody` | 1.00, — | 1.00, 0% | 1.00, — | 1.00, 0% | 23.8% of 512 | 4.9% of 512 |
| `custody_hot` | 1.00, — | 1.00, 0% | 1.00, — | 1.00, 0% | 21.0% of 591 | 0.4% of 527 |
| `publish` | 1.00, — | 1.11, 11% | 1.00, — | 1.21, 21% | 0.7% of 413 | 9.4% of 413 |
| `private` | 1.00, — | not completed | 1.00, — | 1.04, 4% | 1.3% of 901 | 3.7% of 901 |
| `counterparty` | 1.00, — | 1.10, 10% | 1.00, — | 1.05, 5% | 23.8% of 854 | 48.9% of 876 |
| `mesh_outage` | 1.00, — | 1.23, 23% | 1.00, — | 1.15, 15% | 6.4% of 456 | 11.6% of 456 |
| `mesh_partial` | 1.00, — | 1.36, 36% | 1.00, — | 1.21, 21% | 4.7% of 445 | 18.0% of 445 |

## Runs

- family 4, bare: `bonsai-8b-nothink@b7e945ef3ef0`, [v0-server-sizing-bonsai-8b-nothink-confirmatory.md](v0-server-sizing-bonsai-8b-nothink-confirmatory.md)
- family 4, skill as tool: `bonsai-8b-nothink@5bf77bc1d7db`, [v0-server-sizing-bonsai-8b-nothink-capacity_plan-confirmatory.md](v0-server-sizing-bonsai-8b-nothink-capacity_plan-confirmatory.md)
- family 4, TRM complex: `bonsai-8b-nothink-trm-complex@73800c4b1625`, [v0-server-sizing-bonsai-8b-nothink-trm-complex-confirmatory.md](v0-server-sizing-bonsai-8b-nothink-trm-complex-confirmatory.md)
- family 4, combo: `bonsai-8b-nothink-trm-complex@2fe906c9f00c`, [v0-server-sizing-bonsai-8b-nothink-capacity_plan-trm-complex-confirmatory.md](v0-server-sizing-bonsai-8b-nothink-capacity_plan-trm-complex-confirmatory.md)
- `custody`, bare: `bonsai-8b-nothink@d8325f53f685`, [v0-nostr-custody-bonsai-8b-nothink-confirmatory.md](v0-nostr-custody-bonsai-8b-nothink-confirmatory.md)
- `custody`, skill as tool: `bonsai-8b-nothink@284eb3883ea5`, [v0-nostr-custody-bonsai-8b-nothink-custody_policy-confirmatory.md](v0-nostr-custody-bonsai-8b-nothink-custody_policy-confirmatory.md)
- `custody`, TRM complex: `bonsai-8b-nothink-trm-complex@b7f36b872379`, [v0-nostr-custody-bonsai-8b-nothink-trm-complex-confirmatory.md](v0-nostr-custody-bonsai-8b-nothink-trm-complex-confirmatory.md)
- `custody`, combo: `bonsai-8b-nothink-trm-complex@1437fa282657`, [v0-nostr-custody-bonsai-8b-nothink-custody_policy-trm-complex-confirmatory.md](v0-nostr-custody-bonsai-8b-nothink-custody_policy-trm-complex-confirmatory.md)
- `custody_hot`, bare: `bonsai-8b-nothink@fd6b50014da9`, [v0-nostr-custody-hot-bonsai-8b-nothink-confirmatory.md](v0-nostr-custody-hot-bonsai-8b-nothink-confirmatory.md)
- `custody_hot`, skill as tool: `bonsai-8b-nothink@22e2200e3886`, [v0-nostr-custody-hot-bonsai-8b-nothink-inbox_policy-confirmatory.md](v0-nostr-custody-hot-bonsai-8b-nothink-inbox_policy-confirmatory.md)
- `custody_hot`, TRM complex: `bonsai-8b-nothink-trm-complex@74580be3e18a`, [v0-nostr-custody-hot-bonsai-8b-nothink-trm-complex-confirmatory.md](v0-nostr-custody-hot-bonsai-8b-nothink-trm-complex-confirmatory.md)
- `custody_hot`, combo: `bonsai-8b-nothink-trm-complex@0fdc5f0bf0d6`, [v0-nostr-custody-hot-bonsai-8b-nothink-inbox_policy-trm-complex-confirmatory.md](v0-nostr-custody-hot-bonsai-8b-nothink-inbox_policy-trm-complex-confirmatory.md)
- `publish`, bare: `bonsai-8b-nothink@22aa09bf32c9`, [v0-nostr-publish-bonsai-8b-nothink-confirmatory.md](v0-nostr-publish-bonsai-8b-nothink-confirmatory.md)
- `publish`, skill as tool: `bonsai-8b-nothink@9a50b6012cdd`, [v0-nostr-publish-bonsai-8b-nothink-outbox_plan-confirmatory.md](v0-nostr-publish-bonsai-8b-nothink-outbox_plan-confirmatory.md)
- `publish`, TRM complex: `bonsai-8b-nothink-trm-complex@9b1660e75e12`, [v0-nostr-publish-bonsai-8b-nothink-trm-complex-confirmatory.md](v0-nostr-publish-bonsai-8b-nothink-trm-complex-confirmatory.md)
- `publish`, combo: `bonsai-8b-nothink-trm-complex@59d458a1623f`, [v0-nostr-publish-bonsai-8b-nothink-outbox_plan-trm-complex-confirmatory.md](v0-nostr-publish-bonsai-8b-nothink-outbox_plan-trm-complex-confirmatory.md)
- `private`, bare: `bonsai-8b-nothink@e06836fa3df2`, [v0-nostr-private-bonsai-8b-nothink-confirmatory.md](v0-nostr-private-bonsai-8b-nothink-confirmatory.md)
- `private`, skill as tool: not completed
- `private`, TRM complex: `bonsai-8b-nothink-trm-complex@268e93bdb34f`, [v0-nostr-private-bonsai-8b-nothink-trm-complex-confirmatory.md](v0-nostr-private-bonsai-8b-nothink-trm-complex-confirmatory.md)
- `private`, combo: `bonsai-8b-nothink-trm-complex@e3d1294e4333`, [v0-nostr-private-bonsai-8b-nothink-nip17_plan-trm-complex-confirmatory.md](v0-nostr-private-bonsai-8b-nothink-nip17_plan-trm-complex-confirmatory.md)
- `counterparty`, bare: `bonsai-8b-nothink@6332fdb1e664`, [v0-nostr-counterparty-bonsai-8b-nothink-confirmatory.md](v0-nostr-counterparty-bonsai-8b-nothink-confirmatory.md)
- `counterparty`, skill as tool: `bonsai-8b-nothink@7022487f091f`, [v0-nostr-counterparty-bonsai-8b-nothink-buyer_plan-confirmatory.md](v0-nostr-counterparty-bonsai-8b-nothink-buyer_plan-confirmatory.md)
- `counterparty`, TRM complex: `bonsai-8b-nothink-trm-complex@d3f9fd9f4344`, [v0-nostr-counterparty-bonsai-8b-nothink-trm-complex-confirmatory.md](v0-nostr-counterparty-bonsai-8b-nothink-trm-complex-confirmatory.md)
- `counterparty`, combo: `bonsai-8b-nothink-trm-complex@afbf0bceedc8`, [v0-nostr-counterparty-bonsai-8b-nothink-buyer_plan-trm-complex-confirmatory.md](v0-nostr-counterparty-bonsai-8b-nothink-buyer_plan-trm-complex-confirmatory.md)
- `mesh_outage`, bare: `bonsai-8b-nothink@8d6935055857`, [v0-nostr-mesh-outage-bonsai-8b-nothink-confirmatory.md](v0-nostr-mesh-outage-bonsai-8b-nothink-confirmatory.md)
- `mesh_outage`, skill as tool: `bonsai-8b-nothink@e94ca1ac779a`, [v0-nostr-mesh-outage-bonsai-8b-nothink-mesh_router-confirmatory.md](v0-nostr-mesh-outage-bonsai-8b-nothink-mesh_router-confirmatory.md)
- `mesh_outage`, TRM complex: `bonsai-8b-nothink-trm-complex@4be78b83f210`, [v0-nostr-mesh-outage-bonsai-8b-nothink-trm-complex-confirmatory.md](v0-nostr-mesh-outage-bonsai-8b-nothink-trm-complex-confirmatory.md)
- `mesh_outage`, combo: `bonsai-8b-nothink-trm-complex@19af140f792c`, [v0-nostr-mesh-outage-bonsai-8b-nothink-mesh_router-trm-complex-confirmatory.md](v0-nostr-mesh-outage-bonsai-8b-nothink-mesh_router-trm-complex-confirmatory.md)
- `mesh_partial`, bare: `bonsai-8b-nothink@24f957258215`, [v0-nostr-mesh-partial-bonsai-8b-nothink-confirmatory.md](v0-nostr-mesh-partial-bonsai-8b-nothink-confirmatory.md)
- `mesh_partial`, skill as tool: `bonsai-8b-nothink@71bc752498cf`, [v0-nostr-mesh-partial-bonsai-8b-nothink-mesh_router-confirmatory.md](v0-nostr-mesh-partial-bonsai-8b-nothink-mesh_router-confirmatory.md)
- `mesh_partial`, TRM complex: `bonsai-8b-nothink-trm-complex@da92631747e3`, [v0-nostr-mesh-partial-bonsai-8b-nothink-trm-complex-confirmatory.md](v0-nostr-mesh-partial-bonsai-8b-nothink-trm-complex-confirmatory.md)
- `mesh_partial`, combo: `bonsai-8b-nothink-trm-complex@236e8bf4d7e5`, [v0-nostr-mesh-partial-bonsai-8b-nothink-mesh_router-trm-complex-confirmatory.md](v0-nostr-mesh-partial-bonsai-8b-nothink-mesh_router-trm-complex-confirmatory.md)
