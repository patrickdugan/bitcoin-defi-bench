// The chain, the claim graphs, and the watcher's machine for family 12 (docs/tasks.md §15).
// Deterministic: every block's clearing fee rate is in the fixture, and a transaction bidding at
// least that rate confirms in that block. The watcher acts only through the host (env.ts); this
// file applies what it broadcasts and plays the claimants.
//
// The rules, in the order they apply within block t:
//   1. a reorganization at t replaces blocks from_height..t-1 by blocks without the bench's
//      transactions: a claim confirmed in them confirms again at t, and a disprove or payout
//      confirmed in them goes back to the mempool;
//   2. a claim first confirms at its first height and becomes visible with its input labels;
//   3. a claim output confirmed at c and still unspent is paid to P' at t >= c + window: the
//      claimant broadcasts the presigned payout as soon as it is final and sees it through;
//   4. a pending disprove confirms if it was broadcast before t, its claim is confirmed at or
//      before t, t <= c + window - 1, and it bids at least t's clearing rate;
//   5. an evaluation started at s ends at s + eval_blocks with the verdict: the accept label for an
//      honest claim, the reject label for either fraud class.

import type { Bitvm3Fixture } from "./generate.ts";

export interface Disprove { fee_rate: number; height: number; confirmed: number | null; }

export interface ClaimState {
  visible: boolean;
  /** The block the claim is confirmed in on the current chain. */
  confirmed: number | null;
  reorged: boolean;
  check: "pass" | "fail" | null;
  evaluation: "running" | "accept" | "reject" | null;
  disprove: Disprove | null;
  broadcasts: number;
  paidOut: number | null;
}

export interface Bitvm3State {
  height: number;
  claims: ClaimState[];
  evaluator: { claim: number | null; until: number | null };
  evaluations: number;
  checks: number;
}

export const initialState = (f: Bitvm3Fixture): Bitvm3State => ({
  height: f.start_height,
  claims: f.claims.map(() => ({ visible: false, confirmed: null, reorged: false, check: null, evaluation: null, disprove: null, broadcasts: 0, paidOut: null })),
  evaluator: { claim: null, until: null },
  evaluations: 0,
  checks: 0,
});

export const feeAt = (f: Pick<Bitvm3Fixture, "start_height" | "fees">, height: number): number => {
  const i = height - f.start_height;
  if (i < 0 || i >= f.fees.length) throw new Error(`no fee rate for height ${height}`);
  return f.fees[i]!;
};

export const isFraud = (f: Bitvm3Fixture, i: number): boolean => f.claims[i]!.class !== "honest";

/** The claim output has been spent, by the payout or by a confirmed disprove. */
export const settled = (c: ClaimState): boolean => c.paidOut !== null || (c.disprove !== null && c.disprove.confirmed !== null);

/** Advance one block, applying the rules in the header's order. */
export function advanceBlock(f: Bitvm3Fixture, s: Bitvm3State): void {
  const t = s.height + 1;
  const fee = feeAt(f, t);
  const W = f.window_blocks;
  // 1. Reorganization.
  for (const r of f.reorgs) {
    if (r.height !== t) continue;
    const removed = (h: number | null): boolean => h !== null && h >= r.from_height && h < t;
    for (const c of s.claims) {
      if (removed(c.confirmed)) { c.confirmed = t; c.reorged = true; }
      if (c.disprove && removed(c.disprove.confirmed)) c.disprove.confirmed = null;
      if (removed(c.paidOut)) c.paidOut = null;
    }
  }
  // 2. New claims.
  f.claims.forEach((claim, i) => {
    if (claim.first_height === t) { s.claims[i]!.visible = true; s.claims[i]!.confirmed = t; }
  });
  // 3. Payouts.
  for (const c of s.claims) {
    if (c.confirmed !== null && !settled(c) && t >= c.confirmed + W) c.paidOut = t;
  }
  // 4. Disproves.
  for (const c of s.claims) {
    const d = c.disprove;
    if (d && d.confirmed === null && c.paidOut === null && c.confirmed !== null
        && t > d.height && t >= c.confirmed && t <= c.confirmed + W - 1 && d.fee_rate >= fee) d.confirmed = t;
  }
  // 5. The evaluator.
  if (s.evaluator.until === t) {
    const i = s.evaluator.claim!;
    s.claims[i]!.evaluation = isFraud(f, i) ? "reject" : "accept";
    s.evaluator = { claim: null, until: null };
  }
  s.height = t;
}

export interface Bitvm3Outcome {
  value: number;
  fraud: number;
  disproved: number;
  fraudPaid: number;
  lostSats: number;
  feesSats: number;
  evaluations: number;
  honestEvaluations: number;
}

/**
 * The sats the watcher returns to the vault: each disproved claim's output less the disprove's fee,
 * less the cost of every evaluation it started. Letting every claim pay out scores 0.
 */
