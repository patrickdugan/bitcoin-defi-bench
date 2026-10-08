// Family 5: service bonding (docs/tasks.md §6). One decision: a bond B and a challenge period Δ from
// the grid. A well-formed bond is accepted and ends the episode; whether the counterparty admits it
// is judged at scoring, under the challengers' true response rate, as its audit after funding would.
// An inadmissible bond scores as the penalty, as does an episode that offers nothing.

import { BITVM3_PUBLISHED } from "../../../vendor/spiral/model/escrow.ts";
import { accept, reject, type Budget, type Environment, type Outcome, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, type Json } from "../../harness/json.ts";
import type { BondingConfig, BondingFixture } from "./generate.ts";
import { expectedCost, feasible, type Terms } from "./model.ts";

export const valueOf = (cost: number): number => 0 - Math.log(Math.max(cost, 1));

export const termsOf = (f: BondingFixture): Terms => ({ service: f.service, fee_rate_sat_vb: f.fee_rate_sat_vb, capital_rate_per_block: f.capital_rate_per_block, min_delta_blocks: f.challenge.min_delta_blocks, catch_probability: f.challenge.catch_probability });

/** The grid's least expected cost among admissible bonds under the true rate, and the penalty for anything else. */
export function gridOptimum(f: BondingFixture, penaltyFactor: number): { bond: number; delta: number; cost: number; penalty: number } {
  const t = termsOf(f);
  let best = { bond: 0, delta: 0, cost: Number.POSITIVE_INFINITY };
  let worst = 0;
  for (const bond of f.grid.bonds) for (const delta of f.grid.deltas) {
    if (!feasible(t, bond, delta, f.true_response_p)) continue;
    const c = expectedCost(t, bond, delta, f.true_response_p).total_sats;
    worst = Math.max(worst, c);
    if (c < best.cost) best = { bond, delta, cost: c };
  }
  if (!Number.isFinite(best.cost)) throw new Error(`${f.cell} seed ${f.seed}: no admissible bond on the grid`);
  return { ...best, penalty: penaltyFactor * worst };
}

export interface BondingView {
  service: BondingFixture["service"];
  fee_rate_sat_vb: number;
  capital_rate_per_block: number;
  bitvm3: { assert_vb: number; disprove_vb: number };
  challenge: BondingFixture["challenge"];
  grid: BondingFixture["grid"];
}

export class BondingEnv implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell = "single";
  private readonly fixture: BondingFixture;
  private readonly config: BondingConfig;
  private attempts: number;
  private closed = false;
  private bond: { bond: number; delta: number } | null = null;

  constructor(fixture: BondingFixture, config: BondingConfig) {
    this.task = `bonding/${fixture.cell}`;
    this.seed = fixture.seed;
    this.fixture = fixture;
    this.config = config;
    this.attempts = config.budget.attempts;
  }

  budget(): Budget { return { attempts: this.attempts, probes: 0, blocks: 0, sats: 0 }; }

  tools(): string[] { return ["bond", "commit"]; }

  view(): Json {
    const f = this.fixture;
    const v: BondingView = {
      service: { ...f.service },
      fee_rate_sat_vb: f.fee_rate_sat_vb,
      capital_rate_per_block: f.capital_rate_per_block,
      bitvm3: { assert_vb: BITVM3_PUBLISHED.assertVb, disprove_vb: BITVM3_PUBLISHED.disproveVb },
      challenge: { ...f.challenge, observed_response_blocks: [...f.challenge.observed_response_blocks] },
      grid: { bonds: [...f.grid.bonds], deltas: [...f.grid.deltas] },
    };
    return v as unknown as Json;
  }

  done(): boolean { return this.closed; }

  private spend(): void { this.attempts -= 1; if (this.attempts <= 0) this.closed = true; }

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (isObject(action) && action.tool === "commit") { this.closed = true; return accept(); }
    if (!isObject(action) || typeof action.tool !== "string") { this.spend(); return reject("malformed"); }
    if (action.tool !== "bond") { this.spend(); return reject("unknown_tool"); }
    const a = isObject(action.args) ? action.args : {};
    const bond = a.bond_sats;
    const delta = a.delta_blocks;
    if (typeof bond !== "number" || typeof delta !== "number") { this.spend(); return reject("malformed", { detail: "bond needs bond_sats and delta_blocks" }); }
    // The Escrow constructor's own guard: a positive whole bond.
    if (!Number.isInteger(bond) || !Number.isInteger(delta)) { this.spend(); return reject("not_integer"); }
    if (bond <= 0 || delta < this.fixture.challenge.min_delta_blocks) { this.spend(); return reject("below_minimum", { detail: `bond must be positive and Δ at least ${this.fixture.challenge.min_delta_blocks}` }); }
    if (!this.fixture.grid.bonds.includes(bond) || !this.fixture.grid.deltas.includes(delta)) { this.spend(); return reject("out_of_grid", { detail: "bond_sats and delta_blocks must be on the grid" }); }
    this.bond = { bond, delta };
    this.closed = true;
    return accept();
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    const opt = gridOptimum(this.fixture, this.config.infeasible_penalty_factor);
    const t = termsOf(this.fixture);
    const admitted = this.bond !== null && feasible(t, this.bond.bond, this.bond.delta, this.fixture.true_response_p);
    const c = admitted ? expectedCost(t, this.bond!.bond, this.bond!.delta, this.fixture.true_response_p) : null;
    const cost = c ? c.total_sats : opt.penalty;
    return {
      value: valueOf(cost),
      metrics: {
        cost_sats: cost,
        admitted: admitted ? 1 : 0,
        bond_over_value: this.bond ? this.bond.bond / this.fixture.service.value_at_risk_sats : 0,
        delta_blocks: this.bond ? this.bond.delta : 0,
        capital_sats: c ? c.capital_sats : 0,
        assert_fee_sats: c ? c.assert_fee_sats : 0,
        slashed_sats: c ? c.slashed_sats : 0,
      },
    };
  }

  snapshot(): string { return canonical({ bond: this.bond }); }

  privileged(): Json { return { true_response_p: this.fixture.true_response_p }; }
}
