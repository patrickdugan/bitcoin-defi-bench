import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode } from "../harness/episode.ts";
import { readManifest } from "../harness/manifest.ts";
import { PlacementEnv, evaluatePlacements } from "../tasks/placement/env.ts";
import { placementPrompt } from "../tasks/placement/prompt.ts";
import { loadPlacementConfig, placementFixture } from "../tasks/placement/task.ts";
import { ChatAgent, extractAction, type ChatOptions, type Reply } from "./chat.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = readManifest(root);
const config = loadPlacementConfig(root);
const fixture = placementFixture(root, manifest, 0);

interface Mock { server: Server; url: string; requests: Array<{ seed: number; messages: Array<{ role: string; content: string }> }>; }

/** A stand-in for the model server: replies from a script, one entry per turn of a conversation. */
async function mock(reply: (turn: number) => string): Promise<Mock> {
  const requests: Mock["requests"] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw) as { seed: number; messages: Array<{ role: string; content: string }> };
      requests.push(body);
      const turn = body.messages.filter((m) => m.role === "assistant").length;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: reply(turn), reasoning_content: "" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

const options = (baseUrl: string, extra: Partial<ChatOptions> = {}): ChatOptions => ({
  name: "mock", baseUrl, model: "mock-model",
  sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, max_tokens: 256, seed: 1 },
  thinking: false, identity: { model_sha256: "0".repeat(64), runtime: "mock" }, prompt: placementPrompt(256), ...extra,
});

test("the first JSON object in a reply is the action; a reply with none is passed through untouched", () => {
  assert.deepEqual(extractAction('{"tool":"commit"}'), { tool: "commit" });
  assert.deepEqual(extractAction('```json\n{"tool":"commit"}\n```'), { tool: "commit" });
  assert.deepEqual(extractAction('Sure. {"tool":"place","args":{"placements":[{"from":"N000","to":"N001","sats":5}]}} Done.'), { tool: "place", args: { placements: [{ from: "N000", to: "N001", sats: 5 }] } });
  assert.deepEqual(extractAction('{"note":"a } brace in a string","tool":"commit"}'), { note: "a } brace in a string", tool: "commit" });
  assert.equal(extractAction("I would place capacity near the hub."), "I would place capacity near the hub.");
  assert.equal(extractAction('{"tool": "place", "args": {'), '{"tool": "place", "args": {');
});

test("only loopback endpoints are accepted", () => {
  assert.throws(() => new ChatAgent(options("https://api.example.com/v1")), /loopback/);
  assert.throws(() => new ChatAgent(options("http://api.example.com/v1")), /loopback/);
  assert.throws(() => new ChatAgent(options("https://localhost:1/v1")), /loopback/);
  assert.ok(new ChatAgent(options("http://localhost:1/v1")).id.startsWith("mock@"));
});

test("the agent id binds the prompt hash, the sampling parameters, and the model hash", () => {
  const base = new ChatAgent(options("http://127.0.0.1:1/v1")).id;
  assert.equal(new ChatAgent(options("http://127.0.0.1:2/v1")).id, base, "the endpoint address is not part of the identity");
  assert.notEqual(new ChatAgent(options("http://127.0.0.1:1/v1", { sampling: { temperature: 0, top_p: 0.8, top_k: 20, max_tokens: 256, seed: 1 } })).id, base);
  assert.notEqual(new ChatAgent(options("http://127.0.0.1:1/v1", { identity: { model_sha256: "1".repeat(64), runtime: "mock" } })).id, base);
  assert.notEqual(new ChatAgent(options("http://127.0.0.1:1/v1", { prompt: placementPrompt(512) })).id, base, "the reply limit is part of the prompt and so of the id");
});

