// Settlement-object baselines. `random` draws one point of the declared grid. `always_channel` and
// `always_vtxo` are the two settings of the pinned corner test (margin 0.25; refresh lead 288),
// with the same margin on the server's channels as on an agent's.
// `grid_search` is the oracle: it is given every grid point's result on the evaluation stream and
// takes the feasible minimum of liquidity duration.

import type { Agent, EpisodeInfo } from "../../harness/agent.ts";
import { isObject, type Json } from "../../harness/json.ts";
import { stream } from "../../harness/prng.ts";
import type { Choice } from "./corner.ts";
import { choiceKey, type SettlementConfig } from "./env.ts";

const choose = (choice: Choice): Json => ({ tool: "choose", args: { choice: { ...choice } } });

function gridFrom(observation: Json): Choice[] {
  const grid = (observation as { view: { grid: { margin: number[]; refresh_lead_blocks: number[] } } }).view.grid;
  return [
    ...grid.margin.map((margin): Choice => ({ object: "channel", margin })),
    ...grid.refresh_lead_blocks.flatMap((lead) => grid.margin.map((margin): Choice => ({ object: "vtxo", refresh_lead_blocks: lead, margin }))),
  ];
}

export class RandomChoice implements Agent {
  readonly id = "random";
  private episode: EpisodeInfo = { task: "", seed: -1, cell: "" };
  reset(episode: EpisodeInfo): void { this.episode = episode; }
  act(observation: Json): Json {
    return choose(stream("baseline/settlement/random", this.episode.task, this.episode.seed).pick(gridFrom(observation)));
  }
}

export class AlwaysChannel implements Agent {
  readonly id = "always_channel";
  private readonly margin: number;
  constructor(config: SettlementConfig) { this.margin = config.baselines.always_channel_margin; }
  act(): Json { return choose({ object: "channel", margin: this.margin }); }
}

export class AlwaysVtxo implements Agent {
  readonly id = "always_vtxo";
  private readonly lead: number;
  private readonly margin: number;
  constructor(config: SettlementConfig) { this.lead = config.baselines.always_vtxo_refresh_lead_blocks; this.margin = config.baselines.always_vtxo_margin; }
  act(): Json { return choose({ object: "vtxo", refresh_lead_blocks: this.lead, margin: this.margin }); }
}

export class GridSearch implements Agent {
  readonly id = "grid_search";
  readonly privileged = true;
  private best: Choice | null = null;
  reset(_episode: EpisodeInfo, privileged?: Json): void {
    if (!isObject(privileged)) throw new Error("oracle baseline was not given privileged information");
    const rows = (privileged as { evaluation: Array<{ choice: Choice; duration: number | null; feasible: boolean }> }).evaluation.filter((r) => r.feasible && r.duration !== null);
    // Feasible minimum of liquidity duration; ties go to the canonically first choice.
    rows.sort((a, b) => a.duration! - b.duration! || (choiceKey(a.choice) < choiceKey(b.choice) ? -1 : 1));
    this.best = rows[0]?.choice ?? null;
  }
  act(): Json {
    if (!this.best) throw new Error("grid search found no feasible choice");
    return choose(this.best);
  }
}

export const settlementBaselines = (config: SettlementConfig): Agent[] => [new RandomChoice(), new AlwaysChannel(config), new AlwaysVtxo(config), new GridSearch()];
