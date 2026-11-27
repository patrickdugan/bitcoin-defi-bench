// The families with a teacher skill that computes a valid action from the observation (and the
// observations so far) alone, as the SFT data and its scorer build them: the bare agent's prompt
// renderer at the agent runner's reply-token limit, the teacher, and an in-memory episode.
//
// Included: 4 server_sizing, 5 bonding, 6 netting, 7 proof_budget, 9 nostr (seven cells, one teacher
// each), 10 dlc, 11 swap, 12 bitvm3, 13 shz, 14 cashu.
// Skipped: 1 placement (its only skill, failed_pairs, reports counts and returns no action), 2 routing,
// 3 settlement_object (no agent runner), 8 funding_timing (no code, only a README): none has a skill
// that yields an action.

import type { Environment } from "../src/harness/agent.ts";
import type { Json } from "../src/harness/json.ts";
import { lastOf, observationOf } from "../src/harness/episode.ts";
import type { PromptRenderer, Skill } from "../src/agents/chat.ts";
import {
  bitvm3WatchSkill, bondOfferSkill, buyerPlanSkill, capacityPlanSkill, cashuDeskSkill, custodyPolicySkill, dlcDesignSkill, inboxPolicySkill,
  meshRouterSkill, minCostFlowSkill, nip17PlanSkill, outboxPlanSkill, scheduleSkill, shzHedgeSkill, swapWorkflowSkill,
} from "../src/agents/skills.ts";
import { Bitvm3Env } from "../src/tasks/bitvm3/env.ts";
import { generateFixture as generateBitvm3 } from "../src/tasks/bitvm3/generate.ts";
import { bitvm3Prompt } from "../src/tasks/bitvm3/prompt.ts";
import { loadBitvm3Config } from "../src/tasks/bitvm3/task.ts";
import { BondingEnv } from "../src/tasks/bonding/env.ts";
import { generateFixture as generateBonding } from "../src/tasks/bonding/generate.ts";
import { bondingPrompt } from "../src/tasks/bonding/prompt.ts";
import { loadBondingConfig } from "../src/tasks/bonding/task.ts";
import { CashuEnv } from "../src/tasks/cashu/env.ts";
import { generateFixture as generateCashu } from "../src/tasks/cashu/generate.ts";
import { cashuPrompt } from "../src/tasks/cashu/prompt.ts";
import { loadCashuConfig } from "../src/tasks/cashu/task.ts";
import { DlcEnv } from "../src/tasks/dlc/env.ts";
import { generateFixture as generateDlc } from "../src/tasks/dlc/generate.ts";
import { dlcPrompt } from "../src/tasks/dlc/prompt.ts";
import { loadDlcConfig } from "../src/tasks/dlc/task.ts";
import { NettingEnv } from "../src/tasks/netting/env.ts";
import { generateFixture as generateNetting } from "../src/tasks/netting/generate.ts";
import { nettingPrompt } from "../src/tasks/netting/prompt.ts";
import { loadNettingConfig } from "../src/tasks/netting/task.ts";
import { CounterpartyEnv, type CounterpartyFixture } from "../src/tasks/nostr/counterparty.ts";
import { CustodyEnv, type CustodyFixture } from "../src/tasks/nostr/custody.ts";
import { CustodyHotEnv, type CustodyHotFixture } from "../src/tasks/nostr/custody_hot.ts";
import { MeshEnv, type MeshFixture } from "../src/tasks/nostr/mesh.ts";
import { nostrPrompt } from "../src/tasks/nostr/prompt.ts";
import { PrivateEnv, type PrivateFixture } from "../src/tasks/nostr/private.ts";
import { PublishEnv, type PublishFixture } from "../src/tasks/nostr/publish.ts";
import { NOSTR_CELLS, generateNostr, loadNostrConfig, nostrFixtureBytes, type NostrCell } from "../src/tasks/nostr/task.ts";
import { ProofEnv } from "../src/tasks/proof_budget/env.ts";
import { generateFixture as generateProof, loadCostTable } from "../src/tasks/proof_budget/generate.ts";
import { proofPrompt } from "../src/tasks/proof_budget/prompt.ts";
import { loadProofConfig } from "../src/tasks/proof_budget/task.ts";
import { ServerSizingEnv, type SizingInput } from "../src/tasks/server_sizing/env.ts";
import { positionPath, type SizingParams } from "../src/tasks/server_sizing/plan.ts";
import { serverSizingPrompt } from "../src/tasks/server_sizing/prompt.ts";
import { loadServerSizingConfig } from "../src/tasks/server_sizing/task.ts";
import { generateFixture as generateSettlement, loadStream } from "../src/tasks/settlement_object/generate.ts";
import { loadProtocol, loadSettlementConfig } from "../src/tasks/settlement_object/task.ts";
import { ShzEnv } from "../src/tasks/shz/env.ts";
import { generateFixture as generateShz } from "../src/tasks/shz/generate.ts";
import { shzPrompt } from "../src/tasks/shz/prompt.ts";
import { loadShzConfig } from "../src/tasks/shz/task.ts";
import { SwapEnv } from "../src/tasks/swap/env.ts";
import { generateFixture as generateSwap } from "../src/tasks/swap/generate.ts";
import { swapPrompt } from "../src/tasks/swap/prompt.ts";
import { loadSwapConfig } from "../src/tasks/swap/task.ts";

