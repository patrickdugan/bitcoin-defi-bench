// Skills a model may call through the chat adapter (docs/saturation.md). Each is pure in the
// observation and its arguments, reads nothing hidden, and is a few lines on top of a baseline's
// own code. The source of each `run` is hashed into the agent id.

import { pairKey } from "../harness/order.ts";
import { sha256, type Json } from "../harness/json.ts";
import { nonEdges } from "../tasks/placement/baselines.ts";
import { settleOptimal, type Instance } from "../tasks/netting/plans.ts";
import { designJson, exactDesign, menuOf, modelFor, type DlcView } from "../tasks/dlc/designs.ts";
import { rateEstimate } from "../tasks/bonding/baselines.ts";
import type { BondingView } from "../tasks/bonding/env.ts";
import { catchProbability } from "../tasks/bonding/model.ts";
import { eoqInterval } from "../tasks/proof_budget/baselines.ts";
import type { ProofView } from "../tasks/proof_budget/env.ts";
import type { Skill } from "./chat.ts";

const bind = (skill: Omit<Skill, "sha256">): Skill => ({ ...skill, sha256: sha256(`${skill.name}\n${skill.run.toString()}`) });

/**
 * Family 6: the exact minimum-cost settlement plan for the observed instance, returned as the settle
 * action itself. Bonsai 8B copied a wrapper object whole when the action was a field of it
 * (2026-10-07), so the result is the action and nothing else; the cost is the harness's to report.
 */
