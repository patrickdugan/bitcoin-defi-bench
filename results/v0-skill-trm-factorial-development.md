# Skill as a tool × TRM complex, Bonsai 8B, development seeds

Four arms per cell, each run once on the same seeds and fixtures. The rows of each arm's own table give its primary contrast. This table puts the arms side by side, and its contrasts are descriptive: 95% intervals over seed clusters, not adjusted.

- **Bare**: the chat adapter alone.
- **Skill as a tool**: the adapter carrying the cell's skill, which the model may call before it acts.
- **TRM complex**: the bare agent proposes, the package's rules check the proposal, the skill repairs it, and the gate decides the rest (docs/trm_complex.md).
- **Combo**: the complex, with the skill-carrying agent as its proposer and a gate trained on that agent's development runs.

## Normalized gain

0 is the floor, 1 the ceiling. Family 4's floor is `static_pilot`, and family 9's is `idle`.

| Cell | bare | skill as tool | TRM complex | combo |
|---|---|---|---|---|
| family 4, `balanced` | −1.00 (−1.00 to −1.00), clipped | −1.00 (−1.00 to −1.00), clipped | 0.53 (0.49 to 0.58) | 0.53 (0.49 to 0.58) |
| family 4, `correlated` | −1.00 (−1.00 to −0.03), clipped | −0.28 (−0.86 to 0.29) | 0.64 (0.38 to 0.91) | 0.64 (0.38 to 0.91) |
| family 4, `drift` | −1.00 (−1.00 to −1.00), clipped | −1.00 (−1.00 to −1.00), clipped | 0.91 (0.91 to 0.92) | 0.91 (0.91 to 0.92) |
| `custody` | −1.00 (−1.00 to −1.00), clipped | −1.00 (−1.00 to −1.00), clipped | 1.00 (1.00 to 1.00) | 1.00 (1.00 to 1.00) |
| `custody_hot` | 0.00 (0.00 to 0.00) | 0.01 (−0.01 to 0.03) | 0.80 (0.62 to 0.98) | 1.00 (1.00 to 1.00) |
| `publish` | 0.00 (0.00 to 0.00) | 0.08 (−0.10 to 0.26) | 0.83 (0.74 to 0.92) | 0.83 (0.74 to 0.92) |
| `private` | 0.03 (−0.02 to 0.08) | not completed | 1.00 (1.00 to 1.00) | 1.00 (1.00 to 1.00) |
| `counterparty` | 0.07 (−0.24 to 0.39) | 0.13 (−0.17 to 0.43) | 0.95 (0.89 to 1.02) | 1.00 (0.99 to 1.00) |
| `mesh_outage` | −0.12 (−0.28 to 0.03) | −0.11 (−0.26 to 0.05) | 0.85 (0.74 to 0.95) | 0.85 (0.74 to 0.95) |
| `mesh_partial` | −0.16 (−0.33 to 0.02) | 0.02 (−0.11 to 0.15) | 0.86 (0.81 to 0.91) | 0.86 (0.81 to 0.91) |

## Agent − reference

Each arm's agent less the cell's reference heuristic, in the family's unit: ln cost in family 4, sats in family 9.

| Cell | Reference | bare | skill as tool | TRM complex | combo |
|---|---|---|---|---|---|
| family 4, `balanced` | `buffer_rule` | −4.23 (−5.61 to −2.85), negative | −1.99 (−2.91 to −1.08), negative | exactly 0.00, equivalent | exactly 0.00, equivalent |
| family 4, `correlated` | `buffer_rule` | −3.52 (−4.93 to −2.11), negative | −1.62 (−2.79 to −0.45), negative | exactly 0.00, equivalent | exactly 0.00, equivalent |
| family 4, `drift` | `buffer_rule` | −2.80 (−3.98 to −1.62), negative | −2.36 (−3.16 to −1.56), negative | exactly 0.00, equivalent | exactly 0.00, equivalent |
| `custody` | `kinds_only` | −27,333 (−115,343 to +60,677), inconclusive | −48,288 (−115,683 to +19,108), inconclusive | +179,733 (+96,328 to +263,139), positive | +179,733 (+96,328 to +263,139), positive |
| `custody_hot` | `no_key_paste` | +44,663 (+32,401 to +56,924), positive | +44,700 (+32,447 to +56,953), positive | +48,413 (+36,583 to +60,242), positive | +49,375 (+37,671 to +61,079), positive |
| `publish` | `outbox` | −12,988 (−14,633 to −11,342), negative | −11,788 (−14,415 to −9,160), negative | exactly 0, equivalent | exactly 0, equivalent |
| `private` | `legacy_everywhere` | −26,033 (−30,579 to −21,487), negative | not completed | +5,597 (+3,462 to +7,732), positive | +5,597 (+3,462 to +7,732), positive |
| `counterparty` | `cheapest` | +9,679 (−15,296 to +34,654), inconclusive | +11,933 (−13,785 to +37,650), inconclusive | +44,925 (+26,123 to +63,727), positive | +46,687 (+27,201 to +66,172), positive |
| `mesh_outage` | `bitchat_router` | −16,172 (−21,032 to −11,312), negative | −15,852 (−18,293 to −13,411), negative | exactly 0, equivalent | exactly 0, equivalent |
| `mesh_partial` | `bitchat_router` | −18,024 (−20,862 to −15,185), negative | −14,883 (−17,667 to −12,099), negative | exactly 0, equivalent | exactly 0, equivalent |