export interface SftFamily {
  id: string;
  cells: string[];
  /** False when an episode is one action, true when it runs several turns. */
  multi_turn: boolean;
  /** The agent runner's --context-turns default; undefined when the runner sends the whole conversation. */
  context_turns: number | undefined;
  prompt(cell: string): PromptRenderer;
  teacher(cell: string): Skill;
  env(seed: number, cell: string): Environment;
}

/** Fixtures as the agent runners load them: generated here in memory, then through their JSON bytes. */
const viaJson = <T>(fixture: unknown): T => JSON.parse(JSON.stringify(fixture)) as T;

export function sftFamilies(root: string): SftFamily[] {
  const bonding = loadBondingConfig(root);
  const dlc = loadDlcConfig(root);
  const netting = loadNettingConfig(root);
  const sizing = loadServerSizingConfig(root);
  const settlement = loadSettlementConfig(root);
  const protocol = loadProtocol(root);
  const proof = loadProofConfig(root);
  const costTable = loadCostTable(root, proof);
  const nostr = loadNostrConfig(root);
  const swap = loadSwapConfig(root);
  const bitvm3 = loadBitvm3Config(root);
  const shz = loadShzConfig(root);
  const cashu = loadCashuConfig(root);
  const cellsOf = (config: { cells: { [cell: string]: unknown } }) => Object.keys(config.cells).sort();
  // Family 4 reuses family 3's streams; the last pair is kept, as family 4's own loader keeps it.
  let sizingCurrent: { key: string; input: SizingInput } | null = null;
  const sizingInput = (cell: string, seed: number): SizingInput => {
    const key = `${cell}|${seed}`;
    if (sizingCurrent?.key !== key) {
      const source = sizing.cells[cell]!;
      const fixture = generateSettlement(seed, source, settlement.cells[source]!, protocol);
      const pilot = loadStream(fixture, "pilot");
      const evaluation = loadStream(fixture, "evaluation");
      const params: SizingParams = {
        round_interval_blocks: fixture.protocol.round_interval_blocks,
        decision_interval_blocks: sizing.decision_interval_blocks, resize_delay_blocks: sizing.resize_delay_blocks,
        capital_rate_per_block: sizing.capital_rate_per_block, resize_fee_sats: sizing.resize_fee_sats,
        lease_rate_ppm: sizing.lease_rate_ppm, failure_fixed_sats: sizing.failure_fixed_sats,
        failure_value_share: sizing.failure_value_share,
      };
      sizingCurrent = { key, input: { seed, cell, pilot, evaluation, params, attempts: sizing.budget.attempts, max_inbound_pilot_multiple: sizing.max_inbound_pilot_multiple,
        pilotPath: positionPath(pilot), evaluationPath: positionPath(evaluation) } };
    }
    return sizingCurrent.input;
  };
  const nostrTeachers: { [cell in NostrCell]: Skill } = {
    counterparty: buyerPlanSkill, custody: custodyPolicySkill, custody_hot: inboxPolicySkill,
    mesh_outage: meshRouterSkill, mesh_partial: meshRouterSkill, private: nip17PlanSkill, publish: outboxPlanSkill,
  };
  const nostrEnv = (seed: number, cell: string): Environment => {
    const c = cell as NostrCell;
    const f = JSON.parse(nostrFixtureBytes(generateNostr(c, seed, nostr))) as never;
    switch (c) {
      case "custody": return new CustodyEnv(f as CustodyFixture, nostr.custody);
      case "custody_hot": return new CustodyHotEnv(f as CustodyHotFixture, nostr.custody_hot);
      case "publish": return new PublishEnv(f as PublishFixture, nostr.publish);
      case "private": return new PrivateEnv(f as PrivateFixture, nostr.private);
      case "counterparty": return new CounterpartyEnv(f as CounterpartyFixture, nostr.counterparty);
      case "mesh_outage": case "mesh_partial": return new MeshEnv(f as MeshFixture, nostr.mesh);
    }
  };
  const one = { multi_turn: false, context_turns: undefined };
  return [
    { id: "bonding", cells: cellsOf(bonding), ...one, prompt: () => bondingPrompt(768), teacher: () => bondOfferSkill,
      env: (seed, cell) => new BondingEnv(generateBonding(seed, cell, bonding.cells[cell]!, bonding), bonding) },
    { id: "dlc", cells: cellsOf(dlc), ...one, prompt: () => dlcPrompt(768), teacher: () => dlcDesignSkill,
      env: (seed, cell) => new DlcEnv(generateDlc(seed, cell, dlc.cells[cell]!, dlc), dlc) },
    { id: "netting", cells: cellsOf(netting), ...one, prompt: () => nettingPrompt(1024), teacher: () => minCostFlowSkill,
      env: (seed, cell) => new NettingEnv(generateNetting(seed, cell, netting.cells[cell]!, netting.market), netting) },
    { id: "server_sizing", cells: cellsOf(sizing), multi_turn: true, context_turns: 0, prompt: () => serverSizingPrompt(256), teacher: () => capacityPlanSkill,
      env: (seed, cell) => new ServerSizingEnv(sizingInput(cell, seed)) },
    { id: "proof_budget", cells: cellsOf(proof), multi_turn: true, context_turns: 0, prompt: () => proofPrompt(256), teacher: () => scheduleSkill,
      env: (seed, cell) => new ProofEnv(viaJson(generateProof(seed, cell, proof.cells[cell]!, costTable))) },
    { id: "nostr", cells: [...NOSTR_CELLS], multi_turn: true, context_turns: undefined, prompt: (cell) => nostrPrompt(cell as NostrCell, 1024), teacher: (cell) => nostrTeachers[cell as NostrCell],
      env: nostrEnv },
    { id: "swap", cells: cellsOf(swap), multi_turn: true, context_turns: 12, prompt: () => swapPrompt(256), teacher: () => swapWorkflowSkill,
      env: (seed, cell) => new SwapEnv(viaJson(generateSwap(seed, cell, swap.cells[cell]!, swap)), swap) },
    { id: "bitvm3", cells: cellsOf(bitvm3), multi_turn: true, context_turns: 12, prompt: () => bitvm3Prompt(256), teacher: () => bitvm3WatchSkill,
      env: (seed, cell) => new Bitvm3Env(viaJson(generateBitvm3(seed, cell, bitvm3.cells[cell]!, bitvm3)), bitvm3) },
    { id: "shz", cells: cellsOf(shz), multi_turn: true, context_turns: 12, prompt: () => shzPrompt(256), teacher: () => shzHedgeSkill,
      env: (seed, cell) => new ShzEnv(viaJson(generateShz(seed, cell, shz.cells[cell]!, shz)), shz) },
    { id: "cashu", cells: cellsOf(cashu), multi_turn: true, context_turns: 12, prompt: () => cashuPrompt(256), teacher: () => cashuDeskSkill,
      env: (seed, cell) => new CashuEnv(viaJson(generateCashu(seed, cell, cashu.cells[cell]!, cashu)), cashu) },
  ];
}