export const minCostFlowSkill: Skill = bind({
  name: "min_cost_flow",
  // No JSON in the description: a snippet of the send form there cut Bonsai 8B's calls on the dense cell from 8 of 8 to 2 of 8.
  description: "Computes the cheapest valid settlement plan for the instance you were shown and returns it as the exact action to send. To use it, reply with that action unchanged.",
  run(observation: Json): Json {
    const instance = (observation as { view: Instance }).view;
    const plan = settleOptimal(instance);
    return { tool: "settle", args: { plan: { transfers: plan.map((t) => ({ ...t })) } } };
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

/** Family 10: the exact optimum on the menus for the observed contract, as the offer action itself. */
export const dlcDesignSkill: Skill = bind({
  name: "dlc_design",
  // Worded as min_cost_flow's, the description that drew the most calls from Bonsai 8B; no JSON in it.
  description: "Computes the cheapest design on the listed menus for the contract you were shown and returns it as the exact action to send. To use it, reply with that action unchanged.",
  run(observation: Json): Json {
    const view = (observation as unknown as { view: DlcView }).view;
    return { tool: "offer", args: designJson(exactDesign(modelFor(view.contract), menuOf(view))) };
  },
});

/**
 * Family 5: a bond the counterparty will admit, cheaply. The smallest grid bond covering the value at
 * risk, and the shortest grid period meeting the catch probability at half the sample's
 * maximum-likelihood response rate: the `half_rate` baseline, a margin against eight observations.
 */
export const bondOfferSkill: Skill = bind({
  name: "bond_offer",
  description: "Computes a bond the counterparty will admit at low cost, from the observed response times, and returns it as the exact action to send. To use it, reply with that action unchanged.",
  run(observation: Json): Json {
    const v = (observation as unknown as { view: BondingView }).view;
    const bond = v.grid.bonds.filter((b) => b >= v.service.value_at_risk_sats).sort((a, b) => a - b)[0] ?? Math.max(...v.grid.bonds);
    const p = rateEstimate(v.challenge.observed_response_blocks) / 2;
    const delta = v.grid.deltas.filter((d) => d >= v.challenge.min_delta_blocks && catchProbability(p, d) >= v.challenge.catch_probability).sort((a, b) => a - b)[0] ?? Math.max(...v.grid.deltas);
    return { tool: "bond", args: { bond_sats: bond, delta_blocks: delta } };
  },
});

/**
 * Family 7: the next action of the economic-order schedule for the state shown: prove all pending
 * every T blocks, T from the one-claim cost, the mean rate, and the mean value, stretched so the
 * proofs left last the blocks left, and prove everything at the last block. One call per turn.
 */
export const proofStepSkill: Skill = bind({
  name: "proof_step",
  description: "Computes the next action of a sound batching schedule for the state you were shown, either proving now and how many claims or waiting and how long, and returns it as the exact action to send. To use it, reply with that action unchanged.",
  run(observation: Json): Json {
    const o = observation as unknown as { view: ProofView; budget: { attempts: number } };
    const v = o.view;
    const left = v.horizon_blocks - v.block;
    const T = Math.max(eoqInterval(v, o.budget.attempts), Math.ceil(left / Math.max(1, o.budget.attempts)));
    const last = v.horizon_blocks - 1;
    if (v.pending.length > 0 && ((v.block + 1) % T === 0 || v.block === last)) return { tool: "prove", args: { count: Math.min(v.pending.length, v.max_batch) } };
    if (v.block === last) return { tool: "wait", args: { blocks: 1 } };
    const next = Math.min(last, (Math.floor((v.block + 1) / T) + 1) * T - 1);
    return { tool: "wait", args: { blocks: next - v.block } };
  },
});

/**
 * Family 7, second wording, under a name that shares no stem with a tool: Bonsai 8B blended
 * `proof_step` with `prove` into `prove_step` 70 times, and committed whenever the queue was empty,
 * so the description says to call it then too. `proof_step` recomputes a phase-locked interval from
 * the proofs left, which drifts as they run down (0.88 of the ceiling on few_proofs, against the
 * reference's 0.98); this keys the interval to the oldest pending claim instead, which needs no
 * memory of earlier turns and is at least the reference on every cell (docs/saturation.md).
 */
export const scheduleSkill: Skill = bind({
  name: "schedule",
  description: "Computes the next action of a sound batching schedule for the state you were shown, either proving now and how many claims or waiting and how long, and returns it as the exact action to send. Claims keep arriving until the last block, so call it at every turn, also when nothing is pending. To use it, reply with that action unchanged.",
  run(observation: Json): Json {
    const o = observation as unknown as { view: ProofView; budget: { attempts: number } };
    const v = o.view;
    const last = v.horizon_blocks - 1;
    // The economic interval alone (an unlimited budget stretches nothing), stretched so the proofs left last the blocks left.
    const T = Math.max(eoqInterval(v, Number.POSITIVE_INFINITY), Math.ceil((v.horizon_blocks - v.block) / Math.max(1, o.budget.attempts)));
    const oldest = v.pending[0];
    if (oldest !== undefined) {
      // Due once the oldest pending claim has waited T − 1 blocks, when a full batch is pending, and at the last block.
      if (v.block === last || v.block - oldest.arrived_at >= T - 1 || v.pending.length >= v.max_batch) return { tool: "prove", args: { count: Math.min(v.pending.length, v.max_batch) } };
      return { tool: "wait", args: { blocks: Math.min(oldest.arrived_at + T - 1, last) - v.block } };
    }
    // Nothing pending: a claim arriving next block falls due T blocks from now.
    return { tool: "wait", args: { blocks: Math.max(1, Math.min(T, last - v.block)) } };
  },
});

/**
 * `schedule`'s code and name, with a description that names the state where Bonsai 8B still stopped
 * early under greedy decoding: the turn right after a proof has emptied the queue. Registered under
 * its own key so that runs of either wording reproduce.
 */
export const scheduleAfterProofSkill: Skill = bind({
  name: "schedule",
  description: "Computes the next action of a sound batching schedule for the state you were shown, either proving now and how many claims or waiting and how long, and returns it as the exact action to send. Claims keep arriving until the last block, so call it at every turn, also right after a proof when nothing is pending: stopping early loses every claim still to arrive. To use it, reply with that action unchanged.",
  run: scheduleSkill.run,
});

/** Skills by the key `--skills` names; a key differs from the skill's name only for a second wording of one skill. */
export const SKILLS: { [name: string]: Skill } = { min_cost_flow: minCostFlowSkill, failed_pairs: failedPairsSkill, dlc_design: dlcDesignSkill, bond_offer: bondOfferSkill, proof_step: proofStepSkill, schedule: scheduleSkill, schedule_after_proof: scheduleAfterProofSkill };

export function skillsNamed(names: string): Skill[] {
  return names.split(",").map((n) => n.trim()).filter((n) => n !== "").map((n) => {
    const skill = SKILLS[n];
    if (!skill) throw new Error(`unknown skill ${n}; known: ${Object.keys(SKILLS).join(", ")}`);
    return skill;
  });
}
