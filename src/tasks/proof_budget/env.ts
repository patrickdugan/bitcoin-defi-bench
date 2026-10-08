// Family 7: proving claims within a budget (docs/tasks.md §8). Claims arrive block by block; the
// operator proves the oldest pending ones, as many as it chooses up to the largest batch that fits
// the memory ceiling, or waits. Each proof spends one of a fixed number of proofs. Scored by the
// prover's price for each proof, the staleness of every claim while it waits, and the whole value of
// every claim not proven by the horizon.

import { accept, reject, type Budget, type Environment, type Outcome, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, type Json } from "../../harness/json.ts";
import { CostModel, type GridPoint } from "./cost.ts";
import type { Arrivals, Claim, ProofFixture } from "./generate.ts";
import { ordered, type Proof } from "./plan.ts";

/** Native value: −ln of the total cost in sats, with a floor of one sat. */
export const valueOf = (cost: number): number => 0 - Math.log(Math.max(cost, 1));

export const costModelOf = (fixture: Pick<ProofFixture, "cost_table" | "params">): CostModel =>
  new CostModel(fixture.cost_table, fixture.params.prover_price_sats_per_second, fixture.params.memory_ceiling_mib);

export interface ProofView {
  block: number;
  horizon_blocks: number;
  pending: Array<{ id: number; arrived_at: number; value_sats: number }>;
  arrivals: Arrivals;
  cost_table: GridPoint[];
  max_batch: number;
  memory_ceiling_mib: number;
  prover_price_sats_per_second: number;
  staleness_ppm_per_block: number;
}

export class ProofEnv implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell = "single";
  private readonly fixture: ProofFixture;
  private readonly claims: Claim[];
  private readonly cost: CostModel;
  private t = 0;
  private next = 0;
  private proofsLeft: number;
  private closed = false;
  private prover = 0;
  private stale = 0;
  private readonly schedule: Proof[] = [];

  constructor(fixture: ProofFixture) {
    this.task = `proof_budget/${fixture.cell}`;
    this.seed = fixture.seed;
    this.fixture = fixture;
    this.claims = ordered(fixture.claims);
    this.cost = costModelOf(fixture);
    this.proofsLeft = fixture.params.max_proofs;
  }

  private get horizon(): number { return this.fixture.params.horizon_blocks; }

  /** Claims that have arrived by the current block and are not yet proven, oldest first. */
  private pending(): Claim[] {
    const out: Claim[] = [];
    for (let m = this.next; m < this.claims.length && this.claims[m]!.block <= this.t; m++) out.push(this.claims[m]!);
    return out;
  }

  budget(): Budget { return { attempts: this.proofsLeft, probes: 0, blocks: this.horizon - this.t, sats: 0 }; }

  tools(): string[] { return ["prove", "wait", "commit"]; }

  view(): Json {
    const p = this.fixture.params;
    const v: ProofView = {
      block: this.t,
      horizon_blocks: this.horizon,
      pending: this.pending().map((c) => ({ id: c.id, arrived_at: c.block, value_sats: c.value_sats })),
      arrivals: { ...p.arrivals },
      cost_table: this.fixture.cost_table.grid.map((g) => ({ ...g })),
      max_batch: this.cost.maxBatch,
      memory_ceiling_mib: p.memory_ceiling_mib,
      prover_price_sats_per_second: p.prover_price_sats_per_second,
      staleness_ppm_per_block: p.staleness_ppm_per_block,
    };
    return v as unknown as Json;
  }

  done(): boolean { return this.closed; }

  private spendAttempt(): void {
    this.proofsLeft -= 1;
    if (this.proofsLeft <= 0) this.closed = true;
  }

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (isObject(action) && action.tool === "commit") { this.closed = true; return accept(); }
    if (!isObject(action) || typeof action.tool !== "string") { this.spendAttempt(); return reject("malformed"); }
    const args = isObject(action.args) ? action.args : {};
    if (action.tool === "wait") {
      const n = args.blocks;
      if (typeof n !== "number") { this.spendAttempt(); return reject("malformed", { detail: "wait needs blocks" }); }
      if (!Number.isInteger(n)) { this.spendAttempt(); return reject("not_integer"); }
      if (n < 1) { this.spendAttempt(); return reject("below_minimum", { detail: "wait at least one block" }); }
      if (n > this.horizon - this.t) { this.spendAttempt(); return reject("over_budget", { detail: `only ${this.horizon - this.t} blocks remain` }); }
      this.t += n;
      if (this.t >= this.horizon) this.closed = true;
      return accept({ block: this.t });
    }
    if (action.tool === "prove") {
      const n = args.count;
      const pending = this.pending().length;
      this.spendAttempt();
      if (typeof n !== "number") return reject("malformed", { detail: "prove needs count" });
      if (!Number.isInteger(n)) return reject("not_integer");
      if (n < 1) return reject("below_minimum", { detail: "prove at least one claim" });
      if (n > pending) return reject("out_of_grid", { detail: `only ${pending} claims are pending` });
      if (n > this.cost.maxBatch) return reject("over_budget", { detail: `the largest batch that fits is ${this.cost.maxBatch}` });
      const s = this.fixture.params.staleness_ppm_per_block / 1e6;
      const cost = this.cost.cost(n);
      let stale = 0;
      for (let m = this.next; m < this.next + n; m++) stale += s * this.claims[m]!.value_sats * (this.t - this.claims[m]!.block);
      this.prover += cost;
      this.stale += stale;
      this.next += n;
      this.schedule.push({ block: this.t, count: n });
      return accept({ proven: n, prover_sats: cost, staleness_sats: stale });
    }
    this.spendAttempt();
    return reject("unknown_tool");
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    let forfeit = 0;
    for (let m = this.next; m < this.claims.length; m++) forfeit += this.claims[m]!.value_sats;
    const total = this.prover + this.stale + forfeit;
    return {
      value: valueOf(total),
      metrics: {
        cost_sats: total,
        prover_sats: this.prover,
        staleness_sats: this.stale,
        forfeit_sats: forfeit,
        proofs: this.schedule.length,
        proven: this.next,
        forfeited: this.claims.length - this.next,
        mean_batch: this.schedule.length ? this.next / this.schedule.length : 0,
      },
    };
  }

  snapshot(): string { return canonical({ t: this.t, next: this.next, schedule: this.schedule }); }

  /** For the clairvoyant ceiling only: every claim of the horizon, future arrivals included. */
  privileged(): Json { return { claims: this.claims.map((c) => ({ ...c })) } as unknown as Json; }
}
