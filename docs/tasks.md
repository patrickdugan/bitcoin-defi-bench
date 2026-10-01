# Task families, v0

Status: the harness and family 1 are implemented and their preregistration sections are frozen. Family 3 is specified and blocked on §0.1. Families 2, 4, and 5 are specified only.

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
| `model/server.ts` | `8863039977` | families 3, 4 |
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

I recommend A. Sections 4 and 5 are written against the brief's interface so they survive either resolution, with each brief-only element marked.

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

Derives from the paper §3.3 and §7 item 2. Task ids: `settlement_object/<cell>`.

An operator serving a population of payers chooses the settlement object for them, a pre-funded directional channel per agent or VTXOs on one Ark server, and sizes it. The score is capital-time locked per unit delivered, subject to a ceiling on failures.

### 4.1 Demand process [§7 item 1 given; generator invented]

Time advances in steps of one round interval. In each step each agent may receive and may spend.

| Parameter | Meaning |
|---|---|
| `agents` | population size |
| `base` | steady per-step inflow and outflow with jitter |
| `burst` | probability and size of a burst inflow and a burst outflow per step |
| `common_shock_share` ρ | with probability ρ an agent's burst indicators copy a population-wide draw for that step; pairwise correlation of indicators is ρ² |
| `horizon_lifetimes` | horizon in units of the VTXO lifetime |
| `arrival` | `lightning` or `boarding` [brief] |

The observation reports the primitives and two derived descriptors: per-agent drift (mean inflow minus outflow per step) and burstiness (imbalance envelope over own volume, the §7 definition; omitted from the example below because it is computed from the fixture).

Spends an agent could not fund under any object are removed when the fixture is generated: a spend is kept only if it does not exceed the agent's running balance with every receipt delivered. Every remaining failure is then attributable to the object choice, and the failure rate has the same denominator for both objects. [invented]

Cells for v0:

| Cell | Parameters | Tag |
|---|---|---|
| `many_bursty_long` | burst inflow 5000 sat at p = 0.02, burst outflow 4000 sat at p = 0.01, ρ = 0, horizon 8 lifetimes, arrival lightning | [given]: the pinned corner test, except agent count |
| `few_steady_recycling` | 3 agents, inflow and outflow each 100 + U{0..9} sat every step, horizon 8 lifetimes | [given]: the pinned corner test |
| `many_bursty_correlated` | as the first with ρ = 0.8 | [invented] |
| `many_bursty_boarding` | as the first with arrival by boarding | [invented]; needs the [brief] arrival semantics |

The pinned corner uses 200 agents and takes about 8 seconds per run, because `ArkServer` scans every output on each balance query. A grid search repeats that per grid point, per seed, per cell. The agent count for the many-agent cells is therefore set by a timing measurement on development seeds before the prereg is frozen; the working figure is 64. [invented]

### 4.2 Observation

```json
{
  "process": {
    "agents": 64,
    "base": { "in_sats": 0, "out_sats": 0, "jitter_sats": 0 },
    "burst": { "p_in": 0.02, "in_sats": 5000, "p_out": 0.01, "out_sats": 4000 },
    "common_shock_share": 0.0,
    "horizon_lifetimes": 8,
    "arrival": "lightning",
    "derived": { "drift_sats_per_step": 60 }
  },
  "protocol": { "lifetime_blocks": 4032, "round_interval_blocks": 6, "exit_csv_blocks": 144 },
  "epsilon": 0.01,
  "grid": { "margin": [], "server_capital_sats": [], "refresh_lead_blocks": [144, 288, 576] }
}
```

The agent sees the process, not the realized stream.

### 4.3 Actions

| Tool | Args | Cost |
|---|---|---|
| `probe` | a candidate choice | 1 probe. Runs the candidate on a pilot stream drawn from the same process with an independent seed and returns its liquidity duration and failure rate. |
| `choose` | `{ object: "channel", forecast_rule, margin }` or `{ object: "vtxo", server_capital_sats, refresh_lead_blocks, spend_recovery }` | 1 attempt. Fixes the choice scored on the evaluation stream. |

Budget: 3 attempts, 8 probes, 0 blocks, and a sats cap on the capital any choice may lock. [invented] The grid has on the order of a hundred points, so eight probes cannot enumerate it. A choice off the declared grid is rejected (`out_of_grid`).

| Choice field | Values | Tag |
|---|---|---|
| `margin` | a declared grid including negative values; a negative margin under-provisions and trades failures for capital | [given] parameter of `channelLiquidityDuration`; grid [invented] |
| `forecast_rule` | `realized_peak` only at the pin | [brief] for any other rule |
| `server_capital_sats` (B_S) | a declared grid in multiples of the cell's expected spend volume per lifetime | [given] parameter of `ArkServer`; grid [invented] |
| `refresh_lead_blocks` | {144, 288, 576}; 288 is the published two days | [given] default from R5; grid [invented] |
| `spend_recovery` | `at_expiry` is the pinned lock rule | [brief] for any other value |

