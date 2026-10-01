// Family 3: settlement-object selection, pin-supported variant (docs/tasks.md §4, §4.6). The agent
// sees a demand process, may probe candidate choices on a pilot stream drawn from the same process,
// and fixes one choice, which is scored on the evaluation stream by liquidity duration subject to a
// failure-rate ceiling.

import { accept, reject, type Budget, type Environment, type Outcome, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, type Json } from "../../harness/json.ts";
import { runCorner, type Choice, type CornerResult } from "./corner.ts";
import { loadStream, type DemandStream, type SettlementFixture, type StreamKind } from "./generate.ts";

export interface SettlementConfig {
  variant: string;
  epsilon: number;
  infeasible_penalty_factor: number;
  budget: { attempts: number; probes: number };
  grid: { margin: number[]; refresh_lead_blocks: number[] };
  baselines: { always_channel_margin: number; always_vtxo_refresh_lead_blocks: number };
  cells: { [cell: string]: SettlementFixture["params"] };
}

/** The declared grid in canonical order: channel margins ascending, then refresh leads ascending. */
export function gridOf(config: SettlementConfig): Choice[] {
  return [
    ...[...config.grid.margin].sort((a, b) => a - b).map((margin): Choice => ({ object: "channel", margin })),
    ...[...config.grid.refresh_lead_blocks].sort((a, b) => a - b).map((lead): Choice => ({ object: "vtxo", refresh_lead_blocks: lead })),
  ];
}

export const choiceKey = (choice: Choice): string => (choice.object === "channel" ? `channel:${choice.margin}` : `vtxo:${choice.refresh_lead_blocks}`);

export interface Scored extends CornerResult { feasible: boolean; }

/**
 * Simulation results for one fixture. Streams are regenerated from the seed and checked against
 * their bound hashes on first use. Results are memoized, so every policy in a run is scored by the
 * same simulation of the same choice.
 */
export class Simulations {
  readonly fixture: SettlementFixture;
  private readonly epsilon: number;
  private readonly streams = new Map<StreamKind, DemandStream>();
  private readonly results = new Map<string, Scored>();

  constructor(fixture: SettlementFixture, epsilon: number) {
    this.fixture = fixture;
    this.epsilon = epsilon;
  }

  stream(kind: StreamKind): DemandStream {
    let s = this.streams.get(kind);
    if (!s) { s = loadStream(this.fixture, kind); this.streams.set(kind, s); }
    return s;
  }

  run(kind: StreamKind, choice: Choice): Scored {
    const key = `${kind}|${choiceKey(choice)}`;
    let r = this.results.get(key);
    if (!r) {
      const raw = runCorner(this.stream(kind), this.fixture.protocol, choice);
      r = { ...raw, feasible: Number.isFinite(raw.duration) && raw.duration > 0 && raw.failure_rate <= this.epsilon };
      this.results.set(key, r);
    }
    return r;
  }
}

/** Parse a choice and check it is on the grid. Returns a rejection reason or the grid's own choice object. */
function parseChoice(raw: unknown, grid: Choice[]): "malformed" | "out_of_grid" | Choice {
  if (!isObject(raw)) return "malformed";
  let candidate: Choice;
  if (raw.object === "channel" && typeof raw.margin === "number") candidate = { object: "channel", margin: raw.margin };
  else if (raw.object === "vtxo" && typeof raw.refresh_lead_blocks === "number") candidate = { object: "vtxo", refresh_lead_blocks: raw.refresh_lead_blocks };
  else return "malformed";
  return grid.find((g) => choiceKey(g) === choiceKey(candidate)) ?? "out_of_grid";
}

