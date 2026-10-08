# Draft amendments: families 2, 5, and 7

Status: **drafts, not frozen.** Each section is meant to be appended to `prereg/v0.md` under §11 as the next amendment, unchanged except for its number and date, once it has been reviewed. Until then the harness refuses confirmatory seeds for these families, because no "Frozen families:" line names them. The drafts live outside `prereg/v0.md` because amendments there are never edited after they are written. What each one fixes was set before any confirmatory fixture of its family was evaluated.

---

### Amendment N, 2026-10-__: family 2 (routing under hidden state) is frozen

Frozen families: routing

**Reason.** Family 2 is the bench's calibration family: it exists to check that the harness reproduces the routing effects Spiral measured. It was built on 2026-10-08 as tasks §3 specifies, on family 1's fixtures and parameters (`config/placement.json`), and every protocol figure it uses is family 1's.

**Design.**

| Item | Value |
|---|---|
| Seeds | confirmatory 1000 through 1031; development 0 through 7 |
| Tasks | `routing/<balance_model>/<regime>`: balanced_band, uniform, polarized × diffuse, stationary, shift |
| Episodes | one per seed per task; 220 demands, the last 110 scored |
| Policies | `one_shot` (floor), `retry_wallet` (reference), `prefix_oracle_3` (control), `hidden_state_oracle` (ceiling) |
| Native value | success rate over the 110 evaluation demands, in points |
| Band | ±1.0 point (§5) |

**Gates**, family-level, written before any family 2 run and unchanged since.

| Gate | Passes when |
|---|---|
| K21 | `retry_wallet` − `one_shot`, pooled over the nine tasks per seed: point estimate in [2.0, 8.0] and unadjusted interval above zero (Spiral: +5.14, 3.08 to 7.20) |
| K22 | `hidden_state_oracle` − `retry_wallet`, pooled: unadjusted interval above zero |
| K23 | `retry_wallet` through `act` and `prefix_oracle_3` deliver, demand by demand, what family 1's router delivers run directly on the fixture, on every episode |

**Hypotheses.** None beyond the gates for the baseline run: the family's claims about baselines are calibration claims, and they are the gates. Per-task contrasts are secondary and descriptive.

**Agent runs.** As §9 already declares: one primary contrast per task, agent − `retry_wallet`, Bonferroni-adjusted over the nine tasks, with the expectation that a good agent is practically equivalent to the retry wallet. A result outside ±1.0 point in either direction is flagged `outside_calibration` and audited before it is reported. Agents run with the adapter's context window at the current turn (tasks §3.3).

**What was seen before this amendment was written.** The development table on seeds 0 through 7: K21 +4.08 (+0.41 to +7.74), passing; K22 +0.72 (−0.05 to +1.49), failing at eight seeds; K23 passing on all 72 episodes. The gates were not changed after the development table. The confirmatory fixtures had been generated and hash-bound; none had been routed. To check that the diffuse stream was regenerated as designed, the stationary and diffuse streams of seed 1000 were compared step by step, which reads demands but routes none.

**Still not offered:** Spiral's terminal-feedback learner as a baseline.

---

### Amendment N, 2026-10-__: family 5 (service bonding) is frozen

Frozen families: bonding

**Reason.** Family 5 was built on 2026-10-08 as tasks §6 specifies, with the revision tasks §6.1 records: the challengers' response rate is unknown, and the operator sees eight past response times. Its escrow is the pinned model's, at the BitVM3 sizes, and every other number is invented and frozen as it stands in `config/bonding.json`.

**Design.**

| Item | Value |
|---|---|
| Seeds | confirmatory 1000 through 1031; development 0 through 7 |
| Cells | `fast`, `slow`, `strict` |
| Episodes | one per seed per cell |
| Policies | `random` (floor), `plug_in` (reference), `half_rate` and `ghost_required_bond` (descriptive), `oracle` (ceiling) |
| Native value | −ln of the bond's expected cost in sats; a bond the counterparty would not admit, or none, at twice the worst admissible grid cost |
| Band | ±0.05 in ln cost |

**Gates**, family-level: K51, `oracle` ≥ every other policy on every episode; K52, the oracle through `act` equals the grid optimum computed directly from the fixture by driving the pinned `Escrow`.

**Hypotheses.** Within-cell contrasts in −ln cost.

