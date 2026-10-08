import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode } from "../../harness/episode.ts";
import { readManifest } from "../../harness/manifest.ts";
import { bondingBaselines, rateEstimate } from "./baselines.ts";
import { BondingEnv, gridOptimum, termsOf } from "./env.ts";
import { fixtureBytes, generateFixture, fixturePath } from "./generate.ts";
import { binomialBelow, catchProbability, expectedCost, failProbability, feasible, type Terms } from "./model.ts";
import { bondingFixture, loadBondingConfig } from "./task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const config = loadBondingConfig(root);
const manifest = readManifest(root);

test("the outcome and response distributions", () => {
  // P(Binomial(10, 0.5) < 3) = (1 + 10 + 45) / 1024.
  assert.ok(Math.abs(binomialBelow(10, 0.5, 3) - 56 / 1024) < 1e-12);
  assert.equal(binomialBelow(10, 0.5, 0), 0);
  assert.equal(binomialBelow(10, 0.5, 11), 1);
  // A disprove lands iff R < Δ, R ≥ 1 geometric: P = 1 − (1 − p)^(Δ − 1).
  assert.ok(Math.abs(catchProbability(0.5, 3) - 0.75) < 1e-12);
  assert.equal(catchProbability(0.5, 1), 0);
});

test("the escrow-driven expected cost equals its closed form", () => {
  const t: Terms = { service: { window_blocks: 100, requests: 50, p_honored: 0.9, threshold: 0.95, value_at_risk_sats: 1_000_000 }, fee_rate_sat_vb: 3, capital_rate_per_block: 1e-6, min_delta_blocks: 6, catch_probability: 0.9 };
  const B = 1_250_000, D = 12, p = 0.4, W = 100, r = 1e-6;
  const c = expectedCost(t, B, D, p);
  const pf = failProbability(t.service);
  let caughtBlocks = 0, pc = 0;
  for (let R = 1; R < D; R++) { const w = (1 - p) ** (R - 1) * p; caughtBlocks += w * (W + R); pc += w; }
  const capital = (1 - pf) * B * (W + D) * r + pf * (B * caughtBlocks * r + (1 - pc) * B * (W + D) * r);
  assert.equal(c.assert_fee_sats, 2400 * 3);
  assert.ok(Math.abs(c.capital_sats - capital) < 1e-6);
  assert.ok(Math.abs(c.slashed_sats - pf * pc * B) < 1e-6);
  assert.ok(Math.abs(pc - catchProbability(p, D)) < 1e-12);
});

test("admission: the bond covers the value at risk and Δ meets the catch probability under the true rate", () => {
  const f = bondingFixture(root, manifest, "slow", 0);
  const t = termsOf(f);
  const opt = gridOptimum(f, config.infeasible_penalty_factor);
  assert.ok(feasible(t, opt.bond, opt.delta, f.true_response_p));
  assert.ok(opt.bond >= f.service.value_at_risk_sats);
  assert.ok(!feasible(t, f.grid.bonds[0]!, opt.delta, f.true_response_p), "half the value at risk is not admitted");
  assert.ok(opt.penalty > opt.cost);
});

test("the environment shows a sample of response times and never the rate; offers off the grid are rejected", () => {
  const f = bondingFixture(root, manifest, "fast", 1);
  const env = new BondingEnv(f, config);
  const view = JSON.stringify(env.view());
  assert.ok(!view.includes("true_response_p"));
  assert.ok(!view.includes(String(f.true_response_p)));
  assert.equal(env.step({ tool: "bond", args: { bond_sats: f.grid.bonds[2]! + 1, delta_blocks: 12 } }).reason, "out_of_grid");
  assert.equal(env.step({ tool: "bond", args: { bond_sats: f.grid.bonds[2], delta_blocks: 3 } }).reason, "below_minimum");
  assert.equal(env.budget().attempts, config.budget.attempts - 2);
  assert.equal(env.step({ tool: "bond", args: { bond_sats: f.grid.bonds[2], delta_blocks: 12 } }).accepted, true);
  assert.equal(env.done(), true);
});

test("baselines on development seeds: the oracle bounds all, Spiral's bond rule under-bonds, the plug-in estimates the rate", async () => {
  for (const cell of Object.keys(config.cells).sort()) {
    const f = bondingFixture(root, manifest, cell, 3);
    const rows = new Map<string, { value: number; admitted: number; ratio: number }>();
    for (const a of bondingBaselines()) {
      const row = await runEpisode(new BondingEnv(f, config), a);
      rows.set(a.id, { value: row.value, admitted: row.metrics.admitted!, ratio: row.metrics.bond_over_value! });
    }
    for (const [id, r] of rows) assert.ok(r.value <= rows.get("oracle")!.value + 1e-9, `${cell}: ${id} above the oracle`);
    assert.equal(rows.get("ghost_required_bond")!.admitted, 0);
    assert.ok(rows.get("ghost_required_bond")!.ratio < 1);
    assert.ok(rows.get("plug_in")!.ratio >= 1);
  }
  assert.equal(rateEstimate([1, 2, 3, 2]), 0.5);
});

test("fixtures regenerate byte for byte", () => {
  for (const cell of Object.keys(config.cells).sort()) for (const seed of [0, 1, 1000]) {
    assert.equal(fixtureBytes(generateFixture(seed, cell, config.cells[cell]!, config)), readFileSync(join(root, fixturePath(cell, seed)), "utf8"), `${cell} seed ${seed}`);
  }
});