export interface Episode {
  /** The observations the agent saw, one per turn, as JSON copies. */
  observations: Json[];
  /** The actions stepped, one per turn. */
  actions: Json[];
  /** The episode's value, or null when it did not complete. */
  value: number | null;
  /** Why it did not complete; empty when it did. */
  why: string;
  /** The turn at which it did not complete. */
  failedAt: number | null;
}

/**
 * Play one episode: the teacher at every turn, except that `override` replaces the action at its turn.
 * It stops at the first rejected action, whoever chose it.
 */
export function playEpisode(fam: SftFamily, seed: number, cell: string, override?: { turn: number; action: Json }): Episode {
  const env = fam.env(seed, cell);
  const teacher = fam.teacher(cell);
  const b = env.budget();
  const limit = b.attempts + b.probes + b.blocks + 1;
  const observations: Json[] = [];
  const actions: Json[] = [];
  let last: Json = null;
  for (let turn = 0; !env.done(); turn++) {
    const fail = (why: string): Episode => ({ observations, actions, value: null, why, failedAt: turn });
    if (turn >= limit) return fail("episode exceeded its turn limit");
    const observation = JSON.parse(JSON.stringify(observationOf(env, turn, last))) as Json;
    observations.push(observation);
    let action: Json;
    if (override && override.turn === turn) action = override.action;
    else {
      try { action = teacher.run(observation, {}, observations); } catch (e) { return fail(`teacher failed: ${(e as Error).message}`); }
    }
    actions.push(action);
    const step = env.step(action);
    if (!step.accepted) return fail(`rejected: ${step.reason}`);
    last = lastOf(step);
  }
  return { observations, actions, value: env.finish().value, why: "", failedAt: null };
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** The messages the bare ChatAgent sends at `turn`, given the teacher's actions at the turns before it. */
export function messagesAt(fam: SftFamily, cell: string, observations: readonly Json[], actions: readonly Json[], turn: number): ChatMessage[] {
  const prompt = fam.prompt(cell);
  const all: ChatMessage[] = [{ role: "system", content: prompt.system(observations[0]!) }];
  const starts: number[] = [];
  for (let t = 0; t <= turn; t++) {
    starts.push(all.length);
    all.push({ role: "user", content: prompt.turn(observations[t]!) });
    if (t < turn) all.push({ role: "assistant", content: JSON.stringify(actions[t]) });
  }
  const k = fam.context_turns;
  if (k === undefined) return all;
  return [all[0]!, ...all.slice(starts[Math.max(0, starts.length - 1 - k)]!)];
}
