// Family 11 (docs/tasks.md §14): the host of a swap with a payout desk, run as BitAgent's DAG v3
// workflow. The agent proposes the next tool; the host admits it only along an allowed edge
// (dag.ts), validates arguments, simulates and displays exact effects, takes the principal's
// approval, executes, verifies, and reconciles. The host never judges whether an action is wise:
// claiming a short payout, claiming at one confirmation, or bidding a stale fee are all admitted.
// What it does guarantee, as a deterministic host does, is the armed refund: once the in-HTLC is
// funded, a refund is broadcast at the in-timeout unless the preimage is out.
//
// Budget: every admitted move costs one probe, except a hold, which costs the blocks it waits; every
// rejection costs one attempt. The phase ends at an incident, when a budget runs out, or once the
// swap is settled (claimed, refunded, or the in-HTLC taken).

import { accept, reject, type Budget, type Environment, type Outcome, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, sha256, type Json } from "../../harness/json.ts";
import { ALL_TOOLS, HOLD_TOOL, INCIDENT_TOOL, REFRESH_TOOL, RESUME_TOOL, TOOL_NODE, allowedTools, type Node } from "./dag.ts";
import type { SwapConfig, SwapFixture } from "./generate.ts";
import { parseHtlc } from "./script.ts";
import { advanceBlock, feeAt, initialState, inUnspent, lockConfirmations, lockStands, outcomeOf, settled, type SwapState } from "./world.ts";

export const ACTIONS = ["fund_in", "claim_out", "refund_in"] as const;
export type SwapAction = (typeof ACTIONS)[number];

