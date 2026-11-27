// The venue, the federation's marks, and the holder's books for family 13 (docs/tasks.md §16). Pure
// functions of the fixture and the config, shared by the host (env.ts), the baselines, and the exact
// ceiling, so the ceiling through `act` and its direct computation cannot drift apart.
//
// One step, in order:
//   1. Settlement, if the federation has a verified mark at this step (always at maturity). The venue
//      marks the short to the mark and settles the interval since the last settlement over Lightning.
//      The margin bounds the interval's loss (the DLC clamp). At or past bankruptcy the account loses
//      exactly its margin and the short closes; below maintenance the short closes at the auction's
//      capped discount, a penalty. The margin stays posted.
//   2. The balance flow, which moves the hedge target.
//   3. The agent's moves: at most one margin transfer and one take.
//   4. The capital charge on the margin posted through the step.
// At maturity the short settles at the attested mark at no fee and the margin comes home over Lightning.
//
// Score, in sats: minus the tracking error (at each settlement, the absolute gap between the hedge's
// sats change and the change in sats the target dollar value needs, summed without netting) and minus
// every cost: execution against the mark, taker fees, Lightning routing fees, capital, and penalties.

import type { FederationPolicy, Packet, PacketKind, ShzConfig, ShzFixture, Tier } from "./generate.ts";
import { TIERS } from "./generate.ts";

/** Exact floor and ceiling of a / b for non-negative integers below 2^53. */
export function divFloor(a: number, b: number): number {
  let q = Math.floor(a / b);
  while (q * b > a) q -= 1;
  while ((q + 1) * b <= a) q += 1;
  return q;
}
export const divCeil = (a: number, b: number): number => {
  const q = divFloor(a, b);
  return q * b === a ? q : q + 1;
};

/** Value in sats of `usd` dollars at `price` (floor), as the venue values an inverse lot (risk.rs `lot_value_v3`). */
export const vSats = (usd: number, price: number): number => divFloor(usd * 100_000_000, price);
/** Notional in sats at the mark, rounded up (risk.rs `notional_sats`). */
export const notionalSats = (usd: number, price: number): number => divCeil(usd * 100_000_000, price);

/** Initial margin for a short of `lots` at `price`: a tenth of the notional at the maximum leverage. */
export const initialMargin = (f: Pick<ShzFixture, "lot_usd">, config: ShzConfig, lots: number, price: number): number =>
  lots === 0 ? 0 : divCeil(notionalSats(lots * f.lot_usd, price), config.max_leverage);

/** Routing fee in sats for one payment of `sats` through one hop: base_fee_msat + ceil(sats × ppm / 1000) msat, rounded up to whole sats. */
export const lnFee = (config: ShzConfig, sats: number): number =>
  sats <= 0 ? 0 : divCeil(config.lightning.base_fee_msat + divCeil(sats * config.lightning.fee_ppm, 1000), 1000);

export const capitalFee = (config: ShzConfig, marginSats: number): number => divCeil(marginSats * config.capital_ppm_per_step, 1_000_000);

/** Last settled mark at each step's decision: the step's own mark unless the federation holds. */
export function settledMarks(f: ShzFixture): number[] {
  const out: number[] = [];
  for (let t = 0; t < f.steps; t++) out.push(t === 0 || f.hold[t] === 0 ? f.marks[t]! : out[t - 1]!);
  return out;
}

export const tradeable = (kind: PacketKind): boolean => kind !== "hold" && kind !== "timeout";

export interface Fill { lots: number; price_usd: number; }
export interface TakeOutcome { filled: boolean; fills: Fill[]; execution: number; taker_fee: number; lightning: number; rogue: boolean; }

/** The ladder's fills for `lots` against a reference price: sells hit bids below it, buys lift asks above it. */
export function ladderFills(config: ShzConfig, side: "sell" | "buy", lots: number, ref: number): Fill[] | null {
  const L = config.ladder;
  if (lots > L.levels * L.lots_per_level) return null;
  const fills: Fill[] = [];
  let left = lots;
  for (let j = 0; left > 0; j++) {
    const off = L.first_offset_bps + j * L.step_bps;
    const n = Math.min(left, L.lots_per_level);
    const price = side === "sell" ? divFloor(ref * (10_000 - off), 10_000) : divCeil(ref * (10_000 + off), 10_000);
    fills.push({ lots: n, price_usd: price });
    left -= n;
  }
  return fills;
}

/**
 * The outcome of a take of `lots` at slot `slot` of step t. A genuine packet's take fills against the ladder at the
 * mark (premium) or at the mark 200 ms later (standard). A take on a packet that fails the policy goes
 * to whoever served it, who fills only when the packet's price is worse for the taker than the mark,
 * and then at a ladder around the packet's price. Costs are measured against the true mark. Null when
 * the step has no tradeable packet.
 */
