import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArkServer } from "../../../vendor/spiral/model/server.ts";
import { ManifestError, loadFixture, readManifest } from "../../harness/manifest.ts";
import { executeRun } from "../../harness/run.ts";
import { SEED_BLOCKS } from "../../harness/seeds.ts";
import { analyze, renderTable } from "../../harness/table.ts";
import { settlementBaselines } from "./baselines.ts";
import { runChannel, runVtxo, serverEnvelope, serverTierCapacity } from "./corner.ts";
import { SettlementEnv, gridOf } from "./env.ts";
import { fixtureBytes, fixturePath, generateFixture, generateStream, loadStream, summarize, type DemandStream, type SettlementFixture, type Step } from "./generate.ts";
import { settlementGates, settlementReport, settlementTaskSpecs } from "./report.ts";
import { loadProtocol, loadSettlementConfig, simulationsFor } from "./task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifest = readManifest(root);
const config = loadSettlementConfig(root);
const protocol = loadProtocol(root);
const dev = [...SEED_BLOCKS.development];
const tiny = { lifetime_blocks: 100, round_interval_blocks: 1 };

const streamOf = (agents: { [name: string]: Array<[step: number, inflow: number, outflow: number]> }, steps: number): DemandStream => {
  const out: DemandStream = new Map();
  for (const name of Object.keys(agents).sort()) {
    const series: Step[] = Array.from({ length: steps }, () => ({ out: 0, in: 0 }));
    for (const [t, inflow, outflow] of agents[name]!) series[t] = { in: inflow, out: outflow };
    out.set(name, series);
  }
  return out;
};

test("corner runner on a hand-worked case: lock for the residual lifetime, volume in both directions", () => {
  // One holder receives 1000 at height 0 and spends it at height 50; lifetime 100, one-block rounds.
  const stream = streamOf({ a000: [[0, 1000, 0], [50, 0, 1000]] }, 100);
  const v = runVtxo(stream, tiny, 10);            // the pinned definition: no server-tier term
  assert.equal(v.locked_integral, 1000 * 50);     // fronted at 50, swept at expiry 100
  assert.equal(v.volume, 2000);                   // the receipt and the spend
  assert.equal(v.duration, 25);                   // the pinned model alone reports 50: it divides by spends only
  assert.deepEqual([v.peak_fronted, v.server_tier_locked, v.attempts, v.failures], [1000, 0, 2, 0]);
  // The same numbers straight from the pinned server, to show the runner adds nothing but the denominator.
  const S = new ArkServer(10_000, { lifetimeBlocks: 100, roundInterval: 1, refreshLead: 10 });
  S.receive("a000", 1000); S.advance(50); S.spendLightning("a000", 1000); S.advance(50);
  assert.equal(S.liquidityDuration() * S.volumeDelivered, v.locked_integral);
  // Channel: inbound pre-funded to the peak held balance and held for the horizon.
  const c = runChannel(stream, tiny, 0);
  assert.deepEqual([c.peak_locked, c.locked_integral, c.duration, c.failures], [1000, 1000 * 100, 50, 0]);
  // Under-provisioning fails the receipt, and then the spend it would have funded.
  const under = runChannel(stream, tiny, -0.5);
  assert.deepEqual([under.failures, under.attempts], [2, 2]);
});

test("server tier on hand-worked cases: one holder gets no pooling, two offsetting holders do", () => {
  // One holder: the server's channels must take the same 1000 the agent's channel would.
  const one = streamOf({ a000: [[0, 1000, 0], [50, 0, 1000]] }, 100);
  assert.deepEqual(serverEnvelope(one), { peak: 1000, trough: 0 });
  const v = runVtxo(one, tiny, 10, 0);
  assert.equal(v.server_tier_locked, 1000);
  assert.equal(v.locked_integral, 1000 * 50 + 1000 * 100);  // ∫ W_S plus the server's channels for the horizon
  assert.equal(v.duration, 75);                             // against 50 for the channel: the server also fronts the spend
  assert.equal(runVtxo(one, tiny, 10, 0.25).server_tier_locked, 1250);
  // Two holders whose balances never overlap: a000 holds 1000 over steps 0-9, a001 over steps 20-29.
  const two = streamOf({ a000: [[0, 1000, 0], [10, 0, 1000]], a001: [[20, 1000, 0], [30, 0, 1000]] }, 100);
  assert.deepEqual(serverEnvelope(two), { peak: 1000, trough: 0 });
  assert.equal(runChannel(two, tiny, 0).peak_locked, 2000);       // each agent's channel pre-funds its own peak
  assert.equal(runVtxo(two, tiny, 10, 0).server_tier_locked, 1000); // the server's channels are reused
  // The same two holders at the same time: nothing to pool.
  const together = streamOf({ a000: [[0, 1000, 0], [10, 0, 1000]], a001: [[0, 1000, 0], [10, 0, 1000]] }, 100);
  assert.equal(runVtxo(together, tiny, 10, 0).server_tier_locked, 2000);
});

