// Family 7's schedules and their costs. A proof covers the oldest pending claims (the order is the
// protocol's, not the agent's); the agent chooses when to prove and how many. A schedule is a list
// of (block, count) proofs. Costs, in sats: the prover's price for each proof's seconds; staleness,
// s × value for each block a claim waits between arrival and its proof; and forfeiture, the whole
// value of every claim not proven by the horizon.

import type { CostModel } from "./cost.ts";
import type { Claim } from "./generate.ts";

export interface Proof { block: number; count: number; }

export interface Costs {
  prover_sats: number;
  staleness_sats: number;
  forfeit_sats: number;
  total_sats: number;
  proofs: number;
  proven: number;
  forfeited: number;
}

/** Claims in protocol order: by arrival block, then id. */
export const ordered = (claims: readonly Claim[]): Claim[] => [...claims].sort((a, b) => a.block - b.block || a.id - b.id);

/** The cost of a schedule, or the first reason it is invalid. Used by tests and the ceiling's check; the environment accumulates the same terms as it steps. */
export function scheduleCost(claims: readonly Claim[], schedule: readonly Proof[], cost: CostModel, stalenessPpm: number): Costs | string {
  const queue = ordered(claims);
  let next = 0;
  let prover = 0;
  let stale = 0;
  let lastBlock = -1;
  for (const p of schedule) {
    if (p.block < lastBlock) return "proofs out of order";
    lastBlock = p.block;
    const arrived = queue.filter((c) => c.block <= p.block).length;
    if (p.count < 1 || next + p.count > arrived) return `proof at block ${p.block} covers claims that have not arrived`;
    if (p.count > cost.maxBatch) return `batch of ${p.count} exceeds the largest that fits, ${cost.maxBatch}`;
    prover += cost.cost(p.count);
    for (let m = next; m < next + p.count; m++) stale += (stalenessPpm / 1e6) * queue[m]!.value_sats * (p.block - queue[m]!.block);
    next += p.count;
  }
  let forfeit = 0;
  for (let m = next; m < queue.length; m++) forfeit += queue[m]!.value_sats;
  return { prover_sats: prover, staleness_sats: stale, forfeit_sats: forfeit, total_sats: prover + stale + forfeit, proofs: schedule.length, proven: next, forfeited: queue.length - next };
}

/**
 * The clairvoyant optimum: a dynamic program over batch boundaries for the realized arrivals, with
 * at most `maxProofs` proofs of at most `cost.maxBatch` claims. Exact over the agent's action space:
 * a proof covering claims i..j is best published when claim j arrives (later only adds staleness and
 * cannot change which claims later proofs cover), and the claims never proven are a suffix.
 * f(i, k) = least cost of claims i.. with k proofs left = min(forfeit i.., min over j of
 * cost(j − i + 1) + staleness(i, j) + f(j + 1, k − 1)).
 */
export function optimalSchedule(claims: readonly Claim[], cost: CostModel, stalenessPpm: number, maxProofs: number): Proof[] {
  const q = ordered(claims);
  const n = q.length;
  const s = stalenessPpm / 1e6;
  const V = new Float64Array(n + 1);
  const VA = new Float64Array(n + 1);
  for (let m = 0; m < n; m++) { V[m + 1] = V[m]! + q[m]!.value_sats; VA[m + 1] = VA[m]! + q[m]!.value_sats * q[m]!.block; }
  const K = Math.min(maxProofs, n);
  // f[k][i], rolling over k with full tables kept for reconstruction.
  const f: Float64Array[] = [];
  const choice: Int32Array[] = [];
  const forfeit = (i: number): number => V[n]! - V[i]!;
  f.push(Float64Array.from({ length: n + 1 }, (_, i) => forfeit(i)));
  choice.push(new Int32Array(n + 1).fill(-1));
  for (let k = 1; k <= K; k++) {
    const row = new Float64Array(n + 1);
    const pick = new Int32Array(n + 1).fill(-1);
    const prev = f[k - 1]!;
    for (let i = n; i >= 0; i--) {
      let best = forfeit(i);
      let arg = -1;
      const last = Math.min(n - 1, i + cost.maxBatch - 1);
      for (let j = i; j <= last; j++) {
        const aj = q[j]!.block;
        const c = cost.cost(j - i + 1) + s * (aj * (V[j + 1]! - V[i]!) - (VA[j + 1]! - VA[i]!)) + prev[j + 1]!;
        if (c < best) { best = c; arg = j; }
      }
      row[i] = best;
      pick[i] = arg;
    }
    f.push(row);
    choice.push(pick);
  }
  const schedule: Proof[] = [];
  let i = 0;
  for (let k = K; k >= 1 && i < n; k--) {
    const j = choice[k]![i]!;
    if (j < 0) break;
    schedule.push({ block: q[j]!.block, count: j - i + 1 });
    i = j + 1;
  }
  return schedule;
}
