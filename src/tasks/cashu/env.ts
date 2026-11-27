// Family 14 (docs/tasks.md §17): the host of a Cashu desk backed by Ark. Each block, deposits with
// evidence, Cashu tokens offered in payment, and withdrawal requests arrive; the desk's VTXOs run
// toward expiry; the mint publishes its reserve each round. The agent checks and decides; the host
// executes what it is told and never judges whether it is wise: it admits a deposit nobody verified
// and accepts a token nobody checked. What it does guarantee is its defaults (world.ts header): an
// item not decided in its block is refused, the outbox dispatches a withdrawal at its deadline, and
// the watcher exits a VTXO at the last block its runway allows. So doing nothing loses no principal,
// except the Cashu float the desk holds when its mint halts.
//
// Budget: a check costs one probe; a decision costs one attempt, and so does a rejection; a wait
// costs the blocks it waits. The phase ends at the horizon, at `end`, or when attempts run out.

import { accept, reject, type Budget, type Environment, type Outcome, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, sha256, type Json } from "../../harness/json.ts";
import type { CashuConfig, CashuFixture, DepositEvent, TokenEvent, Vtxo, WithdrawalEvent } from "./generate.ts";
import { acceptValue, admitValue, at, ceilingOf, exitCost, exitRunway, lastExitBlock, moveOutFee, online, refreshFee, reportAt, tokenGood, withdrawalFee } from "./world.ts";

export const CHECK_TOOLS = ["proof.verify", "chain.check", "mint.check_state"] as const;
export const DECISION_TOOLS = ["deposit.admit", "deposit.refuse", "token.accept", "token.refuse", "withdrawal.dispatch", "ark.refresh", "ark.exit", "mint.move_out"] as const;
export const TOOLS = [...CHECK_TOOLS, ...DECISION_TOOLS, "wait", "end"] as const;

type VtxoStatus = { status: "live" } | { status: "refreshed" | "exited" | "watcher_exit"; height: number; fee_sats: number };

interface Checks { proof_valid?: boolean; chain?: { block_height: number; active_block_hash: string; matches_evidence: boolean; tip_height: number }; states?: Array<{ Y: string; state: "UNSPENT" | "SPENT" }> | "unreachable" }

interface State {
  height: number;
  value: number;
  float: number;
  decided: { [id: string]: string };
  claimed: string[];
  spentYs: string[];
  checks: { [id: string]: Checks };
  withdrawals: { [id: string]: { height: number; fee_sats: number; by: "desk" | "outbox" } };
  vtxos: { [id: string]: VtxoStatus };
  halted: boolean;
  floatLost: number;
  alerts: string[];
  counts: { admitted: number; admitted_bad: number; accepted: number; accepted_bad: number; lapsed: number; refresh_fees: number; exit_fees: number; watcher_exits: number; withdrawal_fees: number; move_fees: number; moved_sats: number; checks: number };
}

