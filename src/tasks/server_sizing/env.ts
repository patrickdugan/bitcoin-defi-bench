// Family 4: server inbound resizing (docs/tasks.md §5). The agent is an Ark server sizing the
// inbound capacity of its own Lightning channels over family 3's horizon. A step is one round;
// decisions come every decision interval; a resize ordered at a decision after the first takes
// effect one resize delay later. Each step runs in the stream's agent order, each agent's receipt
// and then its spend, as family 3's serverEnvelope does. A receipt fails when it would take the
// server's position past the capacity in force; a spend the agent's delivered balance cannot cover
// is dropped, and is not a failure. Outbound is not modelled: family 3's funded-spend rule keeps
// the position at or above zero.
//
// The capacity can never be below the position the server already holds in its channels. A resize
// whose target is below the position at the decision is rejected (below_position). One step later,
// when it takes effect, the capacity in force becomes the larger of the target and the position at
// that step, so a lower target never strands a receipt that was already in the channels. The fee is
// charged at the decision, for a target different from the capacity in force; the lease is charged
// when the resize takes effect, on the increase actually put in force.

import { accept, reject, type Budget, type Environment, type Outcome, type RejectReason, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, type Json } from "../../harness/json.ts";
import type { DemandStream } from "../settlement_object/generate.ts";
import { intervalSummaries, positionPath, timing, type IntervalSummary, type PositionPath, type SizingParams } from "./plan.ts";

/** Native value: −ln of the total cost in sats, with a floor of one sat. */
export const valueOf = (cost: number): number => 0 - Math.log(Math.max(1, cost));

export interface SizingInput {
  seed: number;
  cell: string;
  /** The scored stream. */
  evaluation: DemandStream;
  /** The stream the agent is shown, summarised. */
  pilot: DemandStream;
  params: SizingParams;
  attempts: number;
  max_inbound_pilot_multiple: number;
  evaluationPath?: PositionPath;
  pilotPath?: PositionPath;
}

export interface SizingView extends SizingParams {
  decision_index: number;
  decision_count: number;
  step: number;
  block: number;
  horizon_steps: number;
  horizon_blocks: number;
  capacity_in_force: number;
  pending_resize: { inbound_sats: number; effective_step: number; effective_block: number } | null;
  position: number;
  failures: number;
  failed_sats: number;
  max_inbound_sats: number;
  /** The pilot stream on the no-failure path, per decision interval, and its peak. */
  pilot: { peak: number; intervals: IntervalSummary[] };
  /** The evaluation stream on the no-failure path, completed intervals only. */
  evaluation_completed: IntervalSummary[];
}

