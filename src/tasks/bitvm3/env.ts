// Family 12 (docs/tasks.md §15): the watcher's host over one vault's BitVM3 claim graphs. The agent
// checks a claim's handed-over proof natively, starts the garbled evaluation of a claim on its one
// machine, broadcasts or replaces a disprove with a reject label it holds, waits, or stops. The host
// admits whatever is valid on chain and never judges whether it is wise: evaluating an honest claim,
// evaluating a claim whose window has passed, or bidding a stale fee are all admitted. A disprove
// without the reject label is refused, as Bitcoin refuses it (the disprove leaf's OP_EQUALVERIFY).
//
// Budget: every admitted move costs one probe, except a wait, which costs the blocks it waits;
// every rejection costs one attempt. The phase ends at `stop`, when a budget runs out, or at the
// horizon.

import { accept, reject, type Budget, type Environment, type Outcome, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, sha256, type Json } from "../../harness/json.ts";
import type { Bitvm3Config, Bitvm3Fixture } from "./generate.ts";
import { advanceBlock, feeAt, initialState, outcomeOf, settled, type Bitvm3State, type ClaimState } from "./world.ts";

export const TOOLS = ["check", "evaluate", "disprove", "wait", "stop"] as const;

export interface ClaimView {
  id: string;
  vault_sats: number;
  k_sats: number;
  confirmed_height: number;
  confirmations: number;
  reorged: boolean;
  last_disprove_height: number;
  payout_height: number;
  status: "open" | "paid_out" | "disproved";
  check: "pass" | "fail" | null;
  evaluation: "running" | "accept" | "reject" | null;
  disprove: { fee_rate: number; broadcast_height: number; confirmed_height: number | null } | null;
}

export interface Bitvm3View {
  height: number;
  horizon_height: number;
  fee_estimate_sat_vb: number;
  window_blocks: number;
  reclaim_blocks: number;
  vbytes_disprove: number;
  dust_sats: number;
  max_fee_rate: number;
  fraud_prior_ppm: { honest: number; wrong_statement: number; invalid_proof: number };
  evaluator: { busy: boolean; claim: string | null; ready_at_height: number | null; eval_blocks: number; cost_sats: number };
  evaluations_started: number;
  claims: ClaimView[];
}

const statusOf = (c: ClaimState): ClaimView["status"] => c.paidOut !== null ? "paid_out" : c.disprove?.confirmed != null ? "disproved" : "open";

