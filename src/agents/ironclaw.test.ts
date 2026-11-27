// The IronClaw backend against a mock of IronClaw's Responses API: the wire protocol (one thread per
// episode, chained by previous_response_id, the token from the environment), the id, a family
// episode through the skill loop, a rerun that continues the chain from the reply log, a turn
// IronClaw fails, and transport failures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode } from "../harness/episode.ts";
import { canonical, type Json } from "../harness/json.ts";
import { readManifest } from "../harness/manifest.ts";
import { SEED_BLOCKS } from "../harness/seeds.ts";
import { serverSizingBaselines } from "../tasks/server_sizing/baselines.ts";
import { serverSizingPrompt } from "../tasks/server_sizing/prompt.ts";
import { loadServerSizingConfig, serverSizingEpisodes } from "../tasks/server_sizing/task.ts";
import { backendOptions, loggedReply } from "./backend_args.ts";
import { ChatAgent, type ChatOptions, type PromptRenderer, type Reply } from "./chat.ts";
import { IronClawBackend, readResponse } from "./ironclaw.ts";
import { capacityPlanSkill } from "./skills.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = readManifest(root);

interface Seen { input: string; previous: string | null; auth: string | undefined; model: string }

/**
 * A mock IronClaw: each response gets a fresh id, and the reply is a scripted function of the
 * input. `status` lets a test answer with an HTTP error or a failed response instead.
 */
async function mockIronClaw(answer: (input: string) => string, status?: (n: number) => number | "failed" | undefined): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      assert.equal(req.url, "/api/v1/responses");
      const body = JSON.parse(raw) as { input: string; previous_response_id: string | null; model: string; stream: boolean };
      assert.equal(body.stream, false);
      seen.push({ input: body.input, previous: body.previous_response_id, auth: req.headers.authorization, model: body.model });
      const s = status?.(seen.length);
      if (typeof s === "number") { res.statusCode = s; res.end("busy"); return; }
      const id = `resp_${String(seen.length).padStart(4, "0")}`;
      res.setHeader("content-type", "application/json");
      if (s === "failed") { res.end(JSON.stringify({ id, object: "response", status: "failed", output: [], error: { message: "tool approval required" } })); return; }
      res.end(JSON.stringify({ id, object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer(body.input) }] }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

/** Calls the skill, then copies its result: the echo model of the chat adapter's tests, on IronClaw's wire. */
const echo = (skill: string) => (input: string): string => (input.startsWith("Result of skill") ? input.split("\n")[1]! : JSON.stringify({ skill, args: {} }));

const prompt: PromptRenderer = { sha256: "f".repeat(64), system: () => "SYSTEM", turn: (o) => `TURN ${canonical(o)}` };

const options = (url: string, extra: Partial<ChatOptions> = {}): ChatOptions => ({
  name: "ironclaw-mock", baseUrl: url, model: "default", sampling: { temperature: 0, top_p: 1, top_k: 1, max_tokens: 256, seed: 0 }, thinking: false,
  identity: { model_sha256: "0".repeat(64), runtime: "mock" }, prompt,
  backend: new IronClawBackend({ baseUrl: url, model: "default", version: "ironclaw 0.0.0-mock", minIntervalMs: 0, env: { IRONCLAW_REBORN_WEBUI_TOKEN: "tok-123" } }),
  ...extra,
});

const obs = (turn: number): Json => ({ episode: { turn }, tools: ["hold"] });

test("one thread per episode: the first input is the system prompt and the turn, later inputs chain by previous_response_id, with the token", async () => {
  const m = await mockIronClaw(() => '{"tool":"hold"}');
  try {
    const agent = new ChatAgent(options(m.url));
    agent.reset({ task: "t", seed: 1, cell: "c" });
    assert.deepEqual(await agent.act(obs(0)), { tool: "hold" });
    assert.deepEqual(await agent.act(obs(1)), { tool: "hold" });
    agent.reset({ task: "t", seed: 2, cell: "c" });
    await agent.act({ episode: { turn: 0 }, tools: ["hold"], other: 1 });
    assert.equal(m.seen.length, 3);
    assert.deepEqual(m.seen[0], { input: `SYSTEM\n\nTURN ${canonical(obs(0))}`, previous: null, auth: "Bearer tok-123", model: "default" });
    assert.deepEqual(m.seen[1], { input: `TURN ${canonical(obs(1))}`, previous: "resp_0001", auth: "Bearer tok-123", model: "default" });
    assert.equal(m.seen[2]!.previous, null, "a new episode starts a new thread");
  } finally { m.server.close(); }
});

test("the id binds the backend; the token is in neither the id nor the description; an agent without a backend has no backend field", () => {
  const url = "http://127.0.0.1:1";
  const ironclaw = new ChatAgent(options(url));
  const plain = new ChatAgent({ ...options(url), backend: undefined });
  assert.notEqual(ironclaw.id, plain.id);
  assert.equal((ironclaw.describe() as { backend: { kind: string } }).backend.kind, "ironclaw");
  assert.ok(!("backend" in (plain.describe() as object)));
  assert.ok(!JSON.stringify(ironclaw.describe()).includes("tok-123"));
  const other = new ChatAgent({ ...options(url), backend: new IronClawBackend({ baseUrl: url, model: "default", version: "ironclaw 0.0.1-mock" }) });
  assert.notEqual(ironclaw.id, other.id, "the IronClaw version is bound");
});

test("only loopback IronClaw addresses are accepted, and a context window is refused with a backend", () => {
  assert.throws(() => new IronClawBackend({ baseUrl: "http://10.0.0.2:3000", model: "default", version: "x" }), /loopback/);
  assert.throws(() => new ChatAgent(options("http://127.0.0.1:1", { contextTurns: 4 })), /contextTurns/);
});

