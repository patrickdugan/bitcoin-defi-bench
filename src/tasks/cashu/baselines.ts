// Family 14 baselines (docs/tasks.md §17). All but the oracle decide from the current observation
// alone, so a skill can return the reference's next action without replaying the episode.
//
//   idle          ends at once: the host's defaults refuse every item, the outbox dispatches each
//                 withdrawal at its deadline, the watcher exits each VTXO, and the float stays put
//   accept_all    admits every deposit and accepts every token unchecked; otherwise the reference
//   no_dleq       the reference, but it trusts the mint's reports: a token passes on NUT-07 state
//                 alone, and a mint's report that a deposit was paid counts as evidence
//   proof_grove   the reference: Proof Grove's admission rules and wallet checks; refuses tokens and
//                 moves the float out while the mint's reserve is below its outstanding; dispatches
//                 a withdrawal when its quote is within the fee limit; refreshes at 144 blocks left
//                 while the server is online and exits at 72 while it is not
//   late_refresh  the reference, but it refreshes at 72 blocks left and exits at 48: the cheapest
//                 tier of the fee table, at the price of a shorter margin against an outage
//   oracle        the ceiling, privileged: follows `ceilingOf`'s plan

import type { Agent } from "../../harness/agent.ts";
import type { Json } from "../../harness/json.ts";
import type { Evidence, Intent, Keyset } from "./generate.ts";
import { proofDleqValid, type ProofJson } from "./nut.ts";

interface View {
  height: number;
  horizon_height: number;
  operator_online: boolean;
  float_sats: number;
  mint: { status: "running" | "halted"; keysets: Keyset[]; report: { reserve_sats: number; outstanding_sats: number } | null };
  policy: { min_confirmations: number; max_tip_lag: number; withdrawal_fee_limit_sats: number; exit_runway_blocks: number };
  intents: Array<Intent & { registered_height: number }>;
  claimed_outpoints: string[];
  pending: {
    deposits: Array<{ id: string; intent_id: string; evidence: Evidence }>;
    tokens: Array<{ id: string; amount_sats: number; token: { unit: string; proofs: ProofJson[] } }>;
    withdrawals: Array<{ id: string; amount_sats: number; deadline_height: number; quote_fee_sats: number }>;
  };
  checks: { [id: string]: { proof_valid?: boolean; chain?: { matches_evidence: boolean; tip_height: number }; states?: Array<{ state: string }> | "unreachable" } };
  vtxos: Array<{ id: string; amount_sats: number; expiry_height: number; watcher_exit_height: number; status: string }>;
}

interface Obs { view: View; budget: { attempts: number; probes: number; blocks: number } }

const act = (tool: string, args: Json = {}): Json => ({ tool, args });

/** Proof Grove's planner margins (proof-grove/proofdesk/domain.py plan_vtxo defaults); a test holds them equal to config/cashu.json. */
export const PLAN = { refresh_before: 144, exit_before: 72 } as const;

export interface DeskParams {
  /** proof_grove: Proof Grove's decide(); trust_mint: also admits a mint's report of payment; admit_all: no checks. */
  deposits: "proof_grove" | "trust_mint" | "admit_all";
  /** full: keyset, DLEQ, and NUT-07 state; state_only: NUT-07 alone; accept_all: none, and regardless of the mint. */
  tokens: "full" | "state_only" | "accept_all";
  /** Refresh at this many blocks left while the server is online; exit at exit_before while it is not. */
  plan: { refresh_before: number; exit_before: number };
}

export const shortfall = (v: View): boolean => v.mint.report !== null && v.mint.report.reserve_sats < v.mint.report.outstanding_sats;

