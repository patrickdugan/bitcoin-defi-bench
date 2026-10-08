// Fixtures for family 5: one bonding decision per seed and cell. The challenger's true response
// rate is drawn per seed and kept in the fixture for scoring and for the oracle; the agent sees only
// a sample of past response times drawn from it.

import { canonical } from "../../harness/json.ts";
import { stream } from "../../harness/prng.ts";
import type { Service } from "./model.ts";

export const FIXTURE_VERSION = "bonding-fixture/v0";

export interface CellParams {
  window_blocks: number;
  requests: [number, number];
  p_honored: [number, number];
  threshold: number;
  value_at_risk_sats: [number, number];
  fee_rate_sat_vb: [number, number];
  response_p: [number, number];
  catch_probability: number;
  sample_size: number;
}

export interface BondingConfig {
  capital_rate_per_block: number;
  min_delta_blocks: number;
  bond_multipliers: number[];
  delta_grid: number[];
  infeasible_penalty_factor: number;
  budget: { attempts: number };
  cells: { [cell: string]: CellParams };
}

export interface BondingFixture {
  version: string;
  seed: number;
  cell: string;
  service: Service;
  fee_rate_sat_vb: number;
  capital_rate_per_block: number;
  challenge: { min_delta_blocks: number; catch_probability: number; observed_response_blocks: number[] };
  grid: { bonds: number[]; deltas: number[] };
  /** Hidden: the challengers' per-block response probability. Scored against, shown only to the oracle. */
  true_response_p: number;
}

const uniform = (rng: { next(): number }, [a, b]: [number, number]): number => a + (b - a) * rng.next();

export function generateFixture(seed: number, cell: string, params: CellParams, config: BondingConfig): BondingFixture {
  const rng = stream("bonding", seed, cell);
  const requests = Math.round(uniform(rng, params.requests));
  const pHonored = Math.round(uniform(rng, params.p_honored) * 1e6) / 1e6;
  const [vLo, vHi] = params.value_at_risk_sats;
  const value = Math.round(Math.exp(Math.log(vLo) + (Math.log(vHi) - Math.log(vLo)) * rng.next()) / 1000) * 1000;
  const feeRate = Math.round(uniform(rng, params.fee_rate_sat_vb));
  const p = Math.round(uniform(rng, params.response_p) * 1e6) / 1e6;
  const sample = stream("bonding/sample", seed, cell);
  const observed: number[] = [];
  for (let i = 0; i < params.sample_size; i++) {
    // Geometric on {1, 2, …}: blocks until the first block in which a challenger responds.
    let r = 1;
    while (sample.next() >= p) r += 1;
    observed.push(r);
  }
  return {
    version: FIXTURE_VERSION, seed, cell,
    service: { window_blocks: params.window_blocks, requests, p_honored: pHonored, threshold: params.threshold, value_at_risk_sats: value },
    fee_rate_sat_vb: feeRate,
    capital_rate_per_block: config.capital_rate_per_block,
    challenge: { min_delta_blocks: config.min_delta_blocks, catch_probability: params.catch_probability, observed_response_blocks: observed },
    grid: { bonds: config.bond_multipliers.map((m) => Math.ceil(value * m)), deltas: [...config.delta_grid] },
    true_response_p: p,
  };
}

export const fixtureBytes = (fixture: BondingFixture): string => `${canonical(fixture)}\n`;

export const fixturePath = (cell: string, seed: number): string => `fixtures/bonding/${cell}/seed-${String(seed).padStart(4, "0")}.json`;
