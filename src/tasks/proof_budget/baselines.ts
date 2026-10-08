// Family 7 baselines. All but the ceiling read only the observation: the pending claims, the
// arrival process's parameters, the cost table, and the prices. The ceiling is clairvoyant: it is
// handed every claim of the horizon and plays the dynamic program's schedule.

import type { Agent, EpisodeInfo } from "../../harness/agent.ts";
import { isObject, type Json } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";
import { CostModel } from "./cost.ts";
import type { ProofView } from "./env.ts";
import { meanRate, meanValue, type Claim } from "./generate.ts";
import { optimalSchedule, type Proof } from "./plan.ts";

interface Obs { view: ProofView; budget: { attempts: number; blocks: number }; episode: { seed: number } }
const obsOf = (o: Json): Obs => o as unknown as Obs;
const costOf = (v: ProofView): CostModel => new CostModel({ grid: v.cost_table, source: { file: "", sha256: "", program_sha256: "", toolchain: "", machine: "", statistic: "" } }, v.prover_price_sats_per_second, v.memory_ceiling_mib);
const prove = (count: number): Json => ({ tool: "prove", args: { count } });
const wait = (blocks: number): Json => ({ tool: "wait", args: { blocks } });

/**
 * The interval of the economic order quantity: proving every T blocks costs a fixed cost F per
 * proof and, per block, staleness growing with the pending value, so T* = √(2F / (λ s v̄)), with F
 * the prover's price for one claim (the cost's floor), λ the mean arrival rate, and v̄ the mean
 * value. Lengthened if needed so the proofs last the horizon.
 */
export function eoqInterval(v: ProofView, maxProofs: number): number {
  const F = costOf(v).cost(1);
  const rate = meanRate(v.arrivals);
  const s = v.staleness_ppm_per_block / 1e6;
  const t = Math.max(1, Math.round(Math.sqrt((2 * F) / (rate * s * meanValue(v.arrivals)))));
  return Math.max(t, Math.ceil(v.horizon_blocks / Math.max(1, maxProofs)));
}

/** Floor: prove whatever is pending at every block that has any. */
export class EveryArrival implements Agent {
  readonly id = "every_arrival";
  act(o: Json): Json {
    const { view: v } = obsOf(o);
    if (v.pending.length > 0) return prove(Math.min(v.pending.length, v.max_batch));
    return wait(1);
  }
}

/** Reference: prove all pending every T blocks, T from the economic order quantity, and at the last block. */
export class FixedInterval implements Agent {
  readonly id = "fixed_interval";
  private interval = 0;
  reset(): void { this.interval = 0; }
  act(o: Json): Json {
    const { view: v, budget } = obsOf(o);
    if (this.interval === 0) this.interval = eoqInterval(v, budget.attempts);
    const T = this.interval;
    const last = v.horizon_blocks - 1;
    // Due at blocks T − 1, 2T − 1, …, and at the last block.
    const due = (v.block + 1) % T === 0 || v.block === last;
    if (due && v.pending.length > 0) return prove(Math.min(v.pending.length, v.max_batch));
    if (v.block === last) return wait(1);
    const nextDue = Math.min(last, (Math.floor((v.block + 1) / T) + 1) * T - 1);
    return wait(nextDue - v.block);
  }
}

/** Descriptive: prove when the pending claims' accrued staleness reaches the cost of a one-claim proof, or at the last block. */
export class Threshold implements Agent {
  readonly id = "threshold";
  act(o: Json): Json {
    const { view: v } = obsOf(o);
    const s = v.staleness_ppm_per_block / 1e6;
    const accrued = v.pending.reduce((sum, c) => sum + s * c.value_sats * (v.block - c.arrived_at), 0);
    const F = costOf(v).cost(1);
    if (v.pending.length > 0 && (accrued >= F || v.pending.length >= v.max_batch || v.block === v.horizon_blocks - 1)) return prove(Math.min(v.pending.length, v.max_batch));
    return wait(1);
  }
}

/** Descriptive: wait a random number of blocks, up to twice the reference's interval, then prove all pending. */
export class RandomInterval implements Agent {
  readonly id = "random_interval";
  private rng: Stream = stream("proof_budget/random_interval", 0);
  private interval = 0;
  reset(episode: EpisodeInfo): void { this.rng = stream("proof_budget/random_interval", episode.seed, episode.task); this.interval = 0; }
  act(o: Json): Json {
    const { view: v, budget } = obsOf(o);
    if (this.interval === 0) this.interval = eoqInterval(v, budget.attempts);
    if (v.pending.length > 0 && (v.block === v.horizon_blocks - 1 || this.rng.next() < 1 / this.interval)) return prove(Math.min(v.pending.length, v.max_batch));
    return wait(1);
  }
}

/** Ceiling: the clairvoyant dynamic program's schedule, played through `act`. */
export class OptimalBatching implements Agent {
  readonly id = "optimal_batching";
  readonly privileged = true;
  private plan: Proof[] = [];
  private claims: Claim[] = [];
  private planned = false;
  reset(_episode: EpisodeInfo, privileged?: Json): void {
    if (!isObject(privileged)) throw new Error("optimal_batching was not given privileged information");
    this.claims = (privileged as unknown as { claims: Claim[] }).claims;
    this.plan = [];
    this.planned = false;
  }
  act(o: Json): Json {
    const { view: v, budget } = obsOf(o);
    if (!this.planned) {
      this.plan = optimalSchedule(this.claims, costOf(v), v.staleness_ppm_per_block, budget.attempts);
      this.planned = true;
    }
    const nextProof = this.plan[0];
    if (!nextProof) return { tool: "commit" };
    if (nextProof.block === v.block) { this.plan.shift(); return prove(nextProof.count); }
    return wait(nextProof.block - v.block);
  }
}

export const proofBaselines = (): Agent[] => [new EveryArrival(), new RandomInterval(), new Threshold(), new FixedInterval(), new OptimalBatching()];
