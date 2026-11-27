// Family 13 baselines (docs/tasks.md §16). Each plans at the first observation of each slot (read the
// next slot, or reach a short and a margin with at most one transfer and one take, then wait).
//
//   idle            never trades: the unhedged holder (the floor; it scores minus its tracking error)
//   naive           at the first packet that says VALID, unverified, posts the minimum margin and sells
//                   the full hedge on the standard tier; once filled it holds to maturity
//   thin_margin     `hedger` keeping only the initial margin: no buffer against a jump
//   unverified      `hedger` trading on any packet that says VALID
//   premium_always  `hedger` with every take on the paid tier
//   hedger          the reference: verifies every packet against the pinned policy and reads the next
//                   slot when one fails, keeps the short at the target on the free tier, and keeps
//                   margin to survive a 20% rise between
//                   settlements, topping up below it and withdrawing above it plus two units
//   oracle          the ceiling, privileged: plays the dynamic program of `ceilingOf`

import type { Agent } from "../../harness/agent.ts";
import type { Json } from "../../harness/json.ts";
import type { FederationPolicy, Packet, ShzConfig, ShzFixture, Tier } from "./generate.ts";
import { ceilingOf, divCeil, notionalSats, packetFault, type Ceiling } from "./world.ts";

export interface ShzView {
  step: number;
  steps: number;
  slot: number;
  slots_per_step: number;
  clock: { now_ms: number };
  packet: Packet | null;
  federation: Omit<FederationPolicy, "members"> & { members: string[] };
  target: { lots: number; usd: number; lot_usd: number; balance_sats: number };
  account: { short_lots: number; margin_sats: number; margin_unit_sats: number; max_margin_units: number; liquidation_mark_usd: number | null };
  this_step: { took: boolean; moved_margin: boolean };
  venue: { max_lots: number; max_leverage: number; maintenance_bps: number };
}

interface Obs { view: ShzView; last: { accepted: boolean; result: Json } | null; }

/** Why the client may not trade on this step's packet under the pinned policy, or null. */
export const faultOf = (v: ShzView): string | null =>
  packetFault(v.packet, { ...v.federation, members: v.federation.members.length, keys: v.federation.members }, v.clock.now_ms);

/** A slot's plan: read the next slot, end the step, hold to maturity, or reach (lots, units) with a take on `tier`. */
export type Plan = { kind: "refresh" } | { kind: "wait" } | { kind: "commit" } | { kind: "move"; lots: number; units: number; tier: Tier };

/**
 * Plans at the first observation of each slot, then derives each move from the account against the
 * plan: deposit first, then the take, then a withdrawal, then wait. A refused move ends the step.
 * Deriving moves from the account keeps the policy in step when it is replayed over an episode in
 * which someone else sent some of the moves.
 */
export abstract class Planner implements Agent {
  abstract readonly id: string;
  private at = "";
  private current: Plan = { kind: "wait" };

  reset(_episode?: unknown, privileged?: Json): void { this.at = ""; this.current = { kind: "wait" }; this.onReset(privileged); }
  protected onReset(_privileged?: Json): void {}
  protected abstract plan(v: ShzView): Plan;

  act(observation: Json): Json {
    const o = observation as unknown as Obs;
    const v = o.view;
    const at = `${v.step}.${v.slot}`;
    if (at !== this.at) { this.at = at; this.current = this.plan(v); }
    else if (o.last && !o.last.accepted) this.current = { kind: "wait" };
    return nextMove(v, this.current);
  }
}

/** The next move toward a plan from the account as it stands. */
export function nextMove(v: ShzView, plan: Plan): Json {
  if (plan.kind !== "move") return { tool: plan.kind };
  const a = v.account;
  const u = a.margin_unit_sats;
  const units = a.margin_sats / u;
  if (plan.units > units && !v.this_step.moved_margin) return { tool: "deposit", args: { sats: (plan.units - units) * u } };
  if (plan.lots !== a.short_lots && !v.this_step.took) return { tool: "take", args: { side: plan.lots > a.short_lots ? "sell" : "buy", lots: Math.abs(plan.lots - a.short_lots), tier: plan.tier } };
  if (plan.units < units && !v.this_step.moved_margin) return { tool: "withdraw", args: { sats: (units - plan.units) * u } };
  return { tool: "wait" };
}

export class Idle extends Planner {
  readonly id = "idle";
  protected plan(): Plan { return { kind: "commit" }; }
}