export function takeOutcome(f: ShzFixture, config: ShzConfig, t: number, slot: number, side: "sell" | "buy", lots: number, tier: Tier): TakeOutcome | null {
  const { kind, packet } = f.packets[t]![slot]!;
  if (!tradeable(kind) || packet === null || packet.price_usd === null) return null;
  const mark = f.marks[t]!;
  const rogue = kind !== "genuine";
  let ref: number;
  if (!rogue) ref = tier === "premium" ? mark : mark + f.delta_usd[t]![slot]!;
  else {
    const adverse = side === "sell" ? packet.price_usd < mark : packet.price_usd > mark;
    if (!adverse) return { filled: false, fills: [], execution: 0, taker_fee: 0, lightning: 0, rogue };
    ref = packet.price_usd;
  }
  const fills = ladderFills(config, side, lots, ref);
  if (fills === null) return null;
  let execution = 0;
  let notional = 0;
  for (const fl of fills) {
    const q = fl.lots * f.lot_usd;
    execution += side === "sell" ? vSats(q, fl.price_usd) - vSats(q, mark) : vSats(q, mark) - vSats(q, fl.price_usd);
    notional += vSats(q, fl.price_usd);
  }
  const takerFee = divCeil(notional * config.tiers[tier].taker_ppm, 1_000_000);
  return { filled: true, fills, execution, taker_fee: takerFee, lightning: lnFee(config, Math.abs(execution + takerFee)), rogue };
}

export interface Settlement {
  pnl: number;
  /** The hedge's sats change: the PnL, or minus the margin at or past bankruptcy. */
  hedge: number;
  tracking: number;
  penalty: number;
  lightning: number;
  liquidated: boolean;
  bankrupt: boolean;
  lots_after: number;
}

/** Settle a short of `lots` with `margin` from `from` to `to`, against a target of `targetLots`. */
export function settle(f: Pick<ShzFixture, "lot_usd">, config: ShzConfig, lots: number, margin: number, from: number, to: number, targetLots: number): Settlement {
  const target = targetLots * f.lot_usd;
  const needed = vSats(target, to) - vSats(target, from);
  if (lots === 0) return { pnl: 0, hedge: 0, tracking: Math.abs(needed), penalty: 0, lightning: 0, liquidated: false, bankrupt: false, lots_after: 0 };
  const q = lots * f.lot_usd;
  const pnl = vSats(q, to) - vSats(q, from);
  const equity = margin + pnl;
  let hedge = pnl;
  let penalty = 0;
  let liquidated = false;
  let bankrupt = false;
  if (equity <= 0) { hedge = -margin; bankrupt = true; }
  else if (divFloor(equity * 10_000, notionalSats(q, to)) < config.maintenance_bps) {
    liquidated = true;
    const close = divCeil(to * (10_000 + config.liquidation_discount_bps), 10_000);
    penalty = Math.min(vSats(q, to) - vSats(q, close), equity);
  }
  return {
    pnl, hedge, tracking: Math.abs(hedge - needed), penalty, lightning: lnFee(config, Math.abs(hedge - penalty)),
    liquidated, bankrupt, lots_after: liquidated || bankrupt ? 0 : lots,
  };
}