## The two factors

Paired by seed across runs. The first two columns are the complex's effect without and with the skill as a tool. The last two are the tool's effect without and with the complex. Units as above.

| Cell | complex − bare | combo − skill as tool | skill as tool − bare | combo − complex |
|---|---|---|---|---|
| family 4, `balanced` | +4.23 (+2.85 to +5.61), positive | +1.99 (+1.08 to +2.91), positive | +2.24 (+0.51 to +3.96), positive | exactly 0.00, equivalent |
| family 4, `correlated` | +3.52 (+2.11 to +4.93), positive | +1.62 (+0.45 to +2.79), positive | +1.90 (+0.48 to +3.33), positive | exactly 0.00, equivalent |
| family 4, `drift` | +2.80 (+1.62 to +3.98), positive | +2.36 (+1.56 to +3.16), positive | +0.44 (−1.01 to +1.89), inconclusive | exactly 0.00, equivalent |
| `custody` | +207,066 (+138,550 to +275,582), positive | +228,021 (+185,794 to +270,248), positive | −20,955 (−75,749 to +33,839), inconclusive | exactly 0, equivalent |
| `custody_hot` | +3,750 (+1,873 to +5,627), positive | +4,675 (+2,762 to +6,588), positive | +38 (−51 to +126), equivalent | +963 (+111 to +1,814), positive |
| `publish` | +12,988 (+11,342 to +14,633), positive | +11,788 (+9,160 to +14,415), positive | +1,200 (−1,638 to +4,038), inconclusive | exactly 0, equivalent |
| `private` | +31,630 (+25,942 to +37,318), positive | — | — | exactly 0, equivalent |
| `counterparty` | +35,246 (+20,712 to +49,780), positive | +34,754 (+23,269 to +46,239), positive | +2,254 (−15,784 to +20,291), inconclusive | +1,762 (−965 to +4,488), inconclusive |
| `mesh_outage` | +16,172 (+11,312 to +21,032), positive | +15,852 (+13,411 to +18,293), positive | +320 (−2,834 to +3,475), inconclusive | exactly 0, equivalent |
| `mesh_partial` | +18,024 (+15,185 to +20,862), positive | +14,883 (+12,099 to +17,667), positive | +3,141 (+264 to +6,017), positive | exactly 0, equivalent |

## What the model did

- **Model calls per action**: requests to the model server per action sent, including skill calls.
- **Skill calls**: the share of actions preceded by a skill call.
- **Proposal sent**: in a complex, the share of actions that were the model's own proposal, because it agreed with the skill or the gate chose it.

| Cell | bare: model calls per action, skill calls | skill as tool: model calls per action, skill calls | TRM complex: model calls per action, skill calls | combo: model calls per action, skill calls | complex: proposal sent | combo: proposal sent |
|---|---|---|---|---|---|---|
| family 4, `balanced` | 1.00, — | 1.28, 28% | 1.00, — | 1.33, 33% | 3.9% of 256 | 33.2% of 256 |
| family 4, `correlated` | 1.00, — | 1.32, 32% | 1.00, — | 1.32, 32% | 2.7% of 256 | 31.6% of 256 |
| family 4, `drift` | 1.00, — | 1.31, 31% | 1.00, — | 1.30, 30% | 1.6% of 256 | 30.1% of 256 |
| `custody` | 1.00, — | 1.00, 0% | 1.00, — | 1.01, 1% | 13.3% of 128 | 0.8% of 128 |
| `custody_hot` | 1.00, — | 1.01, 1% | 1.00, — | 1.01, 1% | 28.1% of 185 | 1.5% of 133 |
| `publish` | 1.00, — | 1.13, 13% | 1.00, — | 1.16, 16% | 1.9% of 106 | 9.4% of 106 |
| `private` | 1.00, — | not completed | 1.00, — | 1.03, 3% | 1.7% of 229 | 4.8% of 229 |
| `counterparty` | 1.00, — | 1.21, 21% | 1.00, — | 1.07, 7% | 27.8% of 187 | 33.3% of 162 |
| `mesh_outage` | 1.00, — | 1.19, 19% | 1.00, — | 1.19, 19% | 6.8% of 103 | 19.4% of 103 |
| `mesh_partial` | 1.00, — | 1.33, 33% | 1.00, — | 1.16, 16% | 8.3% of 96 | 26.0% of 96 |

