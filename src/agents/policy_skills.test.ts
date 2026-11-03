// The family 4 and family 9 skills: each is its baseline's procedure, so a model that calls it at
// every turn and passes its result on must play that baseline exactly. Also the two adapter rules
// they rely on: a skill sees the episode's observations so far, and where the environment has its
// own send tool, a send with arguments is that tool's action rather than a stored result.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode, type EpisodeRow } from "../harness/episode.ts";
import type { Json } from "../harness/json.ts";
import { readManifest } from "../harness/manifest.ts";
import { SEED_BLOCKS } from "../harness/seeds.ts";
import { nostrPrompt } from "../tasks/nostr/prompt.ts";
import { loadNostrConfig, nostrBaselines, nostrEpisodes, type NostrCell } from "../tasks/nostr/task.ts";
import { serverSizingBaselines } from "../tasks/server_sizing/baselines.ts";
import { serverSizingPrompt } from "../tasks/server_sizing/prompt.ts";
import { loadServerSizingConfig, serverSizingEpisodes } from "../tasks/server_sizing/task.ts";
import { ChatAgent, type PromptRenderer, type Skill } from "./chat.ts";
import { echoSkillServer } from "./echo_mock.test_helper.ts";
import { SKILLS, capacityPlanSkill } from "./skills.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = readManifest(root);

const echoAgent = (url: string, skill: Skill, prompt: PromptRenderer): ChatAgent => new ChatAgent({
  name: "echo", baseUrl: url, model: "mock", sampling: { temperature: 0, top_p: 1, top_k: 1, max_tokens: 256, seed: 0 }, thinking: false,
  identity: { model_sha256: "0".repeat(64), runtime: "mock" }, prompt, skills: [skill], maxSkillCalls: 1000, maxSkillCallsPerTurn: 1, contextTurns: 0,
});

const same = (a: EpisodeRow, b: EpisodeRow, label: string): void => {
  assert.equal(a.value, b.value, `${label}: value`);
  assert.deepEqual(a.metrics, b.metrics, `${label}: metrics`);
};

test("capacity_plan: a model that calls it at every decision and copies its result plays buffer_rule exactly", async () => {
  const config = loadServerSizingConfig(root);
  assert.equal(config.buffer_margin, 0.25, "the skill's margin, written in its source, is the config's");
  const reference = serverSizingBaselines(config).find((b) => b.id === "buffer_rule")!;
  const m = await echoSkillServer("capacity_plan");
  try {
    const agent = echoAgent(m.url, capacityPlanSkill, serverSizingPrompt(256));
    for (const cell of Object.keys(config.cells).sort()) {
      for (const seed of SEED_BLOCKS.development) {
        const a = await runEpisode(serverSizingEpisodes(root, manifest, config, cell, seed)[0]!, agent);
        const b = await runEpisode(serverSizingEpisodes(root, manifest, config, cell, seed)[0]!, reference);
        same(a, b, `${cell} seed ${seed}`);
        assert.equal(a.rejections.length, 0);
      }
    }
  } finally { m.server.close(); }
});

const NOSTR_SKILLS: Array<{ cell: NostrCell; skill: string; baseline: string }> = [
  { cell: "custody", skill: "custody_policy", baseline: "policy" },
  { cell: "custody_hot", skill: "inbox_policy", baseline: "policy" },
  { cell: "publish", skill: "outbox_plan", baseline: "outbox" },
  { cell: "private", skill: "nip17_plan", baseline: "nip17" },
  { cell: "counterparty", skill: "buyer_plan", baseline: "reputation" },
  { cell: "mesh_outage", skill: "mesh_router", baseline: "bitchat_router" },
  { cell: "mesh_partial", skill: "mesh_router", baseline: "bitchat_router" },
];

