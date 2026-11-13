// Family 11 baselines (docs/tasks.md §14). Each drives the same DAG workflow through the host; they
// differ only in what they decide after observing. `Driver` walks a pass node by node; a policy
// supplies `decide`, called at `observe` with the evidence the host just returned.
//
//   idle          observes and freezes: never funds (the floor; doing nothing is safe and earns 0)
//   trusting      funds, then claims at the first confirmation at the current estimate; checks nothing
//   no_depth      the workflow's checks and fees, but claims at one confirmation
//   estimate_fee  the workflow's checks and depth, but bids the current estimate and never re-bids
//   workflow      the reference: funds only when the round trip pays at current fees plus a quarter;
//                 waits for three confirmations; checks digest, key, time left and amount; bids 1.25x
//                 the estimate, re-bids higher each block it waits, and 4x near the deadline;
//                 otherwise freezes and lets the armed refund run
//   oracle        the ceiling, privileged: knows the desk and every block's clearing rate

import type { Agent } from "../../harness/agent.ts";
import type { Json } from "../../harness/json.ts";
import { HOLD_TOOL, INCIDENT_TOOL, NODE_TOOL, REFRESH_TOOL, type Node } from "./dag.ts";
import type { Quote } from "./generate.ts";
import { parseHtlc } from "./script.ts";
import { ceilingOf, type PlanInput } from "./world.ts";

export interface Evidence {
  height: number;
  fee_estimate_sat_vb: number;
  in_htlc: { status: string; confirmations: number; refund_height: number; pending_refund: { fee_rate: number; broadcast_height: number } | null };
  payout_htlc: { status: string; confirmations: number; amount_sats: number; script_hex: string; pending_claim: { fee_rate: number; broadcast_height: number } | null } | null;
  preimage_broadcast: boolean;
  refund_armed: boolean;
}

export interface SwapView {
  workflow: { node: Node; pass: { action: string | null; fee_rate: number | null } };
  height: number;
  quote: Quote & { quote_valid_at_height: number };
  vbytes: { fund: number; claim: number; refund: number };
  wallet: { claim_pubkey_hash: string; refund_pubkey_hash: string; preimage_digest: string };
  max_fee_rate: number;
  armed_refund_fee_multiplier: number;
}

interface Obs { view: SwapView; budget: { blocks: number }; last: { accepted: boolean; result: Record<string, unknown> | null } | null; }

export type Decision =
  | { kind: "fund" }
  | { kind: "claim"; fee_rate: number }
  | { kind: "refund"; fee_rate: number }
  | { kind: "wait"; blocks: number }
  | { kind: "stop" };

const ACTION_OF = { fund: "fund_in", claim: "claim_out", refund: "refund_in" } as const;
const isEvidence = (r: Record<string, unknown> | null | undefined): r is Record<string, unknown> & Evidence =>
  !!r && "fee_estimate_sat_vb" in r && "in_htlc" in r && "refund_armed" in r;

/** Walks the DAG for whatever the policy decides. */
export abstract class Driver implements Agent {
  abstract readonly id: string;
  protected ev: Evidence | null = null;
  private pending: Decision | null = null;

  reset(_episode?: unknown, privileged?: Json): void { this.ev = null; this.pending = null; this.onReset(privileged); }
  protected onReset(_privileged?: Json): void {}
  protected abstract decide(view: SwapView, ev: Evidence): Decision;

