// Family 5 baselines. All but the oracle read only the observation, which shows a sample of past
// challenger response times and not the rate behind them.

import type { Agent, EpisodeInfo } from "../../harness/agent.ts";
import { isObject, type Json } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";
import type { BondingView } from "./env.ts";
import { catchProbability, expectedCost, feasible, type Terms } from "./model.ts";

const viewOf = (o: Json): BondingView => (o as unknown as { view: BondingView }).view;
const offer = (bond: number, delta: number): Json => ({ tool: "bond", args: { bond_sats: bond, delta_blocks: delta } });
const termsOf = (v: BondingView): Terms => ({ service: v.service, fee_rate_sat_vb: v.fee_rate_sat_vb, capital_rate_per_block: v.capital_rate_per_block, min_delta_blocks: v.challenge.min_delta_blocks, catch_probability: v.challenge.catch_probability });

/** The smallest grid bond covering the value at risk. */
const coveringBond = (v: BondingView): number => v.grid.bonds.filter((b) => b >= v.service.value_at_risk_sats).sort((a, b) => a - b)[0] ?? Math.max(...v.grid.bonds);

/** The shortest grid period that meets the catch probability at rate p (the longest if none does). */
function periodFor(v: BondingView, p: number): number {
  const ok = v.grid.deltas.filter((d) => d >= v.challenge.min_delta_blocks && catchProbability(p, d) >= v.challenge.catch_probability).sort((a, b) => a - b);
  return ok[0] ?? Math.max(...v.grid.deltas);
}

/** The maximum-likelihood rate of a geometric sample on {1, 2, …}: n / Σ R. */
export const rateEstimate = (sample: readonly number[]): number => sample.length / sample.reduce((a, b) => a + b, 0);

/** Floor: a uniformly random grid point. */
export class RandomBond implements Agent {
  readonly id = "random";
  private rng: Stream = stream("bonding/random", 0);
  reset(e: EpisodeInfo): void { this.rng = stream("bonding/random", e.seed, e.task); }
  act(o: Json): Json {
    const v = viewOf(o);
    return offer(this.rng.pick(v.grid.bonds), this.rng.pick(v.grid.deltas.filter((d) => d >= v.challenge.min_delta_blocks)));
  }
}

/** Descriptive: Spiral's GhostPlan.required_bond, amount × (0.10 + risk rate × horizon), with Δ = 144. */
export class GhostRequiredBond implements Agent {
  readonly id = "ghost_required_bond";
  act(o: Json): Json {
    const v = viewOf(o);
    // The risk rate times the horizon is the expected share of requests not honored.
    const required = Math.ceil(v.service.value_at_risk_sats * (0.10 + (1 - v.service.p_honored)));
    const bond = v.grid.bonds.filter((b) => b >= required).sort((a, b) => a - b)[0] ?? Math.max(...v.grid.bonds);
    const delta = v.grid.deltas.filter((d) => d >= 144).sort((a, b) => a - b)[0] ?? Math.max(...v.grid.deltas);
    return offer(bond, delta);
  }
}

/** Reference: cover the value at risk; set Δ from the sample's maximum-likelihood rate. */
export class PlugIn implements Agent {
  readonly id = "plug_in";
  act(o: Json): Json {
    const v = viewOf(o);
    return offer(coveringBond(v), periodFor(v, rateEstimate(v.challenge.observed_response_blocks)));
  }
}

/** Descriptive: as `plug_in`, with the estimated rate halved as a margin against a small sample. */
export class HalfRate implements Agent {
  readonly id = "half_rate";
  act(o: Json): Json {
    const v = viewOf(o);
    return offer(coveringBond(v), periodFor(v, rateEstimate(v.challenge.observed_response_blocks) / 2));
  }
}

/** Ceiling: knows the true rate and offers the grid's cheapest admissible bond. */
export class OracleBond implements Agent {
  readonly id = "oracle";
  readonly privileged = true;
  private p = 0;
  reset(_e: EpisodeInfo, privileged?: Json): void {
    if (!isObject(privileged) || typeof privileged.true_response_p !== "number") throw new Error("oracle was not given privileged information");
    this.p = privileged.true_response_p;
  }
  act(o: Json): Json {
    const v = viewOf(o);
    const t = termsOf(v);
    let best = { bond: 0, delta: 0, cost: Number.POSITIVE_INFINITY };
    for (const bond of v.grid.bonds) for (const delta of v.grid.deltas) {
      if (!feasible(t, bond, delta, this.p)) continue;
      const c = expectedCost(t, bond, delta, this.p).total_sats;
      if (c < best.cost) best = { bond, delta, cost: c };
    }
    return offer(best.bond, best.delta);
  }
}

export const bondingBaselines = (): Agent[] => [new RandomBond(), new GhostRequiredBond(), new PlugIn(), new HalfRate(), new OracleBond()];
