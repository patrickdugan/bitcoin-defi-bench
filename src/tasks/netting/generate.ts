// Fixtures for family 6: a clearing instance in the terms of the application the paper cites as
// R14. Traders are addresses with collateral; trades are bilateral contracts on one instrument;
// the settlement value is external; every traded pair has a settlement link with a capacity and a
// per-unit rate, and any pair can be joined by a ghost link at a higher rate. An instance is small
// enough to commit whole, as integers and strings.

import { canonical } from "../../harness/json.ts";
import { cmp, nodeId, pairKey, sortedPair } from "../../harness/order.ts";
import { stream } from "../../harness/prng.ts";

export const FIXTURE_VERSION = "netting-fixture/v0";

export interface CellParams {
  traders: number;
  trades: number;
  /** How pairs are drawn: `uniform` over all pairs, or `ring` with chords (each trader trades with near neighbours). */
  graph: "uniform" | "ring";
  /** Link capacity as parts per million of the pair's gross notional. */
  link_capacity_ppm_of_notional: number;
}

export interface Trader { id: string; collateral_sats: number; }
export interface Trade { id: number; long: string; short: string; quantity: number; entry_price: number; }
export interface Link { a: string; b: string; capacity_sats: number; rate_ppm: number; }

export interface NettingFixture {
  version: string;
  seed: number;
  cell: string;
  params: CellParams;
  traders: Trader[];
  trades: Trade[];
  settlement_value: number;
  links: Link[];
  ghost: { rate_ppm: number };
  base_fee_sats: number;
}

export interface Market {
  base_price: number;
  entry_spread_ppm: number;
  settlement_spread_ppm: number;
  max_quantity: number;
  link_rate_ppm: number;
  ghost_rate_ppm: number;
  base_fee_sats: number;
  /** Collateral is this many parts per million of a trader's gross payable at settlement; at least one million. */
  collateral_ppm_of_gross_payable: number;
}

/** Obligation of a trade at the settlement value: positive means the short pays the long. */
export const obligation = (trade: Trade, settlement: number): number => trade.quantity * (settlement - trade.entry_price);

/** Net amount each trader must pay (negative: receive), summing to zero. */
export function netPayable(fixture: NettingFixture): Map<string, number> {
  const net = new Map<string, number>(fixture.traders.map((t) => [t.id, 0]));
  for (const t of fixture.trades) {
    const v = obligation(t, fixture.settlement_value);
    net.set(t.short, net.get(t.short)! + v);
    net.set(t.long, net.get(t.long)! - v);
  }
  return net;
}

/** The most each trader pays if every trade is settled on its own. */
export function grossPayable(fixture: NettingFixture): Map<string, number> {
  const gross = new Map<string, number>(fixture.traders.map((t) => [t.id, 0]));
  for (const t of fixture.trades) {
    const v = obligation(t, fixture.settlement_value);
    const payer = v > 0 ? t.short : t.long;
    gross.set(payer, gross.get(payer)! + Math.abs(v));
  }
  return gross;
}

export function generateFixture(seed: number, cell: string, params: CellParams, market: Market): NettingFixture {
  const rng = stream("netting", seed, cell);
  const ids = Array.from({ length: params.traders }, (_, i) => nodeId(i, "t"));
  const pairs: Array<[string, string]> = [];
  if (params.graph === "uniform") {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i]!, ids[j]!]);
  } else {
    // A ring, plus a chord from each trader to the one three places on. Cycles of several lengths.
    const n = ids.length;
    for (let i = 0; i < n; i++) {
      pairs.push(sortedPair(ids[i]!, ids[(i + 1) % n]!));
      if (n > 6) pairs.push(sortedPair(ids[i]!, ids[(i + 3) % n]!));
    }
  }
  const keys = new Map(pairs.map((p) => [pairKey(p[0], p[1]), p]));
  const pairList = [...keys.keys()].sort(cmp).map((k) => keys.get(k)!);
  const million = 1_000_000;
  const spread = (ppm: number): number => Math.round(market.base_price * ((2 * rng.next() - 1) * ppm) / million);
  const trades: Trade[] = [];
  for (let k = 0; k < params.trades; k++) {
    const [a, b] = rng.pick(pairList);
    const longIsA = rng.next() < 0.5;
    trades.push({ id: k, long: longIsA ? a : b, short: longIsA ? b : a, quantity: 1 + rng.int(market.max_quantity), entry_price: market.base_price + spread(market.entry_spread_ppm) });
  }
  const settlement = market.base_price + spread(market.settlement_spread_ppm);
  // Links: one per traded pair, sized against the pair's gross notional.
  const notional = new Map<string, number>();
  for (const t of trades) {
    const key = pairKey(t.long, t.short);
    notional.set(key, (notional.get(key) ?? 0) + t.quantity * t.entry_price);
  }
  const links: Link[] = [...notional.keys()].sort(cmp).map((key) => {
    const [a, b] = key.split("|") as [string, string];
    return { a, b, capacity_sats: Math.ceil((notional.get(key)! * params.link_capacity_ppm_of_notional) / million), rate_ppm: market.link_rate_ppm };
  });
  const partial: NettingFixture = {
    version: FIXTURE_VERSION, seed, cell, params,
    traders: ids.map((id) => ({ id, collateral_sats: 0 })),
    trades, settlement_value: settlement, links, ghost: { rate_ppm: market.ghost_rate_ppm }, base_fee_sats: market.base_fee_sats,
  };
  // Collateral covers each trader's gross payable with a margin, so every plan is fundable and
  // every failure is the plan's. It is set after the settlement value: a funding guarantee, not a forecast.
  const gross = grossPayable(partial);
  partial.traders = ids.map((id) => ({ id, collateral_sats: Math.ceil((gross.get(id)! * Math.max(million, market.collateral_ppm_of_gross_payable)) / million) }));
  return partial;
}

export const fixtureBytes = (fixture: NettingFixture): string => `${canonical(fixture)}\n`;

export const fixturePath = (cell: string, seed: number): string => `fixtures/netting/${cell}/seed-${String(seed).padStart(4, "0")}.json`;