/** The lowest mark above `from` at which the next settlement closes the short (the venue's liquidation price), or null. */
export function liquidationMark(f: Pick<ShzFixture, "lot_usd">, config: ShzConfig, lots: number, margin: number, from: number): number | null {
  if (lots === 0) return null;
  const closes = (p: number): boolean => { const s = settle(f, config, lots, margin, from, p, lots); return s.liquidated || s.bankrupt; };
  let lo = from;
  let hi = from * 100;
  if (!closes(hi)) return null;
  if (closes(lo)) return lo;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (closes(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

/** The client's pinned policy: why a packet may not be traded on, or null when it may. */
export function packetFault(p: Packet | null, fed: FederationPolicy & { keys: string[] }, nowMs: number): string | null {
  if (p === null) return "no packet";
  if (p.status !== "VALID" || p.price_usd === null) return "HOLD";
  if (p.boundary_ms > nowMs || nowMs - p.boundary_ms > fed.max_packet_age_ms) return "packet older than the freshness bound";
  const seen = new Set<number>();
  for (const s of p.signatures) {
    if (!Number.isInteger(s.member) || s.member < 0 || s.member >= fed.keys.length || seen.has(s.member)) return "signature from no distinct member";
    if (s.key !== fed.keys[s.member]) return "signature by a key that is not the member's";
    seen.add(s.member);
  }
  if (seen.size < fed.quorum) return "fewer member signatures than the quorum";
  const ts = p.sources.map((s) => s.ts_ms);
  for (const x of ts) if (x < p.boundary_ms - fed.max_source_age_ms || x > p.boundary_ms + fed.max_future_ms) return "source timestamp outside the age bound";
  if (Math.max(...ts) - Math.min(...ts) > fed.max_source_skew_ms) return "sources skewed beyond the bound";
  const prices = p.sources.map((s) => s.price_usd ?? 0);
  const lo = Math.min(...prices);
  if (lo <= 0 || (Math.max(...prices) - lo) * 10_000 > fed.max_dispersion_bps * lo) return "sources dispersed beyond the bound";
  return null;
}

/** The unhedged holder's score: minus the tracking error of holding no short. */
export function idleValue(f: ShzFixture, config: ShzConfig): number {
  const pset = settledMarks(f);
  let total = 0;
  for (let t = 1; t <= f.steps; t++) {
    if (t < f.steps && f.hold[t] === 1) continue;
    total += settle(f, config, 0, 0, pset[t - 1]!, f.marks[t]!, f.target_lots[t - 1]!).tracking;
  }
  return -total;
}

export interface Move { lots: number; units: number; tier: Tier; slot: number; }
export interface Ceiling { value: number; /** best[t][lots][units]: the move from that state at step t. */ best: Move[][][]; }

/**
 * The exact ceiling: dynamic programming over (lots, margin units) at every step, from the hidden
 * marks, holds, 200 ms moves, and packets. A move is the step's resulting lots, margin units, and the
 * take's tier. A sell, or a withdrawal, needs the resulting margin to cover the initial margin at the
 * last settled mark; a take on a packet that fails the policy is a move only where it fills.
 */
export function ceilingOf(f: ShzFixture, config: ShzConfig): Ceiling {
  const T = f.steps;
  const nL = config.max_lots + 1;
  const nU = config.max_margin_units + 1;
  const u = f.margin_unit_sats;
  const pset = settledMarks(f);
  const marginFee = Array.from({ length: nU }, (_, d) => lnFee(config, d * u));
  const capital = Array.from({ length: nU }, (_, k) => capitalFee(config, k * u));
  // W: cost-to-go at the start of step t, before its settlement. At maturity: settle, then bring the margin home.
  let W: number[][] = [];
  for (let n = 0; n < nL; n++) {
    W.push([]);
    for (let k = 0; k < nU; k++) {
      const s = settle(f, config, n, k * u, pset[T - 1]!, f.marks[T]!, f.target_lots[T - 1]!);
      W[n]!.push(s.tracking + s.penalty + s.lightning + marginFee[k]!);
    }
  }
  const best: Move[][][] = Array.from({ length: T }, () => []);
  let V: number[][] = [];
  for (let t = T - 1; t >= 0; t--) {
    // Cheapest take from n to n2 by tier at this step over its slots, or Infinity, and the slot.
    const take: number[][][] = [];
    const slotOf: number[][][] = [];
    for (let n = 0; n < nL; n++) {
      take.push([]);
      slotOf.push([]);
      for (let n2 = 0; n2 < nL; n2++) {
        const costs: number[] = [];
        const slots: number[] = [];
        for (const tier of TIERS) {
          let c = n2 === n && tier === "standard" ? 0 : Infinity;
          let at = 0;
          for (let r = 0; n2 !== n && r < config.slots_per_step; r++) {
            const o = takeOutcome(f, config, t, r, n2 > n ? "sell" : "buy", Math.abs(n2 - n), tier);
            const x = o && o.filled ? o.execution + o.taker_fee + o.lightning : Infinity;
            if (x < c) { c = x; at = r; }
          }
          costs.push(c);
          slots.push(at);
        }
        take[n]!.push(costs);
        slotOf[n]!.push(slots);
      }
    }
    const im = Array.from({ length: nL }, (_, n) => initialMargin(f, config, n, pset[t]!));
    V = [];
    for (let n = 0; n < nL; n++) {
      V.push([]);
      best[t]!.push([]);
      for (let k = 0; k < nU; k++) {
        let bv = Infinity;
        let bm: Move = { lots: n, units: k, tier: "standard", slot: 0 };
        for (let n2 = 0; n2 < nL; n2++) {
          for (let k2 = 0; k2 < nU; k2++) {
            if ((n2 > n || k2 < k) && k2 * u < im[n2]!) continue;
            const base = (k2 === k ? 0 : marginFee[Math.abs(k2 - k)]!) + capital[k2]! + W[n2]![k2]!;
            for (let i = 0; i < TIERS.length; i++) {
              const c = take[n]![n2]![i]! + base;
              if (c < bv) { bv = c; bm = { lots: n2, units: k2, tier: TIERS[i]!, slot: slotOf[n]![n2]![i]! }; }
            }
          }
        }
        V[n]!.push(bv);
        best[t]![n]!.push(bm);
      }
    }
    if (t === 0) break;
    // Before step t's decisions: its settlement, unless the federation holds.
    const Wt: number[][] = [];
    for (let n = 0; n < nL; n++) {
      Wt.push([]);
      for (let k = 0; k < nU; k++) {
        if (f.hold[t] === 1) { Wt[n]!.push(V[n]![k]!); continue; }
        const s = settle(f, config, n, k * u, pset[t - 1]!, f.marks[t]!, f.target_lots[t - 1]!);
        Wt[n]!.push(s.tracking + s.penalty + s.lightning + V[s.lots_after]![k]!);
      }
    }
    W = Wt;
  }
  return { value: -V[0]![0]!, best };
}
