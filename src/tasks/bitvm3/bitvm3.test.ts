import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent } from "../../harness/agent.ts";
import { runEpisode } from "../../harness/episode.ts";
import type { Json } from "../../harness/json.ts";
import { stream } from "../../harness/prng.ts";
import { LARGEST_FIRST, Oracle, Watcher, bitvm3Baselines, fraudProbability } from "./baselines.ts";
import { Bitvm3Env, type Bitvm3View } from "./env.ts";
import { finalHeight, generateFixture, type Bitvm3Config, type Bitvm3Fixture, type ClaimClass } from "./generate.ts";
import { bitvm3Prompt } from "./prompt.ts";
import { ceilingOf, feeAt, isFraud, replacedHeights, startGain } from "./world.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const config = JSON.parse(readFileSync(join(root, "config/bitvm3.json"), "utf8")) as Bitvm3Config;
const CELLS = Object.keys(config.cells).sort();
const fixture = (cell: string, seed: number): Bitvm3Fixture => generateFixture(seed, cell, config.cells[cell]!, config);
const act = (env: Bitvm3Env, tool: string, args: Json = {}) => env.step({ tool, args });
const view = (env: Bitvm3Env): Bitvm3View => env.view() as unknown as Bitvm3View;
const claimView = (env: Bitvm3Env, id: string) => view(env).claims.find((c) => c.id === id);

/** Wait until the given height. */
function waitTo(env: Bitvm3Env, height: number): void {
  const h = view(env).height;
  if (height > h) assert.ok(act(env, "wait", { blocks: height - h }).accepted);
}

/** The first seed in [0, 400) of a cell with a claim of this class that also satisfies `also`. */
function withClass(cls: ClaimClass, cell = "watch", also: (f: Bitvm3Fixture, i: number) => boolean = () => true): { f: Bitvm3Fixture; i: number } {
  for (let seed = 0; seed < 400; seed++) {
    const f = fixture(cell, seed);
    const i = f.claims.findIndex((c, j) => c.class === cls && also(f, j));
    if (i >= 0) return { f, i };
  }
  throw new Error(`no ${cls} claim in 400 seeds`);
}

const roomy = { budget: { attempts: 20, probes: 200 } };

test("fixtures are deterministic, and their claims, reorganizations and spikes follow the config", () => {
  for (const cell of CELLS) {
    for (let seed = 0; seed < 40; seed++) {
      const f = fixture(cell, seed);
      assert.deepEqual(fixture(cell, seed), f);
      assert.equal(f.fees.length, f.horizon_height - f.start_height + 1);
      assert.ok(f.claims.length >= config.bursts[0] * config.burst_size[0] && f.claims.length <= config.bursts[1] * config.burst_size[1]);
      f.claims.forEach((c, i) => {
        assert.equal(c.id, `c${String(i + 1).padStart(2, "0")}`);
        assert.equal(c.k_sats, c.vault_sats - config.vbytes.claim * config.presigned_fee_sat_vb);
        assert.equal(c.final_height, finalHeight(c.first_height, f.reorgs));
        assert.ok(c.first_height > f.start_height && c.first_height <= f.start_height + config.arrival_blocks);
        // Every window closes, and every payout matures, by the horizon, and long before the reclaim.
        assert.ok(c.final_height + f.window_blocks <= f.horizon_height);
        assert.ok(f.horizon_height - f.start_height < f.reclaim_blocks);
      });
      for (let k = 1; k < f.reorgs.length; k++) assert.ok(f.reorgs[k]!.from_height > f.reorgs[k - 1]!.height);
      if (cell !== "reorg") assert.equal(f.reorgs.length, 0);
      if (cell !== "fee_spike") assert.equal(f.spikes.length, 0);
    }
  }
  assert.ok([...Array(40).keys()].some((s) => fixture("reorg", s).reorgs.length > 0));
  assert.ok([...Array(40).keys()].some((s) => fixture("fee_spike", s).spikes.length > 0));
});

