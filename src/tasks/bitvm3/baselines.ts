// Family 12 baselines (docs/tasks.md §15). Every one but the oracle reads only the observation, so
// each turn's action is a function of the view alone.
//
//   idle           stops at once: evaluates nothing and lets every claim pay out (the floor; 0)
//   cheap_only     checks every claim's proof natively and evaluates only those that fail, earliest
//                  window first: it catches wrong statements and never an invalid proof
//   evaluate_all   no check; evaluates every claim in arrival order while its window allows, paying
//                  for each evaluation
//   largest_first  the reference: checks every claim, then evaluates the claim with the largest
//                  expected recovery, its output times the probability it is fraudulent given its
//                  check, less the evaluation's cost
//   oracle         the ceiling, privileged: knows each claim's class, every reorganization and every
//                  block's clearing rate, and follows the exact schedule of ceilingOf
//
// The three watchers share one disprove rule: bid 1.25x the estimate, re-bid each block the disprove
// waits at 1.5x the last bid, 4x the estimate in the last block that can still confirm it, and never
// so much that the output falls below dust or returns nothing.

import type { Agent } from "../../harness/agent.ts";
import type { Json } from "../../harness/json.ts";
import type { Bitvm3View, ClaimView } from "./env.ts";
import type { Bitvm3Fixture } from "./generate.ts";
import { ceilingOf, type PlanStep } from "./world.ts";

interface Obs { view: Bitvm3View; }

export const HEADROOM = 1.25;
export const REBID = 1.5;
export const URGENT_MULTIPLIER = 4;

/** The probability that a claim is fraudulent, from the shown prior and its check. */
export function fraudProbability(v: Pick<Bitvm3View, "fraud_prior_ppm">, c: Pick<ClaimView, "check">): number {
  const p = v.fraud_prior_ppm;
  if (c.check === "fail") return 1;
  if (c.check === "pass") return p.invalid_proof / (p.honest + p.invalid_proof);
  return (p.wrong_statement + p.invalid_proof) / (p.honest + p.wrong_statement + p.invalid_proof);
}

/** The highest bid that leaves the disprove's output above dust. */
export const dustCap = (v: Bitvm3View, c: ClaimView): number => Math.min(v.max_fee_rate, Math.floor((c.k_sats - v.dust_sats) / v.vbytes_disprove));

/** The first bid for a disprove broadcast now. */
export const firstBid = (v: Bitvm3View, c: ClaimView): number => Math.min(dustCap(v, c), Math.ceil(HEADROOM * v.fee_estimate_sat_vb));

/** The next disprove or replacement for a claim whose reject label is held, earliest window first; null when none is due. */
export function disproveAction(v: Bitvm3View): Json | null {
  const h = v.height;
  const est = v.fee_estimate_sat_vb;
  const due = v.claims
    .filter((c) => c.evaluation === "reject" && c.status === "open" && h <= c.last_disprove_height - 1)
    .sort((a, b) => a.last_disprove_height - b.last_disprove_height || (a.id < b.id ? -1 : 1));
  for (const c of due) {
    let bid = Math.ceil(HEADROOM * est);
    if (c.disprove) {
      // Broadcast in this block: it has not had a block to confirm in yet.
      if (c.disprove.broadcast_height >= h) continue;
      bid = Math.max(bid, c.disprove.fee_rate + 1, Math.ceil(REBID * c.disprove.fee_rate));
    }
    if (c.last_disprove_height - h <= 1) bid = Math.max(bid, URGENT_MULTIPLIER * est);
    bid = Math.min(bid, dustCap(v, c));
    if (bid < 1 || (c.disprove && bid <= c.disprove.fee_rate)) continue;
    return { tool: "disprove", args: { claim: c.id, fee_rate: bid } };
  }
  return null;
}

export type Selection = "fifo" | "flagged" | "expected";
export interface WatcherParams { check: boolean; select: Selection; }

