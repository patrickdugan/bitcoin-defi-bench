# Draft amendment: family 9 (Nostr coordination and the bitchat mesh)

Status: **appended and frozen.** On 2026-10-08 the text below the line was appended to `prereg/v0.md` as Amendment 5 (commit `f54de1a`), unchanged except for its heading's number and date. `prereg/v0.md` is the binding copy; this file is the draft as it was reviewed. The confirmatory results are in `docs/tasks.md` §10.9.

---

### Amendment N, 2026-10-__: family 9 (Nostr coordination and the bitchat mesh) is frozen

Frozen families: nostr

**Reason.** Family 9 was added to the scorecard on request on 2026-10-08 (tasks §0.2, §10) and built the same day. Its primitives come from published specifications pinned by commit and SHA-256 (`data/nostr/provenance.json`): the NIPs at `a79e21d`, BIP-340, and the bitchat protocol whitepaper version 2.0. Its protocol core is checked against their published vectors (tasks §10.8).

**Design.**

| Item | Value |
|---|---|
| Seeds | confirmatory 1000 through 1031; development 0 through 7 |
| Cells | `custody`, `custody_hot`, `publish`, `private`, `counterparty`, `mesh_outage`, `mesh_partial` |
| Episodes | one per seed per cell |
| Run records | one per cell: each cell has its own baselines, and the harness runs every policy of a record on every task |
| Floor | `idle` in every cell: commit at once. Doing nothing is safe and earns nothing in each cell, so the normalized gain is the share of attainable value captured, and it is negative when a policy does harm. |
| Native value | sats, as tasks §10.2 to §10.6 define per cell |
| Bands | ±500 sats (`custody`, `publish`, `private`, `mesh_outage`, `mesh_partial`), ±300 (`custody_hot`), ±1000 (`counterparty`) |

| Cell | Policies (reference in italics, ceiling last) | Ceiling |
|---|---|---|
| `custody` | `idle`, `approve_all`, `random`, *`kinds_only`*, `policy` | exact: the operator's policy applied to the observation |
| `custody_hot` | `idle`, `answer_all`, `random`, *`no_key_paste`*, `policy` | exact |
| `publish` | `idle`, `random`, `popular`, *`outbox`*, `max_reach` | privileged reference: knows the relays down at read time and which followers use the outbox model |
| `private` | `idle`, `plaintext_mention`, `random`, *`legacy_everywhere`*, `nip17` | exact: NIP-17 to the ready, NIP-04 to the legacy, nothing to the rest |
| `counterparty` | `idle`, `first_offer`, `random`, *`cheapest`*, `reputation`, `oracle` | exact, privileged: pays the cheapest provider that delivers in time |
| `mesh_outage`, `mesh_partial` | `idle`, `nostr_only`, `flood_now`, `random`, *`bitchat_router`*, `oracle` | privileged reference: plans each message on the realized future |

**Gates**, cell-level.

| Gate | Passes when |
|---|---|
| K91 | `idle` earns exactly 0 on every episode |
| K92 | where the ceiling is exact, the ceiling through `act` earns exactly the value computed directly from the fixture on every episode |
| K93 | where the ceiling is exact, no policy beats it on any episode |

**Hypotheses.** Each is a within-cell paired contrast in sats. They are the cells' design claims.

