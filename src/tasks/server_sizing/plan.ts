// Family 4 planning: the no-failure position path of a demand stream, the per-interval summaries
// an agent sees, and the exact dynamic program over never-failing capacity schedules.
//
// Positions follow family 3's server envelope (corner.ts serverEnvelope): in each step, in the
// stream's agent order (Map insertion order), each agent's receipt and then its spend.
import type { DemandStream } from "../settlement_object/generate.ts";

/** What the schedule's capital and resizing cost depend on, and the decision timing. */
export interface PlanParams {
  round_interval_blocks: number;
  decision_interval_blocks: number;
  resize_delay_blocks: number;
  capital_rate_per_block: number;
  resize_fee_sats: number;
  lease_rate_ppm: number;
}

/** The environment's prices: the plan's, and the cost of a failed receipt. The baselines' margins are in the config, not here. */
export interface SizingParams extends PlanParams {
  failure_fixed_sats: number;
  failure_value_share: number;
}

/**
 * The server's net position with every payment delivered, one entry per step. `start` and `end`
 * are the position before the step's first event and after its last; `max` is the highest position
 * in the step including its start (what a summary calls the maximum); `recv` is the highest
 * position right after any receipt in the step, 0 when the step has none. A receipt fails exactly
 * when the position after it would exceed the capacity, so `recv` is what capacity must cover.
 */
export interface PositionPath { start: number[]; max: number[]; end: number[]; recv: number[]; peak: number }

export interface IntervalSummary {
  start_step: number;
  end_step: number;
  position_start: number;
  position_max: number;
  position_end: number;
  /** End of the window of interval plus resize delay, clipped to the steps observed so far. */
  delay_end_step: number;
  /** Highest position from the interval's first step to `delay_end_step`. */
  max_with_delay: number;
}

export function timing(p: PlanParams, steps: number): { interval: number; delay: number; count: number } {
  const interval = p.decision_interval_blocks / p.round_interval_blocks;
  const delay = p.resize_delay_blocks / p.round_interval_blocks;
  if (!Number.isInteger(interval) || interval < 1 || !Number.isInteger(delay) || delay < 0 || delay >= interval || steps < 1) {
    throw new Error("sizing requires whole rounds and a delay shorter than the decision interval");
  }
  return { interval, delay, count: Math.ceil(steps / interval) };
}

export function positionPath(demand: DemandStream): PositionPath {
  const series = [...demand.values()];
  const steps = series[0]?.length ?? 0;
  if (steps < 1 || series.some((s) => s.length !== steps)) throw new Error("empty or unequal demand series");
  const path: PositionPath = { start: [], max: [], end: [], recv: [], peak: 0 };
  let position = 0;
  for (let t = 0; t < steps; t++) {
    path.start.push(position);
    let peak = position;
    let received = 0;
    for (const s of series) {
      const step = s[t]!;
      if (step.in) {
        position += step.in;
        if (position > received) received = position;
        if (position > peak) peak = position;
      }
      position -= step.out;
    }
    path.max.push(peak);
    path.recv.push(received);
    path.end.push(position);
    if (peak > path.peak) path.peak = peak;
  }
  return path;
}

const maxOf = (values: number[], from: number, to: number): number => {
  let best = -Infinity;
  for (let i = from; i < to; i++) if (values[i]! > best) best = values[i]!;
  return best;
};

/** Summaries of the completed decision intervals, using only steps before `observedSteps`. */
export function intervalSummaries(path: PositionPath, p: PlanParams, observedSteps = path.end.length): IntervalSummary[] {
  const { interval, delay } = timing(p, path.end.length);
  const out: IntervalSummary[] = [];
  for (let start = 0; start < observedSteps; start += interval) {
    const end = Math.min(start + interval, path.end.length);
    if (end > observedSteps) break;
    const delayEnd = Math.min(end + delay, observedSteps);
    out.push({
      start_step: start, end_step: end, position_start: path.start[start]!,
      position_max: maxOf(path.max, start, end), position_end: path.end[end - 1]!,
      delay_end_step: delayEnd, max_with_delay: maxOf(path.max, start, delayEnd),
    });
  }
  return out;
}

