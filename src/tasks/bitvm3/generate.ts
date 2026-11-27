// Fixtures for family 12 (docs/tasks.md §15): the claims against one vault per seed and cell. A
// fixture holds every claim (its vault UTXO, the block it first confirms in, and, hidden, its class
// and the block it finally confirms in), the chain's reorganizations, and the clearing fee rate of
// every block to the horizon, computed once here and hash-bound.

import { canonical } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";

export const FIXTURE_VERSION = "bitvm3-fixture/v0";
export const VERSION_TAG = "bitcoin-defi-bench/v0|bitvm3";

export const CLASSES = ["honest", "wrong_statement", "invalid_proof"] as const;
export type ClaimClass = (typeof CLASSES)[number];

export interface CellParams {
  spikes: number;
  spike_ppm: number;
  spike_multiplier: [number, number];
  spike_blocks: [number, number];
  spike_after_claim: [number, number];
  reorg_ppm: number;
  reorg_shift_blocks: [number, number];
}

export interface Bitvm3Config {
  start_height: [number, number];
  arrival_blocks: number;
  horizon_after_arrivals: number;
  bursts: [number, number];
  burst_size: [number, number];
  vault_sats: number[];
  classes: { [c in ClaimClass]: number };
  window_blocks: number;
  reclaim_blocks: number;
  presigned_fee_sat_vb: number;
  vbytes: { claim: number; payout: number; disprove: number };
  dust_sats: number;
  eval_blocks: number;
  eval_cost_sats: number;
  max_fee_rate: number;
  fees: { base_sat_vb: [number, number]; walk_sigma: number; min_sat_vb: number };
  cells: { [cell: string]: CellParams };
  budget: { attempts: number; probes: number };
}

export interface Claim {
  id: string;
  /** The vault UTXO this claim's graph spends. */
  vault_sats: number;
  /** The claim output K: the vault less the presigned claim fee. A disprove returns it, less its own fee. */
  k_sats: number;
  /** The block the claim first confirms in; the watcher sees it, and its input labels, from then. */
  first_height: number;
  /** Hidden from the agent from here down. */
  class: ClaimClass;
  /** The block the claim confirms in once every reorganization has happened. Its window counts from here. */
  final_height: number;
}

/** At `height`, the blocks from `from_height` to `height - 1` are replaced by blocks without the bench's transactions; whatever they held confirms again from `height`. */
export interface Reorg { from_height: number; height: number; }

export interface Bitvm3Fixture {
  version: string;
  seed: number;
  cell: string;
  start_height: number;
  horizon_height: number;
  window_blocks: number;
  reclaim_blocks: number;
  eval_blocks: number;
  eval_cost_sats: number;
  vbytes_disprove: number;
  dust_sats: number;
  max_fee_rate: number;
  fraud_prior_ppm: { [c in ClaimClass]: number };
  claims: Claim[];
  reorgs: Reorg[];
  /** Clearing fee rate of each block from start_height to horizon_height, sat/vB: a transaction bidding at least this confirms in that block. */
  fees: number[];
  spikes: Array<{ start_height: number; blocks: number; multiplier: number }>;
}

export const fixturePath = (cell: string, seed: number): string => `fixtures/bitvm3/${cell}/seed-${String(seed).padStart(4, "0")}.json`;
export const fixtureBytes = (fixture: Bitvm3Fixture): string => `${canonical(fixture)}\n`;

const between = (rng: Stream, [lo, hi]: [number, number]): number => lo + rng.int(hi - lo + 1);

function drawClass(rng: Stream, weights: Bitvm3Config["classes"]): ClaimClass {
  const total = CLASSES.reduce((a, c) => a + weights[c], 0);
  let x = rng.int(total);
  for (const c of CLASSES) {
    if (x < weights[c]) return c;
    x -= weights[c];
  }
  throw new Error("unreachable");
}

/** Where each claim confirms once the reorganizations, applied in height order, have moved it. */
export function finalHeight(first: number, reorgs: readonly Reorg[]): number {
  let h = first;
  for (const r of reorgs) if (h >= r.from_height && h < r.height) h = r.height;
  return h;
}

export function generateFixture(seed: number, cell: string, params: CellParams, config: Bitvm3Config): Bitvm3Fixture {
  const rng = (label: string): Stream => stream(VERSION_TAG, cell, seed, label);
  const h0 = between(rng("start"), config.start_height);
  const horizon = h0 + config.arrival_blocks + config.horizon_after_arrivals;

  // Bursts of claims at distinct heights after the start.
  const b = rng("bursts");
  const slots = Array.from({ length: config.arrival_blocks }, (_, i) => h0 + 1 + i);
  b.shuffle(slots);
  const heights = slots.slice(0, between(b, config.bursts)).sort((x, y) => x - y);
  const sizes = heights.map(() => between(b, config.burst_size));

  // Reorganizations: each burst's block, with probability reorg_ppm, is replaced, and its claims
  // confirm again `shift` blocks later. Ranges never overlap.
  const r = rng("reorgs");
  const reorgs: Reorg[] = [];
  let lastReorg = -1;
  for (const h of heights) {
    const draw = r.int(1_000_000);
    const shift = between(r, params.reorg_shift_blocks);
    if (draw < params.reorg_ppm && shift > 0 && h > lastReorg) {
      reorgs.push({ from_height: h, height: h + shift });
      lastReorg = h + shift;
    }
  }

  const c = rng("claims");
  const claims: Claim[] = [];
  heights.forEach((h, i) => {
    for (let j = 0; j < sizes[i]!; j++) {
      const vault = c.pick(config.vault_sats);
      const cls = drawClass(c, config.classes);
      claims.push({
        id: `c${String(claims.length + 1).padStart(2, "0")}`, vault_sats: vault,
        k_sats: vault - config.vbytes.claim * config.presigned_fee_sat_vb,
        first_height: h, class: cls, final_height: finalHeight(h, reorgs),
      });
    }
  });

  // Fee spikes, placed after a burst so they can cover its disprove window.
  const s = rng("spikes");
  const spikes: Bitvm3Fixture["spikes"] = [];
  for (let i = 0; i < params.spikes; i++) {
    const draw = s.int(1_000_000);
    const at = s.pick(heights);
    const spike = { start_height: at + between(s, params.spike_after_claim), blocks: between(s, params.spike_blocks), multiplier: between(s, params.spike_multiplier) };
    if (draw < params.spike_ppm) spikes.push(spike);
  }

  // Family 11's fee model: a log-uniform base and a lognormal walk, times the largest spike over the block.
  const f = rng("fees");
  const [lo, hi] = config.fees.base_sat_vb;
  let walk = Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * f.next());
  const fees: number[] = [];
  for (let h = h0; h <= horizon; h++) {
    if (h > h0) walk *= Math.exp(config.fees.walk_sigma * f.normal());
    let mult = 1;
    for (const sp of spikes) if (h >= sp.start_height && h < sp.start_height + sp.blocks) mult = Math.max(mult, sp.multiplier);
    fees.push(Math.max(config.fees.min_sat_vb, Math.round(walk * mult)));
  }

  return {
    version: FIXTURE_VERSION, seed, cell, start_height: h0, horizon_height: horizon,
    window_blocks: config.window_blocks, reclaim_blocks: config.reclaim_blocks,
    eval_blocks: config.eval_blocks, eval_cost_sats: config.eval_cost_sats,
    vbytes_disprove: config.vbytes.disprove, dust_sats: config.dust_sats, max_fee_rate: config.max_fee_rate,
    fraud_prior_ppm: { ...config.classes },
    claims, reorgs, fees, spikes,
  };
}
