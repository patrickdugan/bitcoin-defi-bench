# Expansion v1: TradeLayer economics and proof-dependent operations

Date: 2026-10-28. Status: proposed roadmap with two unit-tested synthetic contracts.
Benchmark base: `829cec81ff6cbde990444c419668160077c0e493`.

This addition leaves F1-F10, their fixtures, scoring and preregistration unchanged.
The code in `src/expansion/tradelayer_zk.ts` is an isolated development aid.
It has no agent runner, external verifier, production adapter or new scored row.
Every returned result carries `economic_authorization: false`.

## Source map and evidence boundaries

Sources were inspected through GitHub on the date above. Pins describe the
inspected snapshots; later upstream work needs a new review before import.

| Source | Inspected revision and paths | Supported use in this expansion |
|---|---|---|
| TradeLayer-Rust | `41007c5dd423d6fffca32a849404ac52c0caf72c`; `README.md`, `docs/INSURED_DISTRESSED_CLOSEOUT.md`, `src/clearing_distress_impl.rs` lines 1-135 | Independent networks, offline joint replay and a synthetic full-book insured-closeout rule. The Rust module recomputes mark/risk and charges existing margin plus one real ledger reserve. |
| zkTL | `edff311d7bfc71cd8b33bf6e2cf2bb2f282bec2d`; `README.md` (blob `e887f4edf89ce0d31a525afdb4cf3c8954e9d8ae`) | JS transition kernels, strict versus audit replay, batch checkpoints and a stated Cairo batch-binding boundary. Per-transition Cairo economic execution remains an integration requirement. |
| rust-bitcoin-zk-adapter | `fe74b8dc1cc8dcb935a1ba40363a416198476085`; `README.md` | Protocol-neutral extraction, supplied-header transaction inclusion and external pinned Raito verification. Reading this README establishes interfaces and limits, without establishing a successful live proof run. |
| UTXO-Ref | `3d053c02b430b83a6dfe63ab77ec70afe311de88`; `integrations/cashu-bitvm/DESIGN.md` | PaymentClaimV1, explicitly unverified G0 receipts and the existing G0-G5 acceptance gates. Those gates retain their ownership. |
| Raito-Scrypt / Lighto-MWEB workstream | Private upstream; private source, artifacts and revision details are excluded from this public change | Candidate scheduling and composition tasks below. A publishable provenance bundle is required before external evidence can enter public fixtures. |

Source links:

- https://github.com/patrickdugan/TradeLayer-Rust/blob/41007c5dd423d6fffca32a849404ac52c0caf72c/docs/INSURED_DISTRESSED_CLOSEOUT.md
- https://github.com/patrickdugan/TradeLayer-Rust/blob/41007c5dd423d6fffca32a849404ac52c0caf72c/src/clearing_distress_impl.rs
- https://github.com/patrickdugan/zkTL/blob/edff311d7bfc71cd8b33bf6e2cf2bb2f282bec2d/README.md
- https://github.com/patrickdugan/rust-bitcoin-zk-adapter/blob/fe74b8dc1cc8dcb935a1ba40363a416198476085/README.md
- https://github.com/patrickdugan/UTXO-Ref/blob/3d053c02b430b83a6dfe63ab77ec70afe311de88/integrations/cashu-bitvm/DESIGN.md

TradeLayer remains an application-state engine and, where appropriate, a
state-oracle input. Its independent Bitcoin, Litecoin and Dogecoin instances
need distinct genesis/asset domains. An asset ID has meaning only inside its
own domain. The existing Mercury-style statechain column stays separate.
Raito and the sidecar retain protocol-neutral interfaces.

## Extend existing families

| Family | Proposed depth | Prerequisite and discriminating baseline |
|---|---|---|
| F1 placement | Rolling demand, paid rebalancing and channel closure under a shared balance | Specify realized fees and capital-time; compare failure-aware and static allocations under matched information. |
| F2 hidden-state routing | Implement bounded retries, then delayed feedback and liquidity drift | Preserve the specified three-attempt control and identity tests; show headroom beyond the retry wallet before adding complexity. |
| F3 settlement objects | Ecash/statechain columns on identical demands, then combined holder/operator balances | Source each fee/lifetime and fix finite-capital failure reporting; retain custody and exit attributes. |
| F4 server sizing | Ark and mint gateway capacity with withdrawals and delayed funding | The pinned model must report unmet demand and starved refreshes. Compare peak-envelope and budgeted adaptive policies. |
| F5 bonding | Defensive dispute scheduling against deadline and fee congestion | Pin the enforceable or simulated challenge model. Compare fixed bond/window with budget-aware defense; expose challenger availability. |
| F6 netting | `tradelayer/clearing`, `insurance_depletion`, `checkpoint_replay` | Bind one asset/domain, checked atom arithmetic, eligible positions and current collateral. Preserve exact min-cost flow for its original assumptions. Fixed-charge or whole-coin cells require a separate solver bound. |
| F7 proof budget | Jobs with dependency graphs, proof scope, RAM caps, verifier time, expiry and reorg cancellation | Use pinned measured cost fixtures; compare FIFO, deadline-first and exact small-instance scheduling. Prover throughput remains a measurement input. |
| F8 funding | Fee uncertainty, replacement policy and maturity deadlines | Source transaction size/relay rules; compare immediate funding with threshold and finite-horizon dynamic-programming policies. |
| F9 coordination | Run frozen cells with named agents, then versioned authorization and payout intents | Preserve frozen observations. New tests bind recipient, rail, network/asset, amount/units, quote expiry, fees and idempotency. Unknown provider inventory stays unavailable. |
| F10 DLC design | Maturity/refund ordering, stale oracle state, hedging and collateral stress | Keep the exact design optimizer as its own baseline. Describe the evidence connecting an oracle outcome to the CET; test wrong outcome and missing-attestation recovery. |

