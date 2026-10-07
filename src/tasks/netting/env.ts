// Family 6: position netting toward a target settlement value (docs/tasks.md §7). The agent sees
// the whole clearing instance, may probe plans for their violations and cost, and commits one plan,
// scored by its cost. An invalid plan is rejected whole and places nothing.

import { accept, reject, type Budget, type Environment, type Outcome, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, type Json } from "../../harness/json.ts";
import type { NettingFixture } from "./generate.ts";
import { evaluatePlan, instanceOf, parsePlan, settleGross, type Evaluation, type Instance, type Transfer } from "./plans.ts";

export interface NettingConfig {
  epsilon_unused: null;
  infeasible_penalty_factor: number;
  budget: { attempts: number; probes: number };
  market: { base_price: number; entry_spread_ppm: number; settlement_spread_ppm: number; max_quantity: number; link_rate_ppm: number; ghost_rate_ppm: number; base_fee_sats: number; collateral_ppm_of_gross_payable: number };
  cells: { [cell: string]: NettingFixture["params"] };
}

/** Native value: −ln of a cost in sats, with a floor of one sat so that a free settlement scores zero. */
export const valueOf = (cost: number): number => 0 - Math.log(Math.max(cost, 1));

export class NettingEnv implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell = "single";
  private readonly instance: Instance;
  private readonly config: NettingConfig;
  private attempts: number;
  private probes: number;
  private closed = false;
  private plan: Transfer[] | null = null;
  private readonly probed: string[] = [];

  constructor(fixture: NettingFixture, config: NettingConfig) {
    this.task = `netting/${fixture.cell}`;
    this.seed = fixture.seed;
    this.instance = instanceOf(fixture);
    this.config = config;
    this.attempts = config.budget.attempts;
    this.probes = config.budget.probes;
  }

  budget(): Budget {
    return { attempts: this.attempts, probes: this.probes, blocks: 0, sats: 0 };
  }

  tools(): string[] {
    return ["probe", "settle", "commit"];
  }

  view(): Json {
    return instanceOf({ ...this.instance, version: "", seed: 0, cell: "", params: { traders: 0, trades: 0, graph: "uniform", link_capacity_ppm_of_notional: 0 } }) as unknown as Json;
  }

  done(): boolean {
    return this.closed;
  }

  private spendAttempt(): void {
    this.attempts -= 1;
    if (this.attempts === 0) this.closed = true;
  }

  private report(e: Evaluation): Json {
    return { valid: e.violations.length === 0, violations: e.violations.map((v) => ({ ...v })), cost_sats: e.cost, transfers: e.transfers, gross_volume_sats: e.gross_volume, ghost_volume_sats: e.ghost_volume };
  }

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (isObject(action) && action.tool === "commit") {
      this.closed = true;
      return accept();
    }
    if (!isObject(action) || typeof action.tool !== "string") { this.spendAttempt(); return reject("malformed"); }
    if (action.tool === "probe") {
      if (this.probes === 0) { this.spendAttempt(); return reject("over_budget"); }
      this.probes -= 1;
      const plan = parsePlan(isObject(action.args) ? action.args.plan : undefined);
      if (plan === "malformed") return reject("malformed");
      const e = evaluatePlan(this.instance, plan);
      this.probed.push(canonical(plan));
      return accept(this.report(e));
    }
    if (action.tool === "settle") {
      this.spendAttempt();
      const plan = parsePlan(isObject(action.args) ? action.args.plan : undefined);
      if (plan === "malformed") return reject("malformed");
      const e = evaluatePlan(this.instance, plan);
      // Rejected whole on the first violation; the whole list is what a probe is for.
      if (e.violations.length > 0) return reject(e.violations[0]!.reason, this.report(e));
      this.plan = plan;
      this.closed = true;
      return accept(this.report(e));
    }
    this.spendAttempt();
    return reject("unknown_tool");
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    const floor = evaluatePlan(this.instance, settleGross(this.instance));
    if (floor.violations.length > 0) throw new Error(`${this.task} seed ${this.seed}: the floor plan is invalid: ${floor.violations[0]!.detail}`);
    const e = this.plan ? evaluatePlan(this.instance, this.plan) : null;
    const cost = e ? e.cost : this.config.infeasible_penalty_factor * floor.cost;
    return {
      value: valueOf(cost),
      metrics: {
        cost_sats: cost,
        settled: e ? 1 : 0,
        transfers: e ? e.transfers : 0,
        gross_volume_sats: e ? e.gross_volume : 0,
        ghost_volume_sats: e ? e.ghost_volume : 0,
        probes_used: this.config.budget.probes - this.probes,
      },
    };
  }

  snapshot(): string {
    return canonical({ plan: this.plan, probed: this.probed });
  }

  privileged(): Json {
    // Nothing is hidden in this family; the ceiling computes from the observation.
    return {};
  }
}