for (const { cell, skill, baseline } of NOSTR_SKILLS) {
  test(`${skill}: a model that calls it at every turn and copies its result plays ${baseline} on ${cell} exactly`, async () => {
    const config = loadNostrConfig(root);
    const reference = nostrBaselines(cell).find((b) => b.id === baseline)!;
    assert.ok(!reference.privileged, "a skill wraps only a baseline that sees no hidden state");
    const m = await echoSkillServer(skill);
    try {
      const agent = echoAgent(m.url, SKILLS[skill]!, nostrPrompt(cell, 1024));
      for (const seed of SEED_BLOCKS.development) {
        const a = await runEpisode(nostrEpisodes(root, manifest, config, cell, seed)[0]!, agent);
        const b = await runEpisode(nostrEpisodes(root, manifest, config, cell, seed)[0]!, reference);
        same(a, b, `${cell} seed ${seed}`);
        assert.deepEqual(a.rejections, b.rejections);
      }
    } finally { m.server.close(); }
  });
}

test("mesh_router sent by reference with {\"tool\":\"send\"} plays bitchat_router exactly too", async () => {
  const config = loadNostrConfig(root);
  const reference = nostrBaselines("mesh_partial").find((b) => b.id === "bitchat_router")!;
  const m = await echoSkillServer("mesh_router", "reference");
  try {
    const agent = echoAgent(m.url, SKILLS.mesh_router!, nostrPrompt("mesh_partial", 1024));
    for (const seed of SEED_BLOCKS.development.slice(0, 3)) {
      same(await runEpisode(nostrEpisodes(root, manifest, config, "mesh_partial", seed)[0]!, agent),
        await runEpisode(nostrEpisodes(root, manifest, config, "mesh_partial", seed)[0]!, reference), `mesh_partial seed ${seed}`);
    }
  } finally { m.server.close(); }
});

/** A server that answers each request with the next reply in the list. */
async function scripted(replies: string[]): Promise<{ url: string; close: () => void }> {
  let i = 0;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: replies[i++ % replies.length], reasoning_content: "" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => server.close() };
}

const PROMPT: PromptRenderer = { sha256: "0".repeat(64), system: () => "system", turn: () => "turn" };
const observation = (turn: number, tools: string[]): Json => ({ task: "t", episode: { seed: 0, cell: "c", turn }, tools, view: { turn }, last: null });

test("a skill sees every observation of the episode so far, and only of this episode", async () => {
  const counting: Skill = { name: "count", description: "", sha256: "0".repeat(64), run: (_o, _a, history) => ({ tool: "noop", args: { seen: history.length } }) };
  const s = await scripted(['{"skill":"count"}', '{"tool":"send"}']);
  try {
    const agent = echoAgent(s.url, counting, PROMPT);
    for (const episode of [0, 1]) {
      agent.reset({ task: "t", seed: episode, cell: "c" });
      for (let turn = 0; turn < 3; turn++) {
        assert.deepEqual(await agent.act(observation(turn, ["noop"])), { tool: "noop", args: { seen: turn + 1 } });
      }
    }
  } finally { s.close(); }
});

test("where the environment has a send tool, a send with arguments is the model's own action, not the stored result", async () => {
  const stored: Skill = { name: "route", description: "", sha256: "0".repeat(64), run: () => ({ tool: "send", args: { message: "x0", via: "mesh" } }) };
  const own = '{"tool":"send","args":{"message":"x1","via":"courier","copies":2}}';
  const s = await scripted(['{"skill":"route"}', own]);
  try {
    const agent = echoAgent(s.url, stored, PROMPT);
    agent.reset({ task: "t", seed: 0, cell: "c" });
    assert.deepEqual(await agent.act(observation(0, ["neighbors", "send", "wait", "commit"])), JSON.parse(own));
    // Without a send tool the rule is as before: any send names a stored result.
    agent.reset({ task: "t", seed: 1, cell: "c" });
    assert.deepEqual(await agent.act(observation(0, ["attempt", "skip"])), { tool: "send", args: { message: "x0", via: "mesh" } });
  } finally { s.close(); }
});