Each change gets a new task version and a new preregistration before
confirmatory seeds are used. Existing rows remain reproducible at the base pin.

## Additional financial categories

Numbers F11-F21 from the initial discussion are provisional planning labels.
Promotion requires a distinct decision problem and measurable headroom.
Several categories can begin as cells of F6 or F10.

| Candidate | Concrete TradeLayer or adjacent problem | Native measurements and comparison |
|---|---|---|
| F11 collateralized lending | Choose collateral, repayment and refinancing under explicit loan terms | Borrowing cost, unmet funding and collateral-time; fixed leverage versus constrained optimization. Lending needs a sourced contract model. |
| F12 margin and liquidation | Fund margin; choose eligible closeouts; preserve shared insurance across shocks | Unpaid obligations, reserve draw and realized recovery; hold, naive gross claims and policy-aware closeout. The included kernel covers only a synthetic full-book rule. |
| F13 spot/AMM execution | Allocate orders between executable venues; manage reserves and price limits | Slippage, fill share and inventory PnL; fixed split versus an exact bounded route optimizer. Audit the current Rust AMM slice before importing it. |
| F14 derivatives/hedging | Hedge TradeLayer contract exposure with a DLC, including expiry and basis | Terminal cash-flow shortfall, collateral-time and cost; unhedged, static hedge and constrained optimizer. |
| F15 cross-rail fulfillment | Handle to quote to authenticated evidence to recipient payout | Net recipient amount, failed deadlines and duplicate payouts; cheapest advertised quote versus executable net-payout ranking. |
| F16 treasury | Schedule shared capital across payment obligations and hedges | Liquidity shortfall and net cash flow; static reserve versus rolling constrained allocation. |
| F17 oracle/proof consumption | Select sufficient evidence, refresh stale anchors, challenge unsupported claims | Unsupported acceptance, valid completion and verification cost; accept-all, hold-all and scope-aware policy. |
| F18 stable-value liabilities | Manage synthetic liabilities, collateral and redemption under stress | Redemption shortfall, peg deviation and reserve use; fixed collateral ratio versus explicit stress policy. Model parity is a prerequisite. |
| F19 insurance | Allocate a finite reserve across correlated eligible losses | Uncovered obligations and reserve depletion; first-come versus budgeted allocation. Current full-book rules require full funding. |
| F20 recovery/unwind | Restore checkpoints, roll back rejected history and close positions before deadlines | Recoverable collateral, duplicate credits and recovery time; snapshot-only versus journal/replay-aware policy. |
| F21 composition | Settle a merchant obligation using TradeLayer liquidity, a hedge and proof-qualified payout | End-to-end valid completion with a component-level cost profile. Begin after constituent tasks pass independently. |

Every liquidation/AMM/insurance task needs a pinned policy version. Historical
JavaScript behavior is useful differential evidence; proposed Rust economic
rules need their own declared semantics. Unsupported types remain explicitly
unavailable in simulated adapter capability tables.

## ZK-specific depth

The useful unit is a proven statement with a declared consumer policy.
Keep scope as a set of capabilities. A batch-binding proof establishes the
bound batch fields. A consumer that needs economic execution must separately
obtain the required transition relation. A supplied-header Merkle path also
needs an authenticated chain context and a declared canonical-chain policy.

