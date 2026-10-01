import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "../../harness/agent.ts";
import { runEpisode } from "../../harness/episode.ts";
import { sha256, type Json } from "../../harness/json.ts";
import { ManifestError, readManifest, type Manifest } from "../../harness/manifest.ts";
import { cmpSeq } from "../../harness/order.ts";
import { stream } from "../../harness/prng.ts";
import { executeRun } from "../../harness/run.ts";
import { SEED_BLOCKS } from "../../harness/seeds.ts";
import { analyze, renderTable } from "../../harness/table.ts";
import { placementBaselines } from "./baselines.ts";
import { PlacementEnv, evaluatePlacements } from "./env.ts";
import { BALANCE_MODELS, fixtureBytes, fixturePath, generateFixture } from "./generate.ts";
import { adjacencyOf, parseGml } from "./gml.ts";
import { kShortestSimplePaths } from "./paths.ts";
import { placementGates, placementIdentityCheck, placementReport, placementTaskSpecs } from "./report.ts";
import { loadPlacementConfig, placementFixture } from "./task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifest = readManifest(root);
const config = loadPlacementConfig(root);
const dev = [...SEED_BLOCKS.development];

const devRun = () => executeRun({
  root, manifest, block: "development", seeds: dev,
  tasks: placementTaskSpecs(root, manifest, config),
  baselines: placementBaselines(),
  checks: placementIdentityCheck(root, manifest, config),
});

test("(a) oracle ≥ failure-aware ≥ random on the development fixtures, and the identity control holds", async () => {
  const record = await devRun();
  const analysis = analyze(record);
  const mean = (task: string, agent: string): number => {
    const m = [...analysis.means(task, agent).values()];
    return m.reduce((a, x) => a + x, 0) / m.length;
  };
  const s = (a: string) => mean("placement/stationary", a);
  assert.ok(s("oracle") >= s("failure_aware"), `stationary: oracle ${s("oracle")} < failure_aware ${s("failure_aware")}`);
  assert.ok(s("failure_aware") >= s("random"), `stationary: failure_aware ${s("failure_aware")} < random ${s("random")}`);
  // After a shift the calibration says failure-aware and random are not distinguishable, so the
  // strict ordering is asserted only for the oracle; the heuristic is held to the equivalence band.
  const h = (a: string) => mean("placement/shift", a);
  assert.ok(h("oracle") >= h("failure_aware") && h("oracle") >= h("random"));
  assert.ok(h("failure_aware") >= h("random") - 1.0);
  const gates = placementGates(analysis, record);
  assert.ok(gates.find((g) => g.id === "K4")!.pass);
  assert.ok(gates.find((g) => g.id === "K5")!.pass, gates.find((g) => g.id === "K5")!.detail);
});

test("(b) a rejected or malformed action is the identity on state and costs one attempt", () => {
  const fixture = placementFixture(root, manifest, dev[0]!);
  const [a, b] = [fixture.nodes[0]!, fixture.nodes[1]!];
  const cases: Array<[unknown, string]> = [
    [null, "malformed"],
    ["place", "malformed"],
    [{ tool: 7 }, "malformed"],
    [{ tool: "open_channel", args: {} }, "unknown_tool"],
    [{ tool: "place" }, "malformed"],
    [{ tool: "place", args: { placements: [] } }, "malformed"],
    [{ tool: "place", args: { placements: [{ from: a, to: b }] } }, "malformed"],
    [{ tool: "place", args: { placements: [{ from: a, to: "N999", sats: 50_000 }] } }, "unknown_node"],
    [{ tool: "place", args: { placements: [{ from: a, to: a, sats: 50_000 }] } }, "self_pair"],
    [{ tool: "place", args: { placements: [{ from: a, to: b, sats: 50_000.5 }] } }, "not_integer"],
    [{ tool: "place", args: { placements: [{ from: a, to: b, sats: -1 }] } }, "not_integer"],
    [{ tool: "place", args: { placements: [{ from: a, to: b, sats: config.budget_sats + 1 }] } }, "over_budget"],
    // A valid first entry does not rescue an invalid second one: the action is rejected whole.
    [{ tool: "place", args: { placements: [{ from: a, to: b, sats: 30_000 }, { from: b, to: "N999", sats: 30_000 }] } }, "unknown_node"],
  ];
  for (const [action, reason] of cases) {
    const env = new PlacementEnv(fixture, "uniform", "stationary", config);
    const before = env.snapshot();
    const budget = env.budget();
    const result = env.step(action);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, reason, JSON.stringify(action));
    assert.equal(env.snapshot(), before, `state changed on ${reason}`);
    assert.deepEqual(env.budget(), { ...budget, attempts: budget.attempts - 1 });
  }
});