test("a rejection is the identity on state and costs one attempt; the host refuses what Bitcoin refuses", () => {
  const { f, i } = withClass("honest");
  const id = f.claims[i]!.id;
  const env = new Bitvm3Env(f, roomy);
  const before = env.snapshot();
  assert.equal(act(env, "sign_everything").reason, "unknown_tool");
  assert.equal(env.step("not an object").reason, "malformed");
  assert.equal(act(env, "check", { claim: 7 }).reason, "malformed");
  assert.equal(act(env, "evaluate", { claim: id }).reason, "unknown_id", "a claim is not visible before it confirms");
  assert.equal(env.snapshot(), before);
  assert.equal(env.budget().attempts, roomy.budget.attempts - 4);
  waitTo(env, f.claims[i]!.first_height);
  assert.equal(act(env, "disprove", { claim: id, fee_rate: 10 }).reason, "no_label");
  assert.ok(act(env, "evaluate", { claim: id }).accepted);
  const other = f.claims.find((c, j) => j !== i && c.first_height === f.claims[i]!.first_height);
  if (other) assert.equal(act(env, "evaluate", { claim: other.id }).reason, "busy");
  assert.equal(act(env, "evaluate", { claim: id }).reason, "duplicate");
  waitTo(env, f.claims[i]!.first_height + f.eval_blocks);
  assert.equal(claimView(env, id)!.evaluation, "accept");
  assert.equal(act(env, "disprove", { claim: id, fee_rate: 10 }).reason, "no_label", "the accept label opens nothing");
  assert.equal(act(env, "wait", { blocks: 0 }).reason, "not_integer");
  assert.equal(act(env, "wait", { blocks: 10_000 }).reason, "over_budget");
});

test("the native check fails only a proof of another statement; the evaluation rejects both fraud classes", () => {
  for (const cls of ["honest", "wrong_statement", "invalid_proof"] as const) {
    const { f, i } = withClass(cls);
    const env = new Bitvm3Env(f, config);
    const id = f.claims[i]!.id;
    waitTo(env, f.claims[i]!.first_height);
    const r = act(env, "check", { claim: id });
    assert.ok(r.accepted);
    assert.equal((r.result as { check: string }).check, cls === "wrong_statement" ? "fail" : "pass");
    assert.ok(act(env, "evaluate", { claim: id }).accepted);
    assert.equal(view(env).evaluator.busy, true);
    waitTo(env, f.claims[i]!.first_height + f.eval_blocks - 1);
    assert.equal(claimView(env, id)!.evaluation, "running");
    waitTo(env, f.claims[i]!.first_height + f.eval_blocks);
    assert.equal(claimView(env, id)!.evaluation, cls === "honest" ? "accept" : "reject");
    assert.equal(view(env).evaluator.busy, false);
  }
  const v = { fraud_prior_ppm: config.classes };
  assert.equal(fraudProbability(v, { check: "fail" }), 1);
  assert.equal(fraudProbability(v, { check: "pass" }), 1 / 3);
  assert.equal(fraudProbability(v, { check: null }), 1 / 2);
});

test("a disprove confirms only inside the window; after it the payout to P' wins, and a replacement must bid more", () => {
  // A vault small enough that the dust cap binds below the grid's top.
  const { f, i } = withClass("invalid_proof", "watch", (g, j) => g.claims[j]!.vault_sats <= 250_000);
  const c = f.claims[i]!;
  const id = c.id;
  const cap = Math.floor((c.k_sats - f.dust_sats) / f.vbytes_disprove);
  assert.ok(cap < f.max_fee_rate);
  // In time: evaluate at once, broadcast at the verdict bidding the dust cap.
  {
    const env = new Bitvm3Env(f, roomy);
    waitTo(env, c.first_height);
    assert.ok(act(env, "evaluate", { claim: id }).accepted);
    waitTo(env, c.first_height + f.eval_blocks);
    assert.equal(act(env, "disprove", { claim: id, fee_rate: cap + 1 }).reason, "over_budget");
    assert.equal(act(env, "disprove", { claim: id, fee_rate: 0 }).reason, "out_of_grid");
    assert.equal(act(env, "disprove", { claim: id, fee_rate: 1.5 }).reason, "not_integer");
    const low = 1;
    assert.ok(act(env, "disprove", { claim: id, fee_rate: low }).accepted);
    assert.equal(act(env, "disprove", { claim: id, fee_rate: low }).reason, "below_minimum");
    const high = cap;
    assert.ok(act(env, "disprove", { claim: id, fee_rate: high }).accepted);
    assert.ok(high >= feeAt(f, c.first_height + f.eval_blocks + 1));
    waitTo(env, c.first_height + f.eval_blocks + 1);
    assert.equal(claimView(env, id)!.status, "disproved");
    assert.equal(act(env, "disprove", { claim: id, fee_rate: high }).reason, "phase_closed");
    assert.ok(act(env, "stop").accepted);
    const o = env.finish();
    assert.equal(o.value, c.k_sats - f.vbytes_disprove * high - f.eval_cost_sats);
    assert.equal(o.metrics.disproved, 1);
  }
  // Too late: a disprove broadcast in the last block of the window cannot confirm before the payout.
  {
    const env = new Bitvm3Env(f, config);
    waitTo(env, c.first_height);
    assert.ok(act(env, "evaluate", { claim: id }).accepted);
    waitTo(env, c.final_height + f.window_blocks - 1);
    assert.ok(act(env, "disprove", { claim: id, fee_rate: cap }).accepted);
    waitTo(env, c.final_height + f.window_blocks);
    assert.equal(claimView(env, id)!.status, "paid_out");
    assert.equal(act(env, "disprove", { claim: id, fee_rate: cap }).reason, "phase_closed");
    assert.ok(act(env, "stop").accepted);
    const o = env.finish();
    assert.equal(o.value, -f.eval_cost_sats);
    assert.equal(o.metrics.fraud_paid, f.claims.filter((x) => x.class !== "honest").length);
  }
});