## Runs

- family 4, bare: `bonsai-8b-nothink@b7e945ef3ef0`, [v0-server-sizing-bonsai-8b-nothink-development.md](v0-server-sizing-bonsai-8b-nothink-development.md)
- family 4, skill as tool: `bonsai-8b-nothink@5bf77bc1d7db`, [v0-server-sizing-bonsai-8b-nothink-capacity_plan-development.md](v0-server-sizing-bonsai-8b-nothink-capacity_plan-development.md)
- family 4, TRM complex: `bonsai-8b-nothink-trm-complex@73800c4b1625`, [v0-server-sizing-bonsai-8b-nothink-trm-complex-development.md](v0-server-sizing-bonsai-8b-nothink-trm-complex-development.md)
- family 4, combo: `bonsai-8b-nothink-trm-complex@2fe906c9f00c`, [v0-server-sizing-bonsai-8b-nothink-capacity_plan-trm-complex-development.md](v0-server-sizing-bonsai-8b-nothink-capacity_plan-trm-complex-development.md)
- `custody`, bare: `bonsai-8b-nothink@d8325f53f685`, [v0-nostr-custody-bonsai-8b-nothink-development.md](v0-nostr-custody-bonsai-8b-nothink-development.md)
- `custody`, skill as tool: `bonsai-8b-nothink@284eb3883ea5`, [v0-nostr-custody-bonsai-8b-nothink-custody_policy-development.md](v0-nostr-custody-bonsai-8b-nothink-custody_policy-development.md)
- `custody`, TRM complex: `bonsai-8b-nothink-trm-complex@b7f36b872379`, [v0-nostr-custody-bonsai-8b-nothink-trm-complex-development.md](v0-nostr-custody-bonsai-8b-nothink-trm-complex-development.md)
- `custody`, combo: `bonsai-8b-nothink-trm-complex@1437fa282657`, [v0-nostr-custody-bonsai-8b-nothink-custody_policy-trm-complex-development.md](v0-nostr-custody-bonsai-8b-nothink-custody_policy-trm-complex-development.md)
- `custody_hot`, bare: `bonsai-8b-nothink@fd6b50014da9`, [v0-nostr-custody-hot-bonsai-8b-nothink-development.md](v0-nostr-custody-hot-bonsai-8b-nothink-development.md)
- `custody_hot`, skill as tool: `bonsai-8b-nothink@22e2200e3886`, [v0-nostr-custody-hot-bonsai-8b-nothink-inbox_policy-development.md](v0-nostr-custody-hot-bonsai-8b-nothink-inbox_policy-development.md)
- `custody_hot`, TRM complex: `bonsai-8b-nothink-trm-complex@74580be3e18a`, [v0-nostr-custody-hot-bonsai-8b-nothink-trm-complex-development.md](v0-nostr-custody-hot-bonsai-8b-nothink-trm-complex-development.md)
- `custody_hot`, combo: `bonsai-8b-nothink-trm-complex@0fdc5f0bf0d6`, [v0-nostr-custody-hot-bonsai-8b-nothink-inbox_policy-trm-complex-development.md](v0-nostr-custody-hot-bonsai-8b-nothink-inbox_policy-trm-complex-development.md)
- `publish`, bare: `bonsai-8b-nothink@22aa09bf32c9`, [v0-nostr-publish-bonsai-8b-nothink-development.md](v0-nostr-publish-bonsai-8b-nothink-development.md)
- `publish`, skill as tool: `bonsai-8b-nothink@9a50b6012cdd`, [v0-nostr-publish-bonsai-8b-nothink-outbox_plan-development.md](v0-nostr-publish-bonsai-8b-nothink-outbox_plan-development.md)
- `publish`, TRM complex: `bonsai-8b-nothink-trm-complex@9b1660e75e12`, [v0-nostr-publish-bonsai-8b-nothink-trm-complex-development.md](v0-nostr-publish-bonsai-8b-nothink-trm-complex-development.md)
- `publish`, combo: `bonsai-8b-nothink-trm-complex@59d458a1623f`, [v0-nostr-publish-bonsai-8b-nothink-outbox_plan-trm-complex-development.md](v0-nostr-publish-bonsai-8b-nothink-outbox_plan-trm-complex-development.md)
- `private`, bare: `bonsai-8b-nothink@e06836fa3df2`, [v0-nostr-private-bonsai-8b-nothink-development.md](v0-nostr-private-bonsai-8b-nothink-development.md)
- `private`, skill as tool: not completed
- `private`, TRM complex: `bonsai-8b-nothink-trm-complex@268e93bdb34f`, [v0-nostr-private-bonsai-8b-nothink-trm-complex-development.md](v0-nostr-private-bonsai-8b-nothink-trm-complex-development.md)
- `private`, combo: `bonsai-8b-nothink-trm-complex@e3d1294e4333`, [v0-nostr-private-bonsai-8b-nothink-nip17_plan-trm-complex-development.md](v0-nostr-private-bonsai-8b-nothink-nip17_plan-trm-complex-development.md)
- `counterparty`, bare: `bonsai-8b-nothink@6332fdb1e664`, [v0-nostr-counterparty-bonsai-8b-nothink-development.md](v0-nostr-counterparty-bonsai-8b-nothink-development.md)
- `counterparty`, skill as tool: `bonsai-8b-nothink@7022487f091f`, [v0-nostr-counterparty-bonsai-8b-nothink-buyer_plan-development.md](v0-nostr-counterparty-bonsai-8b-nothink-buyer_plan-development.md)
- `counterparty`, TRM complex: `bonsai-8b-nothink-trm-complex@d3f9fd9f4344`, [v0-nostr-counterparty-bonsai-8b-nothink-trm-complex-development.md](v0-nostr-counterparty-bonsai-8b-nothink-trm-complex-development.md)
- `counterparty`, combo: `bonsai-8b-nothink-trm-complex@afbf0bceedc8`, [v0-nostr-counterparty-bonsai-8b-nothink-buyer_plan-trm-complex-development.md](v0-nostr-counterparty-bonsai-8b-nothink-buyer_plan-trm-complex-development.md)
- `mesh_outage`, bare: `bonsai-8b-nothink@8d6935055857`, [v0-nostr-mesh-outage-bonsai-8b-nothink-development.md](v0-nostr-mesh-outage-bonsai-8b-nothink-development.md)
- `mesh_outage`, skill as tool: `bonsai-8b-nothink@e94ca1ac779a`, [v0-nostr-mesh-outage-bonsai-8b-nothink-mesh_router-development.md](v0-nostr-mesh-outage-bonsai-8b-nothink-mesh_router-development.md)
- `mesh_outage`, TRM complex: `bonsai-8b-nothink-trm-complex@4be78b83f210`, [v0-nostr-mesh-outage-bonsai-8b-nothink-trm-complex-development.md](v0-nostr-mesh-outage-bonsai-8b-nothink-trm-complex-development.md)
- `mesh_outage`, combo: `bonsai-8b-nothink-trm-complex@19af140f792c`, [v0-nostr-mesh-outage-bonsai-8b-nothink-mesh_router-trm-complex-development.md](v0-nostr-mesh-outage-bonsai-8b-nothink-mesh_router-trm-complex-development.md)
- `mesh_partial`, bare: `bonsai-8b-nothink@24f957258215`, [v0-nostr-mesh-partial-bonsai-8b-nothink-development.md](v0-nostr-mesh-partial-bonsai-8b-nothink-development.md)
- `mesh_partial`, skill as tool: `bonsai-8b-nothink@71bc752498cf`, [v0-nostr-mesh-partial-bonsai-8b-nothink-mesh_router-development.md](v0-nostr-mesh-partial-bonsai-8b-nothink-mesh_router-development.md)
- `mesh_partial`, TRM complex: `bonsai-8b-nothink-trm-complex@da92631747e3`, [v0-nostr-mesh-partial-bonsai-8b-nothink-trm-complex-development.md](v0-nostr-mesh-partial-bonsai-8b-nothink-trm-complex-development.md)
- `mesh_partial`, combo: `bonsai-8b-nothink-trm-complex@236e8bf4d7e5`, [v0-nostr-mesh-partial-bonsai-8b-nothink-mesh_router-trm-complex-development.md](v0-nostr-mesh-partial-bonsai-8b-nothink-mesh_router-trm-complex-development.md)
