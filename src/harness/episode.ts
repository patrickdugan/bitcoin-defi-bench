// Episode runner. One loop for every policy: build the observation envelope, await act, step the
// environment, repeat until the decision phase ends, then run the simulator to the horizon.
// Episodes run strictly in sequence, so a promise-returning agent cannot reorder anything.

import { BENCH, type Agent, type Environment, type RejectReason } from "./agent.ts";
import type { Json } from "./json.ts";

export interface EpisodeRow {
  task: string;
  seed: number;
  cell: string;
  agent: string;
  value: number;
  metrics: { [name: string]: number };
  turns: number;
  rejections: Array<{ turn: number; reason: RejectReason }>;
}

export async function runEpisode(env: Environment, agent: Agent): Promise<EpisodeRow> {
  agent.reset?.({ task: env.task, seed: env.seed, cell: env.cell }, agent.privileged ? env.privileged() : undefined);
  const initial = env.budget();
  // Every step either debits attempts, probes, or blocks (a wait of at least one block), or ends
  // the phase, so this bound cannot bind unless an environment breaks the budget contract.
  const limit = initial.attempts + initial.probes + initial.blocks + 1;
  const rejections: EpisodeRow["rejections"] = [];
  let last: Json = null;
  let turn = 0;
  while (!env.done()) {
    if (turn >= limit) throw new Error(`${env.task} seed ${env.seed}: episode exceeded its turn limit`);
    const observation: Json = {
      bench: BENCH,
      task: env.task,
      episode: { seed: env.seed, cell: env.cell, turn },
      budget: { ...env.budget() },
      tools: env.tools(),
      view: env.view(),
      last,
    };
    // The agent receives a copy; nothing it does to the observation can reach the environment.
    const action = await agent.act(JSON.parse(JSON.stringify(observation)) as Json);
    const result = env.step(action);
    if (!result.accepted && result.reason !== null) rejections.push({ turn, reason: result.reason });
    last = { accepted: result.accepted, reason: result.reason, result: result.result };
    turn += 1;
  }
  const outcome = env.finish();
  return {
    task: env.task, seed: env.seed, cell: env.cell, agent: agent.id,
    value: outcome.value, metrics: outcome.metrics, turns: turn, rejections,
  };
}
