import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "../../harness/agent.ts";
import { runEpisode } from "../../harness/episode.ts";
import { ManifestError, loadFixture, readManifest } from "../../harness/manifest.ts";
import { executeRun } from "../../harness/run.ts";
import { SEED_BLOCKS } from "../../harness/seeds.ts";
import { analyze, renderTable } from "../../harness/table.ts";
import { nettingBaselines } from "./baselines.ts";
import { NettingEnv, valueOf } from "./env.ts";
import { minCostFlow } from "./flow.ts";
import { fixtureBytes, fixturePath, generateFixture, grossPayable, netPayable, type NettingFixture } from "./generate.ts";
import { evaluatePlan, instanceOf, settleBilateral, settleGross, settleOptimal, type Instance, type Transfer } from "./plans.ts";
import { nettingGates, nettingIdentityCheck, nettingReport, nettingTaskSpecs } from "./report.ts";
import { loadNettingConfig, nettingFixture } from "./task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifest = readManifest(root);
const config = loadNettingConfig(root);
const dev = [...SEED_BLOCKS.development];

/** A hand-built instance: traders with collateral, trades, links; settlement at 100 per unit. */
function instance(trades: Array<[long: string, short: string, quantity: number, entry: number]>, links: Array<[a: string, b: string, capacity: number]>, collateral = 1_000_000): Instance {
  const ids = [...new Set([...trades.flatMap(([l, s]) => [l, s]), ...links.flatMap(([a, b]) => [a, b])])].sort();
  return {
    traders: ids.map((id) => ({ id, collateral_sats: collateral })),
    trades: trades.map(([long, short, quantity, entry_price], id) => ({ id, long, short, quantity, entry_price })),
    settlement_value: 100,
    links: links.map(([a, b, capacity_sats]) => ({ a, b, capacity_sats, rate_ppm: 100 })),
    ghost: { rate_ppm: 2000 },
    base_fee_sats: 0,
  };
}

test("minimum-cost flow on hand-worked cases", () => {
  // A chain: 0 must send 100 to 2 through 1, or straight to 2 at twenty times the rate.
  const arcs = [{ from: 0, to: 1, capacity: 100, cost: 100 }, { from: 1, to: 2, capacity: 100, cost: 100 }, { from: 0, to: 2, capacity: 100, cost: 2000 }];
  assert.deepEqual(minCostFlow(3, arcs, [100, 0, -100]), { flows: [100, 100, 0], cost: 20_000, routed: 100 });
  // The chain's capacity binds: the rest goes direct.
  assert.deepEqual(minCostFlow(3, [{ ...arcs[0]!, capacity: 60 }, arcs[1]!, arcs[2]!], [100, 0, -100]).flows, [60, 60, 40]);
  // Nothing to route.
  assert.deepEqual(minCostFlow(3, arcs, [0, 0, 0]), { flows: [0, 0, 0], cost: 0, routed: 0 });
  assert.throws(() => minCostFlow(3, arcs, [100, 0, -50]), /sum to/);
  assert.throws(() => minCostFlow(2, [{ from: 0, to: 1, capacity: 10, cost: 1 }], [100, -100]), /cannot carry/);
});

test("obligations, nets, and the three plans on a triangle that nets to nothing", () => {
  // a owes b 100, b owes c 100, c owes a 100 (each short at 90 on one unit, settled at 100).
  const tri = instance([["b", "a", 10, 90], ["c", "b", 10, 90], ["a", "c", 10, 90]], [["a", "b", 1000], ["b", "c", 1000], ["a", "c", 1000]]);
  const fixtureLike = { ...tri, version: "", seed: 0, cell: "", params: { traders: 0, trades: 0, graph: "uniform" as const, link_capacity_ppm_of_notional: 0 } };
  assert.deepEqual([...netPayable(fixtureLike).values()], [0, 0, 0]);
  assert.deepEqual([...grossPayable(fixtureLike).values()], [100, 100, 100]);
  const gross = settleGross(tri);
  assert.equal(gross.length, 3);
  assert.equal(evaluatePlan(tri, gross).cost, 3 * 100 * 100 / 1e6);
  assert.equal(evaluatePlan(tri, settleBilateral(tri)).cost, 3 * 100 * 100 / 1e6); // one trade per pair: nothing to net bilaterally
  assert.deepEqual(settleOptimal(tri), []);                                          // multilaterally it all cancels
  assert.equal(evaluatePlan(tri, []).violations.length, 0);
  assert.equal(valueOf(0), 0);
});