/** A watcher that checks, disproves, and picks what to evaluate by `select`. */
export class Watcher implements Agent {
  readonly id: string;
  private readonly p: WatcherParams;
  constructor(id: string, p: WatcherParams) { this.id = id; this.p = p; }

  act(observation: Json): Json {
    const v = (observation as unknown as Obs).view;
    if (this.p.check) {
      const unchecked = v.claims.find((c) => c.check === null && c.status === "open");
      if (unchecked) return { tool: "check", args: { claim: unchecked.id } };
    }
    const d = disproveAction(v);
    if (d) return d;
    if (!v.evaluator.busy) {
      const next = this.choose(v);
      if (next) return { tool: "evaluate", args: { claim: next.id } };
    }
    return { tool: "wait", args: { blocks: 1 } };
  }

  private choose(v: Bitvm3View): ClaimView | null {
    const h = v.height;
    const E = v.evaluator.eval_blocks;
    const cost = v.evaluator.cost_sats;
    // A verdict at h + E, broadcast then, confirms by the last disprove height at the latest.
    const open = v.claims.filter((c) => c.status === "open" && c.evaluation === null && h + E + 1 <= c.last_disprove_height);
    const recover = (c: ClaimView): number => c.k_sats - v.vbytes_disprove * firstBid(v, c);
    const byWindow = (a: ClaimView, b: ClaimView): number => a.last_disprove_height - b.last_disprove_height || (a.id < b.id ? -1 : 1);
    if (this.p.select === "fifo") return [...open].sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? null;
    if (this.p.select === "flagged") return open.filter((c) => c.check === "fail" && recover(c) - cost > 0).sort(byWindow)[0] ?? null;
    const ev = (c: ClaimView): number => fraudProbability(v, c) * recover(c) - cost;
    return open.filter((c) => ev(c) > 0).sort((a, b) => ev(b) - ev(a) || byWindow(a, b))[0] ?? null;
  }
}

export class Idle implements Agent {
  readonly id = "idle";
  act(): Json { return { tool: "stop" }; }
}

/** Ceiling, privileged: the schedule of ceilingOf, from the whole fixture. */
export class Oracle implements Agent {
  readonly id = "oracle";
  readonly privileged = true;
  private f: Bitvm3Fixture | null = null;
  private plan: PlanStep[] = [];

  reset(_episode?: unknown, privileged?: Json): void {
    this.f = (privileged ?? null) as Bitvm3Fixture | null;
    this.plan = this.f ? ceilingOf(this.f).plan : [];
  }

  act(observation: Json): Json {
    if (!this.f) throw new Error("oracle needs privileged information");
    const v = (observation as unknown as Obs).view;
    const h = v.height;
    const byId = new Map(v.claims.map((c) => [c.id, c]));
    const idOf = (p: PlanStep): string => this.f!.claims[p.claim]!.id;
    for (const p of this.plan) {
      const c = byId.get(idOf(p));
      if (c && c.evaluation === "reject" && c.disprove === null && c.status === "open") return { tool: "disprove", args: { claim: c.id, fee_rate: p.fee_rate } };
    }
    const due = this.plan.find((p) => p.start === h);
    if (due && !v.evaluator.busy && byId.get(idOf(due))?.evaluation === null) return { tool: "evaluate", args: { claim: idOf(due) } };
    const ahead = this.plan.flatMap((p) => [p.start, p.start + v.evaluator.eval_blocks]).filter((t) => t > h);
    if (ahead.length === 0) return { tool: "stop" };
    return { tool: "wait", args: { blocks: Math.min(...ahead, v.horizon_height) - h } };
  }
}

export const LARGEST_FIRST: WatcherParams = { check: true, select: "expected" };

export const bitvm3Baselines = (): Agent[] => [
  new Idle(),
  new Watcher("cheap_only", { check: true, select: "flagged" }),
  new Watcher("evaluate_all", { check: false, select: "fifo" }),
  new Watcher("largest_first", LARGEST_FIRST),
  new Oracle(),
];