export class CashuEnv implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell = "single";
  private readonly f: CashuFixture;
  private readonly config: CashuConfig;
  private readonly s: State;
  private attempts: number;
  private probes: number;
  private closed = false;

  constructor(fixture: CashuFixture, config: CashuConfig) {
    this.f = fixture;
    this.config = config;
    this.task = `cashu/${fixture.cell}`;
    this.seed = fixture.seed;
    const budget = config.cells[fixture.cell]!.budget;
    this.attempts = budget.attempts;
    this.probes = budget.probes;
    this.s = {
      height: fixture.start_height, value: 0, float: fixture.float_sats, decided: {}, claimed: [], spentYs: [], checks: {}, withdrawals: {},
      vtxos: Object.fromEntries(fixture.vtxos.map((v) => [v.id, { status: "live" } as VtxoStatus])), halted: false, floatLost: 0, alerts: [],
      counts: { admitted: 0, admitted_bad: 0, accepted: 0, accepted_bad: 0, lapsed: 0, refresh_fees: 0, exit_fees: 0, watcher_exits: 0, withdrawal_fees: 0, move_fees: 0, moved_sats: 0, checks: 0 },
    };
    this.s.alerts = this.arrivalAlerts();
  }

  budget(): Budget { return { attempts: this.attempts, probes: this.probes, blocks: this.f.horizon_height - this.s.height, sats: 0 }; }
  tools(): string[] { return this.closed ? [] : [...TOOLS]; }
  done(): boolean { return this.closed; }

  private pendingDeposits(): DepositEvent[] { return this.f.deposits.filter((d) => d.arrival === this.s.height && !(d.id in this.s.decided)); }
  private pendingTokens(): TokenEvent[] { return this.f.tokens.filter((t) => t.arrival === this.s.height && !(t.id in this.s.decided)); }
  private pendingWithdrawals(): WithdrawalEvent[] { return this.f.withdrawals.filter((w) => w.arrival <= this.s.height && !(w.id in this.s.withdrawals)); }
  private live(v: Vtxo): boolean { return this.s.vtxos[v.id]!.status === "live"; }

  view(): Json {
    const f = this.f;
    const s = this.s;
    const h = s.height;
    const report = s.halted ? null : reportAt(f, h);
    return {
      height: h,
      horizon_height: f.horizon_height,
      fee_rate_sat_vb: at(f, f.fees, h),
      operator_online: online(f, h),
      float_sats: s.float,
      mint: { status: s.halted ? "halted" : "running", keysets: f.mint.keysets as unknown as Json, report: report as unknown as Json },
      policy: {
        min_confirmations: this.config.rules.min_confirmations, max_tip_lag: this.config.rules.max_tip_lag,
        desk_fee_ppm: this.config.desk_fee_ppm, token_margin_ppm: this.config.token_margin_ppm,
        refresh_fee: this.config.refresh_fee as unknown as Json, move_out_fee: this.config.move_out_fee,
        exit_vbytes: this.config.exit.vbytes, exit_runway_blocks: exitRunway(this.config), watcher_fee_multiplier: this.config.exit.armed_multiplier,
        withdrawal_fee_limit_sats: this.config.withdrawal.fee_limit_sats,
      },
      intents: f.deposits.filter((d) => d.arrival <= h).map((d) => ({ ...d.intent, registered_height: d.arrival })) as unknown as Json,
      claimed_outpoints: [...s.claimed],
      pending: {
        deposits: this.pendingDeposits().map((d) => ({ id: d.id, intent_id: d.intent.id, evidence: d.evidence })) as unknown as Json,
        tokens: this.pendingTokens().map((t) => ({ id: t.id, amount_sats: t.amount_sats, token: t.token })) as unknown as Json,
        withdrawals: this.pendingWithdrawals().map((w) => ({ id: w.id, amount_sats: w.amount_sats, deadline_height: w.deadline, quote_fee_sats: withdrawalFee(w.amount_sats, at(f, f.quotes, h)) })) as unknown as Json,
      },
      checks: Object.fromEntries(Object.entries(s.checks).filter(([id]) => this.pendingDeposits().some((d) => d.id === id) || this.pendingTokens().some((t) => t.id === id))) as unknown as Json,
      vtxos: f.vtxos.map((v) => ({ id: v.id, amount_sats: v.amount_sats, expiry_height: v.expiry_height, watcher_exit_height: lastExitBlock(this.config, v), ...s.vtxos[v.id] })) as unknown as Json,
      alerts: [...s.alerts],
    };
  }

  private rejectWith(reason: Parameters<typeof reject>[0], detail?: string): StepResult {
    this.attempts -= 1;
    if (this.attempts <= 0) this.close();
    return reject(reason, detail ? { detail } : null);
  }

  private close(): void { this.closed = true; }

  private arrivalAlerts(): string[] {
    const h = this.s.height;
    const out: string[] = [];
    for (const d of this.f.deposits) if (d.arrival === h) out.push(`deposit ${d.id} arrived`);
    for (const t of this.f.tokens) if (t.arrival === h) out.push(`token ${t.id} offered`);
    for (const w of this.f.withdrawals) if (w.arrival === h) out.push(`withdrawal ${w.id} requested`);
    return out;
  }

  private shortfall(height: number): boolean {
    const r = reportAt(this.f, height);
    return r !== null && r.reserve_sats < r.outstanding_sats;
  }

  /** Advance one block, applying the host's defaults to the block being left. */
  private advance(): void {
    const f = this.f;
    const s = this.s;
    const t = s.height;
    const alerts: string[] = [];
    for (const d of this.pendingDeposits()) { s.decided[d.id] = "lapsed"; s.counts.lapsed += 1; }
    for (const x of this.pendingTokens()) { s.decided[x.id] = "lapsed"; s.counts.lapsed += 1; }
    for (const w of this.pendingWithdrawals()) {
      if (w.deadline !== t) continue;
      const fee = withdrawalFee(w.amount_sats, at(f, f.quotes, t));
      s.withdrawals[w.id] = { height: t, fee_sats: fee, by: "outbox" };
      s.value -= fee; s.float -= w.amount_sats; s.counts.withdrawal_fees += fee;
      alerts.push(`outbox dispatched withdrawal ${w.id}`);
    }
    for (const v of f.vtxos) {
      if (!this.live(v) || lastExitBlock(this.config, v) !== t) continue;
      const fee = exitCost(this.config, f, t, this.config.exit.armed_multiplier);
      s.vtxos[v.id] = { status: "watcher_exit", height: t, fee_sats: fee };
      s.value -= fee; s.counts.exit_fees += fee; s.counts.watcher_exits += 1;
      alerts.push(`watcher exited ${v.id}`);
    }
    s.checks = {};
    s.height = t + 1;
    const h = s.height;
    if (f.mint.failure_height === h) {
      s.floatLost = s.float; s.value -= s.float; s.float = 0; s.halted = true;
      alerts.push("mint halted");
    }
    if (online(f, h) !== online(f, t)) alerts.push(online(f, h) ? "Ark server back online" : "Ark server offline");
    if (!s.halted && this.shortfall(h) !== this.shortfall(t)) alerts.push(this.shortfall(h) ? "mint reserve below outstanding" : "mint reserve restored");
    s.alerts = [...alerts, ...this.arrivalAlerts()];
  }

  private idOf(args: Record<string, unknown>, key: string): string | null { return typeof args[key] === "string" ? args[key] as string : null; }

  private check(tool: string, args: Record<string, unknown>): StepResult {
    if (this.probes <= 0) return this.rejectWith("over_budget", "no checks left");
    const s = this.s;
    if (tool === "mint.check_state") {
      const id = this.idOf(args, "token");
      const t = this.pendingTokens().find((x) => x.id === id);
      if (!t) return this.rejectWith("unknown_id", "token must name a token offered in this block");
      this.probes -= 1; s.counts.checks += 1;
      if (s.halted) { s.checks[t.id] = { ...s.checks[t.id], states: "unreachable" }; return accept({ token: t.id, reachable: false }); }
      const states = t.ys.map((Y) => ({ Y, state: (t.spent || s.spentYs.includes(Y) ? "SPENT" : "UNSPENT") as "SPENT" | "UNSPENT" }));
      s.checks[t.id] = { ...s.checks[t.id], states };
      return accept({ token: t.id, reachable: true, states } as unknown as Json);
    }
    const id = this.idOf(args, "deposit");
    const d = this.pendingDeposits().find((x) => x.id === id);
    if (!d) return this.rejectWith("unknown_id", "deposit must name a deposit that arrived in this block");
    this.probes -= 1; s.counts.checks += 1;
    if (tool === "proof.verify") {
      const valid = d.evidence.kind === "m16-proof" && d.proof_valid;
      s.checks[d.id] = { ...s.checks[d.id], proof_valid: valid };
      return accept({ deposit: d.id, valid, verifier: "pinned M16 PAY1 verifier", ...(d.evidence.kind === "m16-proof" ? {} : { detail: "an operator report carries no statement or proof" }) });
    }
    const chain = { block_height: d.evidence.block_height, active_block_hash: d.active_block_hash, matches_evidence: d.active_block_hash === d.evidence.block_hash, tip_height: s.height };
    s.checks[d.id] = { ...s.checks[d.id], chain };
    return accept({ deposit: d.id, ...chain });
  }

  private vtxoArgs(args: Record<string, unknown>): Vtxo[] | string {
    const ids = args.vtxos;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== "string") || new Set(ids).size !== ids.length) return "vtxos must be a non-empty list of distinct VTXO ids";
    const out: Vtxo[] = [];
    for (const id of ids as string[]) {
      const v = this.f.vtxos.find((x) => x.id === id);
      if (!v) return `unknown VTXO ${id}`;
      if (!this.live(v)) return `${id} is no longer live`;
      out.push(v);
    }
    return out;
  }

  private decide(tool: string, args: Record<string, unknown>): StepResult {
    const f = this.f;
    const s = this.s;
    const h = s.height;
    switch (tool) {
      case "deposit.admit": case "deposit.refuse": {
        const d = this.pendingDeposits().find((x) => x.id === this.idOf(args, "deposit"));
        if (!d) return this.rejectWith("unknown_id", "deposit must name a deposit that arrived in this block");
        this.attempts -= 1;
        if (tool === "deposit.refuse") { s.decided[d.id] = "refused"; return accept({ deposit: d.id, admitted: false }); }
        const value = admitValue(this.config, d);
        s.decided[d.id] = "admitted"; s.value += value; s.counts.admitted += 1;
        if (value < 0) s.counts.admitted_bad += 1;
        s.claimed.push(`${d.evidence.txid}:${d.evidence.vout}`);
        return accept({ deposit: d.id, admitted: true, receipt_id: sha256(canonical({ seed: this.seed, d: d.id, h })).slice(0, 16) });
      }
      case "token.accept": case "token.refuse": {
        const t = this.pendingTokens().find((x) => x.id === this.idOf(args, "token"));
        if (!t) return this.rejectWith("unknown_id", "token must name a token offered in this block");
        this.attempts -= 1;
        if (tool === "token.refuse") { s.decided[t.id] = "refused"; return accept({ token: t.id, accepted: false }); }
        const good = tokenGood(f, t, h);
        s.decided[t.id] = "accepted"; s.value += acceptValue(this.config, f, t, h); s.counts.accepted += 1;
        if (good) { s.float += t.amount_sats; s.spentYs.push(...t.ys); } else s.counts.accepted_bad += 1;
        // The desk swaps the proofs at the mint once the sale is done; the mint's answer comes too late to refuse.
        return accept({ token: t.id, accepted: true, swap: good ? "swapped for fresh proofs" : s.halted ? "mint unreachable" : "refused by the mint" });
      }
      case "withdrawal.dispatch": {
        const w = this.pendingWithdrawals().find((x) => x.id === this.idOf(args, "withdrawal"));
        if (!w) return this.rejectWith("unknown_id", "withdrawal must name a pending withdrawal");
        if (s.halted) return this.rejectWith("phase_closed", "the mint is halted");
        if (w.amount_sats > s.float) return this.rejectWith("over_budget", "the float is smaller than the withdrawal");
        this.attempts -= 1;
        const fee = withdrawalFee(w.amount_sats, at(f, f.quotes, h));
        s.withdrawals[w.id] = { height: h, fee_sats: fee, by: "desk" };
        s.value -= fee; s.float -= w.amount_sats; s.counts.withdrawal_fees += fee;
        return accept({ withdrawal: w.id, fee_sats: fee, float_sats: s.float });
      }
      case "ark.refresh": {
        const vs = this.vtxoArgs(args);
        if (typeof vs === "string") return this.rejectWith("unknown_id", vs);
        if (!online(f, h)) return this.rejectWith("phase_closed", "the Ark server is offline; no round can refresh a VTXO");
        this.attempts -= 1;
        const fee = refreshFee(this.config.refresh_fee, vs, h);
        for (const v of vs) s.vtxos[v.id] = { status: "refreshed", height: h, fee_sats: fee };
        s.value -= fee; s.counts.refresh_fees += fee;
        return accept({ refreshed: vs.map((v) => v.id), fee_sats: fee });
      }
      case "ark.exit": {
        const vs = this.vtxoArgs(args);
        if (typeof vs === "string") return this.rejectWith("unknown_id", vs);
        if (vs.some((v) => h > lastExitBlock(this.config, v))) return this.rejectWith("phase_closed", `an exit needs more than ${exitRunway(this.config)} blocks before expiry`);
        this.attempts -= 1;
        let total = 0;
        for (const v of vs) {
          const fee = exitCost(this.config, f, h);
          s.vtxos[v.id] = { status: "exited", height: h, fee_sats: fee };
          total += fee;
        }
        s.value -= total; s.counts.exit_fees += total;
        return accept({ exited: vs.map((v) => v.id), fee_sats: total });
      }
      case "mint.move_out": {
        const amount = args.amount_sats;
        if (typeof amount !== "number" || !Number.isInteger(amount)) return this.rejectWith("not_integer", "amount_sats must be a whole number");
        if (s.halted) return this.rejectWith("phase_closed", "the mint is halted");
        if (amount < 1 || amount > s.float) return this.rejectWith("over_budget", `amount_sats must be from 1 to the float, ${s.float}`);
        this.attempts -= 1;
        const fee = moveOutFee(this.config, amount);
        s.float -= amount; s.value -= fee; s.counts.move_fees += fee; s.counts.moved_sats += amount;
        return accept({ moved_sats: amount, fee_sats: fee, float_sats: s.float });
      }
    }
    throw new Error(`unhandled ${tool}`);
  }

  private wait(args: Record<string, unknown>): StepResult {
    const n = args.blocks === undefined ? 1 : args.blocks;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return this.rejectWith("not_integer", "blocks must be a whole number of at least 1");
    const left = this.f.horizon_height - this.s.height;
    if (n > left) return this.rejectWith("over_budget", `only ${left} blocks are left before the horizon`);
    let waited = 0;
    const seen: string[] = [];
    while (waited < n) {
      this.advance();
      waited += 1;
      seen.push(...this.s.alerts.map((a) => `${this.s.height}: ${a}`));
      if (this.s.alerts.length > 0) break;
    }
    return accept({ height: this.s.height, blocks_waited: waited, alerts: seen });
  }

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (!isObject(action) || typeof action.tool !== "string") return this.rejectWith("malformed");
    const args = action.args === undefined ? {} : action.args;
    if (!isObject(args)) return this.rejectWith("malformed");
    const tool = action.tool;
    let result: StepResult;
    if ((CHECK_TOOLS as readonly string[]).includes(tool)) result = this.check(tool, args);
    else if ((DECISION_TOOLS as readonly string[]).includes(tool)) result = this.decide(tool, args);
    else if (tool === "wait") result = this.wait(args);
    else if (tool === "end") { this.close(); return accept({ ended: true, height: this.s.height }); }
    else return this.rejectWith("unknown_tool", `tools are: ${TOOLS.join(", ")}`);
    if (this.attempts <= 0 || this.s.height >= this.f.horizon_height) this.close();
    return result;
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    while (this.s.height < this.f.horizon_height) this.advance();
    const c = this.s.counts;
    return {
      value: this.s.value,
      metrics: {
        admitted: c.admitted, admitted_bad: c.admitted_bad, accepted: c.accepted, accepted_bad: c.accepted_bad, lapsed: c.lapsed, checks: c.checks,
        refresh_fees: c.refresh_fees, exit_fees: c.exit_fees, watcher_exits: c.watcher_exits, withdrawal_fees: c.withdrawal_fees,
        move_fees: c.move_fees, moved_sats: c.moved_sats, float_lost: this.s.floatLost,
      },
    };
  }

  snapshot(): string { return canonical({ s: this.s, closed: this.closed }); }

  privileged(): Json {
    const c = ceilingOf(this.config, this.f);
    return {
      admit: c.admit, accept: c.accept,
      withdrawals: [...c.withdrawals.entries()].map(([id, w]) => ({ id, height: w.height })),
      refresh: c.vtxos.refresh, exits: c.vtxos.exits, move_out_height: c.move_out_height,
    } as unknown as Json;
  }
}