export class SettlementEnv implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell = "single";
  private readonly sims: Simulations;
  private readonly config: SettlementConfig;
  private readonly grid: Choice[];
  private attempts: number;
  private probes: number;
  private closed = false;
  private chosen: Choice | null = null;
  private readonly probed: string[] = [];

  constructor(sims: Simulations, config: SettlementConfig) {
    this.task = `settlement_object/${sims.fixture.cell}`;
    this.seed = sims.fixture.seed;
    this.sims = sims;
    this.config = config;
    this.grid = gridOf(config);
    this.attempts = config.budget.attempts;
    this.probes = config.budget.probes;
  }

  budget(): Budget {
    return { attempts: this.attempts, probes: this.probes, blocks: 0, sats: 0 };
  }

  tools(): string[] {
    return ["probe", "choose", "commit"];
  }

  view(): Json {
    const { params, protocol, steps } = this.sims.fixture;
    const { base, burst } = params;
    const perStepIn = (burst.p_in_ppm / 1e6) * burst.in_sats + (base.in_sats > 0 ? base.in_sats + (base.jitter_sats - 1) / 2 : 0);
    const perStepOut = (burst.p_out_ppm / 1e6) * burst.out_sats + (base.out_sats > 0 ? base.out_sats + (base.jitter_sats - 1) / 2 : 0);
    return {
      process: {
        agents: params.agents,
        base: { ...base },
        burst: { p_in: burst.p_in_ppm / 1e6, in_sats: burst.in_sats, p_out: burst.p_out_ppm / 1e6, out_sats: burst.out_sats },
        common_shock_share: params.common_shock_share_ppm / 1e6,
        horizon_lifetimes: params.horizon_lifetimes,
        derived: { inflow_sats_per_step: perStepIn, outflow_sats_per_step: perStepOut, drift_sats_per_step: perStepIn - perStepOut },
      },
      protocol: { lifetime_blocks: protocol.lifetime_blocks, round_interval_blocks: protocol.round_interval_blocks, steps },
      epsilon: this.config.epsilon,
      grid: { margin: this.grid.filter((g) => g.object === "channel").map((g) => (g as { margin: number }).margin), refresh_lead_blocks: this.grid.filter((g) => g.object === "vtxo").map((g) => (g as { refresh_lead_blocks: number }).refresh_lead_blocks) },
      variant: this.config.variant,
    };
  }

  done(): boolean {
    return this.closed;
  }

  private spendAttempt(): void {
    this.attempts -= 1;
    if (this.attempts === 0) this.closed = true;
  }

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (isObject(action) && action.tool === "commit") {
      this.closed = true;
      return accept();
    }
    if (!isObject(action) || typeof action.tool !== "string") { this.spendAttempt(); return reject("malformed"); }
    if (action.tool === "probe") {
      // A probe costs one probe, accepted or not. With none left it costs an attempt and is refused.
      if (this.probes === 0) { this.spendAttempt(); return reject("over_budget"); }
      this.probes -= 1;
      const choice = parseChoice(isObject(action.args) ? action.args.choice : undefined, this.grid);
      if (typeof choice === "string") return reject(choice);
      const r = this.sims.run("pilot", choice);
      this.probed.push(choiceKey(choice));
      return accept({ choice: { ...choice }, duration: Number.isFinite(r.duration) ? r.duration : null, failure_rate: r.failure_rate, feasible: r.feasible });
    }
    if (action.tool === "choose") {
      this.spendAttempt();
      const choice = parseChoice(isObject(action.args) ? action.args.choice : undefined, this.grid);
      if (typeof choice === "string") return reject(choice);
      this.chosen = choice;
      this.closed = true;
      return accept({ choice: { ...choice } });
    }
    this.spendAttempt();
    return reject("unknown_tool");
  }

  /** Every grid point on the evaluation stream. Used for the infeasibility penalty and by the oracle. */
  private evaluationGrid(): Array<{ choice: Choice; result: Scored }> {
    return this.grid.map((choice) => ({ choice, result: this.sims.run("evaluation", choice) }));
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    const feasible = this.evaluationGrid().filter((g) => g.result.feasible);
    if (feasible.length === 0) throw new Error(`${this.task} seed ${this.seed}: no feasible grid point`);
    const penalty = this.config.infeasible_penalty_factor * Math.max(...feasible.map((g) => g.result.duration));
    const r = this.chosen ? this.sims.run("evaluation", this.chosen) : null;
    const ok = r !== null && r.feasible;
    const scored = ok ? r.duration : penalty;
    return {
      value: -Math.log(scored),
      metrics: {
        scored_duration: scored,
        feasible: ok ? 1 : 0,
        chose: this.chosen ? 1 : 0,
        vtxo: this.chosen?.object === "vtxo" ? 1 : 0,
        failure_rate: r ? r.failure_rate : 0,
        peak_locked: r ? r.peak_locked : 0,
        probes_used: this.config.budget.probes - this.probes,
      },
    };
  }

  snapshot(): string {
    return canonical({ chosen: this.chosen, probed: this.probed });
  }

  privileged(): Json {
    return {
      evaluation: this.evaluationGrid().map((g) => ({ choice: { ...g.choice }, duration: Number.isFinite(g.result.duration) ? g.result.duration : null, failure_rate: g.result.failure_rate, feasible: g.result.feasible })),
    };
  }
}
