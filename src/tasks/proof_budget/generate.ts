// Fixtures for family 7: the claims that arrive over one horizon, and the cost table they are
// proven at. Arrivals are drawn per block from a seeded process (steady Poisson, or a two-state
// Markov-modulated Poisson for bursts); values are log-uniform. The cost table is copied from the
// adopted measurement, whose SHA-256 the config names and the generator checks.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, sha256 } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";
import type { CostTable, GridPoint } from "./cost.ts";

export const FIXTURE_VERSION = "proof-budget-fixture/v0";

export interface Arrivals {
  /** "steady": Poisson at `rate`; "bursty": Poisson at `quiet_rate` or `burst_rate`, switching per block. */
  process: "steady" | "bursty";
  rate?: number;
  quiet_rate?: number;
  burst_rate?: number;
  p_quiet_to_burst?: number;
  p_burst_to_quiet?: number;
  value_sats_min: number;
  value_sats_max: number;
}

export interface CellParams {
  horizon_blocks: number;
  arrivals: Arrivals;
  /** Proofs the operator may publish in the horizon: the attempt budget. */
  max_proofs: number;
  prover_price_sats_per_second: number;
  staleness_ppm_per_block: number;
  memory_ceiling_mib: number;
}

export interface ProofBudgetConfig {
  /** The adopted measurement (cairo/rcap/measurements/…), and the SHA-256 of its LF-normalized text. */
  cost_model: { file: string; sha256: string };
  cells: { [cell: string]: CellParams };
}

export interface Claim { id: number; block: number; value_sats: number; }

export interface ProofFixture {
  version: string;
  seed: number;
  cell: string;
  params: CellParams;
  claims: Claim[];
  cost_table: CostTable;
}

/** Mean arrival rate per block, from the process parameters alone (what the agent is told). */
export function meanRate(a: Arrivals): number {
  if (a.process === "steady") return a.rate!;
  const pi = a.p_quiet_to_burst! / (a.p_quiet_to_burst! + a.p_burst_to_quiet!);
  return (1 - pi) * a.quiet_rate! + pi * a.burst_rate!;
}

/** Mean of the log-uniform value distribution. */
export const meanValue = (a: Arrivals): number => (a.value_sats_max - a.value_sats_min) / Math.log(a.value_sats_max / a.value_sats_min);

function poisson(rng: Stream, rate: number): number {
  const limit = Math.exp(-rate);
  let k = 0;
  let p = rng.next();
  while (p > limit) { k += 1; p *= rng.next(); }
  return k;
}

/** The adopted measurement, checked against the SHA-256 the config names. */
export function loadCostTable(root: string, config: ProofBudgetConfig): CostTable {
  // Hashed with line endings normalized, so a checkout that converts them cannot change the digest.
  const text = readFileSync(join(root, config.cost_model.file), "utf8").replace(/\r\n/g, "\n");
  const digest = sha256(text);
  if (digest !== config.cost_model.sha256) throw new Error(`${config.cost_model.file}: SHA-256 ${digest} is not the adopted ${config.cost_model.sha256}`);
  const m = JSON.parse(text) as { program_sha256: string; toolchain: string; machine: string; statistic?: string; runs: Array<{ batch: number; steps: number; prove_seconds: number; peak_rss_mib: number; verified: boolean }> };
  if (!m.runs.every((r) => r.verified)) throw new Error("the measurement includes a proof that did not verify");
  const grid: GridPoint[] = m.runs.map((r) => ({ batch: r.batch, seconds: r.prove_seconds, peak_mib: r.peak_rss_mib, steps: r.steps })).sort((a, b) => a.batch - b.batch);
  return { grid, source: { file: config.cost_model.file, sha256: digest, program_sha256: m.program_sha256, toolchain: m.toolchain, machine: m.machine, statistic: m.statistic ?? "one run per size" } };
}

export function generateFixture(seed: number, cell: string, params: CellParams, costTable: CostTable): ProofFixture {
  const rng = stream("proof_budget", seed, cell);
  const values = stream("proof_budget/values", seed, cell);
  const a = params.arrivals;
  const claims: Claim[] = [];
  let burst = false;
  for (let block = 0; block < params.horizon_blocks; block++) {
    if (a.process === "bursty") {
      const u = rng.next();
      burst = burst ? !(u < a.p_burst_to_quiet!) : u < a.p_quiet_to_burst!;
    }
    const n = poisson(rng, a.process === "steady" ? a.rate! : burst ? a.burst_rate! : a.quiet_rate!);
    for (let i = 0; i < n; i++) {
      const lv = Math.log(a.value_sats_min) + (Math.log(a.value_sats_max) - Math.log(a.value_sats_min)) * values.next();
      claims.push({ id: claims.length, block, value_sats: Math.round(Math.exp(lv)) });
    }
  }
  return { version: FIXTURE_VERSION, seed, cell, params, claims, cost_table: costTable };
}

export const fixtureBytes = (fixture: ProofFixture): string => `${canonical(fixture)}\n`;

export const fixturePath = (cell: string, seed: number): string => `fixtures/proof_budget/${cell}/seed-${String(seed).padStart(4, "0")}.json`;