/** The deposit checks of Proof Grove's decide() that need no request, as a refusal code or null. */
export function depositRefusal(v: View, d: View["pending"]["deposits"][number], trustMint: boolean): string | null {
  const intent = v.intents.find((i) => i.id === d.intent_id);
  if (!intent) return "unknown_intent";
  const e = d.evidence;
  if (e.kind !== "m16-proof" && !trustMint) return "verified_evidence_required";
  if (v.intents.some((i) => i.id !== intent.id && i.script_sha256 === intent.script_sha256)) return "deposit_script_reused";
  if (e.tip_height !== e.block_height + e.confirmations - 1) return "inconsistent_confirmations";
  if (v.height - e.tip_height > v.policy.max_tip_lag) return "proof_tip_stale";
  if (e.confirmations < v.policy.min_confirmations) return "too_few_confirmations";
  if (e.script_sha256 !== intent.script_sha256) return "wrong_payment_script";
  if (e.value_sats !== intent.amount_sats) return "wrong_amount";
  if (v.claimed_outpoints.includes(`${e.txid}:${e.vout}`)) return "payment_already_claimed";
  return null;
}

/** The token checks that need no request: a listed keyset, a key for every amount, the amounts summing, every DLEQ. */
export function tokenOffline(v: View, t: View["pending"]["tokens"][number]): boolean {
  if (t.token.unit !== "sat" || t.token.proofs.length === 0) return false;
  let sum = 0;
  for (const p of t.token.proofs) {
    const ks = v.mint.keysets.find((k) => k.id === p.id);
    const key = ks?.keys[String(p.amount)];
    if (!ks || !key || !proofDleqValid(key, p)) return false;
    sum += p.amount;
  }
  return sum === t.amount_sats;
}

/** A desk that decides from the current observation alone. */
export class Desk implements Agent {
  readonly id: string;
  private readonly p: DeskParams;
  constructor(id: string, p: DeskParams) { this.id = id; this.p = p; }

  act(observation: Json): Json {
    const o = observation as unknown as Obs;
    const v = o.view;
    const probes = o.budget.probes;
    // Exposure first: with the reserve below the outstanding, the float leaves the mint.
    if (v.mint.status === "running" && shortfall(v) && v.float_sats > 0) return act("mint.move_out", { amount_sats: v.float_sats });
    for (const d of v.pending.deposits) {
      if (this.p.deposits === "admit_all") return act("deposit.admit", { deposit: d.id });
      if (depositRefusal(v, d, this.p.deposits === "trust_mint") !== null) return act("deposit.refuse", { deposit: d.id });
      const c = v.checks[d.id] ?? {};
      if (d.evidence.kind === "m16-proof") {
        if (c.proof_valid === undefined) return probes > 0 ? act("proof.verify", { deposit: d.id }) : act("deposit.refuse", { deposit: d.id });
        if (!c.proof_valid) return act("deposit.refuse", { deposit: d.id });
      }
      if (c.chain === undefined) return probes > 0 ? act("chain.check", { deposit: d.id }) : act("deposit.refuse", { deposit: d.id });
      return act(c.chain.matches_evidence ? "deposit.admit" : "deposit.refuse", { deposit: d.id });
    }
    for (const t of v.pending.tokens) {
      if (this.p.tokens === "accept_all") return act("token.accept", { token: t.id });
      if (v.mint.status !== "running" || shortfall(v)) return act("token.refuse", { token: t.id });
      if (this.p.tokens === "full" && !tokenOffline(v, t)) return act("token.refuse", { token: t.id });
      const states = v.checks[t.id]?.states;
      if (states === undefined) return probes > 0 ? act("mint.check_state", { token: t.id }) : act("token.refuse", { token: t.id });
      const unspent = states !== "unreachable" && states.length === t.token.proofs.length && states.every((s) => s.state === "UNSPENT");
      return act(unspent ? "token.accept" : "token.refuse", { token: t.id });
    }
    for (const w of v.pending.withdrawals) {
      if (v.mint.status === "running" && w.quote_fee_sats <= v.policy.withdrawal_fee_limit_sats && w.amount_sats <= v.float_sats) return act("withdrawal.dispatch", { withdrawal: w.id });
    }
    const live = v.vtxos.filter((x) => x.status === "live" && v.height <= x.watcher_exit_height);
    if (v.operator_online) {
      const due = live.filter((x) => x.expiry_height - v.height <= this.p.plan.refresh_before);
      if (due.length > 0) return act("ark.refresh", { vtxos: due.map((x) => x.id) });
    } else {
      const due = live.filter((x) => x.expiry_height - v.height <= this.p.plan.exit_before);
      if (due.length > 0) return act("ark.exit", { vtxos: due.map((x) => x.id) });
    }
    // Nothing to do in this block: wait for the next margin, or a block while a withdrawal waits on its quote.
    let next = o.budget.blocks;
    if (v.pending.withdrawals.length > 0) next = 1;
    for (const x of live) {
      const margin = x.expiry_height - (v.operator_online ? this.p.plan.refresh_before : this.p.plan.exit_before);
      if (margin > v.height) next = Math.min(next, margin - v.height);
    }
    if (o.budget.blocks <= 0) return act("end");
    return act("wait", { blocks: Math.max(1, Math.min(next, o.budget.blocks)) });
  }
}