- **H1.** `policy` − `idle` is positive on `custody`.
- **H2.** `kinds_only` − `idle` is negative on `custody`: checking what is asked, but not who asks or how much, loses money.
- **H3.** `policy` − `idle` is positive on `custody_hot`.
- **H4.** `no_key_paste` − `idle` is negative on `custody_hot`: refusing to paste the key is not enough when the bot signs whatever it is handed.
- **H5.** `outbox` − `random` is positive on `publish`.
- **H6.** `max_reach` − `outbox` is positive on `publish`.
- **H7.** `nip17` − `legacy_everywhere` is positive on `private`.
- **H8.** `plaintext_mention` − `idle` is negative on `private`.
- **H9.** `reputation` − `cheapest` is positive on `counterparty`: reading the public record beats chasing the lowest price.
- **H10.** `oracle` − `cheapest` is positive on `counterparty`.
- **H11.** `bitchat_router` − `flood_now` is positive on `mesh_outage`.
- **H12.** `oracle` − `bitchat_router` is positive on `mesh_outage`.
- **H13.** `bitchat_router` − `nostr_only` is positive on `mesh_partial`.
- **H14.** `oracle` − `bitchat_router` is positive on `mesh_partial`.

**Multiplicity.** Each cell is its own primary family, Bonferroni-adjusted for its two hypotheses (critical value 2.356 on 31 degrees of freedom), which is the adjustment each cell's table applies.

**Secondary, declared and descriptive.** Every normalized gain; each cell's metrics (approvals and losses, leaks, readers reached, fees, deliveries by scheme, exposures, impostors paid, nutzaps lost, transmissions, deliveries by courier and by Nostr).

**Agent runs.** As §7 and §9: one primary contrast per cell, agent − the cell's reference, from `scripts/run_nostr_agent.ts`. An agent's prompt shows the observation and the policy the cell states. It does not show the hidden labels (which requests are hostile, which relays will be down, which providers deliver, where devices will be). There is no expectation for an agent in v0.

**What was seen before this amendment was written.** Development tables on seeds 0 through 7 (`results/v0-nostr-*-baselines-development.md`), unadjusted and then adjusted for two:

| Hypothesis | Unadjusted | Adjusted |
|---|---|---|
| H1 | +8,913 (+7,053 to +10,773) | +6,678 to +11,147 |
| H2 | −170,821 (−254,541 to −87,101) | −271,416 to −70,226 |
| H3 | +4,713 (+2,818 to +6,607) | +2,436 to +6,989 |
| H4 | −44,663 (−56,924 to −32,401) | −59,395 to −29,930 |
| H5 | +9,700 (+7,068 to +12,332) | +6,538 to +12,862 |
| H6 | +2,600 (+1,075 to +4,125) | +768 to +4,432 |
| H7 | +5,597 (+3,462 to +7,732) | +3,031 to +8,163 |
| H8 | −44,728 (−51,386 to −38,070) | −52,727 to −36,729 |
| H9 | +44,925 (+26,123 to +63,727) | +22,333 to +67,517 |
| H10 | +46,798 (+27,246 to +66,350) | +23,305 to +70,291 |
| H11 | +11,874 (+8,899 to +14,848) | +8,300 to +15,448 |
| H12 | +2,515 (+872 to +4,157) | +541 to +4,488 |
| H13 | +14,643 (+12,415 to +16,871) | +11,966 to +17,320 |
| H14 | +2,533 (+1,854 to +3,211) | +1,718 to +3,347 |

K91 to K93 passed in every cell. Three choices were changed after development results were seen, all before this amendment was written:

1. The floor was changed from each cell's harmful baseline (`approve_all`, `answer_all`, `plaintext_mention`, and so on) to `idle`. A smoke run showed that under the old floors a do-nothing agent would score a normalized gain of about 0.97 in `custody`.
2. The mesh cells' price per transmission was raised from 2 to 20 sats. At 2 sats, `bitchat_router` came within a few hundred sats of the ceiling on every seed, and flooding was close to free.
3. The mesh oracle was made to plan with the courier quotas and to send same-step messages in planning order. Without that it lost a message to its own quota collision on one development seed.

The hypotheses were written after the development tables and match them. The confirmatory fixtures had been generated and hash-bound; none had been evaluated.

**Still not offered**, and to be added only by a further amendment: NIP-49 key export computed rather than classified; signed feedback and result events in `counterparty`; bitchat's public broadcast and gossip sync; source routing on the mesh.