test("an episode through the adapter: a valid placement is applied and scored by the same simulator", async () => {
  const [a, b] = fixture.hotspots.first;
  const place = { tool: "place", args: { placements: [{ from: a, to: b, sats: 80_000 }, { from: b, to: a, sats: 40_000 }] } };
  const m = await mock((turn) => (turn === 0 ? JSON.stringify(place) : '{"tool":"commit"}'));
  try {
    const row = await runEpisode(new PlacementEnv(fixture, "uniform", "stationary", config), new ChatAgent(options(m.url)));
    assert.equal(row.rejections.length, 0);
    assert.equal(row.turns, 2);
    assert.deepEqual({ value: row.value, metrics: row.metrics }, evaluatePlacements(fixture, "uniform", "stationary", config, place.args.placements));
    // The prompt shows public structure and history, and nothing hidden.
    const first = m.requests[0]!.messages;
    assert.equal(first[0]!.role, "system");
    assert.ok(first[1]!.content.includes(`${fixture.edges[0]!.u}-${fixture.edges[0]!.v}`));
    const prompt = JSON.stringify(first);
    for (const hidden of ["hotspot", "stationary", "shift"]) assert.ok(!prompt.includes(hidden), `${hidden} appears in the prompt`);
    // No hidden capacity or balance value appears (values at the clamp bounds are not distinctive).
    const distinctive = (x: number): boolean => x !== config.capacity_minimum && x !== config.capacity_maximum;
    for (const value of [...fixture.capacity, ...fixture.balance_uv.uniform].filter(distinctive)) {
      assert.ok(!prompt.includes(String(value)), `hidden value ${value} appears in the prompt`);
    }
  } finally { m.server.close(); }
});

test("unparseable output is not retried or repaired: it is rejected as malformed and costs an attempt", async () => {
  const m = await mock(() => "I think the hub needs more liquidity.");
  try {
    const row = await runEpisode(new PlacementEnv(fixture, "uniform", "stationary", config), new ChatAgent(options(m.url)));
    assert.equal(m.requests.length, config.attempts, "one request per attempt and no more");
    assert.deepEqual(row.rejections.map((r) => r.reason), Array(config.attempts).fill("malformed"));
    assert.equal(row.value, evaluatePlacements(fixture, "uniform", "stationary", config, []).value);
  } finally { m.server.close(); }
});

test("the two regimes get the same requests, seeds included, and the second is answered from the cache", async () => {
  const m = await mock((turn) => (turn === 0 ? '{"tool":"place","args":{"placements":[{"from":"N000","to":"N000","sats":1}]}}' : '{"tool":"commit"}'));
  try {
    const agent = new ChatAgent(options(m.url));
    const stationary = await runEpisode(new PlacementEnv(fixture, "polarized", "stationary", config), agent);
    const count = m.requests.length;
    const shift = await runEpisode(new PlacementEnv(fixture, "polarized", "shift", config), agent);
    assert.equal(m.requests.length, count, "the shift episode reached the server");
    assert.deepEqual(stationary.rejections, shift.rejections);
    // A different cell is a different request with a different seed.
    await runEpisode(new PlacementEnv(fixture, "uniform", "stationary", config), agent);
    assert.ok(m.requests.length > count);
    assert.notEqual(m.requests[count]!.seed, m.requests[0]!.seed);
  } finally { m.server.close(); }
});

test("a transport failure is an infrastructure failure: it throws and does not become an action", async () => {
  const server = createServer((_req, res) => { res.statusCode = 503; res.end("loading"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    await assert.rejects(runEpisode(new PlacementEnv(fixture, "uniform", "stationary", config), new ChatAgent(options(url))), /HTTP 503/);
  } finally { server.close(); }
});

test("a rerun after a failure replays logged replies for identical requests and asks the server only for the rest", async () => {
  const m = await mock((turn) => (turn === 0 ? '{"tool":"place","args":{"placements":[{"from":"N000","to":"N000","sats":1}]}}' : '{"tool":"commit"}'));
  try {
    const log = new Map<string, Reply>();
    const first = new ChatAgent(options(m.url, { onReply: (key, reply) => log.set(key, reply) }));
    const original = await runEpisode(new PlacementEnv(fixture, "uniform", "stationary", config), first);
    assert.equal(log.size, m.requests.length);
    const served = m.requests.length;
    // The rerun: a new process would start with an empty cache and the log of the failed attempt.
    const rerun = new ChatAgent(options(m.url, { replay: new Map(log) }));
    const replayed = await runEpisode(new PlacementEnv(fixture, "uniform", "stationary", config), rerun);
    assert.equal(m.requests.length, served, "a replayed request reached the server");
    assert.deepEqual(replayed, original);
    assert.deepEqual(rerun.counts, { replayed: log.size, served: 0 });
    // An episode the failed attempt never reached still goes to the server.
    await runEpisode(new PlacementEnv(fixture, "polarized", "stationary", config), rerun);
    assert.ok(m.requests.length > served && rerun.counts.served > 0);
    assert.equal(rerun.id, first.id, "replay is not part of the agent's identity");
  } finally { m.server.close(); }
});