export function outcomeOf(f: Bitvm3Fixture, s: Bitvm3State, evaluated: readonly number[]): Bitvm3Outcome {
  let value = 0 - f.eval_cost_sats * s.evaluations;
  let disproved = 0, fraudPaid = 0, lostSats = 0, feesSats = 0, fraud = 0;
  f.claims.forEach((claim, i) => {
    const c = s.claims[i]!;
    if (claim.class !== "honest") fraud += 1;
    if (c.disprove && c.disprove.confirmed !== null) {
      const fee = f.vbytes_disprove * c.disprove.fee_rate;
      value += claim.k_sats - fee;
      feesSats += fee;
      disproved += 1;
    } else if (claim.class !== "honest" && c.paidOut !== null) {
      fraudPaid += 1;
      lostSats += claim.k_sats;
    }
  });
  const honestEvaluations = evaluated.filter((i) => !isFraud(f, i)).length;
  return { value, fraud, disproved, fraudPaid, lostSats, feesSats, evaluations: s.evaluations, honestEvaluations };
}

/** Heights whose final block holds none of the bench's transactions: the blocks a reorganization replaced. */
export const replacedHeights = (f: Pick<Bitvm3Fixture, "reorgs">): Set<number> => {
  const out = new Set<number>();
  for (const r of f.reorgs) for (let h = r.from_height; h < r.height; h++) out.add(h);
  return out;
};

export interface PlanStep { claim: number; start: number; fee_rate: number; gain: number; }

/**
 * What evaluating fraud claim i from height `start` can return: the claim output less the cheapest
 * disprove that can confirm in a block of the final chain after the verdict and inside the window,
 * less the evaluation's cost; null when that is not positive or no such block exists.
 */
export function startGain(f: Bitvm3Fixture, i: number, start: number, replaced: Set<number>): { gain: number; fee_rate: number } | null {
  const claim = f.claims[i]!;
  if (start < claim.first_height) return null;
  const lo = Math.max(start + f.eval_blocks + 1, claim.final_height);
  const hi = Math.min(claim.final_height + f.window_blocks - 1, f.horizon_height);
  let best = Number.POSITIVE_INFINITY;
  for (let u = lo; u <= hi; u++) if (!replaced.has(u)) best = Math.min(best, feeAt(f, u));
  if (!Number.isFinite(best) || best > f.max_fee_rate || f.vbytes_disprove * best > claim.k_sats - f.dust_sats) return null;
  const gain = claim.k_sats - f.vbytes_disprove * best - f.eval_cost_sats;
  return gain > 0 ? { gain, fee_rate: best } : null;
}

/**
 * The best value any policy can reach on this fixture, from the hidden classes, reorganizations and
 * fee path, with the schedule that reaches it. Only a fraud claim's evaluation can return anything,
 * one evaluation runs at a time, and a disprove pays at least the clearing rate of the final-chain
 * block it confirms in, so a policy earns at most the sum of startGain over a non-overlapping
 * schedule of fraud evaluations. V(t, S), the best from height t with the fraud claims in S already
 * evaluated, is max(V(t + 1, S), max over i not in S of startGain(i, t) + V(t + eval_blocks, S + i)),
 * and V(t, S) = 0 past the horizon. A later start never gains more (the window only shrinks), so
 * each claim's feasible starts are an interval and S matters only for claims still startable at t;
 * the memo keys on that part. The oracle follows the schedule through the host, broadcasting each
 * disprove at its verdict and bidding exactly the cheapest rate in its window.
 */
export function ceilingOf(f: Bitvm3Fixture): { value: number; plan: PlanStep[] } {
  const replaced = replacedHeights(f);
  const fraud = f.claims.map((_, i) => i).filter((i) => isFraud(f, i));
  const n = fraud.length;
  if (n > 30) throw new Error("ceilingOf: more than 30 fraud claims");
  const T0 = f.start_height;
  const E = f.eval_blocks;
  const span = f.horizon_height - T0 + 1;
  const gainAt = fraud.map((i) => Array.from({ length: span }, (_, k) => startGain(f, i, T0 + k, replaced)));
  const lastStart = gainAt.map((row) => row.reduce((b, g, k) => (g ? k : b), -1));
  // live[k]: the fraud claims that can still be started at T0 + k or later.
  const live = Array.from({ length: span + E + 1 }, (_, k) => lastStart.reduce((m, b, j) => (b >= k ? m | (1 << j) : m), 0));
  const memo = new Map<number, number>();
  const V = (k: number, done: number): number => {
    if (k >= span) return 0;
    const S = done & live[k]!;
    const key = k * 2 ** 31 + S;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let best = V(k + 1, S);
    for (let j = 0; j < n; j++) {
      const g = gainAt[j]![k];
      if (!g || S & (1 << j)) continue;
      const v = g.gain + V(k + E, S | (1 << j));
      if (v > best) best = v;
    }
    memo.set(key, best);
    return best;
  };
  const value = V(0, 0);
  // Follow the argmax: the lowest-index start that attains it, else wait a block.
  const plan: PlanStep[] = [];
  let k = 0;
  let S = 0;
  while (k < span) {
    const here = V(k, S);
    let taken = false;
    for (let j = 0; j < n && !taken; j++) {
      const g = gainAt[j]![k];
      if (!g || S & (1 << j)) continue;
      if (g.gain + V(k + E, S | (1 << j)) === here) {
        plan.push({ claim: fraud[j]!, start: T0 + k, fee_rate: g.fee_rate, gain: g.gain });
        S |= 1 << j;
        k += E;
        taken = true;
      }
    }
    if (!taken) k += 1;
  }
  return { value, plan };
}

