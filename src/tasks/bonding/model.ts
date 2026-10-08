// Family 5's cost model (docs/tasks.md §6). An operator bonds a connector service for one window
// with an optimistic escrow E(B, κ, Δ) from the pinned model (vendor/spiral/model/escrow.ts) and
// the BitVM3 sizes it publishes. The counterparty admits the bond only if B covers the window's
// value at risk and a challenger would disprove a false Assert within Δ with the required
// probability, judged under the true response distribution, which the operator does not see.
//
// Expected cost, exact over the service outcome and the challenger's response time, each branch
// driven through the Escrow state machine:
// - the service meets its threshold: Assert true, withdraw at W + Δ;
// - it falls short and a challenger responds at R < Δ: Assert false, disprove at W + R, bond lost;
// - it falls short and no challenger responds in time: Assert false, withdraw at W + Δ.
// Cost = the Assert fee + capital (bond × blocks locked × rate) + the bond if slashed.

import { BITVM3_PUBLISHED, Escrow, type EscrowParams } from "../../../vendor/spiral/model/escrow.ts";

export interface Service { window_blocks: number; requests: number; p_honored: number; threshold: number; value_at_risk_sats: number; }

export interface Terms {
  service: Service;
  fee_rate_sat_vb: number;
  capital_rate_per_block: number;
  min_delta_blocks: number;
  catch_probability: number;
}

/** P(Binomial(n, p) < k), by summing the pmf in log space. */
export function binomialBelow(n: number, p: number, k: number): number {
  if (k <= 0) return 0;
  if (k > n) return 1;
  let logC = 0; // log C(n, 0)
  let total = 0;
  for (let i = 0; i < k; i++) {
    if (i > 0) logC += Math.log((n - i + 1) / i);
    total += Math.exp(logC + i * Math.log(p) + (n - i) * Math.log1p(-p));
  }
  return Math.min(1, total);
}

/** Probability the service falls below its threshold of honored requests. */
export const failProbability = (s: Service): number => binomialBelow(s.requests, s.p_honored, Math.ceil(s.threshold * s.requests));

/** A challenger's response time R ≥ 1 is geometric with per-block probability p; a disprove lands iff R < Δ. */
export const catchProbability = (p: number, delta: number): number => 1 - (1 - p) ** (delta - 1);

export function feasible(t: Terms, bond: number, delta: number, p: number): boolean {
  return Number.isInteger(bond) && bond >= t.service.value_at_risk_sats && delta >= t.min_delta_blocks && catchProbability(p, delta) >= t.catch_probability;
}

export interface Costs { assert_fee_sats: number; capital_sats: number; slashed_sats: number; total_sats: number; }

/** Expected cost of a bond (B, Δ) when challengers respond at rate p per block. */
export function expectedCost(t: Terms, bond: number, delta: number, p: number): Costs {
  const params: EscrowParams = { delta, assertVb: BITVM3_PUBLISHED.assertVb, disproveVb: BITVM3_PUBLISHED.disproveVb, feeRate: t.fee_rate_sat_vb };
  const W = t.service.window_blocks;
  const r = t.capital_rate_per_block;
  const pFail = failProbability(t.service);
  // Honored: Assert true, withdraw after Δ.
  const ok = new Escrow(bond, params, 0);
  ok.assert(W, true);
  if (!ok.withdraw(W + delta)) throw new Error("withdraw refused after Δ");
  const assertFee = ok.costs.operatorFees;
  const okCapital = ok.costs.capitalBlocks * r;
  // Failed and uncaught: Assert false, nobody disproves, withdraw after Δ.
  const missed = new Escrow(bond, params, 0);
  missed.assert(W, false);
  if (!missed.withdraw(W + delta)) throw new Error("withdraw refused after Δ");
  const missedCapital = missed.costs.capitalBlocks * r;
  // Failed and caught at R = 1 … Δ − 1: Assert false, disprove at W + R, the bond is lost.
  let caughtCapital = 0;
  let pCaught = 0;
  for (let R = 1; R < delta; R++) {
    const w = (1 - p) ** (R - 1) * p;
    const e = new Escrow(bond, params, 0);
    e.assert(W, false);
    if (!e.disprove(W + R) || e.state !== "slashed") throw new Error("a disprove within Δ of a false Assert must slash");
    caughtCapital += w * e.costs.capitalBlocks * r;
    pCaught += w;
  }
  const capital = (1 - pFail) * okCapital + pFail * (caughtCapital + (1 - pCaught) * missedCapital);
  const slashed = pFail * pCaught * bond;
  return { assert_fee_sats: assertFee, capital_sats: capital, slashed_sats: slashed, total_sats: assertFee + capital + slashed };
}
