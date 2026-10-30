// Family 4 baselines. All but the ceiling read only the observation. The ceiling is privileged: it
// is handed the evaluation stream and plays the dynamic program's never-failing schedule.

import type { Agent, EpisodeInfo } from "../../harness/agent.ts";
import { isObject, type Json } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";
import type { DemandStream, Step } from "../settlement_object/generate.ts";
import type { SizingView } from "./env.ts";
import { optimalSchedule, positionPath, type PositionPath } from "./plan.ts";

/** The two margins the heuristics use. They are in the config and not in the observation: the agent is not told the baselines' tuning. */
export interface Margins { static_margin: number; buffer_margin: number }

const viewOf = (o: Json): SizingView => (o as unknown as { view: SizingView }).view;
const resize = (n: number): Json => ({ tool: "resize", args: { inbound_sats: n } });
const bounded = (n: number, v: SizingView): number => Math.min(v.max_inbound_sats, Math.ceil(n));

/** Floor, family 3's server-tier rule: size ceil((1 + margin) × the pilot peak) at decision 0 and never resize. */
export class StaticPilot implements Agent {
  readonly id = "static_pilot";
  private readonly margin: number;
  constructor(margins: Margins) { this.margin = margins.static_margin; }
  act(o: Json): Json {
    const v = viewOf(o);
    return v.decision_index === 0 ? resize(bounded((1 + this.margin) * v.pilot.peak, v)) : { tool: "commit" };
  }
}

/**
 * Reference: b is (1 + margin) × the largest one-interval rise, the highest position in an interval
 * plus the resize delay less the position at the interval's start, over the pilot's intervals and
 * the completed evaluation intervals whose delay step has been observed. Size ceil(p + 2b) at
 * decision 0; later, resize to ceil(p + 2b) when the capacity is below p + b or above p + 3b.
 */
export class BufferRule implements Agent {
  readonly id = "buffer_rule";
  private readonly margin: number;
  constructor(margins: Margins) { this.margin = margins.buffer_margin; }
  act(o: Json): Json {
    const v = viewOf(o);
    const delay = v.resize_delay_blocks / v.round_interval_blocks;
    // At a decision the newest completed interval has not yet exposed its delay step: its window
    // would be one step short, so only intervals whose whole window was observed enter b.
    const seen = [...v.pilot.intervals, ...v.evaluation_completed].filter((i) => i.delay_end_step >= Math.min(i.end_step + delay, v.horizon_steps));
    const rise = Math.max(0, ...seen.map((i) => i.max_with_delay - i.position_start));
    const b = (1 + this.margin) * rise;
    if (v.decision_index === 0 || v.capacity_in_force < v.position + b || v.capacity_in_force > v.position + 3 * b) {
      return resize(bounded(v.position + 2 * b, v));
    }
    return { tool: "hold" };
  }
}

/**
 * Descriptive: a target uniform on [position, max(position, 2 × the pilot peak)] at every decision,
 * from the harness's seeded stream. The floor is the position, because a target below it is
 * rejected; without it this policy would only generate rejections.
 */
export class RandomSizing implements Agent {
  readonly id = "random";
  private rng: Stream = stream("server_sizing/random", 0);
  reset(episode: EpisodeInfo): void { this.rng = stream("server_sizing/random", episode.seed, episode.task); }
  act(o: Json): Json {
    const v = viewOf(o);
    const high = Math.max(v.position, 2 * v.pilot.peak);
    return resize(v.position + this.rng.int(high - v.position + 1));
  }
}

/** Ceiling, privileged: the exact dynamic program over never-failing schedules, played through `act`. */
export class Oracle implements Agent {
  readonly id = "oracle";
  readonly privileged = true;
  private path: PositionPath | null = null;
  private levels: number[] | null = null;
  reset(_episode: EpisodeInfo, privileged?: Json): void {
    if (!isObject(privileged) || !Array.isArray(privileged.evaluation)) throw new Error("oracle needs the evaluation stream");
    const demand: DemandStream = new Map(privileged.evaluation as unknown as Array<[string, Step[]]>);
    this.path = positionPath(demand);
    this.levels = null;
  }
  act(o: Json): Json {
    const v = viewOf(o);
    if (!this.path) throw new Error("oracle was not reset");
    this.levels ??= optimalSchedule(this.path, v, v.max_inbound_sats).levels;
    return resize(this.levels[v.decision_index]!);
  }
}

export const serverSizingBaselines = (margins: Margins): Agent[] => [new StaticPilot(margins), new BufferRule(margins), new RandomSizing(), new Oracle()];
