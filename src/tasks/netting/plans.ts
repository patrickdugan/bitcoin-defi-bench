// Settlement plans for family 6: what a plan is, when it is valid, what it costs, and the three
// baseline rules that produce one. Baselines work from the instance an observation carries, which
// is the fixture without its bookkeeping fields, so the same functions serve the agent-facing
// path and the identity control's direct computation.

import type { RejectReason } from "../../harness/agent.ts";
import { cmp, pairKey } from "../../harness/order.ts";
import { minCostFlow, type Arc } from "./flow.ts";
import { netPayable, obligation, type Link, type NettingFixture, type Trade, type Trader } from "./generate.ts";

export type Via = "link" | "ghost";
export interface Transfer { from: string; to: string; sats: number; via: Via; }

/** The instance as the agent sees it. */
export interface Instance {
  traders: Trader[];
  trades: Trade[];
  settlement_value: number;
  links: Link[];
  ghost: { rate_ppm: number };
  base_fee_sats: number;
}

export const instanceOf = (fixture: NettingFixture): Instance => ({
  traders: fixture.traders.map((t) => ({ ...t })),
  trades: fixture.trades.map((t) => ({ ...t })),
  settlement_value: fixture.settlement_value,
  links: fixture.links.map((l) => ({ ...l })),
  ghost: { ...fixture.ghost },
  base_fee_sats: fixture.base_fee_sats,
});

export interface Violation { reason: RejectReason; detail: string; }

export interface Evaluation {
  violations: Violation[];
  /** Σ sats × rate / 10⁶ + base fee × transfers, in sats. Defined for an invalid plan too. */
  cost: number;
  transfers: number;
  gross_volume: number;
  ghost_volume: number;
}

const MILLION = 1_000_000;

/** Parse a plan from an action's args. Returns the transfers or the reason it is malformed. */
export function parsePlan(raw: unknown): Transfer[] | "malformed" {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { transfers?: unknown }).transfers)) return "malformed";
  const out: Transfer[] = [];
  for (const t of (raw as { transfers: unknown[] }).transfers) {
    if (typeof t !== "object" || t === null) return "malformed";
    const x = t as { from?: unknown; to?: unknown; sats?: unknown; via?: unknown };
    if (typeof x.from !== "string" || typeof x.to !== "string" || typeof x.sats !== "number" || (x.via !== "link" && x.via !== "ghost")) return "malformed";
    out.push({ from: x.from, to: x.to, sats: x.sats, via: x.via });
  }
  return out;
}

/** Every rule a plan must satisfy, with every violation listed. Touches no state. */
export function evaluatePlan(instance: Instance, plan: readonly Transfer[]): Evaluation {
  const violations: Violation[] = [];
  const traders = new Map(instance.traders.map((t) => [t.id, t]));
  const links = new Map(instance.links.map((l) => [pairKey(l.a, l.b), l]));
  const onLink = new Map<string, number>();
  const paid = new Map<string, number>();
  const received = new Map<string, number>();
  let cost = 0, gross = 0, ghost = 0;
  plan.forEach((t, i) => {
    if (!traders.has(t.from) || !traders.has(t.to)) { violations.push({ reason: "unknown_node", detail: `transfer ${i}: ${t.from} or ${t.to} is not a trader` }); return; }
    if (t.from === t.to) { violations.push({ reason: "self_pair", detail: `transfer ${i}: ${t.from} to itself` }); return; }
    if (!Number.isInteger(t.sats) || t.sats <= 0) { violations.push({ reason: "not_integer", detail: `transfer ${i}: sats must be a positive whole number` }); return; }
    const key = pairKey(t.from, t.to);
    const link = links.get(key);
    if (t.via === "link") {
      if (!link) { violations.push({ reason: "no_link", detail: `transfer ${i}: ${t.from} and ${t.to} have no link` }); return; }
      onLink.set(key, (onLink.get(key) ?? 0) + t.sats);
      cost += (t.sats * link.rate_ppm) / MILLION;
    } else {
      ghost += t.sats;
      cost += (t.sats * instance.ghost.rate_ppm) / MILLION;
    }
    gross += t.sats;
    cost += instance.base_fee_sats;
    paid.set(t.from, (paid.get(t.from) ?? 0) + t.sats);
    received.set(t.to, (received.get(t.to) ?? 0) + t.sats);
  });
  for (const key of [...onLink.keys()].sort(cmp)) {
    const link = links.get(key)!;
    if (onLink.get(key)! > link.capacity_sats) violations.push({ reason: "over_budget", detail: `link ${key}: ${onLink.get(key)} exceeds its capacity ${link.capacity_sats}` });
  }
  const net = netPayable({ ...instance, version: "", seed: 0, cell: "", params: { traders: 0, trades: 0, graph: "uniform", link_capacity_ppm_of_notional: 0 } });
  for (const trader of instance.traders) {
    const p = paid.get(trader.id) ?? 0;
    const r = received.get(trader.id) ?? 0;
    if (p > trader.collateral_sats) violations.push({ reason: "over_budget", detail: `${trader.id} pays ${p}, more than its collateral ${trader.collateral_sats}` });
    if (p - r !== net.get(trader.id)) violations.push({ reason: "unbalanced", detail: `${trader.id} pays net ${p - r}, must pay net ${net.get(trader.id)}` });
  }
  return { violations, cost, transfers: plan.length, gross_volume: gross, ghost_volume: ghost };
}