test("(b) below-minimum placement on a pair with no channel is rejected whole; an accepted one debits sats", () => {
  const fixture = placementFixture(root, manifest, dev[0]!);
  const env = new PlacementEnv(fixture, "uniform", "stationary", config);
  const edges = new Set(fixture.edges.map((e) => `${e.u}|${e.v}`));
  let pair: [string, string] | null = null;
  for (const u of fixture.nodes) for (const v of fixture.nodes) if (pair === null && u < v && !edges.has(`${u}|${v}`)) pair = [u, v];
  const [u, v] = pair!;
  const before = env.snapshot();
  assert.equal(env.step({ tool: "place", args: { placements: [{ from: u, to: v, sats: config.min_pair_sats - 1 }] } }).reason, "below_minimum");
  assert.equal(env.snapshot(), before);
  const ok = env.step({ tool: "place", args: { placements: [{ from: u, to: v, sats: 70_000 }, { from: v, to: u, sats: 30_000 }] } });
  assert.ok(ok.accepted);
  assert.equal(env.budget().sats, config.budget_sats - 100_000);
  assert.notEqual(env.snapshot(), before);
  // Capital already committed cannot be committed twice.
  assert.equal(env.step({ tool: "place", args: { placements: [{ from: u, to: v, sats: 30_000 }] } }).reason, "over_budget");
});

test("(b) an episode of rejected actions scores exactly as no placement, and the phase closes when attempts run out", async () => {
  const fixture = placementFixture(root, manifest, dev[1]!);
  let calls = 0;
  const junk: Agent = { id: "junk", act: () => { calls += 1; return { tool: "place", args: { placements: [{ from: "N000", to: "N000", sats: 1 }] } }; } };
  const row = await runEpisode(new PlacementEnv(fixture, "polarized", "stationary", config), junk);
  assert.equal(calls, config.attempts);
  assert.equal(row.rejections.length, config.attempts);
  const none = evaluatePlacements(fixture, "polarized", "stationary", config, []);
  assert.equal(row.value, none.value);
  assert.equal(row.metrics.placed_sats, 0);
});

test("(c) a run refuses to score when a fixture's hash does not match the manifest", async () => {
  const tampered: Manifest = {
    ...manifest,
    fixtures: manifest.fixtures.map((f, i) => (i === 0 ? { ...f, sha256: sha256("tampered") } : f)),
  };
  let acted = false;
  const spy: Agent = { id: "spy", act: () => { acted = true; return { tool: "commit" }; } };
  await assert.rejects(
    executeRun({ root, manifest: tampered, block: "development", seeds: dev, tasks: placementTaskSpecs(root, tampered, config), baselines: placementBaselines(), agents: [spy] }),
    (e: unknown) => e instanceof ManifestError && e.file === manifest.fixtures[0]!.path,
  );
  assert.equal(acted, false, "an episode ran before the manifest was verified");
});

test("the action order inside a placement cannot change the outcome", () => {
  const fixture = placementFixture(root, manifest, dev[2]!);
  const [a, b] = fixture.hotspots.first;
  const [c, d] = fixture.hotspots.second;
  const p = [{ from: a, to: b, sats: 40_000 }, { from: d, to: c, sats: 30_000 }, { from: b, to: a, sats: 20_000 }, { from: c, to: d, sats: 30_000 }];
  const forward = evaluatePlacements(fixture, "uniform", "shift", config, p);
  const reversed = evaluatePlacements(fixture, "uniform", "shift", config, [...p].reverse());
  assert.deepEqual(forward, reversed);
});

