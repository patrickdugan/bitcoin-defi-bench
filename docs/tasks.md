# Task families, v0

Status: the harness and family 1 are implemented, their preregistration sections are frozen, and the baselines have been run on the confirmatory seeds (`results/v0-placement-baselines.md`). An LLM adapter exists (`docs/running.md`); no LLM has been run. Family 3 is implemented with the server-tier term of §4.4 and preregistered by amendment; three of the brief's choices are still not offered (§4.6). Families 2, 4, 5, 6, 7, and 8 are specified only; the scorecard they fill is §0.2.

Every statement below carries one of four provenance tags.

| Tag | Meaning |
|---|---|
| **[given]** | Taken from the Spiral repository at the pinned commit: a paper section, a model file, a config, or a recorded campaign output. |
| **[ported]** | Spiral Python logic re-expressed in TypeScript. Same distributions and rules; not bit-identical, and each deliberate deviation is listed. |
| **[brief]** | Named in the project brief but absent from the pinned commit. Cannot be implemented from the pin without invention. |
| **[invented]** | A bench decision made in this document. Open to change at review. |

## 0. Source, pin, and the pin gap

Source: <https://github.com/patrickdugan/Spiral>, cloned to `vendor/spiral` at `9824c30ad402cc9bca768eca27d176e0e8788db5` (`main`, 2026-10-01). Paper: `vendor/spiral/paper/where_the_capital_bound_moves.md`, cited below as "the paper". Its references R1–R14 are cited by those labels.

The reference model is imported from the checkout and never modified. The manifest binds each imported file by git blob id, which is independent of the platform's line endings (the checkout uses `core.autocrlf=true`, so working-tree bytes differ between Windows and Unix; the harness recomputes each blob id from LF-normalized content).

| File | Blob id at pin | Used by |
|---|---|---|
| `model/server.ts` | `8863039977` | family 3 (`ArkServer`, `channelLiquidityDuration`); family 4 |
| `model/ledger.ts` | `4ebe1eefda` | capital accounting in 1, 4, 5; conservation check in all |
| `model/escrow.ts` | `0df94f915b` | family 5 |
| `model/registry.ts` | `2f283706e0` | family 5; duplicate-capital guard in 1, 4 |

`model/warden.ts` is not imported. The bench has no warden, coalition, or detection task.

### 0.1 The pin gap

The brief describes a reference model that is not the one at the pin. I searched every ref of the repository, local and remote (`main`, `swarm-compromise-eval`), with `git log --all -S` for each name; none occurs in any commit. `model/` has one commit in its history (`2e5c6dd`).

| The brief names | At the pin |
|---|---|
| `runCorner` in `model/server.ts` | Absent. `model/server.test.ts` has a non-exported `corner(kind, seed)` with two hard-coded demand kinds, unbounded server capital, `margin = 0.25`, and `refreshLead = 288`. |
| `ArkServer.aggregateSteps` | Absent. `ArkServer` exposes `receive`, `spendLightning`, `refresh`, `advance`, `holderValue`, `liquidityDuration`, the two bound checks, and the per-holder `outward`, `inward`, `allocated` maps. |
| A server-tier term in the liquidity-duration ratio (§3.3) | Absent. §3.3 defines Locked_V(t) = W_S(t) only. §3.4 says in prose that the cut deficits move to the server's channel set; no term is defined. |
| Vol counts both directions | `channelLiquidityDuration` counts receipts and spends. `ArkServer.volumeDelivered` counts spends only. The two objects are divided by different volumes. |
| A spend-recovery assumption the agent chooses | One rule: a forfeited output is swept at its absolute expiry. |
| Arrival over Lightning versus by boarding | `receive` is liquidity-neutral for the server in both cases. |
| A forecast rule the agent chooses | `channelLiquidityDuration` fixes the forecast at (1 + margin) × the realized full-horizon peak. Only `margin` varies. |

Family 1 does not touch any of these and is unaffected. Family 3 cannot be implemented as the brief specifies from the pin, and family 4's interface is undefined. There are two ways to close the gap.

- **A. Re-pin.** A revised `model/` is pushed to Spiral, the bench re-pins, and families 3 and 4 bind to the published API. This is the only option that keeps "use `runCorner` directly" and "do not modify the model" both true.
- **B. Bench-side shim.** The bench composes the pinned `ArkServer` and `channelLiquidityDuration` in `src/tasks/settlement_object/corner.ts` and defines the missing terms itself. §4.6 states what can be done without invention and what cannot. Under B the server-tier term and the recovery choice would be my definitions, not the paper's.

I recommended A. No revised model was found in the repository or on disk, so B was taken: family 3 is built on the pinned primitives, and the server-tier term was put up for review in `docs/server_tier_proposal.md` and adopted on 2026-10-02 (§4.4). Section 5 is written against the brief's interface, with each brief-only element marked.

### 0.2 The scorecard

The bench's output is a profile: one row per task, never a composite. This table is the plan for which rows exist. A cell becomes a family only when four things hold: the paper, or a reference model imported from the pinned checkout, defines the primitive; every protocol parameter has a cited source; the simulator is seeded and hash-bound; and the floor and ceiling baselines leave measurable headroom. A cell that fails any of these is a spec, not a row.

Rails are the paper's object classes (§2.1), with two classes added on review on 2026-10-06. Rows are operators' problems.

| Operator problem | Lightning (C) | Ark (V) | Ecash mint (M) | Statechain (S) | Escrow (E) | On-chain (U) | Proof layer |
|---|---|---|---|---|---|---|---|
| Place directional capital | **F1, run** | | | | | | |
| Route under hidden state | F2, specced | | | | | | |
| Choose the settlement object and size it | **F3, run** (channel column) | **F3, run** (VTXO column) | F3 column, specced §4.8 | F3 column, specced §4.8 | | | |
| Size the server's own channels | | F4, specced | F4 applies to the mint's gateway | | | | |
| Bond a service | | | | | F5, specced | | |
| Net positions toward a target settlement value | links as channels, later cell | | | links as statechain transfers, later cell | | links as on-chain settlement | F6, specced §7 |
| Prove claims within a budget | | | | | | RAITO gives root_n | F7, specced §8 |
| Time funding against fee and demand | | | | | | F8, specced §9 | |

Reading the table:

- **F3 is where rails are compared.** Each object class is a column of the same family, scored on the same demand streams by the same liquidity duration. The ecash and statechain columns enter there, not as families of their own.
- **F6 is rail-agnostic in v0.** Its settlement links carry abstract costs and capacities. Rail-specific cells come later and take their link costs from the object table: a Lightning link is a channel with a directional balance, a statechain link moves whole coins, an on-chain link is a ghost link at on-chain cost.
- **The proof layer is not a rail.** Shinigami and RAITO (Bitcoin Script and Bitcoin consensus in Cairo, proven with Stwo) are the verifier the paper's §4.4 says Bitcoin lacks. F7 is the operator's problem that creates: what to prove and when, against a measured prover cost.
- **Attributes are reported, never scored.** The tuple fields that liquidity duration cannot price, above all the counterparty set Γ (a channel peer, a co-signing server, a custodial mint or federation, a statechain entity, a BitVM committee) and the exit X, appear beside each column as attributes. A table that let a custodial object win on capital-time without saying it is custodial would be misleading.