/** A copy of a fixture with one fraud claim alone, and a reorganization of the given range. */
function lonely(from: number, to: number): Bitvm3Fixture {
  const { f, i } = withClass("invalid_proof", "reorg");
  const c = { ...f.claims[i]!, id: "c01" };
  const reorgs = [{ from_height: c.first_height + from, height: c.first_height + to }];
  return { ...f, claims: [{ ...c, final_height: finalHeight(c.first_height, reorgs) }], reorgs, fees: f.fees.map(() => 5) };
}

test("a reorganization restarts the claim's window, and one that replaces a confirmed disprove can let the payout through", () => {
  // The claim's own block is replaced: it confirms again two blocks later, and its window counts from there.
  {
    const f = lonely(0, 2);
    const c = f.claims[0]!;
    assert.equal(c.final_height, c.first_height + 2);
    const env = new Bitvm3Env(f, config);
    waitTo(env, c.first_height);
    assert.equal(claimView(env, "c01")!.last_disprove_height, c.first_height + f.window_blocks - 1);
    waitTo(env, c.first_height + 2);
    const v = claimView(env, "c01")!;
    assert.equal(v.confirmed_height, c.first_height + 2);
    assert.equal(v.reorged, true);
    assert.equal(v.last_disprove_height, c.final_height + f.window_blocks - 1);
    // Started after the first window's last useful start, the evaluation still makes the restarted one.
    assert.ok(act(env, "evaluate", { claim: "c01" }).accepted);
    waitTo(env, c.first_height + 2 + f.eval_blocks);
    assert.ok(act(env, "disprove", { claim: "c01", fee_rate: 10 }).accepted);
    assert.ok(act(env, "stop").accepted);
    assert.equal(env.finish().metrics.disproved, 1);
    assert.equal(ceilingOf(f).value, c.k_sats - f.vbytes_disprove * 5 - f.eval_cost_sats);
  }
  // A disprove confirmed at c + 4 is replaced with blocks c + 4 and c + 5: back in the mempool, the
  // payout at c + 6 takes the output.
  {
    const f = lonely(4, 6);
    const c = f.claims[0]!;
    assert.equal(c.final_height, c.first_height);
    const env = new Bitvm3Env(f, config);
    waitTo(env, c.first_height);
    assert.ok(act(env, "evaluate", { claim: "c01" }).accepted);
    waitTo(env, c.first_height + f.eval_blocks);
    assert.ok(act(env, "disprove", { claim: "c01", fee_rate: 10 }).accepted);
    waitTo(env, c.first_height + 4);
    assert.equal(claimView(env, "c01")!.status, "disproved");
    waitTo(env, c.first_height + 6);
    const v = claimView(env, "c01")!;
    assert.equal(v.status, "paid_out");
    assert.equal(v.disprove!.confirmed_height, null);
    assert.ok(act(env, "stop").accepted);
    assert.equal(env.finish().metrics.fraud_paid, 1);
    // The ceiling knows the replaced blocks: there is nothing to gain.
    assert.deepEqual([...replacedHeights(f)], [c.first_height + 4, c.first_height + 5]);
    assert.equal(ceilingOf(f).value, 0);
  }
});

/** The same recurrence without the memo or the live-set keying: an independent check of the ceiling. */
function bruteCeiling(f: Bitvm3Fixture): number {
  const replaced = replacedHeights(f);
  const fraud = f.claims.map((_, i) => i).filter((i) => isFraud(f, i));
  const go = (t: number, done: Set<number>): number => {
    if (t > f.horizon_height) return 0;
    let best = go(t + 1, done);
    for (const i of fraud) {
      if (done.has(i)) continue;
      const g = startGain(f, i, t, replaced);
      if (g) best = Math.max(best, g.gain + go(t + f.eval_blocks, new Set([...done, i])));
    }
    return best;
  };
  return go(f.start_height, new Set());
}