test("an under-provisioned server tier fails payments by the channel model's rule; at margin ≥ 0 it never does", () => {
  const two = streamOf({ a000: [[0, 1000, 0], [10, 0, 1000]], a001: [[0, 1000, 0], [10, 0, 1000]] }, 100);
  assert.deepEqual(serverTierCapacity(serverEnvelope(two), -0.25), { inbound: 1500, outbound: 0 });
  const under = runVtxo(two, tiny, 10, -0.25);
  // a000's receipt fits; a001's does not, so a001's later spend has nothing behind it.
  assert.deepEqual([under.attempts, under.failures, under.volume], [4, 2, 2000]);
  assert.equal(under.server_tier_locked, 1500);
  for (const margin of [0, 0.1, 0.25]) assert.equal(runVtxo(two, tiny, 10, margin).failures, 0);
});

test("streams are deterministic, independent across kinds, and contain only fundable spends", () => {
  const params = config.cells.many_bursty_long!;
  const small = { ...params, agents: 12, horizon_lifetimes: 1 };
  const a = generateStream(5, "t", "evaluation", small, protocol);
  assert.equal(summarize(a).sha256, summarize(generateStream(5, "t", "evaluation", small, protocol)).sha256);
  assert.notEqual(summarize(a).sha256, summarize(generateStream(5, "t", "pilot", small, protocol)).sha256);
  assert.notEqual(summarize(a).sha256, summarize(generateStream(6, "t", "evaluation", small, protocol)).sha256);
  assert.deepEqual([...a.keys()], [...a.keys()].sort());
  for (const series of a.values()) {
    let running = 0;
    for (const s of series) { running += s.in; assert.ok(s.out <= running); running -= s.out; }
  }
  // With every spend fundable, the server's net Lightning position never goes below zero.
  assert.equal(serverEnvelope(a).trough, 0);
  // Adding agents does not change the agents already there.
  const bigger = generateStream(5, "t", "evaluation", { ...small, agents: 13 }, protocol);
  assert.deepEqual(bigger.get("a003"), a.get("a003"));
});

test("(a) grid search ≥ every baseline on every episode, and the matching constant beats random on each corner", async () => {
  // Two development seeds: each 200-agent fixture needs nine runs of the pinned server.
  const record = await executeRun({ root, manifest, block: "development", seeds: dev.slice(0, 2), tasks: settlementTaskSpecs(root, manifest, config), baselines: settlementBaselines(config) });
  const analysis = analyze(record);
  const k6 = settlementGates(analysis, record).find((g) => g.id === "K6")!;
  assert.ok(k6.pass, k6.detail);
  const mean = (cell: string, agent: string): number => {
    const m = [...analysis.means(`settlement_object/${cell}`, agent).values()];
    return m.reduce((x, y) => x + y, 0) / m.length;
  };
  for (const cell of Object.keys(config.cells)) assert.ok(mean(cell, "grid_search") >= mean(cell, "random"));
  // What the random baseline earns in expectation: the mean score over the whole grid. Two seeds
  // are too few to compare against its realized draws.
  const gridAverage = (cell: string): number => {
    const values: number[] = [];
    for (const seed of dev.slice(0, 2)) {
      const sims = simulationsFor(root, manifest, config, cell, seed);
      for (const choice of gridOf(config)) {
        const env = new SettlementEnv(sims, config);
        env.step({ tool: "choose", args: { choice } });
        values.push(env.finish().value);
      }
    }
    return values.reduce((x, y) => x + y, 0) / values.length;
  };
  // Pooling favors the server where demand is idiosyncratic and has no drift; recycling favors the channel.
  assert.ok(mean("many_bursty_balanced", "always_vtxo") > gridAverage("many_bursty_balanced"));
  assert.ok(mean("many_bursty_balanced", "always_vtxo") > mean("many_bursty_balanced", "always_channel"));
  assert.ok(mean("few_steady_recycling", "always_channel") > gridAverage("few_steady_recycling"));
  assert.ok(mean("few_steady_recycling", "always_channel") > mean("few_steady_recycling", "always_vtxo"));
  // The table renders from the record alone and carries the ratio section.
  const table = renderTable(record, settlementReport);
  assert.equal(table, renderTable(JSON.parse(JSON.stringify(record)), settlementReport));
  assert.ok(table.includes("Liquidity-duration ratio") && table.includes(record.manifest_sha256));
});