test("stationary and shift episodes present the same observation, so the regime is not visible to the agent", () => {
  const fixture = placementFixture(root, manifest, dev[3]!);
  for (const model of BALANCE_MODELS) {
    const s = new PlacementEnv(fixture, model, "stationary", config);
    const h = new PlacementEnv(fixture, model, "shift", config);
    assert.deepEqual(s.view(), h.view());
    assert.deepEqual(s.budget(), h.budget());
    assert.notDeepEqual(s.privileged(), h.privileged());
  }
  // The observation exposes public structure and history only.
  const view = JSON.stringify(new PlacementEnv(fixture, "uniform", "stationary", config).view());
  for (const hidden of ["capacity", "balance", "hotspot"]) assert.ok(!view.includes(hidden), `${hidden} leaked into the observation`);
});

test("a run is deterministic and the table is a pure function of the run record", async () => {
  const first = await devRun();
  const second = await devRun();
  assert.deepEqual(first, second);
  const table = renderTable(first, placementReport);
  assert.equal(table, renderTable(JSON.parse(JSON.stringify(second)), placementReport));
  assert.ok(table.includes(first.manifest_sha256) && table.includes(first.prereg_sha256) && table.includes(first.spiral_commit));
  assert.ok(!/composite|overall score/i.test(table.replace("there is no composite score", "")));
});

test("candidate catalog is the exact first k simple paths under (hop count, node sequence)", () => {
  for (let trial = 0; trial < 40; trial++) {
    const rng = stream("test/paths", trial);
    const n = 5 + rng.int(4);
    const nodes = Array.from({ length: n }, (_, i) => `N00${i}`);
    const edges: Array<{ u: string; v: string }> = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rng.next() < 0.45) edges.push({ u: nodes[i]!, v: nodes[j]! });
    const adj = adjacencyOf(edges);
    const [s, t] = [nodes[0]!, nodes[n - 1]!];
    const all: string[][] = [];
    const walk = (path: string[]) => {
      const last = path[path.length - 1]!;
      if (last === t) { all.push(path); return; }
      for (const next of adj.get(last) ?? []) if (!path.includes(next)) walk([...path, next]);
    };
    if (adj.has(s)) walk([s]);
    all.sort((x, y) => x.length - y.length || cmpSeq(x, y));
    assert.deepEqual(kShortestSimplePaths(adj, s, t, 8), all.slice(0, 8), `trial ${trial}`);
  }
});

test("fixtures regenerate byte-for-byte from the pinned snapshot", { skip: !existsSync(join(root, "data/topology/20230716.gml.geo")) && "snapshot not present" }, () => {
  const bytes = readFileSync(join(root, "data/topology/20230716.gml.geo"));
  const graph = parseGml(bytes.toString("utf8"));
  for (const seed of dev.slice(0, 3)) {
    const entry = manifest.fixtures.find((f) => f.path === fixturePath(seed))!;
    assert.equal(sha256(fixtureBytes(generateFixture(graph, sha256(bytes), seed, config))), entry.sha256, `seed ${seed}`);
  }
});

test("fixtures hold integers and strings only, in canonical order", () => {
  for (const seed of dev) {
    const fixture = placementFixture(root, manifest, seed);
    const check = (value: Json): void => {
      if (typeof value === "number") assert.ok(Number.isInteger(value));
      else if (Array.isArray(value)) value.forEach(check);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(check);
      else assert.equal(typeof value, "string");
    };
    check(fixture as unknown as Json);
    const keys = fixture.edges.map((e) => `${e.u}|${e.v}`);
    assert.ok(fixture.edges.every((e) => e.u < e.v));
    assert.deepEqual(keys, [...keys].sort());
    assert.deepEqual(fixture.nodes, [...fixture.nodes].sort());
    assert.equal(fixture.nodes.length, config.node_count);
    assert.equal(fixture.demand.stationary.length, config.steps);
    // The two regimes share one stream and differ only after the boundary.
    assert.deepEqual(fixture.demand.stationary.slice(0, config.evaluation_start), fixture.demand.shift.slice(0, config.evaluation_start));
  }
});