export class Idle implements Agent {
  readonly id = "idle";
  act(): Json { return act("end"); }
}

interface Plan {
  admit: string[];
  accept: string[];
  withdrawals: Array<{ id: string; height: number }>;
  refresh: Array<{ height: number; ids: string[] }>;
  exits: Array<{ height: number; id: string }>;
  move_out_height: number | null;
}

/** Ceiling, privileged: the plan of `ceilingOf`, from the hidden truth. */
export class Oracle implements Agent {
  readonly id = "oracle";
  readonly privileged = true;
  private plan: Plan | null = null;
  private done = new Set<string>();

  reset(_episode?: unknown, privileged?: Json): void {
    this.plan = (privileged ?? null) as unknown as Plan | null;
    this.done = new Set();
  }

  act(observation: Json): Json {
    if (!this.plan) throw new Error("oracle needs privileged information");
    const o = observation as unknown as Obs;
    const v = o.view;
    const h = v.height;
    const p = this.plan;
    for (const d of v.pending.deposits) return act(p.admit.includes(d.id) ? "deposit.admit" : "deposit.refuse", { deposit: d.id });
    for (const t of v.pending.tokens) return act(p.accept.includes(t.id) ? "token.accept" : "token.refuse", { token: t.id });
    for (const w of p.withdrawals) if (w.height === h && v.pending.withdrawals.some((x) => x.id === w.id)) return act("withdrawal.dispatch", { withdrawal: w.id });
    for (const r of p.refresh) if (r.height === h && !this.done.has(`r${h}`)) { this.done.add(`r${h}`); return act("ark.refresh", { vtxos: r.ids }); }
    const exits = p.exits.filter((x) => x.height === h && v.vtxos.some((y) => y.id === x.id && y.status === "live"));
    if (exits.length > 0) return act("ark.exit", { vtxos: exits.map((x) => x.id) });
    if (p.move_out_height === h && v.float_sats > 0 && v.mint.status === "running") return act("mint.move_out", { amount_sats: v.float_sats });
    const ahead = [...p.withdrawals.map((w) => w.height), ...p.refresh.map((r) => r.height), ...p.exits.map((x) => x.height), ...(p.move_out_height === null ? [] : [p.move_out_height])].filter((x) => x > h);
    if (o.budget.blocks <= 0) return act("end");
    const next = ahead.length > 0 ? Math.min(...ahead) - h : o.budget.blocks;
    return act("wait", { blocks: Math.max(1, Math.min(next, o.budget.blocks)) });
  }
}

export const PROOF_GROVE: DeskParams = { deposits: "proof_grove", tokens: "full", plan: PLAN };
/** Refreshing in the cheapest tier of the fee table, 72 blocks or fewer before expiry, with an exit margin of 48 behind it. [invented] */
export const LATE_PLAN = { refresh_before: 72, exit_before: 48 } as const;

export const cashuBaselines = (): Agent[] => [
  new Idle(),
  new Desk("accept_all", { ...PROOF_GROVE, deposits: "admit_all", tokens: "accept_all" }),
  new Desk("no_dleq", { ...PROOF_GROVE, deposits: "trust_mint", tokens: "state_only" }),
  new Desk("late_refresh", { ...PROOF_GROVE, plan: LATE_PLAN }),
  new Desk("proof_grove", PROOF_GROVE),
  new Oracle(),
];