export class Bitvm3Env implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell = "single";
  private readonly f: Bitvm3Fixture;
  private readonly s: Bitvm3State;
  private attempts: number;
  private probes: number;
  private closed = false;
  private readonly evaluated: number[] = [];
  private readonly log: string[] = [];

  constructor(fixture: Bitvm3Fixture, config: Pick<Bitvm3Config, "budget">) {
    this.f = fixture;
    this.task = `bitvm3/${fixture.cell}`;
    this.seed = fixture.seed;
    this.s = initialState(fixture);
    this.attempts = config.budget.attempts;
    this.probes = config.budget.probes;
  }

  budget(): Budget { return { attempts: this.attempts, probes: this.probes, blocks: this.f.horizon_height - this.s.height, sats: 0 }; }
  tools(): string[] { return this.closed ? [] : [...TOOLS]; }
  done(): boolean { return this.closed; }

  view(): Json {
    const f = this.f;
    const s = this.s;
    const ev = s.evaluator;
    const view: Bitvm3View = {
      height: s.height,
      horizon_height: f.horizon_height,
      fee_estimate_sat_vb: feeAt(f, s.height),
      window_blocks: f.window_blocks,
      reclaim_blocks: f.reclaim_blocks,
      vbytes_disprove: f.vbytes_disprove,
      dust_sats: f.dust_sats,
      max_fee_rate: f.max_fee_rate,
      fraud_prior_ppm: { ...f.fraud_prior_ppm },
      evaluator: { busy: ev.claim !== null, claim: ev.claim === null ? null : f.claims[ev.claim]!.id, ready_at_height: ev.until, eval_blocks: f.eval_blocks, cost_sats: f.eval_cost_sats },
      evaluations_started: s.evaluations,
      claims: f.claims.flatMap((claim, i) => {
        const c = s.claims[i]!;
        if (!c.visible || c.confirmed === null) return [];
        return [{
          id: claim.id, vault_sats: claim.vault_sats, k_sats: claim.k_sats,
          confirmed_height: c.confirmed, confirmations: s.height - c.confirmed + 1, reorged: c.reorged,
          last_disprove_height: c.confirmed + f.window_blocks - 1, payout_height: c.confirmed + f.window_blocks,
          status: statusOf(c), check: c.check, evaluation: c.evaluation,
          disprove: c.disprove === null ? null : { fee_rate: c.disprove.fee_rate, broadcast_height: c.disprove.height, confirmed_height: c.disprove.confirmed },
        }];
      }),
    };
    return view as unknown as Json;
  }

  private close(): void { this.closed = true; }

  private rejectWith(reason: Parameters<typeof reject>[0], detail?: string): StepResult {
    this.attempts -= 1;
    if (this.attempts <= 0) this.close();
    return reject(reason, detail ? { detail } : null);
  }

  /** The visible claim named by args.claim, or a rejection. */
  private claimArg(args: Record<string, unknown>): number | StepResult {
    const id = args.claim;
    if (typeof id !== "string") return this.rejectWith("malformed", "claim must be a claim id string, for example \"c01\"");
    const i = this.f.claims.findIndex((c) => c.id === id);
    if (i < 0 || !this.s.claims[i]!.visible) return this.rejectWith("unknown_id", `no visible claim ${id}`);
    return i;
  }

  private check(i: number): StepResult {
    const c = this.s.claims[i]!;
    c.check = this.f.claims[i]!.class === "wrong_statement" ? "fail" : "pass";
    this.s.checks += 1;
    return accept({ claim: this.f.claims[i]!.id, native_verify: c.check === "pass" ? "accept" : "reject", check: c.check });
  }

  private evaluate(i: number): StepResult {
    const s = this.s;
    const c = s.claims[i]!;
    if (c.evaluation !== null) return this.rejectWith("duplicate", `${this.f.claims[i]!.id} has already been evaluated`);
    if (s.evaluator.claim !== null) return this.rejectWith("busy", `the evaluator is busy with ${this.f.claims[s.evaluator.claim]!.id} until height ${s.evaluator.until}`);
    c.evaluation = "running";
    s.evaluator = { claim: i, until: s.height + this.f.eval_blocks };
    s.evaluations += 1;
    this.evaluated.push(i);
    return accept({ claim: this.f.claims[i]!.id, started_height: s.height, ready_at_height: s.evaluator.until, cost_sats: this.f.eval_cost_sats });
  }

  private disprove(i: number, args: Record<string, unknown>): StepResult {
    const f = this.f;
    const s = this.s;
    const c = s.claims[i]!;
    const claim = f.claims[i]!;
    if (c.evaluation !== "reject") return this.rejectWith("no_label", `no reject label is held for ${claim.id}; the disprove leaf needs it (SHA256 <H(reject)> EQUALVERIFY)`);
    if (settled(c)) return this.rejectWith("phase_closed", `the claim output of ${claim.id} is already spent`);
    const r = args.fee_rate;
    if (typeof r !== "number" || !Number.isInteger(r)) return this.rejectWith("not_integer", "fee_rate must be a whole number of sats per vbyte");
    if (r < 1 || r > f.max_fee_rate) return this.rejectWith("out_of_grid", `fee_rate must be from 1 to ${f.max_fee_rate}`);
    if (f.vbytes_disprove * r > claim.k_sats - f.dust_sats) return this.rejectWith("over_budget", `at ${r} sat/vB the disprove's output would be below ${f.dust_sats} sats`);
    if (c.disprove && c.disprove.confirmed === null && r <= c.disprove.fee_rate) return this.rejectWith("below_minimum", `a disprove bidding ${c.disprove.fee_rate} sat/vB is pending; a replacement must bid more`);
    c.disprove = { fee_rate: r, height: s.height, confirmed: null };
    c.broadcasts += 1;
    const txid = sha256(canonical({ seed: this.seed, claim: claim.id, r, h: s.height }));
    this.log.push(`${s.height} disprove ${claim.id} ${r}`);
    return accept({ claim: claim.id, txid, fee_rate: r, fee_sats: f.vbytes_disprove * r, broadcast_height: s.height, returns_sats: claim.k_sats - f.vbytes_disprove * r });
  }

  private wait(args: Record<string, unknown>): StepResult {
    const n = args.blocks === undefined ? 1 : args.blocks;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return this.rejectWith("not_integer", "blocks must be a whole number of at least 1");
    const left = this.f.horizon_height - this.s.height;
    if (n > left) return this.rejectWith("over_budget", `only ${left} blocks are left before the horizon`);
    for (let k = 0; k < n; k++) advanceBlock(this.f, this.s);
    return accept({ height: this.s.height, blocks_left: this.f.horizon_height - this.s.height });
  }

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (!isObject(action) || typeof action.tool !== "string") return this.rejectWith("malformed");
    const tool = action.tool;
    const args = action.args === undefined ? {} : action.args;
    if (!isObject(args)) return this.rejectWith("malformed");
    if (!(TOOLS as readonly string[]).includes(tool)) return this.rejectWith("unknown_tool", `tools are: ${TOOLS.join(", ")}`);
    let result: StepResult;
    if (tool === "wait") {
      result = this.wait(args);
    } else if (tool === "stop") {
      this.close();
      return accept({ stopped_at_height: this.s.height });
    } else {
      const i = this.claimArg(args);
      if (typeof i !== "number") return i;
      result = tool === "check" ? this.check(i) : tool === "evaluate" ? this.evaluate(i) : this.disprove(i, args);
    }
    if (!result.accepted) return result;
    if (tool !== "wait") this.probes -= 1;
    if (this.probes <= 0 || this.s.height >= this.f.horizon_height) this.close();
    return result;
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    while (this.s.height < this.f.horizon_height) advanceBlock(this.f, this.s);
    for (const c of this.s.claims) if (c.visible && !settled(c)) throw new Error(`${this.task} seed ${this.seed}: a claim is unsettled at the horizon`);
    const o = outcomeOf(this.f, this.s, this.evaluated);
    return {
      value: o.value,
      metrics: {
        claims: this.f.claims.length, fraud: o.fraud, disproved: o.disproved, fraud_paid: o.fraudPaid, lost_sats: o.lostSats,
        fees_sats: o.feesSats, evaluations: o.evaluations, honest_evaluations: o.honestEvaluations, checks: this.s.checks,
        broadcasts: this.s.claims.reduce((a, c) => a + c.broadcasts, 0),
      },
    };
  }

  snapshot(): string { return canonical({ s: this.s, closed: this.closed, evaluated: this.evaluated, log: this.log }); }

  /** The whole fixture, classes and future included: for the oracle only. */
  privileged(): Json { return this.f as unknown as Json; }
}