test("(b) a rejected or malformed action is the identity on state and costs its budget", () => {
  const sims = simulationsFor(root, manifest, config, "few_steady_recycling", dev[0]!);
  const attempt: Array<[unknown, string]> = [
    [null, "malformed"],
    [{ tool: 3 }, "malformed"],
    [{ tool: "open", args: {} }, "unknown_tool"],
    [{ tool: "choose" }, "malformed"],
    [{ tool: "choose", args: { choice: { object: "channel" } } }, "malformed"],
    [{ tool: "choose", args: { choice: { object: "vtxo", margin: 0 } } }, "malformed"],
    [{ tool: "choose", args: { choice: { object: "channel", margin: 0.33 } } }, "out_of_grid"],
    [{ tool: "choose", args: { choice: { object: "vtxo", refresh_lead_blocks: 100, margin: 0 } } }, "out_of_grid"],
    [{ tool: "choose", args: { choice: { object: "vtxo", refresh_lead_blocks: 288, margin: 0.33 } } }, "out_of_grid"],
    [{ tool: "choose", args: { choice: { object: "covenant", margin: 0 } } }, "malformed"],
  ];
  for (const [action, reason] of attempt) {
    const env = new SettlementEnv(sims, config);
    const before = env.snapshot();
    const budget = env.budget();
    const r = env.step(action);
    assert.deepEqual([r.accepted, r.reason], [false, reason], JSON.stringify(action));
    assert.equal(env.snapshot(), before);
    assert.deepEqual(env.budget(), { ...budget, attempts: budget.attempts - 1 });
  }
  // A rejected probe costs a probe, not an attempt.
  const env = new SettlementEnv(sims, config);
  const before = env.snapshot();
  assert.equal(env.step({ tool: "probe", args: { choice: { object: "channel", margin: 9 } } }).reason, "out_of_grid");
  assert.equal(env.snapshot(), before);
  assert.deepEqual(env.budget(), { attempts: config.budget.attempts, probes: config.budget.probes - 1, blocks: 0, sats: 0 });
  // With no probes left, a probe costs an attempt and is refused.
  for (let i = 1; i < config.budget.probes; i++) assert.ok(env.step({ tool: "probe", args: { choice: { object: "channel", margin: 0 } } }).accepted);
  assert.equal(env.budget().probes, 0);
  const spent = env.snapshot();
  assert.equal(env.step({ tool: "probe", args: { choice: { object: "channel", margin: 0 } } }).reason, "over_budget");
  assert.equal(env.snapshot(), spent);
  assert.equal(env.budget().attempts, config.budget.attempts - 1);
});

test("(b) an episode that never chooses is scored at the infeasibility penalty, as is an infeasible choice", () => {
  const sims = simulationsFor(root, manifest, config, "few_steady_recycling", dev[0]!);
  const worst = Math.max(...gridOf(config).map((g) => sims.run("evaluation", g)).filter((r) => r.feasible).map((r) => r.duration));
  const idle = new SettlementEnv(sims, config);
  idle.step({ tool: "commit" });
  assert.equal(idle.finish().metrics.scored_duration, config.infeasible_penalty_factor * worst);
  const choice = { object: "channel" as const, margin: -0.25 };
  const under = new SettlementEnv(sims, config);
  assert.ok(under.step({ tool: "choose", args: { choice } }).accepted);
  const out = under.finish();
  if (sims.run("evaluation", choice).feasible) assert.equal(out.metrics.feasible, 1);
  else assert.equal(out.metrics.scored_duration, config.infeasible_penalty_factor * worst);
});

test("a probe reports the pilot stream, never the evaluation stream, and the observation carries neither", () => {
  const sims = simulationsFor(root, manifest, config, "few_steady_recycling", dev[1]!);
  const env = new SettlementEnv(sims, config);
  const choice = { object: "channel" as const, margin: 0.25 };
  const probed = env.step({ tool: "probe", args: { choice } }).result as { duration: number };
  assert.equal(probed.duration, sims.run("pilot", choice).duration);
  assert.notEqual(probed.duration, sims.run("evaluation", choice).duration);
  const view = JSON.stringify(env.view());
  for (const hidden of ["sha256", "volume_in", "receipts", String(sims.fixture.streams.evaluation.volume_out)]) assert.ok(!view.includes(hidden), `${hidden} leaked`);
  assert.ok(view.includes('"server_tier":{"charged":true'));
});

test("(c) a tampered fixture is refused: by the manifest when its bytes change, by the stream hash when its stream would", () => {
  const path = fixturePath("few_steady_recycling", dev[0]!);
  const entry = manifest.fixtures.find((f) => f.path === path)!;
  const original = readFileSync(join(root, path), "utf8");
  assert.equal(original, fixtureBytes(generateFixture(dev[0]!, "few_steady_recycling", config.cells.few_steady_recycling!, protocol)), "committed fixture regenerates byte for byte");
  const tmp = mkdtempSync(join(tmpdir(), "bdb-settlement-"));
  mkdirSync(dirname(join(tmp, path)), { recursive: true });
  // Four agents where the fixture says three.
  writeFileSync(join(tmp, path), original.replace('"agents":3', '"agents":4'));
  assert.throws(() => loadFixture(tmp, manifest, path), (e: unknown) => e instanceof ManifestError && e.file === entry.path);
  // A fixture that passed the manifest but whose parameters no longer produce the bound stream.
  const fixture = JSON.parse(original) as SettlementFixture;
  assert.ok(loadStream(fixture, "evaluation").size === 3);
  assert.throws(() => loadStream({ ...fixture, seed: fixture.seed + 1 }, "evaluation"), /does not match its bound hash/);
  assert.throws(() => loadStream({ ...fixture, params: { ...fixture.params, base: { ...fixture.params.base, in_sats: 101 } } }, "pilot"), /does not match its bound hash/);
});
