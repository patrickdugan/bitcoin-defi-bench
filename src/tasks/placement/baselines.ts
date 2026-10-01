// Placement baselines. Each is an Agent and runs through the same episode runner as any policy
// under test. `random` and `failure_aware` are the two rules Spiral's public-topology campaign
// compared (choose_capital_connector): the measured effect of the second over the first is +6.13
// points under stationary demand and not distinguishable from zero after a shift. `oracle` knows
// the hotspot pair active during evaluation and nothing else; it is a fixed rule, not a search.

import type { Agent, EpisodeInfo } from "../../harness/agent.ts";
import { isObject, type Json } from "../../harness/json.ts";
import { cmp, pairKey, sortedPair } from "../../harness/order.ts";
import { stream } from "../../harness/prng.ts";

type Action = { tool: string; args?: { [key: string]: Json } };

interface View {
  nodes: string[];
  edges: Array<{ u: string; v: string }>;
  history: Array<{ source: string; target: string; delivered: boolean }>;
}

const viewOf = (observation: Json): { view: View; sats: number; turn: number } => {
  if (!isObject(observation)) throw new Error("baseline received a malformed observation");
  const o = observation as { view: View; budget: { sats: number }; episode: { turn: number } };
  return { view: o.view, sats: o.budget.sats, turn: o.episode.turn };
};

/** Sorted node pairs with no channel between them. */
export function nonEdges(view: View): Array<[string, string]> {
  const edges = new Set(view.edges.map((e) => pairKey(e.u, e.v)));
  const nodes = [...view.nodes].sort(cmp);
  const out: Array<[string, string]> = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (!edges.has(pairKey(nodes[i]!, nodes[j]!))) out.push([nodes[i]!, nodes[j]!]);
    }
  }
  return out;
}

/** The whole budget on one pair, split evenly, as Spiral's connector (balance = amount // 2). */
const evenSplit = (pair: [string, string], sats: number): Action => ({
  tool: "place",
  args: { placements: [{ from: pair[0], to: pair[1], sats: Math.floor(sats / 2) }, { from: pair[1], to: pair[0], sats: sats - Math.floor(sats / 2) }] },
});

const COMMIT: Action = { tool: "commit" };

/** The pair the random baseline draws. Shared with failure_aware's fallback, as in Spiral. */
const randomPair = (view: View, episode: EpisodeInfo): [string, string] =>
  stream("baseline/placement/random", episode.seed, episode.cell).pick(nonEdges(view));

abstract class OneShot implements Agent {
  abstract readonly id: string;
  protected episode: EpisodeInfo = { task: "", seed: -1, cell: "" };
  reset(episode: EpisodeInfo): void { this.episode = episode; }
  protected abstract choose(view: View, sats: number): Action;
  act(observation: Json): Json {
    const { view, sats, turn } = viewOf(observation);
    return (turn === 0 ? this.choose(view, sats) : COMMIT) as Json;
  }
}

export class NoPlacement implements Agent {
  readonly id = "none";
  act(): Json { return COMMIT as Json; }
}

export class RandomPlacement extends OneShot {
  readonly id = "random";
  protected choose(view: View, sats: number): Action {
    return evenSplit(randomPair(view, this.episode), sats);
  }
}

export class FailureAwarePlacement extends OneShot {
  readonly id = "failure_aware";
  protected choose(view: View, sats: number): Action {
    const available = new Set(nonEdges(view).map(([a, b]) => pairKey(a, b)));
    const failed = new Map<string, number>();
    for (const h of view.history) {
      if (h.delivered) continue;
      const key = pairKey(h.source, h.target);
      if (available.has(key)) failed.set(key, (failed.get(key) ?? 0) + 1);
    }
    if (failed.size === 0) return evenSplit(randomPair(view, this.episode), sats);
    // Most failed demands; ties to the lexicographically greatest pair (Spiral sorts descending).
    const best = [...failed.entries()].sort((x, y) => y[1] - x[1] || cmp(y[0], x[0]))[0]![0];
    const [u, v] = best.split("|") as [string, string];
    return evenSplit(sortedPair(u, v), sats);
  }
}

export class OraclePlacement implements Agent {
  readonly id = "oracle";
  readonly privileged = true;
  private hotspot: [string, string] = ["", ""];
  private forward = 0.5;
  reset(_episode: EpisodeInfo, privileged?: Json): void {
    if (!isObject(privileged)) throw new Error("oracle baseline was not given privileged information");
    const p = privileged as { evaluation_hotspot: [string, string]; forward_probability: number };
    this.hotspot = p.evaluation_hotspot;
    this.forward = p.forward_probability;
  }
  act(observation: Json): Json {
    const { sats, turn } = viewOf(observation);
    if (turn !== 0) return COMMIT as Json;
    const ahead = Math.round(sats * this.forward);
    return {
      tool: "place",
      args: { placements: [{ from: this.hotspot[0], to: this.hotspot[1], sats: ahead }, { from: this.hotspot[1], to: this.hotspot[0], sats: sats - ahead }] },
    };
  }
}

export const placementBaselines = (): Agent[] => [new NoPlacement(), new RandomPlacement(), new FailureAwarePlacement(), new OraclePlacement()];