- **B1, B2, B3.** `oracle` − `plug_in` is positive on `fast`, `slow`, and `strict`: not knowing the response rate costs a maximum-likelihood plug-in.
- **B4, B5, B6.** `plug_in` − `random` is positive on `fast`, `slow`, and `strict`.

**Multiplicity.** B1 through B6, Bonferroni-adjusted for six comparisons (critical value 2.818 on 31 degrees of freedom).

**Secondary, declared and descriptive.** `half_rate` − `plug_in` in each cell; the admission rate of every policy; `ghost_required_bond`'s, which development showed to be zero.

**Agent runs.** One primary contrast per cell, agent − `plug_in`, adjusted over the three cells (critical value 2.531). No directional prediction for any model.

**What was seen before this amendment was written.** The development table on seeds 0 through 7, unadjusted: `oracle` − `plug_in` +0.34 (−0.19 to +0.87), +0.50 (−0.07 to +1.06), +0.41 (−0.21 to +1.03); `plug_in` − `random` +0.22 (−0.22 to +0.66), +0.73 (−0.03 to +1.49), +0.36 (−0.58 to +1.29); `half_rate` − `plug_in` +0.33, +0.42, +0.38; K51 and K52 passing. Every development interval crossed zero, because admission is all or nothing per seed. B4, on `fast`, is the hypothesis most at risk: random offers are admitted more often there than in the other cells.

---

### Amendment N, 2026-10-__: family 7 (proving claims within a budget) is frozen

Frozen families: proof_budget

**Reason.** Family 7 was built on 2026-10-08 as tasks §8 specifies, with the action narrowed to proving the oldest pending claims (§8.6), which makes the ceiling exact. Its only protocol-like input is the prover's cost, measured: the adopted table `cairo/rcap/measurements/adopted-20261008.json`, named with its SHA-256 in `config/proof_budget.json` and copied into every fixture. Every other number is invented and frozen as it stands in that config.

**Design.**

| Item | Value |
|---|---|
| Seeds | confirmatory 1000 through 1031; development 0 through 7 |
| Cells | `steady`, `bursty`, `few_proofs` |
| Episodes | one per seed per cell; 144 blocks |
| Policies | `every_arrival` (floor), `fixed_interval` (reference), `threshold` and `random_interval` (descriptive), `optimal_batching` (ceiling, clairvoyant) |
| Native value | −ln of the horizon's cost in sats: prover price, staleness, forfeiture |
| Band | ±0.05 in ln cost |

**Gates**, family-level: K71, `optimal_batching` ≥ every other policy on every episode; K72, the ceiling through `act` equals its schedule's cost computed directly from the fixture; K73, `fixed_interval` proves every claim on every episode.

**Hypotheses.** Within-cell contrasts in −ln cost.

- **P1, P2, P3.** `optimal_batching` − `fixed_interval` is positive on `steady`, `bursty`, and `few_proofs`: knowing arrivals pays over the economic-order interval.
- **P4.** `threshold` − `fixed_interval` is positive on `bursty`: an adaptive rule pays when the rate moves.
- **P5.** `threshold` − `fixed_interval` is negative on `few_proofs`: a rule blind to the proof budget forfeits when proofs are scarce.

**Multiplicity.** P1 through P5, Bonferroni-adjusted for five comparisons.

**Secondary, declared and descriptive.** Every normalized gain; `fixed_interval` − `every_arrival` in each cell; `threshold` − `fixed_interval` on `steady`; proofs, mean batch, forfeits.

**Agent runs.** One primary contrast per cell, agent − `fixed_interval`, adjusted over the three cells; agents run with the adapter's context window at the current turn (tasks §8.6). No directional prediction for any model.

**What was seen before this amendment was written.** The development table on seeds 0 through 7, unadjusted: P1 +0.17 (+0.15 to +0.19), P2 +0.38 (+0.34 to +0.41), P3 +0.18 (+0.14 to +0.21), P4 +0.18 (+0.13 to +0.24), P5 −6.75 (−6.84 to −6.66); K71 to K73 passing. P4 and P5 were written after that table. The cells and their numbers were set before any development run, on a scratch run of four synthetic seeds, and were not changed. The confirmatory fixtures had been generated and hash-bound; none had been evaluated.
