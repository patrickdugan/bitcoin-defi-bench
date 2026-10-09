import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode } from "../../harness/episode.ts";
import { readManifest } from "../../harness/manifest.ts";
import { stream } from "../../harness/prng.ts";
import { proofBaselines } from "./baselines.ts";
import { CostModel, type CostTable } from "./cost.ts";
import { ProofEnv, costModelOf } from "./env.ts";
import { fixtureBytes, generateFixture, loadCostTable, type Claim } from "./generate.ts";
import { optimalSchedule, scheduleCost, type Proof } from "./plan.ts";
import { loadProofConfig, proofFixture } from "./task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const config = loadProofConfig(root);
const manifest = readManifest(root);

const table: CostTable = {
  grid: [
    { batch: 1, seconds: 16, peak_mib: 14000, steps: 2700 },
    { batch: 4, seconds: 17, peak_mib: 14100, steps: 10700 },
    { batch: 8, seconds: 26, peak_mib: 14200, steps: 21300 },
    { batch: 16, seconds: 25, peak_mib: 14400, steps: 42600 },
    { batch: 32, seconds: 35, peak_mib: 16000, steps: 85100 },
  ],
  source: { file: "test", sha256: "", program_sha256: "", toolchain: "", machine: "", statistic: "" },
};

test("the cost model: measured points, interpolation, padding to a cheaper larger batch, and the memory ceiling", () => {
  const c = new CostModel(table, 2, 65536);
  assert.equal(c.maxBatch, 32);
  assert.equal(c.seconds(1), 16);
  assert.equal(c.seconds(4), 17);
  assert.equal(c.seconds(2), 16 + (17 - 16) / 3);
  // 8 claims measured 26 s but 16 measured 25 s: padding 8 to 16 is cheaper, so 8 and up to 15 cost 25.
  assert.equal(c.seconds(8), 25);
  assert.equal(c.seconds(12), 25);
  for (let b = 1; b < 32; b++) assert.ok(c.seconds(b) <= c.seconds(b + 1), `seconds are non-decreasing at ${b}`);
  assert.equal(c.cost(16), 50);
  assert.throws(() => c.seconds(33), /no measured cost/);
  // A ceiling of 15,000 MiB admits batches up to where interpolated memory crosses it: 16 + (32 − 16) × 600 / 1600 = 22.
  const small = new CostModel(table, 2, 15000);
  assert.equal(small.maxBatch, 22);
  assert.ok(small.seconds(22) <= 35);
});

/** Every schedule the agent can play that is worth considering: consecutive batches, each proven when its last claim arrives, at most k of them, the rest forfeited. */
function bruteForce(claims: Claim[], cost: CostModel, ppm: number, k: number): number {
  const n = claims.length;
  let best = Number.POSITIVE_INFINITY;
  const go = (i: number, left: number, schedule: Proof[]): void => {
    const c = scheduleCost(claims, schedule, cost, ppm);
    if (typeof c !== "string") best = Math.min(best, c.total_sats);
    if (i >= n || left === 0) return;
    for (let j = i; j < Math.min(n, i + cost.maxBatch); j++) {
      // Proven when its last claim arrives; the test below checks that later is never better.
      go(j + 1, left - 1, [...schedule, { block: claims[j]!.block, count: j - i + 1 }]);
    }
  };
  go(0, k, []);
  return best;
}

test("the clairvoyant dynamic program equals enumeration, and proving later than the last arrival never helps", () => {
  const rng = stream("proof-test", "dp");
  for (let trial = 0; trial < 25; trial++) {
    const claims: Claim[] = [];
    let block = 0;
    for (let i = 0; i < 7; i++) { block += rng.int(3); claims.push({ id: i, block, value_sats: 1000 + rng.int(200000) }); }
    const cost = new CostModel(table, 1 + rng.int(20), trial % 3 === 0 ? 14150 : 65536);
    const ppm = 10 + rng.int(500);
    const k = 1 + rng.int(4);
    const schedule = optimalSchedule(claims, cost, ppm, k);
    const dp = scheduleCost(claims, schedule, cost, ppm);
    assert.notEqual(typeof dp, "string");
    const brute = bruteForce(claims, cost, ppm, k);
    assert.ok(Math.abs((dp as { total_sats: number }).total_sats - brute) <= 1e-9 * brute, `trial ${trial}: DP ${(dp as { total_sats: number }).total_sats} vs ${brute}`);
    // Delaying any proof of the optimal schedule by a block costs at least as much.
    for (let p = 0; p < schedule.length; p++) {
      const later = schedule.map((x, i) => (i >= p ? { ...x, block: x.block + 1 } : x));
      const c = scheduleCost(claims, later, cost, ppm);
      if (typeof c !== "string") assert.ok(c.total_sats >= (dp as { total_sats: number }).total_sats - 1e-9);
    }
  }
});