  act(observation: Json): Json {
    const o = observation as unknown as Obs;
    const node = o.view.workflow.node;
    const r = o.last?.result;
    if (o.last?.accepted && isEvidence(r)) this.ev = r;
    else if (o.last?.accepted && r && isEvidence(r.evidence as Record<string, unknown>)) this.ev = r.evidence as unknown as Evidence;
    if (o.last && !o.last.accepted) {
      // A baseline that is refused freezes rather than guess; the armed refund covers a funded swap.
      return node === "simulate" || node === "display" ? { tool: REFRESH_TOOL } : { tool: INCIDENT_TOOL };
    }
    switch (node) {
      case "start": case "hold": case "recovery": return { tool: NODE_TOOL.observe };
      case "observe": {
        const d = this.decide(o.view, this.ev!);
        this.pending = null;
        if (d.kind === "stop") return { tool: INCIDENT_TOOL };
        if (d.kind === "wait") {
          if (o.budget.blocks <= 0) return { tool: INCIDENT_TOOL };
          return { tool: HOLD_TOOL, args: { blocks: Math.max(1, Math.min(d.blocks, o.budget.blocks)) } };
        }
        this.pending = d;
        return { tool: NODE_TOOL.inspect, args: { action: ACTION_OF[d.kind] } };
      }
      case "inspect": {
        // Replayed as a skill over someone else's episode, the pass may not be the one this policy chose.
        if (!this.onPlan(o.view, false)) return { tool: NODE_TOOL.observe };
        const d = this.pending!;
        return { tool: NODE_TOOL.validate, args: d.kind === "claim" || d.kind === "refund" ? { fee_rate: d.fee_rate } : {} };
      }
      case "validate": return this.onPlan(o.view, true) ? { tool: NODE_TOOL.simulate } : { tool: NODE_TOOL.observe };
      case "simulate": return this.onPlan(o.view, true) ? { tool: NODE_TOOL.display } : { tool: REFRESH_TOOL };
      case "display": return this.onPlan(o.view, true) ? { tool: NODE_TOOL.approval } : { tool: REFRESH_TOOL };
      case "approval": return this.onPlan(o.view, true) ? { tool: NODE_TOOL.execute } : { tool: REFRESH_TOOL };
      case "execute": return { tool: NODE_TOOL.verify };
      case "verify": return { tool: NODE_TOOL.reconcile };
      case "reconcile": return { tool: NODE_TOOL.complete };
      default: return { tool: INCIDENT_TOOL };
    }
  }

  /** The open pass is the action this policy decided, with its fee once validated. */
  private onPlan(v: SwapView, validated: boolean): boolean {
    const d = this.pending;
    if (d === null || d.kind === "wait" || d.kind === "stop" || ACTION_OF[d.kind] !== v.workflow.pass.action) return false;
    if (!validated || d.kind === "fund") return true;
    return v.workflow.pass.fee_rate === d.fee_rate;
  }
}

const funded = (ev: Evidence): boolean => ev.in_htlc.status !== "unfunded";

export class Idle extends Driver {
  readonly id = "idle";
  protected decide(): Decision { return { kind: "stop" }; }
}

export class Trusting extends Driver {
  readonly id = "trusting";
  protected decide(v: SwapView, ev: Evidence): Decision {
    if (!funded(ev)) return v.height === v.quote.quote_valid_at_height ? { kind: "fund" } : { kind: "stop" };
    const p = ev.payout_htlc;
    if (p && p.status === "confirmed") return p.pending_claim ? { kind: "wait", blocks: 1 } : { kind: "claim", fee_rate: ev.fee_estimate_sat_vb };
    if (p || v.height >= v.quote.in_timeout_height) return { kind: "stop" };
    return { kind: "wait", blocks: 1 };
  }
}

export interface CarefulParams { depth: number; headroom: number; rebid: boolean; }

/** The workflow's rules with three knobs; `workflow` is the reference setting. */
export class Careful extends Driver {
  readonly id: string;
  private readonly p: CarefulParams;
  constructor(id: string, p: CarefulParams) { super(); this.id = id; this.p = p; }