| Proposed cell | Agent decision | Required evidence before measured scoring |
|---|---|---|
| `zk/scope_selection` | Choose the cheapest sufficient proof bundle | Fixed statement schemas and required capability sets; independent pass/fail vectors for scope substitution. |
| `zk/batch_schedule` | Batch and schedule claims under RAM/time budgets | Per-backend hardware/toolchain pins; producer and verifier measurements kept separate; failed and OOM runs retained. |
| `zk/composition` | Join chain, inclusion, state and payment evidence | Exact public-input agreement, common network/anchor and program/key pinning; cross-proof splice failures. |
| `zk/reorg_recovery` | Cancel or rebuild evidence after the accepted anchor changes | An explicit chain-selection source, invalidation propagation and immutable prior receipts. |
| `zk/dispute_budget` | Reserve time/capital for defense or exit | A pinned optimistic-dispute simulator, deadlines and honest-challenger assumption. Bitcoin enforcement is a separate acceptance gate. |
| `zk/scrypt_header` | Schedule an isolated Scrypt proof and its dependent chain tasks | Publishable verifier evidence for each relation; separate isolated-header, chained-history and current-chain claims. |
| `zk/mweb_boundary` | Select evidence for roots, supply and peg transitions | A pinned relation and independent real vectors. Structural consistency and cryptographic verification have separate evidence labels. |
| `zk/payment_claim` | Validate the evidence required before a simulated payout | Follow UTXO-Ref G0-G5; exact statement/recipient/amount binding, expiry and atomic replay consumption. |

Proof benchmarking records wall time, peak host RSS, cgroup memory peak where
available, proof bytes, verification time, hardware and source/compiler pins.
Missing measurements stay missing. Resource targets carry `target` status.
A local hash, parsed receipt or passing mock verifier supplies no measured
cryptographic-verification result. Proof capabilities also say nothing about
witness privacy unless the precise backend configuration establishes it.

## Included development contracts

`src/expansion/tradelayer_zk.ts` exports two pure functions.

`closeout(state, book)` previews a synthetic whole-book closeout. The caller
commits the returned reserve state explicitly. It uses canonical decimal
strings and BigInt with checked bounds, verifies zero-sum PnL and a maintenance
breach, consumes losing margin before insurance and checks conservation.
Failed previews retain the original state. The fixtures include a second
closeout that becomes unfundable after the first consumes the shared reserve.

This function is independently written against the inspected rule. It has no
Rust FFI or differential execution. Its supplied PnL/maintenance values bypass
Rust's mark calculation. It omits transfer-leg construction, persistent margin
ownership, crash/reorg recovery and authenticated input. Signed PnL uses a
symmetric +/-U128 bound; aggregate capital also has a conservative U128 bound.
The global epoch is strictly increasing per accepted book. Those choices are
bench scaffolding, and require reconciliation before claiming Rust parity.

`proofEligibility(fixture)` checks synthetic stipulations about verification
status, scope and all binding fields. Separate gates cover canonical-chain
status, confirmation count, expiry and consumed claim IDs. The fixture owns
these facts; untrusted receipts must never supply their own trusted scopes or
verification status in a future adapter. Identifiers are synthetic labels;
this function performs no cryptography or canonical PaymentClaimV1 encoding.
The function is read-only; atomic consumption belongs to the future executor.

Neither function is registered as a scored family. No LLM was run. The
fixture suite uses development seeds 0-7 only and returns no normalized gain.

Run the isolated suite with the repository's Node 22.6+ environment:

```sh
node --experimental-strip-types --test src/expansion/tradelayer_zk.test.ts
```

The existing `npm test` glob includes the new test file. A full existing-suite
run still requires the pinned vendor checkouts described in the main README.

## Evaluation and promotion

Stage A, delivered here: reviewed source pointers, category/depth plan and
unit-tested accounting/evidence contracts. Stage B exports real Rust reference
vectors and joins these contracts to the existing `Agent.act` runner without
changing frozen families. Stage C adds genuinely measured verifier/prover
fixtures through opt-in adapters. Later stages freeze task versions and run
new confirmatory seed blocks.

For each economic task, publish native performance and conservation diagnostics.
An unsupported payout or broken conservation blocks a success claim for that
cell. A hold-all baseline remains necessary; valid completion and opportunity
cost prevent it from winning solely through inactivity. Distinguish an
information-matched executable baseline from a privileged reference policy.
Only an exact solver or proven bound supports an optimum claim.

Agent identity binds model, prompt, tool versions, costs and caps. Compare the
bare agent with a tool-equipped agent and its deterministic solver. Tool CPU,
latency and memory become explicit budgets in new resource-aware cells; leave
existing free-skill assumptions intact for replication. Numerical environment
failures and malformed actions retain their declared costs.

The first composed fixture should be wholly synthetic: a recipient commitment,
versioned payout intent, verified-within-simulation inventory, TradeLayer
execution, optional hedge and scope-qualified evidence. One shared budget and
an atomic spent-claim store govern the full workflow. Unknown inventory cannot
be counted as executable liquidity. Existing VPS/prover work and all upstream
branches remain outside this change.