export class Naive extends Planner {
  readonly id = "naive";
  protected plan(v: ShzView): Plan {
    if (v.account.short_lots > 0) return { kind: "commit" };
    const p = v.packet;
    if (p === null || p.status !== "VALID" || p.price_usd === null) return { kind: "wait" };
    const lots = v.target.lots;
    const im = divCeil(notionalSats(lots * v.target.lot_usd, p.price_usd), v.venue.max_leverage);
    const units = Math.max(v.account.margin_sats / v.account.margin_unit_sats, divCeil(im, v.account.margin_unit_sats));
    return { kind: "move", lots, units, tier: "standard" };
  }
}

export interface HedgerParams { tier: Tier; verify: boolean; /** Rise in bps the margin must survive between settlements; 0 keeps only the initial margin. */ buffer_bps: number; band_units: number; }

/** Margin in sats for a short of `lots` to stay above maintenance through a rise of `buffer` bps, and at least the initial margin. */
export function marginFor(v: ShzView, lots: number, price: number, bufferBps: number): number {
  if (lots === 0) return 0;
  const notional = notionalSats(lots * v.target.lot_usd, price);
  const im = divCeil(notional, v.venue.max_leverage);
  // m ≥ notional × (1 − (1 − maintenance) / (1 + buffer)).
  const need = divCeil(notional * (bufferBps + v.venue.maintenance_bps), 10_000 + bufferBps);
  return Math.max(im, need);
}

export class Hedger extends Planner {
  readonly id: string;
  private readonly p: HedgerParams;
  private price: number | null = null;
  constructor(id: string, p: HedgerParams) { super(); this.id = id; this.p = p; }

  protected override onReset(): void { this.price = null; }

  protected plan(v: ShzView): Plan {
    const pk = v.packet;
    const says = pk !== null && pk.status === "VALID" && pk.price_usd !== null;
    const usable = this.p.verify ? faultOf(v) === null : says;
    // A packet that says VALID but fails the policy: read the next slot while there is one.
    if (says && !usable && v.slot + 1 < v.slots_per_step && !v.this_step.took) return { kind: "refresh" };
    if (usable) this.price = pk!.price_usd!;
    if (this.price === null) return { kind: "wait" };
    const a = v.account;
    const u = a.margin_unit_sats;
    const units = a.margin_sats / u;
    const lots2 = usable ? Math.min(v.venue.max_lots, v.target.lots) : a.short_lots;
    const needUnits = Math.min(a.max_margin_units, divCeil(marginFor(v, lots2, this.price, this.p.buffer_bps), u));
    // Top up whenever short of the requirement; withdraw the excess only on a usable packet, whose price is the venue's mark.
    const units2 = units < needUnits ? needUnits : usable && units > needUnits + this.p.band_units ? needUnits : units;
    return { kind: "move", lots: lots2, units: units2, tier: this.p.tier };
  }
}

/** Ceiling, privileged: the moves of `ceilingOf` from each state. */
export class Oracle extends Planner {
  readonly id = "oracle";
  readonly privileged = true;
  private readonly config: ShzConfig;
  private plan_: Ceiling | null = null;
  constructor(config: ShzConfig) { super(); this.config = config; }

  protected override onReset(privileged?: Json): void {
    if (!privileged) throw new Error("oracle needs privileged information");
    this.plan_ = ceilingOf(privileged as unknown as ShzFixture, this.config);
  }

  protected plan(v: ShzView): Plan {
    const a = v.account;
    const m = this.plan_!.best[v.step]![a.short_lots]![a.margin_sats / a.margin_unit_sats]!;
    if (m.lots !== a.short_lots && v.slot < m.slot) return { kind: "refresh" };
    return { kind: "move", lots: m.lots, units: m.units, tier: m.tier };
  }
}

export const HEDGER: HedgerParams = { tier: "standard", verify: true, buffer_bps: 2000, band_units: 2 };

export const shzBaselines = (config: ShzConfig): Agent[] => [
  new Idle(),
  new Naive(),
  new Hedger("thin_margin", { ...HEDGER, buffer_bps: 0 }),
  new Hedger("unverified", { ...HEDGER, verify: false }),
  new Hedger("premium_always", { ...HEDGER, tier: "premium" }),
  new Hedger("hedger", HEDGER),
  new Oracle(config),
];