test("capacity_plan through IronClaw: a model that calls it and copies its result plays buffer_rule exactly", async () => {
  const config = loadServerSizingConfig(root);
  const reference = serverSizingBaselines(config).find((b) => b.id === "buffer_rule")!;
  const m = await mockIronClaw(echo("capacity_plan"));
  try {
    const agent = new ChatAgent(options(m.url, { prompt: serverSizingPrompt(256), skills: [capacityPlanSkill], maxSkillCalls: 1000, maxSkillCallsPerTurn: 1 }));
    const cell = Object.keys(config.cells).sort()[0]!;
    for (const seed of SEED_BLOCKS.development.slice(0, 2)) {
      const a = await runEpisode(serverSizingEpisodes(root, manifest, config, cell, seed)[0]!, agent);
      const b = await runEpisode(serverSizingEpisodes(root, manifest, config, cell, seed)[0]!, reference);
      assert.equal(a.value, b.value, `seed ${seed}`);
      assert.deepEqual(a.metrics, b.metrics);
      assert.equal(a.rejections.length, 0);
    }
    assert.equal(m.seen.filter((s) => s.previous === null).length, 2, "only each episode's first request starts a thread");
    assert.ok(m.seen.every((s, i) => s.previous === null || s.previous === `resp_${String(i).padStart(4, "0")}`), "each later request chains on the response before it");
  } finally { m.server.close(); }
});

test("a rerun replays the reply log and continues the IronClaw thread from the last logged response id", async () => {
  const log: Array<{ request_sha256: string } & Reply> = [];
  const first = await mockIronClaw(() => '{"tool":"hold"}');
  try {
    const agent = new ChatAgent(options(first.url, { onReply: (request_sha256, reply) => log.push({ request_sha256, ...reply }) }));
    agent.reset({ task: "t", seed: 1, cell: "c" });
    await agent.act(obs(0));
    await agent.act(obs(1));
  } finally { first.server.close(); }
  assert.deepEqual(log.map((e) => e.thread), ["resp_0001", "resp_0002"]);
  const second = await mockIronClaw(() => '{"tool":"hold"}');
  try {
    const replay = new Map(log.map((e) => [e.request_sha256, loggedReply(e)] as const));
    const agent = new ChatAgent(options(second.url, { replay }));
    agent.reset({ task: "t", seed: 1, cell: "c" });
    await agent.act(obs(0));
    await agent.act(obs(1));
    assert.equal(second.seen.length, 0, "both turns came from the log");
    await agent.act(obs(2));
    assert.deepEqual(second.seen.map((s) => s.previous), ["resp_0002"]);
    assert.equal(agent.counts.replayed, 2);
  } finally { second.server.close(); }
});

test("a turn IronClaw fails is an empty reply, rejected by the harness as malformed; its status is kept as reasoning", async () => {
  assert.deepEqual(readResponse({ id: "r", status: "failed", output: [], error: { message: "denied" } }), { content: "", reasoning: 'ironclaw status failed: {"message":"denied"}', thread: "r" });
  assert.throws(() => readResponse({ status: "completed", output: [] }), /without an id/);
  const m = await mockIronClaw(() => '{"tool":"hold"}', () => "failed");
  try {
    const agent = new ChatAgent(options(m.url));
    agent.reset({ task: "t", seed: 1, cell: "c" });
    assert.equal(await agent.act(obs(0)), "");
  } finally { m.server.close(); }
});

test("HTTP 429 is waited out and sent again; any other HTTP error is an infrastructure failure", async () => {
  const limited = await mockIronClaw(() => '{"tool":"hold"}', (n) => (n === 1 ? 429 : undefined));
  try {
    const backend = new IronClawBackend({ baseUrl: limited.url, model: "default", version: "x", minIntervalMs: 0, retryMs: 1 });
    const agent = new ChatAgent({ ...options(limited.url), backend });
    agent.reset({ task: "t", seed: 1, cell: "c" });
    assert.deepEqual(await agent.act(obs(0)), { tool: "hold" });
    assert.equal(limited.seen.length, 2);
  } finally { limited.server.close(); }
  const broken = await mockIronClaw(() => "", () => 500);
  try {
    const agent = new ChatAgent(options(broken.url));
    agent.reset({ task: "t", seed: 1, cell: "c" });
    await assert.rejects(agent.act(obs(0)), /HTTP 500/);
  } finally { broken.server.close(); }
});

test("the runner flags: no --backend leaves the options alone; --backend ironclaw sets the backend and drops the context window", () => {
  const args = (map: { [k: string]: string }) => (name: string, fallback?: string): string => {
    if (name in map) return map[name]!;
    if (fallback === undefined) throw new Error(`missing --${name}`);
    return fallback;
  };
  assert.deepEqual(backendOptions(args({}), { baseUrl: "http://127.0.0.1:3000", model: "default" }), {});
  const set = backendOptions(args({ backend: "ironclaw", "ironclaw-version": "ironclaw 1.4.1" }), { baseUrl: "http://127.0.0.1:3000", model: "default" });
  assert.ok(set.backend instanceof IronClawBackend);
  assert.ok("contextTurns" in set && set.contextTurns === undefined);
  assert.throws(() => backendOptions(args({ backend: "ironclaw" }), { baseUrl: "http://127.0.0.1:3000", model: "default" }), /ironclaw-version/);
  assert.throws(() => backendOptions(args({ backend: "other" }), { baseUrl: "http://127.0.0.1:3000", model: "default" }), /chat or ironclaw/);
});