export class ServerSizingEnv implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell: string;
  private readonly input: SizingInput;
  private readonly evaluationPath: PositionPath;
  private readonly pilotPath: PositionPath;
  private readonly series: Array<Array<{ in: number; out: number }>>;
  private readonly balances: number[];
  private readonly interval: number;
  private readonly delay: number;
  private readonly count: number;
  private readonly steps: number;
  private attempts: number;
  private k = 0;
  private t = 0;
  private capacity = 0;
  private pending: SizingView["pending_resize"] = null;
  private position = 0;
  private failures = 0;
  private failedSats = 0;
  private capital = 0;
  private resizing = 0;
  private resizes = 0;
  private capacitySteps = 0;
  private closed = false;

  constructor(input: SizingInput) {
    this.input = input;
    this.seed = input.seed;
    this.cell = input.cell;
    this.task = `server_sizing/${this.cell}`;
    this.evaluationPath = input.evaluationPath ?? positionPath(input.evaluation);
    this.pilotPath = input.pilotPath ?? positionPath(input.pilot);
    this.steps = this.evaluationPath.end.length;
    const time = timing(input.params, this.steps);
    this.interval = time.interval; this.delay = time.delay; this.count = time.count;
    this.series = [...input.evaluation.values()];
    this.balances = this.series.map(() => 0);
    this.attempts = input.attempts;
  }

  /** Attempts are the rejections left; blocks, the blocks to the horizon. An accepted decision spends neither sats nor attempts. */
  budget(): Budget { return { attempts: this.attempts, probes: 0, blocks: (this.steps - this.t) * this.input.params.round_interval_blocks, sats: 0 }; }
  tools(): string[] { return ["resize", "hold", "commit"]; }
  private get maxInbound(): number { return this.input.max_inbound_pilot_multiple * this.pilotPath.peak; }

  view(): Json {
    const p = this.input.params;
    const view: SizingView = {
      ...p, decision_index: this.k, decision_count: this.count, step: this.t,
      block: this.t * p.round_interval_blocks, horizon_steps: this.steps, horizon_blocks: this.steps * p.round_interval_blocks,
      capacity_in_force: this.capacity,
      pending_resize: this.pending ? { ...this.pending } : null,
      position: this.position, failures: this.failures, failed_sats: this.failedSats, max_inbound_sats: this.maxInbound,
      pilot: { peak: this.pilotPath.peak, intervals: intervalSummaries(this.pilotPath, p) },
      evaluation_completed: intervalSummaries(this.evaluationPath, p, this.t),
    };
    return view as unknown as Json;
  }

  done(): boolean { return this.closed || this.attempts <= 0; }
  private rejection(reason: RejectReason): StepResult { this.attempts -= 1; return reject(reason); }

  step(action: unknown): StepResult {
    if (this.done()) return reject("phase_closed");
    if (!isObject(action) || typeof action.tool !== "string") return this.rejection("malformed");
    if (action.tool !== "resize" && action.tool !== "hold" && action.tool !== "commit") return this.rejection("unknown_tool");
    let next = this.capacity;
    if (action.tool === "resize") {
      if (!isObject(action.args) || typeof action.args.inbound_sats !== "number") return this.rejection("malformed");
      next = action.args.inbound_sats;
      if (!Number.isInteger(next)) return this.rejection("not_integer");
      if (next < 0) return this.rejection("below_minimum");
      if (next > this.maxInbound) return this.rejection("over_budget");
      if (next < this.position) return this.rejection("below_position");
    }
    if (action.tool === "commit") { this.closed = true; return accept(); }
    // Accepted from here. A target different from the capacity in force is a resize: the decision at
    // step 0 is in force from step 0, a later one a delay after the decision. The fee is paid now.
    if (next !== this.capacity) {
      this.resizing += this.input.params.resize_fee_sats;
      this.resizes += 1;
      const effective = this.k === 0 ? 0 : this.t + this.delay;
      this.pending = { inbound_sats: next, effective_step: effective, effective_block: effective * this.input.params.round_interval_blocks };
    }
    this.k += 1;
    this.advance(Math.min(this.steps, this.k * this.interval));
    if (this.k >= this.count) this.closed = true;
    return accept({ decision_index: this.k, step: this.t });
  }

  /** Process steps up to, not including, `end`. */
  private advance(end: number): void {
    const p = this.input.params;
    for (; this.t < end; this.t++) {
      if (this.pending && this.pending.effective_step <= this.t) {
        // The capacity cannot fall below the position held at the step the resize takes effect.
        const landed = Math.max(this.pending.inbound_sats, this.position);
        this.resizing += p.lease_rate_ppm / 1e6 * Math.max(0, landed - this.capacity);
        this.capacity = landed;
        this.pending = null;
      }
      for (let a = 0; a < this.series.length; a++) {
        const s = this.series[a]![this.t]!;
        if (s.in > 0) {
          if (this.position + s.in <= this.capacity) { this.position += s.in; this.balances[a]! += s.in; }
          else { this.failures += 1; this.failedSats += s.in; }
        }
        if (s.out > 0 && this.balances[a]! >= s.out) { this.position -= s.out; this.balances[a]! -= s.out; }
      }
      this.capacitySteps += this.capacity;
      this.capital += this.capacity * p.capital_rate_per_block * p.round_interval_blocks;
    }
  }

  finish(): Outcome {
    if (!this.done()) throw new Error("finish called before the decision phase ended");
    // Whatever capacity is in force holds to the horizon.
    this.advance(this.steps);
    const p = this.input.params;
    const failure = this.failures * p.failure_fixed_sats + this.failedSats * p.failure_value_share;
    const total = this.capital + this.resizing + failure;
    return { value: valueOf(total), metrics: {
      cost_sats: total, capital_sats: this.capital, resize_sats: this.resizing, failure_sats: failure,
      failures: this.failures, failed_sats: this.failedSats, resizes: this.resizes, mean_capacity: this.capacitySteps / this.steps,
    } };
  }

  snapshot(): string {
    return canonical({ k: this.k, t: this.t, capacity: this.capacity, pending: this.pending,
      position: this.position, balances: this.balances, failures: this.failures, failedSats: this.failedSats,
      capital: this.capital, resizing: this.resizing, resizes: this.resizes, capacitySteps: this.capacitySteps, closed: this.closed });
  }

  /** For the oracle only: the evaluation stream. Never part of an observation. */
  privileged(): Json { return { evaluation: [...this.input.evaluation] } as unknown as Json; }
}
