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
import { runChannel, runVtxo } from "./corner.ts";
import { SettlementEnv, Simulations, gridOf } from "./env.ts";
import { fixtureBytes, fixturePath, generateFixture, generateStream, loadStream, summarize, type DemandStream, type SettlementFixture, type Step } from "./generate.ts";
import { settlementGates, settlementReport, settlementTaskSpecs } from "./report.ts";
import { loadProtocol, loadSettlementConfig, simulationsFor } from "./task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifest = readManifest(root);
const config = loadSettlementConfig(root);
const protocol = loadProtocol(root);
const dev = [...SEED_BLOCKS.development];

test("corner runner on a hand-worked case: lock for the residual lifetime, volume in both directions", () => {
  // One holder receives 1000 at height 0 and spends it at height 50; lifetime 100, one-block rounds.
  const series: Step[] = Array.from({ length: 100 }, () => ({ out: 0, in: 0 }));
  series[0] = { out: 0, in: 1000 };
  series[50] = { out: 1000, in: 0 };
  const stream: DemandStream = new Map([["a000", series]]);
  const tiny = { lifetime_blocks: 100, round_interval_blocks: 1 };
  const v = runVtxo(stream, tiny, 10);
  assert.equal(v.locked_integral, 1000 * 50);   // fronted at 50, swept at expiry 100
  assert.equal(v.volume, 2000);                 // the receipt and the spend
  assert.equal(v.duration, 25);                 // the pinned model alone reports 50: it divides by spends only
  assert.equal(v.peak_locked, 1000);
  assert.deepEqual([v.attempts, v.failures], [2, 0]);
  // The same numbers straight from the pinned server, to show the runner adds nothing but the denominator.
  const S = new ArkServer(10_000, { lifetimeBlocks: 100, roundInterval: 1, refreshLead: 10 });
  S.receive("a000", 1000); S.advance(50); S.spendLightning("a000", 1000); S.advance(50);
  assert.equal(S.liquidityDuration() * S.volumeDelivered, v.locked_integral);
  // Channel: inbound pre-funded to the peak held balance and held for the horizon.
  const c = runChannel(stream, tiny, 0);
  assert.equal(c.peak_locked, 1000);
  assert.equal(c.locked_integral, 1000 * 100);
  assert.equal(c.duration, 50);
  assert.equal(c.failures, 0);
  // Under-provisioning fails the receipt, and then the spend it would have funded.
  const under = runChannel(stream, tiny, -0.5);
  assert.deepEqual([under.failures, under.attempts], [2, 2]);
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
  // Adding agents does not change the agents already there.
  const bigger = generateStream(5, "t", "evaluation", { ...small, agents: 13 }, protocol);
  assert.deepEqual(bigger.get("a003"), a.get("a003"));
});

test("(a) grid search ≥ every baseline on every episode, and the matching constant beats random on each corner", async () => {
  const record = await executeRun({ root, manifest, block: "development", seeds: dev, tasks: settlementTaskSpecs(root, manifest, config), baselines: settlementBaselines(config) });
  const analysis = analyze(record);
  const gates = settlementGates(analysis, record);
  assert.ok(gates.find((g) => g.id === "K6")!.pass, gates.find((g) => g.id === "K6")!.detail);
  assert.ok(gates.find((g) => g.id === "K8")!.pass, gates.find((g) => g.id === "K8")!.detail);
  const mean = (task: string, agent: string): number => {
    const m = [...analysis.means(task, agent).values()];
    return m.reduce((x, y) => x + y, 0) / m.length;
  };
  // The paper's §3.3 direction at the pinned settings: VTXO on the bursty corner, channel on the steady one.
  assert.ok(mean("settlement_object/many_bursty_long", "always_vtxo") >= mean("settlement_object/many_bursty_long", "random"));
  assert.ok(mean("settlement_object/few_steady_recycling", "always_channel") >= mean("settlement_object/few_steady_recycling", "random"));
  assert.ok(analysis.difference("settlement_object/many_bursty_long", "always_vtxo", "always_channel").lo > 0);
  assert.ok(analysis.difference("settlement_object/few_steady_recycling", "always_vtxo", "always_channel").hi < 0);
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
    [{ tool: "choose", args: { choice: { object: "channel", margin: 0.33 } } }, "out_of_grid"],
    [{ tool: "choose", args: { choice: { object: "vtxo", refresh_lead_blocks: 100 } } }, "out_of_grid"],
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
  const under = new SettlementEnv(sims, config);
  assert.ok(under.step({ tool: "choose", args: { choice: { object: "channel", margin: -0.5 } } }).accepted);
  const out = under.finish();
  if (sims.run("evaluation", { object: "channel", margin: -0.5 }).feasible) assert.equal(out.metrics.feasible, 1);
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