/** Cost of moving the target from `old` to `next`: nothing if equal, else the fee plus the lease on an increase. */
export const resizeCost = (old: number, next: number, p: PlanParams): number =>
  old === next ? 0 : p.resize_fee_sats + p.lease_rate_ppm / 1e6 * Math.max(0, next - old);

export interface RequiredLevels {
  /**
   * What level k must be, at least: the highest no-failure position right after a receipt while it
   * is in force, and for k > 0 the position at the decision and at the step the level takes effect,
   * because the server's capacity can never be below the position it holds.
   */
  q: number[];
  /** The receipt part of q: the highest no-failure position right after a receipt while level k is in force. */
  receipts: number[];
  /** The floor part of q: 0 for level 0, else the larger of the position at the decision and at the step it takes effect. */
  floors: number[];
  /** Steps level k is in force. */
  spans: number[];
  /** The maximum of q over every contiguous range of decisions, which is the set of q. */
  candidates: number[];
}

/**
 * Level 0 is in force for steps [0, interval + delay); level k > 0, ordered at step k × interval,
 * for [k × interval + delay, (k + 1) × interval + delay); the last to the horizon.
 */
export function requiredLevels(path: PositionPath, p: PlanParams): RequiredLevels {
  const steps = path.end.length;
  const { interval, delay, count } = timing(p, steps);
  const receipts: number[] = [], floors: number[] = [], q: number[] = [], spans: number[] = [];
  for (let k = 0; k < count; k++) {
    const start = k === 0 ? 0 : Math.min(steps, k * interval + delay);
    const end = Math.min(steps, (k + 1) * interval + delay);
    const landed = start < end;
    const receipt = landed ? maxOf(path.recv, start, end) : 0;
    // A resize below the position at the decision is rejected; one that lands below the position is lifted to it.
    const floor = k === 0 ? 0 : Math.max(path.start[k * interval]!, landed ? path.start[start]! : 0);
    receipts.push(receipt);
    floors.push(floor);
    q.push(Math.max(receipt, floor));
    spans.push(Math.max(0, end - start));
  }
  // The maximum over a contiguous range is one of the q in it, so the set of range maxima is the set of q.
  return { q, receipts, floors, spans, candidates: [...new Set(q)].sort((a, b) => a - b) };
}

export interface SizingPlan extends RequiredLevels { levels: number[]; cost_sats: number }

/**
 * Exact minimum cost over never-failing schedules that respect the position floor: dynamic
 * programming over (decision, level) with level ≥ q_k, the transition cost of `resizeCost`, and the
 * carry level × rate × span.
 * `maxLevel`, when given, is the cap on a target; a q above it makes the plan infeasible.
 */
export function optimalSchedule(path: PositionPath, p: PlanParams, maxLevel = Infinity): SizingPlan {
  const required = requiredLevels(path, p);
  const { q, spans, candidates: levels } = required;
  const worst = Math.max(...q);
  if (worst > maxLevel) throw new Error(`no never-failing schedule: a decision must cover ${worst} sats, above the cap of ${maxLevel}`);
  const n = q.length, m = levels.length;
  const carryOf = (level: number, k: number): number => level * p.capital_rate_per_block * p.round_interval_blocks * spans[k]!;
  const back: number[][] = [];
  let costs = levels.map((level) => level >= q[0]! ? resizeCost(0, level, p) + carryOf(level, 0) : Infinity);
  for (let k = 1; k < n; k++) {
    const prev: number[] = new Array(m).fill(-1);
    const next: number[] = new Array(m).fill(Infinity);
    for (let j = 0; j < m; j++) {
      if (levels[j]! < q[k]!) continue;
      const carry = carryOf(levels[j]!, k);
      for (let i = 0; i < m; i++) {
        const value = costs[i]! + resizeCost(levels[i]!, levels[j]!, p) + carry;
        if (value < next[j]!) { next[j] = value; prev[j] = i; }
      }
    }
    back.push(prev);
    costs = next;
  }
  let best = 0;
  for (let i = 1; i < m; i++) if (costs[i]! < costs[best]!) best = i;
  const cost_sats = costs[best]!;
  const schedule: number[] = new Array(n);
  for (let k = n - 1; k >= 0; k--) {
    schedule[k] = levels[best]!;
    if (k > 0) best = back[k - 1]![best]!;
  }
  return { ...required, levels: schedule, cost_sats };
}