Kept off the scorecard: coalition, covert-channel, and Sybil tasks (by charter; the registry's nullifier property is asserted in tests, not posed as a task); prover throughput as a score (it is a measurement and an input to F7); and Liquid, which was reviewed and set aside.

### 0.3 Two object classes added on review

The paper's §2.1 table has U, C, V, E, and E′. On 2026-10-06 two classes were added for the scorecard. Their tuples are the bench's reading of the implementers' documentation and are marked [invented] until the paper carries them; the parameters each needs are listed with the family that uses them (§4.8).

| Object | 𝒜 | F | X | Λ | Γ | τ |
|---|---|---|---|---|---|---|
| M: ecash note (Fedimint, Cashu) | the mint's blind signature; a federation threshold for Fedimint | instant on the mint's acceptance | none: a note is a claim on the mint, there is no unilateral exit | none on the holder; the mint keeps 100% reserve | the mint, or the federation's threshold of guardians | keyset rotation |
| S: statechain coin (Mercury-style; TradeLayer transfers generalized here) | the holder's key share with the statechain entity's | the entity's co-signature of the transfer | a pre-signed backup transaction with a decrementing timelock | broadcast the backup before its timelock, or transfer before the lifetime ends | the statechain entity; a prior holder, if the entity colludes | the decrementing timelock: a bounded number of transfers |

What the two classes change in the capital picture: a note's value is backed one for one by the mint's reserve, so a mint locks exactly its holders' balances and nothing against their spends; a statechain coin is the holder's own on-chain capital, locked by nobody else, moved whole. Neither has a direction. Neither fronts a spend. The first is custodial and the second is lumpy, and those are the attributes the scorecard must print beside their liquidity duration.

## 1. Common contract

### 1.1 Agent interface [given by the brief; details invented]

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Agent {
  readonly id: string;                              // recorded in the run record
  readonly privileged?: boolean;                    // oracle baselines only
  reset?(episode: { task: string; seed: number; cell: string }, privileged?: Json): void;
  act(observation: Json): Json | Promise<Json>;
}
```

Scripted baselines, a learned policy, and an LLM adapter all implement `Agent`. The harness awaits `act` and runs episodes strictly in sequence, so a promise-returning agent cannot reorder anything. An oracle baseline declares `privileged` and receives, through `reset`, information that is never part of an observation; the run record marks it. The agent is handed a copy of each observation, so nothing it does to one can reach the simulator.

An observation is one envelope; `view` and the tool list are family-specific.

```json
{
  "bench": "bitcoin-defi-bench/v0",
  "task": "placement/stationary",
  "episode": { "seed": 1000, "cell": "balanced_band", "turn": 0 },
  "budget": { "attempts": 4, "probes": 0, "blocks": 0, "sats": 120000 },
  "tools": ["place", "commit"],
  "view": {},
  "last": null
}
```

An action is one tool call: `{ "tool": "<name>", "args": { } }`. After each action the next observation carries `last = { "accepted": boolean, "reason": string | null, "result": Json }`.

### 1.2 Budgets [invented]

The four counters are those the brief names. Each family's tool table states what a tool costs.

| Counter | Meaning |
|---|---|
| `attempts` | Decision submissions. Every action that is not a probe costs one attempt, including a rejected one. |
| `probes` | Information requests that do not change simulator state. |
| `blocks` | Simulated time the agent may spend before its decision takes effect. Zero in v0 families 1–3. |
| `sats` | Capital the agent may commit. Debited only when an action is accepted, because committed sats are simulator state. |

An action whose own counter is exhausted costs one attempt instead, so every step either debits a counter or ends the phase and an episode always terminates. The decision phase ends at `commit` or when `attempts` reaches zero. The harness then runs the simulator to the horizon with whatever was committed.

### 1.3 Rejection [given: audit L3, ledger S1]

A rejected or malformed action is the identity on simulator state and costs its budget. Validation is side-effect free and precedes every mutation; a multi-part action is accepted or rejected whole. An action the harness cannot parse, or that names no listed tool, costs one attempt. Each rejection carries one reason from a closed list (`malformed`, `unknown_tool`, `unknown_node`, `self_pair`, `not_integer`, `below_minimum`, `over_budget`, `out_of_grid`, `phase_closed`).

The test for this property serializes the full episode state canonically before and after a rejected action and requires byte equality, with the budget counter reduced by exactly the tool's cost.

Capital in families 1, 4, and 5 is held in a `SettlementLedger`: the budget is funded to class U, a commitment is a U→C or U→E event, and an over-budget commitment fails in `initiate` before any hold is placed. `conservationGap` must be zero at the end of every episode.

### 1.4 Determinism and canonical order [given as a requirement: audit §7]

- Node identifiers are zero-padded (`N000`, `a000`) so lexicographic and numeric order agree.
- An undirected edge is stored with endpoints sorted, and edge lists are sorted after endpoints are canonicalized. The audit found the Python generator sorting raw tuples before canonicalizing, which let iteration order reassign seeded draws.
- Candidate paths are ordered by (public fee, hop count, node sequence). Ties in path enumeration are broken by node sequence.
- Action lists (placements, channel sets) are sorted by a canonical key before they are applied.
- No iteration over a `Map` or `Set` reaches an output without an explicit sort.
- Randomness comes from named streams, one per purpose, each seeded from SHA-256 of `bench-version | task | seed | stream-label` [invented]. Adding or removing a draw in one stream cannot shift another. The pinned model's `rng` (a 32-bit LCG) is not used for fixtures.

### 1.5 Fixtures, manifest, run record [given as a requirement; format invented]

A fixture is a JSON file generated from a seed, containing integers and strings only, serialized canonically (sorted keys, no insignificant whitespace). `fixtures/manifest.json` lists, for every fixture, its path, seed, generator version, and SHA-256, together with the Spiral commit, the blob id of each imported model file, and the SHA-256 of each file under `config/`. The manifest hash is the SHA-256 of the canonical manifest.

Before scoring, the harness recomputes every fixture hash and every model-file hash. On any mismatch it refuses to score and names the file. A run record contains the manifest hash, the SHA-256 of `prereg/v0.md`, every agent identifier, the seed set, the Node version, and the per-episode rows.

### 1.6 Scoring [given by the brief; estimator invented]

Each episode yields a native value in the family's own unit, oriented so that higher is better. A seed is a cluster. Let A_s, R_s, O_s be the cluster means of the native value for the agent, the random baseline, and the oracle on seed s.

- **Paired difference.** mean over s of (A_s − B_s) against any baseline B, with a two-sided Student-t interval on the cluster means with (clusters − 1) degrees of freedom. This is the method of `public_topology_analysis.py` [given].
- **Normalized gain.** G = Σ_s (A_s − R_s) / Σ_s (O_s − R_s), clipped to [−1, 1.5]. A ratio of sums, not a mean of per-seed ratios, because a single seed's denominator can be zero or negative. The interval is a delete-one-cluster jackknife with the same t critical value; its endpoints are clipped to the same range and the table says when clipping occurred.
- **Headroom guard.** If the interval for mean (O_s − R_s) does not exclude zero, the task has no measurable headroom and G is printed as `n/a`; only native differences are reported.
- **Equivalence.** A difference is practically equivalent to zero when its whole 95% interval lies inside the band, on both sides (audit §7: a one-sided check can accept a large negative effect). Bands are in native units and are fixed in `prereg/v0.md`.

The oracle is a reference, not a proven upper bound. The audit's two-demand counterexample (§6.1) shows an informed policy is not a full-horizon optimum, which is why the clip is at 1.5 and not 1.

The headline output is one row per task per agent. The table writer has no aggregate row and no function that combines families.

### 1.7 Baselines [given as a requirement]

Random, oracle, and each named heuristic implement `Agent` and run through the same episode runner as the agent under test, in the same process, on the same seeds, every time a table is produced. No baseline value is stored and reused.

### 1.8 Audit flags [given as a requirement; thresholds invented]

The harness computes these on every run and prints them beside the row they concern. A flagged row is moved to a "flagged, pending audit" section of the table and is not a result until an audit note is attached.

| Flag | Condition |
|---|---|
| `outside_calibration` | Family 2: agent − retry wallet is not practically equivalent to zero, in either direction. |
| `exceeds_oracle` | Any task: the point estimate of G is above 1. |
| `unexplained_shift_gain` | `placement/shift`: the interval for agent − random lies wholly above the band. Nothing in the observation predicts the new hotspot. |
| `baseline_off_calibration` | A baseline contrast falls outside its preregistered calibration window. Blocks agent reporting for that family. |
| `identity_broken` | A baseline run through the agent interface does not earn exactly what the simulator returns for the same rule computed directly from the fixture. |

## 2. Family 1: directional placement

Derives from the paper §1 and §3.1, and from the manuscript §9.8 and Appendix B.5. Tasks: `placement/stationary`, `placement/shift`.

The operator has a capital budget and a record of recent demand, and decides where to add directional channel capacity. The earlier campaigns' finding is that this is where the deployable gain is, and that it exists only when demand persists.

### 2.1 Simulator

| Element | Value | Tag |
|---|---|---|
| Topology | 64-node connected sample of the July 16, 2023 public-gossip snapshot, three sampling modes (hub, random, periphery) rotated by seed, with the snapshot's public fee fields | [ported] sampler; see §2.6 |
| Capacity | lognormal, median 100,000 sat, log-sigma 0.85, clamped to [20,000, 1,500,000]; paired across balance models within a seed | [ported] |
| Hidden balance | three ensembles: `balanced_band` 0.30 + 0.40u, `uniform` 0.02 + 0.96u, `polarized` two bands at [0.01, 0.15] and [0.85, 0.99]; clamped to [1, capacity − 1] | [ported] |
| Hotspot pairs | two non-adjacent pairs, distance ≥ 3 where at least two exist, drawn from the 32 most distant; the second disjoint from the first | [ported] |
| Demand | 220 demands. With probability 0.35 a demand is on the active hotspot pair, forward with probability 0.72; otherwise a uniform distinct pair. Amounts uniform on {1000, 2000, 5000, 8000} sat | [ported] |
| Stationary regime | the first hotspot pair is active throughout | [given] |
| Shift regime | the second pair replaces the first at demand 110 | [given] |
| Warm-up and evaluation | demands 0–109 are history; 110–219 are scored | [given] |
| Routing | retry wallet: up to 8 shortest simple paths, ordered by public fee, first 3 attempted, first feasible applied atomically; a failed attempt changes nothing | [given], except the router, below |
| Fees | per hop `base_fee_msat + ceil(sats × fee_ppm / 1000)`, summed over all hops | [ported] |
| Placement timing | takes effect at demand 110, instantly and without on-chain cost | [given]; the audit (§7.1, §8.2) names this as a simplification |
| Budget | 120,000 sat | [given]: `connector_capital` |

Deviations from the measured campaign, each deliberate:

1. Routing during placement episodes is the retry wallet, not the terminal-feedback learner under which +6.13 was measured. The learner adds 0.35 points over retries and carries state between demands; fixing a stateless router isolates the placement decision. [invented]
2. Edge and candidate order are canonical (§1.4). Samples and hidden states are therefore new draws, not reproductions of the 37 recorded samples.
3. Each seed runs one balance draw for each of the three balance models (three episodes per seed per task). The campaigns used two or three draws.
4. The diffuse regime is not a task. Its measured placement effect is 0.14 points (−0.02 to 0.31), so oracle − random has no headroom and a normalized gain is undefined.

### 2.2 Observation

The agent is not told which regime it is in. The two tasks present the same observation form, and the agent cannot distinguish them at decision time. [invented; this matches what the measured heuristic knew]

```json
{
  "nodes": ["N000", "N001"],
  "edges": [
    { "u": "N000", "v": "N001", "base_fee_msat": 1000, "fee_ppm": 100, "cltv_delta": 40 }
  ],
  "history": [
    { "i": 0, "source": "N012", "target": "N055", "sats": 5000, "delivered": false, "failed_attempts": 3 }
  ],
  "horizon": { "warmup": 110, "evaluation": 110 },
  "rules": {
    "min_pair_sats": 20000,
    "existing_edges_allowed": true,
    "new_channel_policy": { "base_fee_msat": 1000, "fee_ppm": 100, "cltv_delta": 40 }
  }
}
```

The agent never sees capacity, directional balance, the failing edge of a failed path, the hotspot pairs, or future demand. [given]

### 2.3 Actions

| Tool | Args | Cost | Effect |
|---|---|---|---|
| `place` | `placements: [{ from, to, sats }]` | 1 attempt; Σ sats on acceptance | Each entry funds `sats` of capacity on the pair with the whole amount spendable from `from` toward `to`. Entries on the same pair aggregate into one channel. On an existing edge the entry adds capacity and `from`-side balance. |
| `commit` | none | 0 | Ends the decision phase. |

Budget: 4 attempts, 0 probes, 0 blocks, 120,000 sat. [attempt count invented]

A placement is directional: a single-funded open puts the whole balance on the funder's side. A 50/50 channel is two entries on one pair. The Spiral connector was always 50/50; the directional form is what the family is named for. [invented]

Rejected when any entry names an unknown node, has `from = to`, or has a non-integer or non-positive amount; when the total exceeds remaining sats; or when a pair that has no channel would end with less than `min_pair_sats` in total. Entries are aggregated per directed pair and applied in canonical order, so their order in the action cannot change the outcome.

### 2.4 Scoring

Native value: success rate over the 110 evaluation demands, in percentage points. Delivered-volume share is reported as a secondary column. Equivalence band: ±1.0 point [given: the earlier preregistrations].

### 2.5 Baselines

| Baseline | Rule | Tag |
|---|---|---|
| `none` | No placement. Reference row only. | [given] |
| `random` | One pair drawn uniformly from the sorted non-edges, whole budget, 50/50. The floor. | [ported] |
| `failure_aware` | The non-edge pair with the most failed warm-up demands, ties to the lexicographically greatest pair, falling back to `random` when nothing failed; whole budget, 50/50. This is the rule measured at +6.13 (4.91 to 7.35) over random under stationary demand and 0.44 (−0.21 to 1.09) after a shift. | [ported] |
| `oracle` | Knows the hotspot pair active during evaluation and its direction skew. Whole budget on that pair, 72% funded from the forward side and 28% from the reverse. The ceiling reference. | [invented] |

The oracle knows the persistent component of demand and nothing else: not the realized draws, not hidden balances. It is a fixed rule, not a search, so oracle ≥ heuristic is an empirical property of the fixtures and the test of it can fail.

Ordering test, on the development fixtures: under stationary demand, mean oracle ≥ mean failure-aware ≥ mean random. Under shift, mean oracle ≥ both others, and failure-aware ≥ random − 1.0 point. The strict heuristic ≥ random ordering is not asserted under shift, because the calibration says that difference is not distinguishable from zero.

### 2.6 Topology source

The Spiral repository retains the sampler and the hidden-state generator in Python and the provenance record of the snapshot, but not the snapshot. `data/topology/20230716.gml.geo` is git-ignored and is not present in the local checkout either. It is one 33 MB member of a 562 MB Harvard Dataverse archive (DOI `10.7910/DVN/2OAVO6`, member SHA-256 `ee1b054a…a8b855`), which Spiral's `scripts/fetch_ln_snapshot.py` extracts by byte range (3.76 MB transferred).

- **T1. Sample the real snapshot.** A one-time fixture build parses the GML, ports `sample_connected_subgraph` with canonical ordering, and writes 64-node samples with their public fee fields as hash-bound fixtures. Running the bench then needs no snapshot and no network. This needs a download and a check of the dataset's licence before derived samples are committed.
- **T2. Synthetic topology.** A generator matched to the recorded statistics of the 37 Spiral samples: 64 nodes; 63 to 366 edges, median 94; maximum degree 35 to 63, 63 in most; 1 to 63 bridges; diameter 2 to 4. No fee-field distribution is recorded, so fees would be the Spiral defaults (1000 msat, 100 ppm).

T1 was chosen. The calibration numbers were measured on samples of this snapshot, and six summary statistics do not pin down the structure that makes placement matter. The dataset is CC BY 4.0 (Valko and Marx Gómez), so the derived 64-node samples are committed as fixtures with attribution in `config/placement.json`; the raw snapshot is not committed. The bench's GML reader reproduces the statistics Spiral recorded for the snapshot exactly (15,100 nodes, 64,212 channels, 15 components, a 15,071-node giant component, maximum degree 2,293), and `scripts/build_fixtures.ts` refuses to build if it does not. The bench's samples are new draws: 64 to 525 edges across the 40 generated fixtures, against 63 to 366 in Spiral's 37.

## 3. Family 2: routing under hidden state (specified, not implemented)

Derives from the manuscript §9 and the audit §6–7. Task ids: `routing/<balance_model>/<regime>`.

A wallet routes a stream of payments over a topology whose directional balances are hidden, with a fixed number of attempts per payment.

**Simulator.** The family 1 topology, capacity, balance, and demand generators, with all three regimes (diffuse, stationary, shift) and no placement. The agent routes all 220 demands; the last 110 are scored. [given]

**Observation.**

```json
{
  "demand": { "i": 117, "source": "N012", "target": "N055", "sats": 5000 },
  "candidates": [
    { "index": 0, "path": ["N012", "N000", "N055"], "fee_msat": 3000, "hops": 2 }
  ],
  "history": [
    { "i": 116, "attempts": [{ "candidate": 0, "delivered": false }, { "candidate": 1, "delivered": true }] }
  ]
}
```

The candidate list is the public eight-path catalog in canonical order. Feedback is terminal: delivered or not, never the failing edge. [given]

**Actions.** `attempt { candidate }` costs one attempt and returns the terminal outcome. `skip` gives up the demand. Budget: 3 attempts per demand, 0 probes, 0 blocks, 0 sats. [given: `max_route_attempts = 3`]

**Score.** Success rate over evaluation demands at the fixed attempt budget, in points. Band ±1.0 point.

**Baselines.**

| Baseline | Rule | Role |
|---|---|---|
| `one_shot` | Cheapest public path, one attempt. | Floor. The brief names no random policy for this family; a random ordering with three attempts would sit next to the retry wallet and leave no denominator. [invented substitution] |
| `retry_wallet` | First three candidates in public-fee order. | The calibration reference. |
| `hidden_state_oracle` | First feasible candidate in the full eight-path catalog. | Ceiling. Per the audit, its advantage is catalog inspection beyond three attempts, not information at equal budget. |
| `prefix_oracle_3` | First feasible among the first three. | Control. Must equal `retry_wallet` in every delivery; the audit's 54 trajectory-equality checks become a harness self-test. |

**Calibration expectation.** Measured: retries +5.14 points over one-shot (3.08 to 7.20); terminal-feedback learning +0.35 beyond retries (0.15 to 0.55), inside the ±1 point band; the oracle +1.11 beyond the learner (0.64 to 1.58). The predeclared expectation is that a good agent is practically equivalent to the retry wallet. A result outside the band in either direction raises `outside_calibration` and is audited before it is reported. This family exists mainly to make that check.

## 4. Family 3: settlement-object selection

Derives from the paper §3.3, §3.4, and §7 item 2. Task ids: `settlement_object/<cell>`.

An operator serving a population of payers chooses the settlement object for them, a pre-funded directional channel per agent or VTXOs on one Ark server, and sets its parameters. The score is capital-time locked per unit delivered, subject to a ceiling on failures.

The family is built on the pinned `ArkServer` and `channelLiquidityDuration`, unmodified, plus one term the pin does not define: the server-tier term, adopted on review on 2026-10-02 (`docs/server_tier_proposal.md`). Three of the brief's choices are still not offered; §4.6 says which and why. §4.7 records an earlier run without the server-tier term.

### 4.1 Demand process [§7 item 1 given; generator invented]

Time advances in steps of one round interval. In each step each agent may receive and may spend. Every receipt and every spend is a Lightning payment.

| Parameter | Meaning |
|---|---|
| `agents` | population size |
| `base` | steady per-step inflow and outflow with jitter |
| `burst` | probability and size of a burst inflow and a burst outflow per step |
| `common_shock_share` ρ | with probability ρ an agent's burst indicators for a step copy a population-wide draw; pairwise correlation of indicators is ρ² |
| `horizon_lifetimes` | horizon in units of the VTXO lifetime |

Each agent has its own random stream and every draw is taken on every step, so changing the population size or a probability cannot shift another agent's draws.

Spends an agent could not fund under any object are removed when the stream is generated: a spend is kept only if it does not exceed the agent's running balance with every receipt delivered. Every remaining failure is then attributable to the object choice, and the failure rate has the same denominator for both objects. [invented]

Cells:

| Cell | Parameters | Tag |
|---|---|---|
| `many_bursty_long` | 200 agents, burst inflow 5000 sat at p = 0.02, burst outflow 4000 sat at p = 0.01, ρ = 0, horizon 8 lifetimes. Every agent accumulates: 100 sat in and 40 out per step on average. | [given]: the pinned corner test |
| `many_bursty_balanced` | the same with inflow and outflow equal: 5000 sat at p = 0.02 each way. No net drift. | [invented] |
| `many_bursty_balanced_correlated` | the balanced cell with ρ = 0.8 | [invented] |
| `few_steady_recycling` | 3 agents, inflow and outflow each 100 + U{0..9} sat every step, horizon 8 lifetimes | [given]: the pinned corner test |

The balanced cell exists because the pinned bursty corner does not isolate pooling. Its agents all accumulate, and accumulation is not diversifiable: a server holding the balances of 200 agents who all accumulate needs room for the sum.

A 200-agent stream is a few million integers, too large to commit. A fixture therefore stores the cell parameters and the SHA-256 of its evaluation and pilot streams; a stream is regenerated from the seed when it is loaded and refused if its hash differs. [invented]

### 4.2 Observation

```json
{
  "process": {
    "agents": 200,
    "base": { "in_sats": 0, "out_sats": 0, "jitter_sats": 0 },
    "burst": { "p_in": 0.02, "in_sats": 5000, "p_out": 0.02, "out_sats": 5000 },
    "common_shock_share": 0,
    "horizon_lifetimes": 8,
    "arrival": "lightning",
    "derived": { "inflow_sats_per_step": 100, "outflow_sats_per_step": 100, "drift_sats_per_step": 0 }
  },
  "protocol": { "lifetime_blocks": 4032, "round_interval_blocks": 6, "steps": 5376 },
  "server_tier": { "charged": true, "rebalancing": "static" },
  "epsilon": 0.01,
  "grid": { "margin": [-0.25, -0.1, 0, 0.1, 0.25], "refresh_lead_blocks": [144, 288, 576] },
  "variant": "server-tier/v1"
}
```

The agent sees the process and never either realized stream. The derived rates are before the funded-spend rule.

### 4.3 Actions

| Tool | Args | Cost |
|---|---|---|
| `probe` | `{ choice }` | 1 probe, accepted or not. Runs the choice on the pilot stream, drawn from the same process with an independent stream, and returns its liquidity duration, failure rate, and feasibility. With no probes left it costs one attempt and is refused. |
| `choose` | `{ choice }` | 1 attempt. Fixes the choice scored on the evaluation stream and ends the phase. |
| `commit` | none | 0. Ends the phase without a choice, which is scored as infeasible. |

A choice is `{ "object": "channel", "margin": m }` or `{ "object": "vtxo", "refresh_lead_blocks": n, "margin": m }`, and must be a point of the declared grid (`out_of_grid` otherwise). The grid has 20 points: 5 channel margins, and 3 refresh leads by 5 server margins. Budget: 3 attempts, 8 probes, 0 blocks, 0 sats. [invented]

| Choice field | Values | Tag |
|---|---|---|
| `margin`, channel | {−0.25, −0.1, 0, 0.1, 0.25}. The operator pre-funds (1 + margin) × each agent's realized peak held balance; a negative margin under-provisions and trades failures for capital. | [given] parameter of `channelLiquidityDuration`; grid [invented] |
| `margin`, VTXO | the same grid and the same rule, applied to the server's own channels (§4.4) | [invented] |
| `refresh_lead_blocks` | {144, 288, 576}; 288 is the published two days | [given] default from R5; grid [invented] |

Fixed and not agent choices: the server-tier term is always charged, and Vol counts receipts and spends for both objects. The safety margin on the server's channels is a choice because the channel's is; were it fixed, the channel would win every cell by shaving a margin the server could not.

### 4.4 Scoring

Liquidity duration 𝒟 = ∫ Locked dt / Vol in blocks, lower is better [given: §3.3].

- **Channel.** Locked is the pre-funded inbound stock, Σ over agents of (1 + margin) × the agent's realized peak held balance, held for the horizon. [given]
- **VTXO.** Locked(t) = W_S(t) + C_S. W_S is the value the server has fronted and not yet swept [given]. C_S is the server-tier term [invented, adopted on review].

**The server-tier term.** Every holder's receipt and spend crosses the server's own Lightning channels, and nothing rebalances those channels during the horizon. Let P be the server's cumulative net Lightning position: a receipt raises it and needs inbound room, a spend lowers it and needs outbound balance. The server pre-funds inbound of (1 + margin) × the realized peak of P and outbound of (1 + margin) × the realized trough, and C_S is their sum, held for the horizon. A receipt that does not fit the inbound room fails; so does a spend that the outbound balance cannot cover, or that a failed receipt left unfunded. This is the channel model's rule applied one tier up, which is how the paper's §3.4 describes the server's position. At a margin of zero or more it never fails a payment.

Because spends are funded, P is the population's total held balance and never falls below zero. The server-tier term is therefore the peak of the total balance, where the channel object locks the total of the peaks. The difference between the two is what pooling is worth.

Failure rate = failed receipts and spends over attempted ones. A choice is feasible when its failure rate is at most ε; ε = 0.01 [invented].

Native value: −ln 𝒟 for a feasible choice. An infeasible choice, or no choice, is scored as twice the largest feasible 𝒟 on the grid for that episode [invented penalty]. Equivalence band: ±0.05 in ln 𝒟, about 5% of liquidity duration [invented].

The table also reports 𝒟_C / 𝒟_V at the baseline settings as a geometric mean over seeds with the interval of the mean log ratio. That is the quantity the paper's §7 item 2 asks for.

### 4.5 Baselines

| Baseline | Rule |
|---|---|
| `random` | One point drawn uniformly from the declared grid. The floor. |
| `always_channel` | Channel at margin 0.25, the pinned corner's value. |
| `always_vtxo` | VTXO at refresh lead 288, the pinned corner's value, with margin 0.25 on the server's channels. |
| `grid_search` | Given every grid point's result on the evaluation stream; takes the feasible minimum of 𝒟. The oracle. |

Ordering test: `grid_search` ≥ every other baseline on every episode. That holds by construction, because every baseline's choice is on the grid, so it checks the harness and not the model. Separately, on development seeds, the matching constant baseline beats the grid average, which is what `random` earns in expectation: `always_vtxo` on `many_bursty_balanced`, `always_channel` on `few_steady_recycling`.

### 4.6 What is the pin's, what is the bench's, and what was left out

The corner runner, `src/tasks/settlement_object/corner.ts`, composes the pinned `ArkServer` and `channelLiquidityDuration` without modifying either. It is the non-exported `corner()` of the pinned test made into a function of a demand stream and a choice, and it stands in for the brief's `runCorner`.

Taken from the pin unchanged: the forfeit-to-sweep lock rule, lifetimes and holder refresh, and the channel's peak-balance forecast.

Added by the bench: a common volume denominator (`ArkServer.volumeDelivered` counts spends only, so ∫ W_S dt is recovered through the public interface as `liquidityDuration() × volumeDelivered` and divided by receipts plus spends); and the server-tier term of §4.4.

Left out, with the reason for each:

1. **Server capital B_S as a choice.** Server capital is unbounded, as in the pinned corner test. `ArkServer.advance` discards the result of a refresh the server cannot front, so a server short of capital defers refreshes without any failure being reported, and a finite B_S would lower 𝒟 by starving refreshes, unobserved. Peak W_S is reported as a metric. B_S becomes a choice when Spiral's model reports starved refreshes.
2. **Rebalancing of the server's channels.** They are static in this family. Rebalancing them is the decision in family 4.
3. **Arrival by boarding.** A boarded deposit does not cross the server's channels, and under the channel object it is the agent's own capital and not the operator's. The pin models neither: `receive` treats every arrival alike and `channelLiquidityDuration` treats every receipt as needing inbound. Both sides need a definition before a boarding cell is fair to either.
4. **The forecast-rule choice.** The pinned function fixes the forecast at (1 + margin) × the realized peak of the stream being scored. That is a hindsight forecast, and the server tier uses the same one so that the two objects are compared like for like. A rule made before the demand is seen needs a different function on both sides.
5. **The spend-recovery choice.** If the agent may simply declare faster recovery, it always will. The choice needs a stated cost or risk, and the pin has neither.
6. **The ledger.** The family commits no agent capital, so there is nothing for a `SettlementLedger` to hold. The runner asserts `ArkServer`'s own aggregate bound instead.

One property of the pinned model shows in every result: refresh lead has no trade-off. An earlier refresh only locks more, so the shortest lead on the grid is never worse.

### 4.7 The earlier run without the server-tier term

Before the server-tier term was adopted, the family was run as the pin defines it, with Locked_V = W_S alone, on an exploratory seed block (2000 through 2031) at commit `a15627b`. The table is `results/v0-settlement-object-pin-variant.md`. On `many_bursty_long` it gave 𝒟_C / 𝒟_V = 25.0 (24.9 to 25.1).

That figure does not survive the server-tier term. The pinned bursty corner's agents accumulate, the server's channels must take the whole accumulation, and the server then locks about what the channel operator locked. The two results are for different definitions and are not comparable as replications; the earlier one is kept as the record of what the pinned definition gives.

### 4.8 Further object columns: ecash and statechain (specified, not implemented)

Added on review on 2026-10-06 (§0.3). Each is a column of family 3: the same demand streams, the same liquidity duration, the same ε, scored beside the channel and VTXO columns. The agent's choice gains `{ "object": "ecash", "margin": m }` and `{ "object": "statechain", "denomination_sats": d }`, and the grid grows accordingly. Attributes (Γ, X, Λ) print beside each column and are not scored.

**Ecash mint (M).** The mint holds a reserve equal to its outstanding notes, so Locked_M(t) = Σ over agents of their held balance at t, plus the mint's Lightning gateway, which carries every receipt and spend exactly as the Ark server's channels do: the server-tier term of §4.4, with the agent's margin, static over the horizon. A receipt that does not fit the gateway's inbound room fails, and a spend the gateway cannot pay fails. Nothing is fronted and nothing is swept, so there is no W_S. Against the VTXO column the comparison is held balances against fronted spends held to expiry; against the channel column it is actual balances against forecast peaks. Fedimint and Cashu share this model; they differ in Γ, a threshold of guardians against one mint, which is printed and not scored.

Parameters to be sourced before the column runs: the gateway's fee policy (Fedimint and Cashu gateway documentation), whether the mint charges a melt or mint fee, and keyset rotation periods. None enters the liquidity duration; they enter the attributes and the failure accounting.

**Statechain coin (S).** A coin is the holder's own capital and moves whole. Locked_S(t) = Σ over agents of ceil(balance_a(t) / d) × d, the balances rounded up to the coin denomination d, since a holder keeps whole coins; a spend smaller than a coin needs a swap or a split through the entity, counted as a failure when the holder has no coin small enough and the entity's swap fails. No gateway term: transfers are between holders of the same entity. The denomination is the agent's choice from a declared grid; a small denomination wastes less capital and needs more transfers per payment, a large one the reverse. Each transfer decrements the coin's remaining lifetime; a coin at the end of its lifetime must be withdrawn and re-deposited, an on-chain cost charged at a declared fee rate.

Parameters to be sourced: the lifetime rule (the decrement per transfer and the initial timelock) and the entity's fee, from the statechain implementation the column is to represent. TradeLayer's transfer semantics are to be mapped onto this class by the user; the column is specified against the Mercury-style construction and the mapping is not assumed.

**Baselines for the two columns.** `always_ecash` at margin 0.25 and `always_statechain` at the median grid denomination join `always_channel` and `always_vtxo`; `grid_search` covers the enlarged grid. Hypotheses for the columns are written only when the parameters above have sources, as an amendment.

## 5. Family 4: server capital sizing (specified, not implemented)

Derives from the paper §3.2 and §3.4. Task id: `server_sizing/<cell>`.

The agent is the Ark server. Its VTXO holders present an aggregate flow; the server's own Lightning channels are the only directional edges left. This is the ghost solver moved one tier up.

**Observation.** [brief: depends on `ArkServer.aggregateSteps`]

```json
{
  "aggregate_history": [{ "step": 0, "out_sats": 12000, "in_sats": 5000 }],
  "peers": [{ "id": "P00", "base_fee_msat": 1000, "fee_ppm": 100, "max_inbound_lease_sats": 2000000 }],
  "protocol": { "lifetime_blocks": 4032, "round_interval_blocks": 6 },
  "objective": { "failure_penalty_sat_blocks": 0 }
}
```

**Actions.** `size { channels: [{ peer, outbound_sats, inbound_sats }] }` costs one attempt and debits the capital on acceptance. `commit` ends the phase. Budget: attempts, a sats cap, and a `blocks` allowance for confirmation delay, the first family where `blocks` is not zero.

**Score.** Failures plus capital-time over the evaluation horizon: a weighted sum with the weight as a declared input [brief for the objective; weight invented].

**Baselines.** `random`: a random feasible sizing. `peak_envelope`: every channel sized to (1 + margin) × the warm-up peak of aggregate imbalance, the failure-aware rule one tier up. `oracle`: the minimal envelope under the realized flow.

Blocked on the same gap as family 3.

## 6. Family 5: service bonding (specified, not implemented)

Derives from the paper §5. Task id: `bonding/<cell>`.

An operator bonds a connector service with an optimistic escrow E(B, κ, Δ) and chooses the bond and the challenge period.

**Observation.**

```json
{
  "service": { "window_blocks": 1008, "outcome": { "kind": "binomial", "requests": 200, "p_honored": 0.97 }, "threshold": 0.95, "value_at_risk_sats": 2000000 },
  "fee_rate_sat_vb": 4,
  "challenge": { "min_delta_blocks": 6, "response_blocks": { "kind": "geometric", "p_per_block": 0.5 } },
  "bitvm3": { "assert_vb": 2400, "disprove_vb": 93 },
  "capital_rate_per_block": 0.0000002
}
```

`bitvm3` holds the published sizes from R7. They are inputs, flagged as such in `config/protocol.json`, and the escrow is constructed with them through `EscrowParams`.

**Actions.** `bond { bond_sats, delta_blocks }` costs one attempt. Rejected for a non-positive or non-integer bond (the `Escrow` constructor's own guard), a Δ below the minimum, or a bond over the sats budget.

**Score.** Negative expected cost over the outcome distribution: the Assert fee, the bond locked for the window plus Δ at the capital rate, and the bond lost when the service falls below threshold, subject to the bond covering the declared value at risk and Δ being long enough for a challenger to respond with the declared probability. Each episode drives an `Escrow` through assert and either withdraw or disprove; the registry records the escrow's identifier, per Proposition S4.

**Baselines.** `random` on the (B, Δ) grid. `ghost_required_bond`: Spiral's `GhostPlan.required_bond` rule, amount × (0.10 + risk rate × horizon), with Δ = 144. `oracle`: the grid minimum of expected cost.

## 7. Family 6: position netting toward a target settlement value (specified, not implemented)

Derives from the paper §2.4 and §4.2, the errata E3, and the application the paper cites as R14 (US 2021/0004796 A1), whose subject is decentralized derivatives clearing: nodes are addresses, each with positions; edges are weighted with the amounts traded; a target value T is imposed from market data or inferred; ghost nodes connect subgraphs so that the rewrite nets to zero-sum as close to T as possible; the output is the transfers between the nodes holding open positions at expiration. Task ids: `netting/<cell>`.

A clearing operator, or any party holding positions, must settle every open position at the settlement value with as little gross value moved, and as few transfers, as the settlement links allow. Netting is what makes that cheap; ghost links are what make it possible when the trade graph does not connect.

Decided on review on 2026-10-06: this family is scored, and the expectation is that a skill passes it (see "Expectation" below).

### 7.1 Simulator [invented, anchored to R14]

| Element | Value |
|---|---|
| Traders | N addresses, each with collateral c_i in sats |
| Trades | M bilateral contracts on one instrument: (long i, short j, quantity q, entry price p₀). The trade graph is the set of pairs that have traded. |
| Settlement value | T, drawn by a seeded process around the entry prices; external to the agent, as the application's market-data case |
| Obligation of a trade | v = q × (T − p₀): the short pays the long when v > 0, the long pays the short when v < 0 |
| Net obligation of a node | n_i = Σ received − Σ paid over its trades; Σ_i n_i = 0 by construction |
| Links | every traded pair has a bilateral link with a capacity (the most it can carry in total, either direction) and a per-unit cost in parts per million. Any other pair can be joined by a ghost link: unlimited, at a higher per-unit cost. |
| Collateral | the generator sets c_i at or above each node's gross payable at T, so every obligation can be met and every failure is the plan's |
| Costs | per-unit rates for links and ghost links, and a base fee per transfer, all declared inputs |

A plan is a list of transfers `{ from, to, sats, via }` with `via` either `link` or `ghost`. It is valid when every amount is a positive integer; every `link` transfer uses a pair that has traded, and the total on each link stays within its capacity; every node's net paid minus received equals its net obligation exactly; and no node pays more in total than its collateral. A plan that breaks any of these is rejected whole and places nothing.

### 7.2 Observation

```json
{
  "traders": [{ "id": "t000", "collateral_sats": 2500000 }],
  "trades": [{ "id": 0, "long": "t003", "short": "t011", "quantity": 4, "entry_price": 61250 }],
  "settlement_value": 61900,
  "links": [{ "a": "t003", "b": "t011", "capacity_sats": 180000, "rate_ppm": 100 }],
  "ghost": { "rate_ppm": 2000 },
  "base_fee_sats": 100
}
```

The agent sees the whole position graph. Nothing is hidden in v0; the difficulty is combinatorial, not informational.

### 7.3 Actions

| Tool | Args | Cost |
|---|---|---|
| `probe` | `{ plan }` | 1 probe. Validates the plan and returns its violations and its cost without committing it. |
| `settle` | `{ plan }` | 1 attempt. Commits a valid plan and ends the phase; an invalid one is rejected whole. |
| `commit` | none | 0. Ends the phase with no plan. |

Budget: 3 attempts, 8 probes, 0 blocks, 0 sats. [invented]

### 7.4 Scoring

Cost of a plan: Σ over transfers of sats × rate(via) / 10⁶ + base fee × number of transfers, in sats. Native value: −ln(cost). An episode that ends with no accepted plan is scored at twice the cost of the floor's plan. Band: ±0.05 in ln cost [invented].

### 7.5 Baselines

| Baseline | Rule | Role |
|---|---|---|
| `gross` | settle every trade on its own link for its full obligation, spilling to a ghost link when the link is full. No netting. | floor; a deterministic stand-in for `random`, declared as F2 declares one-shot |
| `bilateral_net` | net each pair's trades to one amount, settle it on the pair's link, spill to ghost | reference heuristic |
| `min_cost_flow` | the exact minimum-cost flow with supplies n_i over the links (capacitated, at their rates) and ghost links (uncapacitated, at the ghost rate); transfers are the flow's edges | ceiling |

The ceiling ignores the base fee, which would make the exact problem a fixed-charge design problem. It is therefore a reference and not a bound, as every ceiling in the bench is; the clip at 1.5 is for this.

Cells: `netting/bilateral_dense` (few traders, many trades per pair: bilateral netting nearly suffices), `netting/multilateral_sparse` (many traders, a chain-like trade graph with cycles: multilateral netting matters), `netting/disconnected` (two trade subgraphs with obligations that cannot net within either: ghost links are needed, the application's own case).

### 7.6 Expectation, and what is flagged

A skill that implements minimum-cost flow and emits the flow as a plan should reach the ceiling. The harness checks this directly: a scripted agent that runs the oracle's algorithm through `act` must reproduce `min_cost_flow` exactly, the identity control of this family. An LLM agent given such a skill is expected to score at least 0.9; one without a skill is expected to produce plans that fail conservation and be rejected. A result above the ceiling raises `exceeds_oracle` as elsewhere.

### 7.7 Rail-specific cells, later

Each later cell replaces the abstract links with an object class's own: a Lightning link is a channel with a directional balance and routing fees (class C); a statechain link moves whole coins, so a transfer is a number of coins and change needs a swap (class S); a ghost link is on-chain settlement at a fee rate (class U). The plan format does not change.

## 8. Family 7: proving claims within a budget (specified, not implemented)

Derives from the paper §4.2 to §4.4 and §7 item 3, and from the audit's §11.3 and the recovered project's out-of-memory failures. Task ids: `proof_budget/<cell>`.

On Bitcoin nothing in consensus verifies a SNARK, so a claim on 𝓡_cap or 𝓡_svc is verified by a party you trust or by a game you pay for (§4.4). A Cairo verifier is the third way: Shinigami executes Bitcoin Script in Cairo, so "k_ρ satisfies 𝒜_ρ" can be proven rather than attested; RAITO proves Bitcoin consensus, so the verifier's view of 𝒮_n, the `root_n` of the relation, can be checked rather than assumed, which is the assumption Proposition S3 is conditional on. Both are proven with Stwo. The paper's §7 item 3 asks whether a claim can be produced within a stated budget. This family makes the budget the operator's decision.

A registry operator publishes proofs over batches of claims. A proof has a cost that grows with its batch and a memory ceiling it must fit under; a claim earns nothing until a proof covering it is published, and waiting has a cost. The operator chooses when to prove and how much.

### 8.1 Simulator [invented; cost model measured]

| Element | Value |
|---|---|
| Claims | arrive by a seeded process over a horizon of blocks; each has a value v (what it would earn when accepted) |
| Proof cost | c(b) = c₀ + c₁ × b prover-seconds for a batch of b claims, and peak memory m(b) = m₀ + m₁ × b, with a ceiling M. Measured, not modeled: see 8.5. |
| Staleness | each claim pays s × v per block between arrival and the proof that covers it |
| Prover rate | a declared price per prover-second, so cost and staleness share a unit |

### 8.2 Observation

```json
{
  "arrivals": { "rate_per_block": 0.8, "value_sats": { "min": 1000, "max": 50000 } },
  "cost_model": { "c0_seconds": 0, "c1_seconds_per_claim": 0, "m0_mib": 0, "m1_mib_per_claim": 0, "ceiling_mib": 0, "source": "measurement fixture id" },
  "prover_price_sats_per_second": 0,
  "staleness_ppm_per_block": 0,
  "horizon_blocks": 1008,
  "pending": [{ "id": 17, "arrived_at": 240, "value_sats": 12000 }],
  "block": 251
}
```

The zeros are placeholders until the cost model is measured (8.5); the family does not run on invented costs.

### 8.3 Actions

| Tool | Args | Cost |
|---|---|---|
| `prove` | `{ claims: [ids] }` | 1 attempt. Publishes a proof over the named pending claims if their batch fits under the memory ceiling; rejected whole otherwise. |
| `wait` | `{ blocks }` | 0. Advances time. |

Budget: attempts are the number of proofs the operator may publish in the horizon, declared per cell; 0 probes; blocks is the horizon. [invented]

### 8.4 Scoring, baselines, expectation

Native value: −ln(prover cost + staleness cost) over the horizon. Baselines: `every_arrival` (prove each claim as it arrives: floor by cost), `fixed_interval` (prove every k blocks: reference), `random_interval`, and `optimal_batching` (the exact dynamic program over batch boundaries for the realized arrivals: ceiling). A skill that implements the dynamic program should reach the ceiling, and the identity control checks it as in F6.

### 8.5 The cost model is a measurement fixture

The family's only protocol-like inputs are prover costs, and they are measured on this machine with the Cairo toolchain already set up for Stwo: a Cairo program for one claim on 𝓡_cap (a Merkle path and a PRF, as §7 item 3 specifies; nothing more), proven for batch sizes on a declared grid, recording seconds and peak memory per size. The measurement is a fixture: program hash, toolchain commit, machine, grid, and results, hash-bound in the manifest like a BitVM3 size. Nothing in a bench run proves anything; the run reads the fixture. Until the fixture exists the family is a spec.

## 9. Family 8: timing funding against fee and demand (specified, not implemented)

Derives from the paper §2.2 (a U→C event is a funding transaction with a confirmation clock) and the audit §8.1 and §8.2 (three clocks must stay separate; useful demand can expire before usable capital arrives). Task ids: `funding_timing/<cell>`.

Family 1 lets placement take effect instantly and free. This family prices that simplification. The placement is given; the operator chooses when to broadcast the funding transaction, at what fee rate, and at what confirmation depth to start using the channel, while the fee market and demand move.

### 9.1 Simulator [invented, with inputs to be sourced]

| Element | Value |
|---|---|
| Fee market | a seeded fee-rate process in sat/vB over the horizon; inclusion in the next block with a probability that rises with the offered rate against the prevailing one. The process family and its parameters are inputs with a source; a historical fee series from a public dataset, hash-bound, is the preferred source. |
| Demand | the family 1 stream and topology for the seed, with the failure-aware pair already chosen |
| Funding | one transaction of a declared size in vB; its fee is rate × size; confirmation depth k before the channel is usable |
| Capital | charged at a declared rate per sat-block from broadcast to the end of the horizon |

### 9.2 Observation, actions, scoring, baselines

The observation carries the fee-rate history to date, the prevailing rate, the demand history, the funding size, and the depth menu. Actions: `broadcast { rate_sat_vb, depth }` (1 attempt), `wait { blocks }` (0). Budget: 2 attempts (one replace-by-fee), blocks the horizon.

Native value: delivered volume minus fee minus capital charge, in sats. Baselines: `now_high` (broadcast at once at a rate that confirms next block), `wait_for_low` (broadcast when the rate falls below a declared threshold), `random`, and `oracle` (knows the fee path and the demand; the best broadcast and depth by search). Band and the sats weight on delivered volume are set with the fee source, by amendment.

## 10. Protocol parameters

Every protocol figure lives in `config/protocol.json` as `{ value, unit, source, url }` with the date the source was accessed or published, and is read from there. None is a constant in code.

| Parameter | Default | Source |
|---|---|---|
| VTXO lifetime | 4032 blocks (28 days), server-configurable | R3 |
| Unilateral exit CSV | 144 blocks | R3 |
| Round interval | 6 blocks (hourly default) | R3 |
| Refresh lead | 288 blocks (two days before expiry) | R5 |
| Assert size | 2400 vB | R7 |
| Disprove size | 93 vB | R7 |
| Garbled verifier size, evaluation time | 41 GB, 6 minutes (informational) | R7 |
| Snapshot | July 16, 2023 public gossip, member SHA-256 `ee1b054a…a8b855` | Spiral `data/topology/snapshot_provenance.json` |

R6, R8, and R9 are cited in the paper for Ark's timeline and for covenant activation status. No v0 task reads a parameter from them.

## 11. Given and invented, in one place

**Taken as given.** The pinned model files and their behavior, confirmed by running the vendored suite (13 of 13 pass). The four calibration effects and their intervals. The public-topology campaign's generator parameters, warm-up and evaluation split, eight-path catalog, three-attempt budget, 120,000 sat connector, and the failure-aware and random placement rules. Cluster-level Student-t inference and the ±1 point band. The audit's requirements: canonical order, hash-bound fixtures, no fabricated weights, rejection as identity, equivalence on both sides, and the oracle as reference and not as bound. The paper's definition of liquidity duration, its two corners, and its falsifier.

**Invented here.** The observation and action envelopes, the tool tables, and what each budget counter means. The ratio-of-sums normalized gain, its jackknife interval, and the headroom guard. Directional placements and placement on existing edges. The retry wallet as family 1's fixed router. The placement oracle's rule and its 72/28 split. Hiding the regime from the agent. One-shot as family 2's floor. All of family 3's generator beyond the two corner parameter sets, its funded-spend rule, its stream-hash fixtures, its probe tool, grids, ε, penalty, and band, the common volume denominator its corner runner adds, the server-tier term and its failure rule, and the zero-drift cells. The LLM adapter and its prompt. The audit-flag thresholds. The named-stream PRNG. The scorecard (§0.2), the ecash and statechain tuples (§0.3), and families 6 through 8, all specified on review and not yet built.

**Named in the brief and missing from the pin.** `runCorner`, `ArkServer.aggregateSteps`, the server-tier term, server capital as a choice, the spend-recovery choice, the forecast-rule choice, and the arrival-mode distinction (§0.1). Family 3 supplies the server-tier term itself (§4.4, adopted on review) and is built without the others (§4.6).
