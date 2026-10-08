import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode } from "../../harness/episode.ts";
import { readManifest } from "../../harness/manifest.ts";
import { loadPlacementConfig, placementFixture } from "../placement/task.ts";
import { OneShot, RetryWallet, routingBaselines } from "./baselines.ts";
import { RoutingEnv, deliveryHash, publicOrder, type RoutingView } from "./env.ts";
import { diffuseStream, fixtureBytes, fixturePath, generateFixture } from "./generate.ts";
import { directRetry } from "./report.ts";
import { demandsFor, routingFixture } from "./task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifest = readManifest(root);
const config = loadPlacementConfig(root);

test("the diffuse stream is family 1's stream with every hotspot draw replaced by its uniform pair", () => {
  for (const seed of [0, 3, 7]) {
    const p = placementFixture(root, manifest, seed);
    const diffuse = diffuseStream(p, config);
    assert.equal(diffuse.length, config.steps);
    const hot = new Set([p.hotspots.first.join(">"), [...p.hotspots.first].reverse().join(">")]);
    p.demand.stationary.forEach((d, i) => {
      if (!hot.has(`${d[0]}>${d[1]}`)) assert.deepEqual(diffuse[i], d, `seed ${seed} step ${i}: a uniform step must be shared`);
      assert.notEqual(diffuse[i]![0], diffuse[i]![1]);
    });
  }
});

test("fixtures regenerate byte for byte and name their family 1 fixture by the manifest's hash", () => {
  for (const seed of [0, 1, 1000]) {
    const entry = manifest.fixtures.find((f) => f.path === `fixtures/placement/seed-${String(seed).padStart(4, "0")}.json`)!;
    const text = fixtureBytes(generateFixture(placementFixture(root, manifest, seed), entry.path, entry.sha256, config));
    assert.equal(text, readFileSync(join(root, fixturePath(seed)), "utf8"));
    assert.equal(routingFixture(root, manifest, seed).placement.sha256, entry.sha256);
  }
});

test("the environment: terminal feedback, three attempts a demand, rejections spend an attempt and move nothing", () => {
  const p = placementFixture(root, manifest, 0);
  const env = new RoutingEnv(p, demandsFor(root, manifest, 0, "stationary"), "polarized", "stationary", config);
  const v = env.view() as unknown as RoutingView;
  assert.equal(v.attempts_left, 3);
  assert.ok(v.candidates.length > 0 && v.candidates.length <= config.candidate_path_limit);
  assert.ok(!JSON.stringify(v).includes("capacity") && !JSON.stringify(v).includes("balance"), "no hidden state in the view");
  const before = env.snapshot();
  assert.equal(env.step({ tool: "attempt", args: { candidate: 99 } }).reason, "out_of_grid");
  assert.equal(env.step({ tool: "attempt", args: { candidate: 0.5 } }).reason, "not_integer");
  // Two rejections used two of the demand's three attempts; the network did not move.
  assert.equal((env.view() as unknown as RoutingView).attempts_left, 1);
  assert.equal(JSON.parse(env.snapshot()).net, JSON.parse(before).net);
  env.step({ tool: "skip" });
  assert.equal((env.view() as unknown as RoutingView).demand.i, 1, "skip moves to the next demand");
  const r = env.step({ tool: "attempt", args: { candidate: publicOrder((env.view() as unknown as RoutingView).candidates)[0]!.index } });
  assert.equal(r.accepted, true);
  assert.ok(typeof (r.result as { delivered: boolean }).delivered === "boolean");
  assert.ok(!("edge" in (r.result as object)), "feedback is terminal: no failing edge");
});

test("identity: the retry wallet through act and the prefix oracle deliver what family 1's router delivers, demand by demand", async () => {
  for (const [model, regime] of [["uniform", "diffuse"], ["polarized", "shift"], ["balanced_band", "stationary"]] as const) {
    const p = placementFixture(root, manifest, 2);
    const direct = directRetry(root, manifest, config, model, regime, 2);
    const baselines = routingBaselines((seed) => placementFixture(root, manifest, seed));
    const rows = new Map<string, { value: number; hash: number; failed: number }>();
    for (const agent of baselines) {
      const row = await runEpisode(new RoutingEnv(p, demandsFor(root, manifest, 2, regime), model, regime, config), agent);
      rows.set(agent.id, { value: row.value, hash: row.metrics.delivery_hash!, failed: row.metrics.failed_attempts! });
    }
    assert.equal(rows.get("retry_wallet")!.hash, deliveryHash(direct.deliveries));
    assert.equal(rows.get("retry_wallet")!.value, direct.value);
    assert.equal(rows.get("prefix_oracle_3")!.hash, rows.get("retry_wallet")!.hash);
    assert.equal(rows.get("hidden_state_oracle")!.failed, 0, "the oracle never tries an infeasible path");
    assert.equal(rows.get("prefix_oracle_3")!.failed, 0);
  }
});

test("the two scripted policies follow public-fee order and stop where they should", async () => {
  const p = placementFixture(root, manifest, 1);
  const env = new RoutingEnv(p, demandsFor(root, manifest, 1, "diffuse"), "uniform", "diffuse", config);
  const seen: number[] = [];
  const retry = new RetryWallet();
  const one = new OneShot();
  const obs = (v: RoutingView) => ({ view: v } as never);
  // Walk to a demand with at least two candidates; a single-candidate demand is skipped after one try.
  while ((env.view() as unknown as RoutingView).candidates.length < 2) env.step({ tool: "skip" });
  const v = env.view() as unknown as RoutingView;
  const order = publicOrder(v.candidates).map((c) => c.index);
  seen.push((retry.act(obs(v)) as { args: { candidate: number } }).args.candidate);
  assert.equal(seen[0], order[0]);
  const afterOne = { ...v, tried: [{ candidate: order[0]!, delivered: false }] };
  assert.equal((retry.act(obs(afterOne)) as { args: { candidate: number } }).args.candidate, order[1]);
  assert.deepEqual(one.act(obs(afterOne)), { tool: "skip" });
});