/** Transfers aggregated per (from, to, via), in canonical order. */
function aggregate(transfers: Transfer[]): Transfer[] {
  const sum = new Map<string, Transfer>();
  for (const t of transfers) {
    if (t.sats === 0) continue;
    const key = `${t.from}>${t.to}>${t.via}`;
    const existing = sum.get(key);
    if (existing) existing.sats += t.sats; else sum.set(key, { ...t });
  }
  return [...sum.keys()].sort(cmp).map((k) => sum.get(k)!);
}

/** Send `sats` from payer to payee: on their link while it has room, then by ghost link. */
function route(payer: string, payee: string, sats: number, links: Map<string, Link>, room: Map<string, number>, out: Transfer[]): void {
  const key = pairKey(payer, payee);
  const link = links.get(key);
  let rest = sats;
  if (link) {
    const onLink = Math.min(rest, room.get(key) ?? link.capacity_sats);
    if (onLink > 0) { out.push({ from: payer, to: payee, sats: onLink, via: "link" }); room.set(key, (room.get(key) ?? link.capacity_sats) - onLink); rest -= onLink; }
  }
  if (rest > 0) out.push({ from: payer, to: payee, sats: rest, via: "ghost" });
}

/** The floor: every trade settled on its own, no netting. */
export function settleGross(instance: Instance): Transfer[] {
  const links = new Map(instance.links.map((l) => [pairKey(l.a, l.b), l]));
  const room = new Map<string, number>();
  const out: Transfer[] = [];
  for (const t of instance.trades) {
    const v = obligation(t, instance.settlement_value);
    if (v === 0) continue;
    route(v > 0 ? t.short : t.long, v > 0 ? t.long : t.short, Math.abs(v), links, room, out);
  }
  return aggregate(out);
}

/** The reference heuristic: each pair's trades netted to one amount. */
export function settleBilateral(instance: Instance): Transfer[] {
  const links = new Map(instance.links.map((l) => [pairKey(l.a, l.b), l]));
  const room = new Map<string, number>();
  // Net per pair, oriented from the pair's canonical first trader to its second.
  const net = new Map<string, number>();
  for (const t of instance.trades) {
    const v = obligation(t, instance.settlement_value);
    const [a] = [t.long, t.short].sort(cmp);
    // v > 0: short pays long. Oriented a → b: positive when a is the payer.
    const aPays = (v > 0 ? t.short : t.long) === a;
    const key = pairKey(t.long, t.short);
    net.set(key, (net.get(key) ?? 0) + (aPays ? Math.abs(v) : -Math.abs(v)));
  }
  const out: Transfer[] = [];
  for (const key of [...net.keys()].sort(cmp)) {
    const amount = net.get(key)!;
    if (amount === 0) continue;
    const [a, b] = key.split("|") as [string, string];
    route(amount > 0 ? a : b, amount > 0 ? b : a, Math.abs(amount), links, room, out);
  }
  return aggregate(out);
}

/**
 * The ceiling: the exact minimum-cost flow. Each trader is split into an in-node and an out-node
 * joined by an arc of capacity equal to its collateral, so a trader never pays more than it holds;
 * links are arcs in both directions at their capacity and rate; ghost links join every pair at the
 * ghost rate. Exact when the base fee is zero; with a base fee it is a reference, not a bound.
 */
export function settleOptimal(instance: Instance): Transfer[] {
  const ids = instance.traders.map((t) => t.id).sort(cmp);
  const index = new Map(ids.map((id, i) => [id, i]));
  const IN = (i: number): number => 2 * i;
  const OUT = (i: number): number => 2 * i + 1;
  const arcs: Arc[] = [];
  const labels: Array<{ from: string; to: string; via: Via } | null> = [];
  for (const t of instance.traders) { arcs.push({ from: IN(index.get(t.id)!), to: OUT(index.get(t.id)!), capacity: t.collateral_sats, cost: 0 }); labels.push(null); }
  const linked = new Set<string>();
  for (const l of [...instance.links].sort((x, y) => cmp(pairKey(x.a, x.b), pairKey(y.a, y.b)))) {
    linked.add(pairKey(l.a, l.b));
    for (const [from, to] of [[l.a, l.b], [l.b, l.a]] as const) {
      arcs.push({ from: OUT(index.get(from)!), to: IN(index.get(to)!), capacity: l.capacity_sats, cost: l.rate_ppm });
      labels.push({ from, to, via: "link" });
    }
  }
  const unlimited = 2 ** 40;
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      arcs.push({ from: OUT(i), to: IN(j), capacity: unlimited, cost: instance.ghost.rate_ppm });
      labels.push({ from: ids[i]!, to: ids[j]!, via: "ghost" });
    }
  }
  const net = netPayable({ ...instance, version: "", seed: 0, cell: "", params: { traders: 0, trades: 0, graph: "uniform", link_capacity_ppm_of_notional: 0 } });
  const supply = Array(2 * ids.length).fill(0) as number[];
  for (const id of ids) supply[IN(index.get(id)!)] = net.get(id)!;
  const { flows } = minCostFlow(2 * ids.length, arcs, supply);
  const out: Transfer[] = [];
  flows.forEach((f, k) => { const label = labels[k]; if (label && f > 0) out.push({ ...label, sats: f }); });
  return aggregate(out);
}