  protected decide(v: SwapView, ev: Evidence): Decision {
    const q = v.quote;
    const est = ev.fee_estimate_sat_vb;
    const h = v.height;
    const bid = Math.min(v.max_fee_rate, Math.ceil(this.p.headroom * est));
    if (!funded(ev)) {
      if (h !== q.quote_valid_at_height) return { kind: "stop" };
      const roundTrip = q.swap_value_sats + q.amount_out_sats - q.amount_in_sats - v.vbytes.fund * est - v.vbytes.claim * bid;
      return roundTrip > 0 ? { kind: "fund" } : { kind: "stop" };
    }
    const p = ev.payout_htlc;
    if (p === null) return h >= q.in_timeout_height ? { kind: "stop" } : { kind: "wait", blocks: 1 };
    if (p.status !== "confirmed") return { kind: "stop" };
    const d = parseHtlc(Buffer.from(p.script_hex, "hex"));
    if ("error" in d) return { kind: "stop" };
    // A claim broadcast now confirms at h + 1 at the earliest and must confirm by the locktime.
    const blocksLeft = d.locktime - h;
    if (p.pending_claim) {
      if (!this.p.rebid || h <= p.pending_claim.broadcast_height) return { kind: "wait", blocks: 1 };
      // Escalate each block the claim sits unconfirmed; near the deadline, bid well over the current rate.
      const urgent = blocksLeft <= URGENT_BLOCKS ? Math.ceil(URGENT_MULTIPLIER * est) : 0;
      const next = Math.max(p.pending_claim.fee_rate + 1, Math.ceil(1.5 * p.pending_claim.fee_rate), bid, urgent);
      return { kind: "claim", fee_rate: Math.min(v.max_fee_rate, next) };
    }
    if (Buffer.from(d.digest).toString("hex") !== v.wallet.preimage_digest || Buffer.from(d.claimPkh).toString("hex") !== v.wallet.claim_pubkey_hash) return { kind: "stop" };
    // Keep a block of slack beyond the earliest confirmation.
    if (p.confirmations < this.p.depth) return blocksLeft - (this.p.depth - p.confirmations) >= 2 ? { kind: "wait", blocks: 1 } : { kind: "stop" };
    if (blocksLeft < 2) return { kind: "stop" };
    const claimNet = q.swap_value_sats + p.amount_sats - q.amount_in_sats - v.vbytes.claim * bid;
    const refundNet = -v.vbytes.refund * v.armed_refund_fee_multiplier * est;
    return claimNet > refundNet ? { kind: "claim", fee_rate: bid } : { kind: "stop" };
  }
}

/** Ceiling, privileged: the plan of `ceilingOf`, from the hidden desk and fee path. */
export class Oracle extends Driver {
  readonly id = "oracle";
  readonly privileged = true;
  private plan: ReturnType<typeof ceilingOf> | null = null;
  private truth: { desk: PlanInput["desk"]; fees: number[]; start_height: number } | null = null;

  protected override onReset(privileged?: Json): void {
    this.truth = (privileged ?? null) as typeof this.truth;
    this.plan = null;
  }

  protected decide(v: SwapView, ev: Evidence): Decision {
    if (!this.truth) throw new Error("oracle needs privileged information");
    this.plan ??= ceilingOf({ start_height: this.truth.start_height, quote: v.quote, vbytes: v.vbytes, fees: this.truth.fees, desk: this.truth.desk });
    const plan = this.plan;
    if (!plan.fund) return { kind: "stop" };
    if (!funded(ev)) return { kind: "fund" };
    const p = ev.payout_htlc;
    if (p?.pending_claim) return { kind: "wait", blocks: 1 };
    if (v.height < plan.claim_height!) return { kind: "wait", blocks: plan.claim_height! - v.height };
    if (v.height === plan.claim_height) return { kind: "claim", fee_rate: plan.fee_rate! };
    return { kind: "stop" };
  }
}

/** With this many blocks or fewer left before the desk can refund, a re-bid goes to URGENT_MULTIPLIER times the estimate. */
export const URGENT_BLOCKS = 3;
export const URGENT_MULTIPLIER = 4;

export const WORKFLOW: CarefulParams = { depth: 3, headroom: 1.25, rebid: true };

export const swapBaselines = (): Agent[] => [
  new Idle(),
  new Trusting(),
  new Careful("no_depth", { ...WORKFLOW, depth: 1 }),
  new Careful("estimate_fee", { ...WORKFLOW, headroom: 1, rebid: false }),
  new Careful("workflow", WORKFLOW),
  new Oracle(),
];