test("the ceiling routes along links when they are cheaper than ghost links, spills when they fill, and respects collateral", () => {
  // a owes c 100 and only a–b and b–c have links.
  const chain = instance([["c", "a", 10, 90]], [["a", "b", 1000], ["b", "c", 1000]]);
  const plan = settleOptimal(chain);
  assert.deepEqual(plan, [{ from: "a", to: "b", sats: 100, via: "link" }, { from: "b", to: "c", sats: 100, via: "link" }]);
  assert.equal(evaluatePlan(chain, plan).violations.length, 0);
  // With a–b at 60, the rest goes by ghost link straight to c.
  const tight = instance([["c", "a", 10, 90]], [["a", "b", 60], ["b", "c", 1000]]);
  assert.deepEqual(settleOptimal(tight), [{ from: "a", to: "b", sats: 60, via: "link" }, { from: "a", to: "c", sats: 40, via: "ghost" }, { from: "b", to: "c", sats: 60, via: "link" }]);
  // b has collateral for 30 only: it can relay at most 30.
  const poor: Instance = { ...chain, traders: chain.traders.map((t) => (t.id === "b" ? { ...t, collateral_sats: 30 } : t)) };
  const relayed = settleOptimal(poor);
  assert.equal(relayed.filter((t) => t.from === "b").reduce((s, t) => s + t.sats, 0), 30);
  assert.equal(evaluatePlan(poor, relayed).violations.length, 0);
});

test("(b) an invalid plan is rejected whole with its reason, the state is unchanged, and the attempt is spent", () => {
  const fixture = nettingFixture(root, manifest, "bilateral_dense", dev[0]!);
  const inst = instanceOf(fixture);
  const good = settleBilateral(inst);
  const traded = fixture.links[0]!;
  const cases: Array<[unknown, string]> = [
    [null, "malformed"],
    [{ tool: "settle" }, "malformed"],
    [{ tool: "settle", args: { plan: { transfers: [{ from: "t000", to: "t001", sats: 5 }] } } }, "malformed"],
    [{ tool: "settle", args: { plan: { transfers: [{ from: "t000", to: "zzz", sats: 5, via: "ghost" }] } } }, "unknown_node"],
    [{ tool: "settle", args: { plan: { transfers: [{ from: "t000", to: "t000", sats: 5, via: "ghost" }] } } }, "self_pair"],
    [{ tool: "settle", args: { plan: { transfers: [{ from: "t000", to: "t001", sats: 5.5, via: "ghost" }] } } }, "not_integer"],
    [{ tool: "settle", args: { plan: { transfers: [...good, { from: traded.a, to: traded.b, sats: traded.capacity_sats + 1, via: "link" }] } } }, "over_budget"],
    [{ tool: "settle", args: { plan: { transfers: [] } } }, "unbalanced"],
    [{ tool: "settle", args: { plan: { transfers: good.slice(1) } } }, "unbalanced"],
    [{ tool: "settle", args: { plan: { transfers: good.map((t) => ({ ...t, via: "link" as const })).concat([{ from: "t000", to: "t001", sats: 1, via: "ghost" }]) } } }, "unbalanced"],
  ];
  for (const [action, reason] of cases) {
    const env = new NettingEnv(fixture, config);
    const before = env.snapshot();
    const budget = env.budget();
    const r = env.step(action);
    assert.deepEqual([r.accepted, r.reason], [false, reason], JSON.stringify(action).slice(0, 120));
    assert.equal(env.snapshot(), before);
    assert.deepEqual(env.budget(), { ...budget, attempts: budget.attempts - 1 });
  }
  // A link transfer on a pair that never traded.
  const [p, q] = ["t000", "t001"];
  const noLink = !fixture.links.some((l) => (l.a === p && l.b === q));
  if (noLink) {
    const env = new NettingEnv(fixture, config);
    assert.equal(env.step({ tool: "settle", args: { plan: { transfers: [{ from: p, to: q, sats: 1, via: "link" }] } } }).reason, "no_link");
  }
  // A probe lists every violation and costs a probe, not an attempt.
  const env = new NettingEnv(fixture, config);
  const probe = env.step({ tool: "probe", args: { plan: { transfers: [{ from: "t000", to: "t001", sats: 5, via: "ghost" }] } } });
  assert.ok(probe.accepted);
  assert.ok((probe.result as { valid: boolean; violations: unknown[] }).valid === false && (probe.result as { violations: unknown[] }).violations.length > 0);
  assert.deepEqual(env.budget(), { attempts: config.budget.attempts, probes: config.budget.probes - 1, blocks: 0, sats: 0 });
});