test("the environment: rejections change nothing but the proof they spend; its accounting equals the schedule's", () => {
  const fixture = proofFixture(root, manifest, "steady", 0);
  const env = new ProofEnv(fixture);
  const before = env.snapshot();
  const k = env.budget().attempts;
  assert.equal(env.step({ tool: "prove", args: { count: 5 } }).reason, "out_of_grid", "nothing is pending at block 0 beyond its arrivals");
  assert.equal(env.snapshot(), before);
  assert.equal(env.budget().attempts, k - 1);
  assert.equal(env.step({ tool: "wait", args: { blocks: 1000 } }).reason, "over_budget");
  assert.equal(env.step({ tool: "wait", args: { blocks: 1.5 } }).reason, "not_integer");
  assert.equal(env.step({ tool: "wait", args: { blocks: 0 } }).reason, "below_minimum");
  assert.equal(env.snapshot(), before);
  const played: Proof[] = [];
  assert.equal(env.step({ tool: "wait", args: { blocks: 10 } }).accepted, true);
  const pending = (env.view() as { pending: unknown[] }).pending.length;
  assert.ok(pending > 0);
  assert.equal(env.step({ tool: "prove", args: { count: pending } }).accepted, true);
  played.push({ block: 10, count: pending });
  env.step({ tool: "commit" });
  const out = env.finish();
  const direct = scheduleCost(fixture.claims, played, costModelOf(fixture), fixture.params.staleness_ppm_per_block);
  assert.notEqual(typeof direct, "string");
  assert.ok(Math.abs(out.metrics.cost_sats! - (direct as { total_sats: number }).total_sats) < 1e-6);
  assert.equal(out.metrics.forfeited, fixture.claims.length - pending);
});

test("baselines on development seeds: the ceiling bounds every policy, the reference never forfeits, the floor runs out of proofs", async () => {
  for (const cell of Object.keys(config.cells).sort()) {
    const fixture = proofFixture(root, manifest, cell, 1);
    const rows = new Map<string, { value: number; forfeited: number }>();
    for (const agent of proofBaselines()) {
      const row = await runEpisode(new ProofEnv(fixture), agent);
      assert.equal(row.rejections.length, 0, `${agent.id} on ${cell}`);
      rows.set(agent.id, { value: row.value, forfeited: row.metrics.forfeited! });
    }
    for (const [id, r] of rows) assert.ok(r.value <= rows.get("optimal_batching")!.value + 1e-9, `${cell}: ${id} above the ceiling`);
    assert.equal(rows.get("fixed_interval")!.forfeited, 0, `${cell}: the reference forfeits`);
    assert.ok(rows.get("every_arrival")!.forfeited > 0, `${cell}: the floor should exhaust its proofs`);
  }
});

test("fixtures regenerate byte for byte from their seeds and the adopted measurement", () => {
  const costTable = loadCostTable(root, config);
  for (const cell of Object.keys(config.cells).sort()) {
    for (const seed of [0, 1, 1000]) {
      const committed = readFileSync(join(root, `fixtures/proof_budget/${cell}/seed-${String(seed).padStart(4, "0")}.json`), "utf8");
      assert.equal(fixtureBytes(generateFixture(seed, cell, config.cells[cell]!, costTable)), committed, `${cell} seed ${seed}`);
    }
  }
  assert.throws(() => loadCostTable(root, { ...config, cost_model: { ...config.cost_model, sha256: "0".repeat(64) } }), /is not the adopted/);
});

test("the LLM path: the prompt states the costs and the pending claims; a model that only waits forfeits everything", async () => {
  const { createServer } = await import("node:http");
  const { ChatAgent } = await import("../../agents/chat.ts");
  const { proofPrompt } = await import("./prompt.ts");
  const fixture = proofFixture(root, manifest, "bursty", 2);
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"tool":"wait","args":{"blocks":1}}', reasoning_content: "" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const agent = new ChatAgent({
      name: "mock", baseUrl: `http://127.0.0.1:${port}/v1`, model: "mock",
      sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, max_tokens: 256, seed: 1 }, thinking: false,
      identity: { model_sha256: "0".repeat(64), runtime: "mock" }, prompt: proofPrompt(256),
    });
    const row = await runEpisode(new ProofEnv(fixture), agent);
    assert.equal(row.turns, fixture.params.horizon_blocks);
    assert.equal(row.metrics.forfeited, fixture.claims.length);
    const system = requests[0]!.messages[0]!.content;
    assert.ok(!/\{\w+\}/.test(system.replace(/\{"[^}]*\}/g, "")), "no template placeholder is left unfilled");
    assert.ok(system.includes("in bursts"));
    const later = requests[20]!.messages.at(-1)!.content;
    const visible = fixture.claims.filter((c) => c.block <= 20);
    assert.ok(visible.every((c) => later.includes(`${c.id} ${c.block} ${c.value_sats}`)), "every arrived claim is listed");
    assert.ok(!fixture.claims.filter((c) => c.block > 20).some((c) => later.includes(`\n${c.id} ${c.block} ${c.value_sats}`)), "no future claim is shown");
  } finally { server.close(); }
});

test("the schedule skill (proof_step's code): a model that calls it each turn and echoes its result proves every claim", async () => {
  const { ChatAgent } = await import("../../agents/chat.ts");
  const { scheduleSkill } = await import("../../agents/skills.ts");
  const { proofPrompt } = await import("./prompt.ts");
  const { echoSkillServer } = await import("../../agents/echo_mock.test_helper.ts");
  const { EveryArrival } = await import("./baselines.ts");
  const m = await echoSkillServer("schedule");
  try {
    for (const cell of Object.keys(config.cells).sort()) {
      const f = proofFixture(root, manifest, cell, 3);
      const agent = new ChatAgent({
        name: "mock", baseUrl: m.url, model: "mock",
        sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, max_tokens: 256, seed: 1 }, thinking: false,
        identity: { model_sha256: "0".repeat(64), runtime: "mock" }, prompt: proofPrompt(256), skills: [scheduleSkill], maxSkillCalls: 400, contextTurns: 0,
      });
      const row = await runEpisode(new ProofEnv(f), agent);
      const floor = await runEpisode(new ProofEnv(f), new EveryArrival());
      assert.equal(row.rejections.length, 0, cell);
      assert.equal(row.metrics.forfeited, 0, cell);
      assert.ok(row.value > floor.value + 1, cell);
    }
  } finally { m.server.close(); }
});