test("the ceiling equals the unmemoized recurrence on small instances", () => {
  let compared = 0;
  for (const cell of CELLS) {
    for (let seed = 0; seed < 200 && compared < 60; seed++) {
      const f = fixture(cell, seed);
      if (f.claims.filter((c) => c.class !== "honest").length > 5) continue;
      assert.equal(ceilingOf(f).value, bruteCeiling(f), `${cell} ${seed}`);
      compared += 1;
    }
  }
  assert.ok(compared >= 30);
});

/** A watcher that picks a random admissible-looking action each turn, from its own stream. */
class RandomWatcher implements Agent {
  readonly id = "random";
  private rng = stream("bitvm3-test", "random", 0);
  reset(e?: { seed: number; task: string }): void { this.rng = stream("bitvm3-test", "random", e?.task ?? "", e?.seed ?? 0); }
  act(observation: Json): Json {
    const v = (observation as unknown as { view: Bitvm3View }).view;
    const open = v.claims.filter((c) => c.status === "open");
    const x = this.rng.int(10);
    if (open.length > 0 && x < 2) return { tool: "check", args: { claim: this.rng.pick(open).id } };
    if (open.length > 0 && x < 5) return { tool: "evaluate", args: { claim: this.rng.pick(open).id } };
    const held = open.filter((c) => c.evaluation === "reject");
    if (held.length > 0 && x < 8) return { tool: "disprove", args: { claim: this.rng.pick(held).id, fee_rate: 1 + this.rng.int(80) } };
    return { tool: "wait", args: { blocks: 1 + this.rng.int(2) } };
  }
}

test("idle earns 0; the oracle earns exactly the ceiling; no baseline and no random watcher beats it", async () => {
  for (const cell of CELLS) {
    for (let seed = 0; seed < 24; seed++) {
      const f = fixture(cell, seed);
      const ceiling = ceilingOf(f).value;
      const values = new Map<string, number>();
      for (const agent of [...bitvm3Baselines(), new RandomWatcher()]) values.set(agent.id, (await runEpisode(new Bitvm3Env(f, config), agent)).value);
      assert.equal(values.get("idle"), 0, `${cell} ${seed}`);
      assert.equal(values.get("oracle"), ceiling, `${cell} ${seed}`);
      for (const [id, v] of values) assert.ok(v <= ceiling, `${id} beat the oracle on ${cell} ${seed}`);
    }
  }
});

test("on a smoke run the reference stays below the ceiling, and above the other baselines that see no hidden state", async () => {
  for (const cell of CELLS) {
    const sum = new Map<string, number>();
    for (let seed = 0; seed < 40; seed++) {
      const f = fixture(cell, seed);
      for (const agent of bitvm3Baselines()) sum.set(agent.id, (sum.get(agent.id) ?? 0) + (await runEpisode(new Bitvm3Env(f, config), agent)).value);
    }
    const gain = (id: string): number => sum.get(id)! / sum.get("oracle")!;
    assert.ok(gain("largest_first") < 0.95, `${cell}: largest_first at ${gain("largest_first")} of the ceiling`);
    assert.ok(gain("largest_first") > gain("cheap_only") && gain("largest_first") > gain("evaluate_all"), cell);
  }
});

test("episodes are deterministic", async () => {
  const f = fixture("reorg", 5);
  const a = new Bitvm3Env(f, config);
  const b = new Bitvm3Env(f, config);
  const ra = await runEpisode(a, new Watcher("largest_first", LARGEST_FIRST));
  const rb = await runEpisode(b, new Watcher("largest_first", LARGEST_FIRST));
  assert.deepEqual(ra, rb);
  assert.equal(a.snapshot(), b.snapshot());
  const o = new Oracle();
  assert.deepEqual(await runEpisode(new Bitvm3Env(f, config), o), await runEpisode(new Bitvm3Env(f, config), o));
});

test("the prompt renders the mechanics and each turn's claims", () => {
  const f = fixture("watch", 0);
  const env = new Bitvm3Env(f, config);
  waitTo(env, f.claims[0]!.first_height);
  const o = { bench: "x", task: env.task, episode: { seed: 0, cell: env.cell, turn: 0 }, budget: { ...env.budget() }, tools: env.tools(), view: env.view(), last: null } as unknown as Json;
  const p = bitvm3Prompt(256);
  assert.match(p.system(o), /BitVM3/);
  assert.match(p.system(o), /takes 3 blocks and costs 2000 sats/);
  assert.match(p.system(o), /50% are honest, 25% hand over a valid proof of another statement, and 25%/);
  assert.match(p.turn(o), /"id":"c01"/);
});