Fixed and not agent choices, per the brief: the server-tier term is always charged, and Vol counts receipts and spends for both objects.

### 4.4 Scoring

Liquidity duration 𝒟 = ∫ Locked dt / Vol in blocks, lower is better [given: §3.3]. Failure rate = failed receipts and spends over attempted ones. A choice is feasible when its failure rate is at most ε; ε = 0.01 [invented].

Native value: −ln 𝒟 for a feasible choice. An infeasible choice is scored as twice the largest feasible 𝒟 on the grid for that episode [invented penalty]. Equivalence band: ±0.05 in ln 𝒟, about 5% of liquidity duration [invented].

### 4.5 Baselines

| Baseline | Rule |
|---|---|
| `random` | One point drawn uniformly from the declared grid. The floor. |
| `always_channel` | Channel, `realized_peak`, margin 0.25 (the pinned corner's value). |
| `always_vtxo` | VTXO, refresh lead 288, `at_expiry`, and the smallest grid B_S that is feasible on the pilot stream. |
| `grid_search` | Evaluates every grid point on the evaluation stream and takes the feasible minimum of 𝒟. The oracle. |

Ordering test: `grid_search` ≥ each other baseline on every episode, which holds by construction because every baseline's choice is on the grid, and is therefore a check on the harness rather than on the model. Separately, on each corner the matching constant baseline beats `random` in the mean: `always_vtxo` on `many_bursty_long`, `always_channel` on `few_steady_recycling`. The mismatched constant is expected to fall below `random` and is reported, not asserted.

### 4.6 What the pin supports

Without inventing simulator semantics, the pin supports this much: a choice between `channel(margin)` and `vtxo(B_S, refresh_lead)`; the pinned lock rule; and Vol counted in both directions for both objects, because `ArkServer.liquidityDuration() × volumeDelivered` recovers ∫ W_S dt through the public interface and the shim can divide by receipts plus spends.

It does not support three things.

1. **The server-tier term.** `channelLiquidityDuration` models pre-funded inbound toward a party that receives and then spends. A server's own Lightning position also needs pre-funded outbound for holders' spends, which that function does not represent: fed an outward-only aggregate it returns zero locked capital. Any server-tier term built from pinned primitives is a new model.
2. **B_S as a real choice.** §3.3 charges W_S, not B_S. Uncommitted server capital is free in 𝒟, so a larger B_S only removes failures and the optimum is always the largest value allowed. For B_S to be a decision, something must charge it, presumably the server-tier term.
3. **The spend-recovery choice.** If the agent may simply declare faster recovery, it always will. The choice needs a stated cost or risk, and the pin has neither. R4 notes that Lightning spends use HTLC policies and not forfeits, which suggests what the alternative is, but not how relying on it is scored.

Under option B, I would implement the first paragraph, omit `spend_recovery` and `forecast_rule` as choices, and bring a written definition of the server-tier term for review before coding it.

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

## 7. Placeholder: derivative-position netting

`src/tasks/netting/` is reserved for netting derivative positions toward a target settlement value, the ghost-node application cited as R14 in the paper. Not specified in v0.

## 8. Protocol parameters

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

## 9. Given and invented, in one place

**Taken as given.** The pinned model files and their behavior, confirmed by running the vendored suite (13 of 13 pass). The four calibration effects and their intervals. The public-topology campaign's generator parameters, warm-up and evaluation split, eight-path catalog, three-attempt budget, 120,000 sat connector, and the failure-aware and random placement rules. Cluster-level Student-t inference and the ±1 point band. The audit's requirements: canonical order, hash-bound fixtures, no fabricated weights, rejection as identity, equivalence on both sides, and the oracle as reference and not as bound. The paper's definition of liquidity duration, its two corners, and its falsifier.

**Invented here.** The observation and action envelopes, the tool tables, and what each budget counter means. The ratio-of-sums normalized gain, its jackknife interval, and the headroom guard. Directional placements and placement on existing edges. The retry wallet as family 1's fixed router. The placement oracle's rule and its 72/28 split. Hiding the regime from the agent. One-shot as family 2's floor. All of family 3's generator beyond the two corner parameter sets, its probe tool, grids, ε, penalty, and band. The audit-flag thresholds. The named-stream PRNG.

**Named in the brief and missing from the pin.** `runCorner`, `ArkServer.aggregateSteps`, the server-tier term, the spend-recovery choice, the forecast-rule choice, and the arrival-mode distinction (§0.1).