test("(b) an episode with no accepted plan is scored at twice the floor's cost", async () => {
  const fixture = nettingFixture(root, manifest, "multilateral_sparse", dev[1]!);
  const junk: Agent = { id: "junk", act: () => ({ tool: "settle", args: { plan: { transfers: [] } } }) };
  const row = await runEpisode(new NettingEnv(fixture, config), junk);
  assert.equal(row.rejections.length, config.budget.attempts);
  const floor = evaluatePlan(instanceOf(fixture), settleGross(instanceOf(fixture))).cost;
  assert.equal(row.metrics.cost_sats, config.infeasible_penalty_factor * floor);
  assert.equal(row.value, valueOf(config.infeasible_penalty_factor * floor));
});

test("(a) the ceiling beats every policy on every episode, bilateral netting never loses to gross, and the identity control holds", async () => {
  const record = await executeRun({ root, manifest, block: "development", seeds: dev, tasks: nettingTaskSpecs(root, manifest, config), baselines: nettingBaselines(), checks: nettingIdentityCheck(root, manifest, config) });
  const analysis = analyze(record);
  for (const g of nettingGates(analysis, record)) assert.ok(g.pass, `${g.id}: ${g.detail}`);
  // Where multilateral netting is designed to matter, it does; where links are tight, ghost links carry the rest.
  assert.ok(analysis.difference("netting/multilateral_sparse", "min_cost_flow", "bilateral_net").lo > 0);
  assert.ok(analysis.difference("netting/tight_links", "min_cost_flow", "bilateral_net").lo > 0);
  const tightRows = record.rows.filter((r) => r.task === "netting/tight_links" && r.agent === "min_cost_flow");
  assert.ok(tightRows.some((r) => r.metrics.ghost_volume_sats! > 0));
  const table = renderTable(record, nettingReport);
  assert.equal(table, renderTable(JSON.parse(JSON.stringify(record)), nettingReport));
  assert.ok(table.includes(record.manifest_sha256));
});

test("the identity control catches a ceiling that is not the exact solver", () => {
  const rows = [{ task: "netting/bilateral_dense", seed: dev[0]!, cell: "single", agent: "min_cost_flow", value: 0, metrics: {}, turns: 1, rejections: [] }];
  const [check] = nettingIdentityCheck(root, manifest, config)(rows);
  assert.equal(check!.pass, false);
});

test("(c) a tampered fixture is refused by name, and committed fixtures regenerate byte for byte", () => {
  const path = fixturePath("bilateral_dense", dev[0]!);
  const entry = manifest.fixtures.find((f) => f.path === path)!;
  const original = readFileSync(join(root, path), "utf8");
  assert.equal(original, fixtureBytes(generateFixture(dev[0]!, "bilateral_dense", config.cells.bilateral_dense!, config.market)));
  const tmp = mkdtempSync(join(tmpdir(), "bdb-netting-"));
  mkdirSync(dirname(join(tmp, path)), { recursive: true });
  // The settlement value moved by one sat.
  const fixture = JSON.parse(original) as NettingFixture;
  writeFileSync(join(tmp, path), original.replace(`"settlement_value":${fixture.settlement_value}`, `"settlement_value":${fixture.settlement_value + 1}`));
  assert.throws(() => loadFixture(tmp, manifest, path), (e: unknown) => e instanceof ManifestError && e.file === entry.path);
  // Fixtures are integers and strings only, and every trader's collateral covers its gross payable.
  const check = (v: unknown): void => {
    if (typeof v === "number") assert.ok(Number.isInteger(v));
    else if (Array.isArray(v)) v.forEach(check);
    else if (v !== null && typeof v === "object") Object.values(v as object).forEach(check);
    else assert.ok(v === null || typeof v === "string");
  };
  check(fixture);
  const gross = grossPayable(fixture);
  for (const t of fixture.traders) assert.ok(t.collateral_sats >= gross.get(t.id)!);
  const plan: Transfer[] = settleGross(instanceOf(fixture));
  assert.equal(evaluatePlan(instanceOf(fixture), plan).violations.length, 0);
});
