// The one interface every policy plugs into: act(observation: JSON) → action: JSON.
// Scripted baselines, a learned policy, and an LLM adapter are all Agents and all run through the
// same episode runner. An Environment is one seeded episode of one task.

import type { Json } from "./json.ts";

export const BENCH = "bitcoin-defi-bench/v0";

/** Per-episode budget. See docs/tasks.md §1.2 for what each counter means. */
export interface Budget {
  attempts: number;
  probes: number;
  blocks: number;
  sats: number;
}

export interface EpisodeInfo {
  task: string;
  seed: number;
  cell: string;
}

export interface Agent {
  readonly id: string;
  /** Oracle baselines only. The runner passes Environment.privileged() to reset and records the flag. */
  readonly privileged?: boolean;
  reset?(episode: EpisodeInfo, privileged?: Json): void;
  act(observation: Json): Json | Promise<Json>;
}

export const REJECT_REASONS = [
  "malformed", "unknown_tool", "unknown_node", "self_pair", "not_integer",
  "below_minimum", "over_budget", "out_of_grid", "phase_closed",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface StepResult {
  accepted: boolean;
  reason: RejectReason | null;
  result: Json;
}

export interface Outcome {
  /** Native value in the family's own unit, oriented so that higher is better. */
  value: number;
  metrics: { [name: string]: number };
}

export interface Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell: string;
  /** Remaining budget. */
  budget(): Budget;
  tools(): string[];
  view(): Json;
  /** Validate, then apply or reject. A rejection is the identity on state and still costs its budget. */
  step(action: unknown): StepResult;
  /** True once the decision phase has ended (commit, or attempts exhausted). */
  done(): boolean;
  /** Run the simulator to the horizon with whatever was committed. */
  finish(): Outcome;
  /** Canonical serialization of the full simulator state, excluding the budget counters. */
  snapshot(): string;
  /** Information reserved for oracle baselines. Never part of an observation. */
  privileged(): Json;
}

export const accept = (result: Json = null): StepResult => ({ accepted: true, reason: null, result });
export const reject = (reason: RejectReason, result: Json = null): StepResult => ({ accepted: false, reason, result });