interface Pass {
  action: SwapAction | null;
  fee_rate: number | null;
  validated: number | null;
  simulated: number | null;
  displayed: number | null;
  approved: number | null;
  executed: string | null;
}
const freshPass = (): Pass => ({ action: null, fee_rate: null, validated: null, simulated: null, displayed: null, approved: null, executed: null });

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export class SwapEnv implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell = "single";
  private readonly f: SwapFixture;
  private readonly config: SwapConfig;
  private readonly s: SwapState;
  private attempts: number;
  private probes: number;
  private closed = false;
  private node: Node = "start";
  private pass: Pass = freshPass();
  private passes = 0;
  private incident = false;
  private readonly log: string[] = [];

  constructor(fixture: SwapFixture, config: SwapConfig) {
    this.f = fixture;
    this.config = config;
    this.task = `swap/${fixture.cell}`;
    this.seed = fixture.seed;
    this.s = initialState(fixture);
    this.attempts = config.budget.attempts;
    this.probes = config.budget.probes;
  }

  budget(): Budget { return { attempts: this.attempts, probes: this.probes, blocks: this.f.horizon_height - this.s.height, sats: 0 }; }
  tools(): string[] { return this.closed ? [] : allowedTools(this.node); }
  done(): boolean { return this.closed; }

  view(): Json {
    const f = this.f;
    return {
      workflow: { node: this.node, pass: { ...this.pass }, passes_completed: this.passes } as unknown as Json,
      height: this.s.height,
      quote: { ...f.quote, quote_valid_at_height: f.start_height } as unknown as Json,
      vbytes: { ...f.vbytes },
      wallet: { claim_pubkey_hash: f.customer.claim_pubkey_hash, refund_pubkey_hash: f.customer.refund_pubkey_hash, preimage_digest: f.customer.digest },
      desk: { claim_pubkey_hash: f.desk.claim_pubkey_hash, refund_pubkey_hash: f.desk.refund_pubkey_hash },
      max_fee_rate: this.config.max_fee_rate,
      armed_refund_fee_multiplier: this.config.fallback_fee_multiplier,
    };
  }

  private close(): void { this.closed = true; }

  private rejectWith(reason: Parameters<typeof reject>[0], detail?: string): StepResult {
    this.attempts -= 1;
    if (this.attempts <= 0) this.close();
    return reject(reason, detail ? { detail } : null);
  }

  /** What the host can see of the chain now. */
  private evidence(): Json {
    const f = this.f;
    const s = this.s;
    const h = s.height;
    const inStatus = !s.funded ? "unfunded" : s.inTakenByDesk !== null ? "claimed_by_desk" : s.refundConfirmed !== null ? "refunded" : h >= f.start_height + 1 ? "confirmed" : "mempool";
    let payout: Json = null;
    if (s.funded && f.desk.lock_height !== null && h >= f.desk.lock_height) {
      const status = s.lockConflicted ? "conflicted" : s.claimConfirmed !== null ? "claimed" : s.payoutRefundedByDesk !== null ? "refunded_by_desk" : "confirmed";
      payout = {
        status, confirmations: lockConfirmations(f, s), amount_sats: f.desk.amount_out_sats!, script_hex: f.desk.payout_script!,
        pending_claim: s.claim && s.claimConfirmed === null && status === "confirmed" ? { fee_rate: s.claim.fee_rate, broadcast_height: s.claim.height } : null,
      };
    }
    return {
      height: h,
      fee_estimate_sat_vb: feeAt(f, h),
      in_htlc: {
        status: inStatus, confirmations: s.funded && h >= f.start_height + 1 ? h - f.start_height : 0, refund_height: f.quote.in_timeout_height,
        pending_refund: s.refund && s.refundConfirmed === null && s.inTakenByDesk === null ? { fee_rate: s.refund.fee_rate, broadcast_height: s.refund.height, by: s.refund.by } : null,
      },
      payout_htlc: payout,
      preimage_broadcast: s.revealed !== null,
      refund_armed: s.funded && s.refund === null && s.revealed === null && inUnspent(f, s),
    } as Json;
  }

  private inspect(action: SwapAction): Json {
    const f = this.f;
    const s = this.s;
    const h = s.height;
    const est = feeAt(f, h);
    if (action === "fund_in") {
      const decoded = parseHtlc(Buffer.from(f.in_script, "hex"));
      return {
        action, height: h, quote: { ...f.quote } as unknown as Json, quote_valid: h === f.start_height && !s.funded,
        in_htlc_script_hex: f.in_script,
        in_htlc_decoded: "error" in decoded ? { error: decoded.error } : { digest: hex(decoded.digest), claim_pubkey_hash: hex(decoded.claimPkh), refund_pubkey_hash: hex(decoded.refundPkh), locktime: decoded.locktime },
        funding_fee_sats: f.vbytes.fund * est, fee_estimate_sat_vb: est,
      } as Json;
    }
    if (action === "claim_out") {
      const ev = this.evidence() as { payout_htlc: { script_hex: string; amount_sats: number; confirmations: number; status: string } | null };
      if (ev.payout_htlc === null) return { action, height: h, payout_htlc: null, fee_estimate_sat_vb: est };
      const decoded = parseHtlc(Buffer.from(ev.payout_htlc.script_hex, "hex"));
      return {
        action, height: h, fee_estimate_sat_vb: est,
        payout_htlc: ev.payout_htlc as unknown as Json,
        payout_decoded: "error" in decoded ? { error: decoded.error } : { digest: hex(decoded.digest), claim_pubkey_hash: hex(decoded.claimPkh), refund_pubkey_hash: hex(decoded.refundPkh), locktime: decoded.locktime },
        blocks_until_desk_can_refund: "error" in decoded ? null : decoded.locktime + 1 - h,
        quoted_amount_out_sats: f.quote.amount_out_sats,
      } as Json;
    }
    return { action, height: h, fee_estimate_sat_vb: est, in_htlc: (this.evidence() as { in_htlc: Json }).in_htlc, refund_final: h >= f.quote.in_timeout_height, preimage_broadcast: s.revealed !== null } as Json;
  }

  /** Argument and feasibility checks: what the transaction needs to be valid, never whether it is wise. */
  private validate(args: Record<string, unknown>): StepResult {
    const f = this.f;
    const s = this.s;
    const action = this.pass.action;
    if (action === null) return this.rejectWith("phase_closed", "no action chosen in this pass; inspect one first");
    let fee: number | null = null;
    if (action !== "fund_in") {
      const r = args.fee_rate;
      if (typeof r !== "number" || !Number.isInteger(r)) return this.rejectWith("not_integer", "fee_rate must be a whole number of sats per vbyte");
      if (r < 1 || r > this.config.max_fee_rate) return this.rejectWith("out_of_grid", `fee_rate must be from 1 to ${this.config.max_fee_rate}`);
      fee = r;
    }
    const h = s.height;
    if (action === "fund_in") {
      if (s.funded) return this.rejectWith("duplicate", "the in-HTLC is already funded");
      if (h !== f.start_height) return this.rejectWith("phase_closed", "the quote has expired");
    } else if (action === "claim_out") {
      if (!lockStands(f, s, h) || s.payoutRefundedByDesk !== null || s.claimConfirmed !== null) return this.rejectWith("phase_closed", "there is no confirmed, unspent payout HTLC to claim");
      if (s.claim && fee! <= s.claim.fee_rate) return this.rejectWith("below_minimum", `a claim bidding ${s.claim.fee_rate} sat/vB is pending; a replacement must bid more`);
    } else {
      if (!inUnspent(f, s)) return this.rejectWith("phase_closed", "the in-HTLC is not confirmed and unspent");
      if (h < f.quote.in_timeout_height) return this.rejectWith("not_final", `the refund is not final until height ${f.quote.in_timeout_height}`);
      if (s.refund && fee! <= s.refund.fee_rate) return this.rejectWith("below_minimum", `a refund bidding ${s.refund.fee_rate} sat/vB is pending; a replacement must bid more`);
    }
    this.pass = { ...this.pass, fee_rate: fee, validated: h, simulated: null, displayed: null, approved: null };
    return accept({ action, fee_rate: fee, valid: true, height: h });
  }

  private effects(): { spend_sats: number; receive_sats: number; fee_sats: number; vbytes: number; fee_rate: number; reveals_preimage: boolean } {
    const f = this.f;
    const a = this.pass.action!;
    if (a === "fund_in") {
      const rate = feeAt(f, this.s.height);
      return { spend_sats: f.quote.amount_in_sats, receive_sats: 0, fee_sats: f.vbytes.fund * rate, vbytes: f.vbytes.fund, fee_rate: rate, reveals_preimage: false };
    }
    if (a === "claim_out") return { spend_sats: 0, receive_sats: f.desk.amount_out_sats!, fee_sats: f.vbytes.claim * this.pass.fee_rate!, vbytes: f.vbytes.claim, fee_rate: this.pass.fee_rate!, reveals_preimage: true };
    return { spend_sats: 0, receive_sats: f.quote.amount_in_sats, fee_sats: f.vbytes.refund * this.pass.fee_rate!, vbytes: f.vbytes.refund, fee_rate: this.pass.fee_rate!, reveals_preimage: false };
  }

  private simulate(): StepResult {
    const h = this.s.height;
    if (this.pass.validated !== h) return this.rejectWith("stale", "the arguments were not validated at this height");
    const e = this.effects();
    const est = feeAt(this.f, h);
    const a = this.pass.action!;
    const deadline = a === "claim_out" ? { desk_can_refund_from_height: this.f.desk.out_timeout_height! + 1 } : a === "refund_in" ? { desk_can_claim_until: "the preimage is broadcast" } : { refund_final_at_height: this.f.quote.in_timeout_height };
    this.pass = { ...this.pass, simulated: h, displayed: null, approved: null };
    return accept({
      action: a, height: h, ...e, earliest_confirmation_height: h + 1,
      bids_at_least_current_estimate: e.fee_rate >= est, fee_estimate_sat_vb: est, ...deadline,
      simulation_id: sha256(canonical({ seed: this.seed, a, h, e })).slice(0, 16),
    } as unknown as Json);
  }

  private display(): StepResult {
    const h = this.s.height;
    if (this.pass.simulated !== h) return this.rejectWith("stale", "the simulation is not from this height");
    const e = this.effects();
    this.pass = { ...this.pass, displayed: h, approved: null };
    return accept({ action: this.pass.action, height: h, ...e, wallet_change_if_confirmed_sats: e.receive_sats - e.spend_sats - e.fee_sats, display_id: sha256(canonical({ seed: this.seed, a: this.pass.action, h, e, d: 1 })).slice(0, 16) } as unknown as Json);
  }

  private approval(): StepResult {
    const h = this.s.height;
    if (this.pass.displayed !== h) return this.rejectWith("stale", "the display is not from this height");
    this.pass = { ...this.pass, approved: h };
    return accept({ approved: true, by: "principal", valid_at_height: h });
  }

  private execute(): StepResult {
    const f = this.f;
    const s = this.s;
    const h = s.height;
    if (this.pass.approved !== h || this.pass.simulated !== h) return this.rejectWith("stale", "the approval is not from this height; simulate, display, and approve again");
    const a = this.pass.action!;
    const txid = sha256(canonical({ seed: this.seed, a, h, r: this.pass.fee_rate, n: this.log.length }));
    if (a === "fund_in") s.funded = true;
    else if (a === "claim_out") {
      s.claim = { fee_rate: this.pass.fee_rate!, height: h };
      s.claimBroadcasts += 1;
      if (s.revealed === null) s.revealed = h;
    } else s.refund = { fee_rate: this.pass.fee_rate!, height: h, by: "customer" };
    this.log.push(`${h} ${a} ${this.pass.fee_rate ?? ""}`);
    this.pass = { ...this.pass, executed: txid, approved: null };
    return accept({ action: a, txid, broadcast_height: h });
  }

  private verify(): StepResult {
    const s = this.s;
    const a = this.pass.action;
    const status = a === "fund_in" ? (s.height >= this.f.start_height + 1 ? "confirmed" : "mempool")
      : a === "claim_out" ? (s.claimConfirmed !== null ? "confirmed" : s.lockConflicted || s.payoutRefundedByDesk !== null ? "invalid" : s.claim ? "mempool" : "not_broadcast")
      : a === "refund_in" ? (s.refundConfirmed !== null ? "confirmed" : s.inTakenByDesk !== null ? "invalid" : s.refund ? "mempool" : "not_broadcast")
      : "nothing_executed";
    return accept({ action: a, txid: this.pass.executed, status, height: s.height });
  }

  private reconcile(): StepResult {
    const o = outcomeOf(this.f, this.s);
    return accept({ height: this.s.height, settled: settled(this.s), wallet_change_so_far_sats: o.value - (o.completed ? this.f.quote.swap_value_sats : 0), matches_displayed: true });
  }

  private hold(args: Record<string, unknown>): StepResult {
    const n = args.blocks === undefined ? 1 : args.blocks;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return this.rejectWith("not_integer", "blocks must be a whole number of at least 1");
    const left = this.f.horizon_height - this.s.height;
    if (n > left) return this.rejectWith("over_budget", `only ${left} blocks are left before the horizon`);
    for (let i = 0; i < n; i++) advanceBlock(this.f, this.config, this.s);
    this.pass = { ...this.pass, approved: null };
    return accept({ height: this.s.height, blocks_left: this.f.horizon_height - this.s.height });
  }

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (!isObject(action) || typeof action.tool !== "string") return this.rejectWith("malformed");
    const tool = action.tool;
    const args = action.args === undefined ? {} : action.args;
    if (!isObject(args)) return this.rejectWith("malformed");
    if (!ALL_TOOLS.includes(tool)) return this.rejectWith("unknown_tool", `tools are: ${ALL_TOOLS.join(", ")}`);
    if (!allowedTools(this.node).includes(tool)) return this.rejectWith("unknown_node", `from ${this.node} the host admits: ${allowedTools(this.node).join(", ")}`);
    const target = TOOL_NODE[tool]!;
    let result: StepResult;
    switch (target) {
      case "observe": this.pass = freshPass(); result = accept(this.evidence()); break;
      case "inspect": {
        const a = args.action;
        if (typeof a !== "string" || !(ACTIONS as readonly string[]).includes(a)) return this.rejectWith("malformed", `action must be one of ${ACTIONS.join(", ")}`);
        this.pass = { ...freshPass(), action: a as SwapAction };
        result = accept(this.inspect(a as SwapAction));
        break;
      }
      case "validate": result = this.validate(args); break;
      case "simulate": result = this.simulate(); break;
      case "display": result = this.display(); break;
      case "approval": result = this.approval(); break;
      case "execute": result = this.execute(); break;
      case "verify": result = this.verify(); break;
      case "reconcile": result = this.reconcile(); break;
      case "complete": result = accept({ pass: this.passes + 1, action: this.pass.action, settled: settled(this.s) }); break;
      case "hold": result = this.hold(args); break;
      case "recovery": result = accept(tool === REFRESH_TOOL ? this.evidence() : { node: this.node, pass: { ...this.pass }, passes_completed: this.passes, evidence: this.evidence() } as unknown as Json); break;
      case "incident": this.incident = true; result = accept({ frozen: true, refund_armed: (this.evidence() as { refund_armed: boolean }).refund_armed }); break;
    }
    if (!result.accepted) return result;
    if (target !== "hold") this.probes -= 1;
    if (target === "complete") { this.passes += 1; this.node = "start"; this.pass = freshPass(); }
    else this.node = target;
    if (target === "incident" || this.probes <= 0 || this.s.height >= this.f.horizon_height || settled(this.s) || (!this.s.funded && this.s.height > this.f.start_height)) this.close();
    void HOLD_TOOL; void INCIDENT_TOOL; void RESUME_TOOL;
    return result;
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    while (this.s.height < this.f.horizon_height) advanceBlock(this.f, this.config, this.s);
    const o = outcomeOf(this.f, this.s);
    return {
      value: o.value,
      metrics: {
        funded: this.s.funded ? 1 : 0, completed: o.completed ? 1 : 0, refunded: o.refunded ? 1 : 0, lost: o.lost && this.s.funded ? 1 : 0,
        fees_sats: o.fees, claim_broadcasts: this.s.claimBroadcasts, revealed: this.s.revealed !== null ? 1 : 0,
        host_refund: this.s.refund?.by === "host" && o.refunded ? 1 : 0, passes: this.passes, incident: this.incident ? 1 : 0,
      },
    };
  }

  snapshot(): string { return canonical({ s: this.s, node: this.node, pass: this.pass, passes: this.passes, incident: this.incident, closed: this.closed, log: this.log }); }

  privileged(): Json {
    const d = this.f.desk;
    return { desk: { type: d.type, lock_height: d.lock_height, out_timeout_height: d.out_timeout_height, amount_out_sats: d.amount_out_sats, reorg_height: d.reorg_height }, fees: [...this.f.fees], start_height: this.f.start_height } as unknown as Json;
  }
}
