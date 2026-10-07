// Skills a model may call through the chat adapter (docs/saturation.md). Each is pure in the
// observation and its arguments, reads nothing hidden, and is a few lines on top of a baseline's
// own code. The source of each `run` is hashed into the agent id.

import { pairKey } from "../harness/order.ts";
import { sha256, type Json } from "../harness/json.ts";
import { nonEdges } from "../tasks/placement/baselines.ts";
import { evaluatePlan, settleOptimal, type Instance } from "../tasks/netting/plans.ts";
import type { Skill } from "./chat.ts";

const bind = (skill: Omit<Skill, "sha256">): Skill => ({ ...skill, sha256: sha256(`${skill.name}\n${skill.run.toString()}`) });

/** Family 6: the exact minimum-cost settlement plan for the observed instance, as the action to send. */
export const minCostFlowSkill: Skill = bind({
  name: "min_cost_flow",
  description: "Computes the cheapest valid settlement plan for the instance you were shown and returns it as the exact action to send. To use it, reply with that action unchanged.",
  run(observation: Json): Json {
    const instance = (observation as { view: Instance }).view;
    const plan = settleOptimal(instance);
    const e = evaluatePlan(instance, plan);
    return {
      cost_sats: e.cost,
      transfers: e.transfers,
      action: { tool: "settle", args: { plan: { transfers: plan.map((t) => ({ ...t })) } } },
    };
  },
});

/** Family 1: warm-up failures counted per unordered pair, as the failure-aware heuristic counts them. */
export const failedPairsSkill: Skill = bind({
  name: "failed_pairs",
  description: "Counts the failed payments in the history for each pair of nodes and returns the most-failed pairs, saying whether each already has a channel. It does not choose for you.",
  run(observation: Json, args: Json): Json {
    const view = (observation as { view: { nodes: string[]; edges: Array<{ u: string; v: string }>; history: Array<{ source: string; target: string; delivered: boolean }> } }).view;
    const limit = typeof (args as { limit?: unknown })?.limit === "number" ? Math.max(1, Math.min(50, (args as { limit: number }).limit)) : 10;
    const open = new Set(nonEdges(view).map(([a, b]) => pairKey(a, b)));
    const counts = new Map<string, number>();
    for (const h of view.history) {
      if (h.delivered) continue;
      const key = pairKey(h.source, h.target);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, limit);
    return {
      failed_pairs: ranked.map(([key, n]) => {
        const [a, b] = key.split("|");
        return { pair: [a, b], failed: n, has_channel: !open.has(key) };
      }),
      total_failed: view.history.filter((h) => !h.delivered).length,
    };
  },
});

export const SKILLS: { [name: string]: Skill } = { min_cost_flow: minCostFlowSkill, failed_pairs: failedPairsSkill };

export function skillsNamed(names: string): Skill[] {
  return names.split(",").map((n) => n.trim()).filter((n) => n !== "").map((n) => {
    const skill = SKILLS[n];
    if (!skill) throw new Error(`unknown skill ${n}; known: ${Object.keys(SKILLS).join(", ")}`);
    return skill;
  });
}
