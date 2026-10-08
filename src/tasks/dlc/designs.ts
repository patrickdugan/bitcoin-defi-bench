// Family 10's policies as pure functions of the observation, and the parser every design goes
// through. Nothing in this family is hidden: the forecast is the contract's, stated to both parties,
// so even the ceiling reads only what the agent reads.

import { canonical, isObject, type Json } from "../../harness/json.ts";
import type { RejectReason } from "../../harness/agent.ts";
import { Model, evaluateDesign, optimize, type Contract, type Costs, type Design, type Menu, type RoundingInterval } from "./contract.ts";

/** What the environment shows; the view in every observation. */
export interface DlcView {
  contract: Contract;
  oracle: { base: number; max_outcome: number; unit: string };
  offerer_collateral_sats: number;
  breakpoints: Array<{ begin_interval: number; below_probability: number }>;
  rounding_mods: number[];
  collateral_options: Array<{ collateral_sats: number; floor_price_usd: number; below_probability: number }>;
}

// The runner plays every policy on one seed before the next, so two models are enough.
const cache = new Map<string, Model>();
export function modelFor(contract: Contract): Model {
  const key = canonical(contract);
  let model = cache.get(key);
  if (!model) {
    model = new Model(contract);
    cache.set(key, model);
    while (cache.size > 2) cache.delete(cache.keys().next().value!);
  }
  return model;
}

export const menuOf = (view: DlcView): Menu => ({
  breakpoints: view.breakpoints.map((b) => b.begin_interval),
  rounding_mods: [...view.rounding_mods],
  collateral_options: view.collateral_options.map((c) => c.collateral_sats),
});

export type Parsed = { design: Design } | { reason: RejectReason; detail: string };

/** Validate a design against the menu. Zero intervals is the specification's modulus 1 everywhere. */
export function parseDesign(args: unknown, menu: Menu): Parsed {
  if (!isObject(args)) return { reason: "malformed", detail: "args must be an object with collateral_sats and rounding_intervals" };
  const C = args.collateral_sats;
  if (typeof C !== "number") return { reason: "malformed", detail: "collateral_sats must be a number" };
  if (!Number.isInteger(C)) return { reason: "not_integer", detail: "collateral_sats must be a whole number" };
  if (!menu.collateral_options.includes(C)) return { reason: "out_of_grid", detail: `collateral_sats ${C} is not one of the collateral options` };
  const raw = args.rounding_intervals ?? [];
  if (!Array.isArray(raw)) return { reason: "malformed", detail: "rounding_intervals must be a list" };
  const intervals: RoundingInterval[] = [];
  for (const r of raw) {
    if (!isObject(r) || typeof r.begin_interval !== "number" || typeof r.rounding_mod !== "number") return { reason: "malformed", detail: "each rounding interval needs begin_interval and rounding_mod" };
    if (!Number.isInteger(r.begin_interval) || !Number.isInteger(r.rounding_mod)) return { reason: "not_integer", detail: "begin_interval and rounding_mod must be whole numbers" };
    if (!menu.breakpoints.includes(r.begin_interval)) return { reason: "out_of_grid", detail: `begin_interval ${r.begin_interval} is not one of the breakpoints` };
    if (!menu.rounding_mods.includes(r.rounding_mod)) return { reason: "out_of_grid", detail: `rounding_mod ${r.rounding_mod} is not one of the moduli` };
    if (intervals.length > 0 && r.begin_interval <= intervals[intervals.length - 1]!.begin_interval) return { reason: "malformed", detail: "begin_interval values must strictly increase" };
    intervals.push({ begin_interval: r.begin_interval, rounding_mod: r.rounding_mod });
  }
  return { design: { collateral_sats: C, rounding_intervals: intervals } };
}

export const designJson = (design: Design): Json => ({
  collateral_sats: design.collateral_sats,
  rounding_intervals: design.rounding_intervals.map((r) => ({ begin_interval: r.begin_interval, rounding_mod: r.rounding_mod })),
});

/** Floor: the specification's defaults (no rounding intervals, so modulus 1 everywhere) and collateral of about twice the notional. */
export function specDefault(view: DlcView, defaultFloorRatio: number): Design {
  const target = view.contract.forecast.spot_usd * defaultFloorRatio;
  const opt = view.collateral_options.reduce((a, c) => (Math.abs(Math.log(c.floor_price_usd / target)) < Math.abs(Math.log(a.floor_price_usd / target)) ? c : a));
  return { collateral_sats: opt.collateral_sats, rounding_intervals: [] };
}

/** The collateral level that minimizes capital plus expected shortfall: the newsvendor quantile, on the menu. */
export function quantileCollateral(model: Model, menu: Menu): number {
  return menu.collateral_options.reduce((a, c) => (model.capital(c) + model.shortfall(c) < model.capital(a) + model.shortfall(a) ? c : a));
}

const best = (model: Model, designs: Design[]): { design: Design; costs: Costs } =>
  designs.map((design) => ({ design, costs: evaluateDesign(model, design) })).reduce((a, b) => (b.costs.total_sats < a.costs.total_sats ? b : a));

/** Reference: the quantile collateral, and the one modulus over the whole domain that costs least. */
export function uniformTuned(model: Model, menu: Menu): Design {
  const C = quantileCollateral(model, menu);
  return best(model, menu.rounding_mods.map((m) => ({ collateral_sats: C, rounding_intervals: [{ begin_interval: 0, rounding_mod: m }] }))).design;
}

/**
 * Descriptive: tails flat. Regions carrying under 0.1% of the forecast take the largest modulus;
 * the rest share the one modulus that costs least. The first half of what the exact design does.
 */
export function twoBand(model: Model, menu: Menu, view: DlcView): Design {
  const C = quantileCollateral(model, menu);
  const flat = menu.rounding_mods[menu.rounding_mods.length - 1]!;
  const mass = view.breakpoints.map((b, i) => (i + 1 < view.breakpoints.length ? view.breakpoints[i + 1]!.below_probability : 1) - b.below_probability);
  const designs = menu.rounding_mods.map((m) => {
    const intervals: RoundingInterval[] = [];
    view.breakpoints.forEach((b, i) => {
      const mod = mass[i]! < 0.001 ? flat : m;
      if (intervals.length === 0 || intervals[intervals.length - 1]!.rounding_mod !== mod) intervals.push({ begin_interval: b.begin_interval, rounding_mod: mod });
    });
    return { collateral_sats: C, rounding_intervals: intervals };
  });
  return best(model, designs).design;
}

/** Ceiling: the exact optimum over the menu (contract.ts, `optimize`). */
export const exactDesign = (model: Model, menu: Menu): Design => optimize(model, menu).design;
