// Fixtures for family 10: one contract per seed and cell. A fixture holds the contract's public
// parameters and its menus (interval beginnings and collateral levels), computed once here and
// hash-bound, so that a run on another machine offers the agent the same integers.

import { canonical } from "../../harness/json.ts";
import { stream } from "../../harness/prng.ts";
import type { Contract } from "./contract.ts";

export const FIXTURE_VERSION = "dlc-fixture/v0";

export interface CellParams {
  annual_volatility: number;
  days: number;
  capital_rate_annual: number;
  sats_per_cet: number;
}

export interface Market {
  spot_usd_min: number;
  spot_usd_max: number;
  notional_usd_min: number;
  notional_usd_max: number;
  notional_step_usd: number;
}

export interface DlcConfig {
  num_digits: number;
  rounding_mods: number[];
  /** Interval beginnings, in standard deviations of log price from its median. */
  breakpoint_z: number[];
  /** Collateral levels are offered at the breakpoints up to this z. */
  collateral_max_z: number;
  /** The floor policy's collateral: the level whose floor price is nearest this fraction of spot. */
  default_floor_ratio: number;
  infeasible_penalty_factor: number;
  budget: { attempts: number; probes: number };
  market: Market;
  cells: { [cell: string]: CellParams };
}

export interface CollateralOption { collateral_sats: number; floor_price_usd: number; }

export interface DlcFixture {
  version: string;
  seed: number;
  cell: string;
  contract: Contract;
  /** Allowed `begin_interval` values, ascending, from 0. */
  breakpoints: number[];
  rounding_mods: number[];
  collateral_options: CollateralOption[];
}

const SATS_PER_BTC = 100_000_000;

export function generateFixture(seed: number, cell: string, params: CellParams, config: DlcConfig): DlcFixture {
  const rng = stream("dlc", seed, cell);
  const m = config.market;
  const spot = Math.round(m.spot_usd_min + (m.spot_usd_max - m.spot_usd_min) * rng.next());
  const logN = Math.log(m.notional_usd_min) + (Math.log(m.notional_usd_max) - Math.log(m.notional_usd_min)) * rng.next();
  const notional = Math.max(m.notional_usd_min, m.notional_step_usd * Math.round(Math.exp(logN) / m.notional_step_usd));
  const s = params.annual_volatility * Math.sqrt(params.days / 365);
  const mu = Math.log(spot) - (s * s) / 2;
  const maxOutcome = 2 ** config.num_digits - 1;
  if (spot * Math.exp(5.5 * s) >= maxOutcome) throw new Error(`${cell} seed ${seed}: the oracle's range is too small for this forecast`);
  const prices = config.breakpoint_z.map((z) => Math.round(Math.exp(mu + z * s)));
  for (let i = 1; i < prices.length; i++) if (!(prices[i]! > prices[i - 1]!)) throw new Error(`${cell} seed ${seed}: breakpoints do not increase`);
  if (prices[0]! < 1) throw new Error(`${cell} seed ${seed}: a breakpoint is below one dollar`);
  const d = notional * SATS_PER_BTC;
  const collateral = prices.filter((_, i) => config.breakpoint_z[i]! <= config.collateral_max_z)
    .map((p) => ({ collateral_sats: Math.ceil(d / p), floor_price_usd: p }))
    .reverse(); // ascending collateral
  return {
    version: FIXTURE_VERSION, seed, cell,
    contract: { num_digits: config.num_digits, notional_usd: notional, forecast: { spot_usd: spot, annual_volatility: params.annual_volatility, days: params.days }, capital_rate_annual: params.capital_rate_annual, sats_per_cet: params.sats_per_cet },
    breakpoints: [0, ...prices],
    rounding_mods: [...config.rounding_mods],
    collateral_options: collateral,
  };
}

export const fixtureBytes = (fixture: DlcFixture): string => `${canonical(fixture)}\n`;

export const fixturePath = (cell: string, seed: number): string => `fixtures/dlc/${cell}/seed-${String(seed).padStart(4, "0")}.json`;
