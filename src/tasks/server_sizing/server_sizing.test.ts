import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode, type EpisodeRow } from "../../harness/episode.ts";
import { fileSha256, readManifest } from "../../harness/manifest.ts";
import { stream } from "../../harness/prng.ts";
import { SEED_BLOCKS } from "../../harness/seeds.ts";
import type { RunRecord } from "../../harness/run.ts";
import type { Json } from "../../harness/json.ts";
import type { DemandStream, Step } from "../settlement_object/generate.ts";
import { serverEnvelope, serverTierCapacity } from "../settlement_object/corner.ts";
import { BufferRule, Oracle, RandomSizing, StaticPilot, serverSizingBaselines } from "./baselines.ts";
import { ServerSizingEnv, type SizingInput, type SizingView } from "./env.ts";
import { intervalSummaries, optimalSchedule, positionPath, requiredLevels, type SizingParams } from "./plan.ts";
import { serverSizingAgentContrasts, serverSizingContrasts, serverSizingGates, serverSizingIdentityCheck, serverSizingTaskSpecs } from "./report.ts";
import { loadServerSizingConfig, sizingInput } from "./task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const config = loadServerSizingConfig(root);
const manifest = readManifest(root);
const margins = { static_margin: config.static_margin, buffer_margin: config.buffer_margin };
const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)), `${a} != ${b}`);

/**
 * Independent event simulator for a schedule of one target per decision: no environment, path,
 * timing, or cost helper of the family is used. The rules: a target below the position at its
 * decision is rejected, so the schedule is not playable and the result is null; the fee is paid at
 * the decision for a target different from the capacity in force; the resize lands at step 0 for
 * the first decision and one delay after the decision for the rest, as the larger of the target and
 * the position then; the lease is paid on the increase put in force.
 */
function simulate(demand: DemandStream, targets: number[], p: SizingParams): Record<string, number> | null {
  const series = [...demand.values()];
  const steps = series[0]!.length;
  const interval = p.decision_interval_blocks / p.round_interval_blocks;
  const delay = p.resize_delay_blocks / p.round_interval_blocks;
  const balance = series.map(() => 0);
  let pos = 0, cap = 0, failed = 0, failedValue = 0, capital = 0, fees = 0, leases = 0, capacitySum = 0, resizes = 0;
  let pending: { target: number; at: number } | null = null;
  caps.length = 0;
  for (let t = 0; t < steps; t++) {
    if (t % interval === 0) {
      const target = targets[t / interval]!;
      if (target < pos) return null;
      if (target !== cap) { fees += p.resize_fee_sats; resizes++; pending = { target, at: t === 0 ? 0 : t + delay }; }
    }
    if (pending && pending.at <= t) {
      const landed = Math.max(pending.target, pos);
      leases += Math.max(0, landed - cap) * p.lease_rate_ppm / 1e6;
      cap = landed;
      pending = null;
    }
    caps.push(cap);
    capacitySum += cap;
    capital += cap * p.capital_rate_per_block * p.round_interval_blocks;
    for (let a = 0; a < series.length; a++) {
      const { in: receipt, out: spend } = series[a]![t]!;
      if (receipt) {
        if (pos + receipt > cap) { failed++; failedValue += receipt; }
        else { pos += receipt; balance[a]! += receipt; }
      }
      if (spend && balance[a]! >= spend) { pos -= spend; balance[a]! -= spend; }
    }
  }
  const failure = failed * p.failure_fixed_sats + failedValue * p.failure_value_share;
  const resize = fees + leases;
  return { cost_sats: capital + resize + failure, capital_sats: capital, resize_sats: resize,
    failure_sats: failure, failures: failed, failed_sats: failedValue, resizes, mean_capacity: capacitySum / steps };
}
/** The capacity in force at each step of the latest simulate call. */
const caps: number[] = [];
/** simulate for a schedule that must be playable. */
function direct(demand: DemandStream, targets: number[], p: SizingParams): Record<string, number> {
  const result = simulate(demand, targets, p);
  assert.ok(result !== null, `the schedule ${targets} is rejected: a target is below the position`);
  return result;
}

/** Position of the delivered path, written apart from plan.ts: per step the start, the highest point, and the end. */
function trace(demand: DemandStream): { start: number[]; max: number[]; end: number[] } {
  const series = [...demand.values()];
  const out = { start: [] as number[], max: [] as number[], end: [] as number[] };
  let pos = 0;
  for (let t = 0; t < series[0]!.length; t++) {
    out.start.push(pos);
    let hi = pos;
    for (const s of series) { pos += s[t]!.in; hi = Math.max(hi, pos); pos -= s[t]!.out; }
    out.max.push(hi);
    out.end.push(pos);
  }
  return out;
}

const zeros = (n: number): Step[] => Array.from({ length: n }, () => ({ in: 0, out: 0 }));
const priced = (over: Partial<SizingParams> = {}): SizingParams => ({
  round_interval_blocks: 1, decision_interval_blocks: 2, resize_delay_blocks: 1, capital_rate_per_block: 0.01,
  resize_fee_sats: 2, lease_rate_ppm: 1000, failure_fixed_sats: 3, failure_value_share: 0.5, ...over,
});
const inputOf = (demand: DemandStream, params: SizingParams, over: Partial<SizingInput> = {}): SizingInput =>
  ({ seed: 0, cell: "hand", evaluation: demand, pilot: demand, params, attempts: 32, max_inbound_pilot_multiple: 4, ...over });

/** Holders in a non-sorted insertion order, with spends funded as in family 3's streams. */
function randomDemand(rng: ReturnType<typeof stream>, agents: number, steps: number): DemandStream {
  const demand: DemandStream = new Map();
  for (let a = 0; a < agents; a++) {
    let balance = 0;
    demand.set(`agent-${agents - a}`, Array.from({ length: steps }, () => {
      const receipt = rng.next() < 0.4 ? 1 + (rng.next() < 0.25 ? 1 : 0) : 0;
      balance += receipt;
      const spend = balance > 0 && rng.next() < 0.65 ? Math.min(balance, 1 + (rng.next() < 0.25 ? 1 : 0)) : 0;
      balance -= spend;
      return { in: receipt, out: spend };
    }));
  }
  return demand;
}

/**
 * A small random instance: 2 to 4 holders in a non-sorted insertion order, 3 or 4 decisions, short
 * intervals, rounds of 1 to 3 blocks, a delay of 0 or 1 round, and random prices. Spends are funded
 * as in family 3's streams. `tight` prices failures exactly at the config's two inequalities
 * (failure_fixed = resize_fee, failure_value_share = capital_rate x horizon + lease); `loose`
 * prices them above.
 */
function synthetic(seed: number, regime: "tight" | "loose" = "loose"): SizingInput {
  const rng = stream("server-sizing-test", seed);
  const agents = 2 + rng.int(3), decisions = 3 + rng.int(2), interval = 2 + rng.int(2), round = 1 + (seed % 3), delay = seed % 2;
  const demand = randomDemand(rng, agents, decisions * interval);
  const rate = 0.0005 + rng.next() * 0.002;
  const fee = rng.next() * 0.03;
  const blocks = decisions * interval * round;
  const margin = regime === "tight" ? 0 : 1;
  return inputOf(demand, {
    round_interval_blocks: round, decision_interval_blocks: interval * round, resize_delay_blocks: delay * round,
    capital_rate_per_block: rate, resize_fee_sats: fee, lease_rate_ppm: 1000,
    failure_fixed_sats: fee + 0.01 * margin,
    failure_value_share: rate * blocks + 1000 / 1e6 + 0.1 * margin,
  }, { seed, cell: "synthetic" });
}

function enumerate(options: number[], count: number, visit: (levels: number[]) => void): void {
  const levels: number[] = [];
  const go = (): void => {
    if (levels.length === count) { visit(levels); return; }
    for (const level of options) { levels.push(level); go(); levels.pop(); }
  };
  go();
}

test("DP equals the minimum over exhaustive never-failing candidate schedules, and no schedule on a fine grid, failing ones included, beats it (30 small streams, two price regimes)", () => {
  let failing = 0, checked = 0, refused = 0, holds = 0, moves = 0;
  for (const regime of ["tight", "loose"] as const) {
    for (let trial = 0; trial < 30; trial++) {
      const input = synthetic(trial, regime);
      const path = positionPath(input.evaluation);
      assert.equal(path.peak, serverEnvelope(input.evaluation).peak);
      const plan = optimalSchedule(path, input.params);
      const count = plan.q.length;
      assert.ok(count === 3 || count === 4);
      // The exhaustive enumeration over the candidate set.
      let best = Infinity;
      enumerate(plan.candidates, count, (levels) => {
        if (levels.some((level, k) => level < plan.q[k]!)) return;
        const result = direct(input.evaluation, levels, input.params);
        assert.equal(result.failures, 0, `${regime} ${trial}: a level at or above q fails a payment`);
        best = Math.min(best, result.cost_sats!);
      });
      close(plan.cost_sats, best);
      const played = direct(input.evaluation, plan.levels, input.params);
      assert.equal(played.failures, 0);
      close(plan.cost_sats, played.cost_sats!);
      plan.levels.forEach((level, k) => { if (k > 0) { if (level === plan.levels[k - 1]) holds++; else moves++; } });
      // Every whole-sat schedule from zero through one sat beyond the realized peak that the server
      // may play (no target below the position at its decision), failures simulated.
      const grid = Array.from({ length: path.peak + 2 }, (_, i) => i);
      let cheapestNeverFailing = Infinity;
      enumerate(grid, count, (levels) => {
        const result = simulate(input.evaluation, levels, input.params);
        if (result === null) { refused++; return; }
        checked++;
        if (result.failures! > 0) failing++; else cheapestNeverFailing = Math.min(cheapestNeverFailing, result.cost_sats!);
        assert.ok(result.cost_sats! + 1e-9 >= plan.cost_sats, `${regime} trial ${trial}: ${levels} beats the DP (${result.cost_sats} < ${plan.cost_sats})`);
      });
      close(cheapestNeverFailing, plan.cost_sats);
    }
  }
  assert.ok(failing > 1000 && checked > 5000, `the grid includes many failing schedules (${failing} of ${checked})`);
  assert.ok(refused > 1000, "and many schedules the server may not play");
  assert.ok(holds > 10 && moves > 10, `the plans both hold and resize (${holds} holds, ${moves} resizes)`);
});

test("q_k is the least target for level k that the server may play, that fails nothing, and that is the capacity in force over the level's steps", () => {
  for (let trial = 0; trial < 30; trial++) {
    const input = synthetic(trial);
    const path = positionPath(input.evaluation);
    const { q } = requiredLevels(path, input.params);
    const big = path.peak + 5;
    const interval = input.params.decision_interval_blocks / input.params.round_interval_blocks;
    const delay = input.params.resize_delay_blocks / input.params.round_interval_blocks;
    const steps = path.end.length;
    for (let k = 0; k < q.length; k++) {
      const first = k === 0 ? 0 : k * interval + delay, last = Math.min(steps, (k + 1) * interval + delay);
      /** Whether target c for level k can be played, fails nothing, and is the capacity over the level's steps. */
      const works = (c: number): boolean => {
        const result = simulate(input.evaluation, q.map((_, j) => (j === k ? c : big)), input.params);
        return result !== null && result.failures === 0 && caps.slice(first, last).every((x) => x === c);
      };
      assert.ok(works(q[k]!), `trial ${trial} level ${k}: q does not work`);
      if (q[k]! > 0) assert.ok(!works(q[k]! - 1), `trial ${trial} level ${k}: one sat below q works`);
    }
  }
});

test("floors: the position at the decision and at the step a level lands bound it from below, receipts bound it within, and the plan follows", () => {
  // One holder gets 10 at step 0 and spends 6 at step 4; another gets 1 at step 5. Decisions at steps 0, 2, 4, 6, no delay.
  const demand: DemandStream = new Map([
    ["a", [{ in: 10, out: 0 }, ...zeros(3), { in: 0, out: 6 }, { in: 0, out: 0 }, ...zeros(2)]],
    ["b", [...zeros(5), { in: 1, out: 0 }, ...zeros(2)]],
  ]);
  const p = priced({ resize_delay_blocks: 0, resize_fee_sats: 0.001, capital_rate_per_block: 0.05 });
  const path = positionPath(demand);
  const required = requiredLevels(path, p);
  assert.deepEqual(required.receipts, [10, 0, 5, 0]);
  assert.deepEqual(required.floors, [0, 10, 10, 5], "the server holds 10 at steps 2 and 4, and 5 at step 6");
  assert.deepEqual(required.q, [10, 10, 10, 5]);
  assert.equal(path.max[4], 10, "the summary maximum of step 4 includes the position it starts with");
  assert.equal(path.recv[4], 0);
  assert.equal(simulate(demand, [10, 0, 5, 0], p), null, "a target below the position is not playable");
  const plan = optimalSchedule(path, p);
  assert.deepEqual(plan.levels, [10, 10, 10, 5]);
  close(plan.cost_sats, direct(demand, plan.levels, p).cost_sats!);
  assert.ok(plan.cost_sats < direct(demand, [10, 10, 10, 10], p).cost_sats!);
  // A delay moves the landing, so the floor is the position one step after the decision.
  const delayed = requiredLevels(path, priced({ resize_delay_blocks: 1 }));
  assert.deepEqual(delayed.floors, [0, 10, 10, 5]);
});

test("a level that lands after the decision step raised the position is lifted to it, so its floor is the position at landing, and the oracle plays it without a lift", async () => {
  // a gets 10 at step 0 and 6 at step 2 (the step of decision 1, so the resize lands at step 3 with the position at 16), then spends all 16 at step 3.
  const demand: DemandStream = new Map([["a", [{ in: 10, out: 0 }, { in: 0, out: 0 }, { in: 6, out: 0 }, { in: 0, out: 16 }, ...zeros(4)]]]);
  const p = priced({ resize_fee_sats: 0.001, capital_rate_per_block: 0.05 });
  const path = positionPath(demand);
  const required = requiredLevels(path, p);
  assert.deepEqual(required.floors, [0, 16, 0, 0], "position 10 at the decision, 16 at the landing, 0 at the later ones");
  assert.deepEqual(required.q, [16, 16, 0, 0]);
  // Ordering 10 at decision 1 is allowed (the position is 10), but it lands as 16.
  const played = simulate(demand, [16, 10, 0, 0], p);
  assert.ok(played !== null);
  assert.deepEqual(caps.slice(0, 5), [16, 16, 16, 16, 16], "lifted at step 3 from the ordered 10 to the 16 held");
  const plan = optimalSchedule(path, p);
  assert.deepEqual(plan.levels, [16, 16, 0, 0]);
  const x = inputOf(demand, p);
  const row = await runEpisode(new ServerSizingEnv(x), new Oracle());
  assert.equal(row.rejections.length, 0);
  close(row.metrics.cost_sats!, plan.cost_sats);
  close(row.metrics.cost_sats!, direct(demand, plan.levels, p).cost_sats!);
});

test("the sparse stream that beat the DP before the position floor: under the rule the failing schedules are refused or lose", () => {
  // One holder gets 100 at step 0 and keeps it; another gets 1 at step 5. Without a floor, cutting to 0 after step 1 and failing
  // that one receipt was cheaper than holding 101. With it the server cannot cut below the 100 it holds.
  const demand: DemandStream = new Map([
    ["a", [{ in: 100, out: 0 }, ...zeros(7)]],
    ["b", [...zeros(5), { in: 1, out: 0 }, ...zeros(2)]],
  ]);
  for (const margin of [0, 1]) {
    const p = priced({ resize_delay_blocks: 0, resize_fee_sats: 1, failure_fixed_sats: 1 + margin, failure_value_share: 0.01 * 8 + 0.001 + 0.05 * margin });
    assert.ok(p.failure_fixed_sats >= p.resize_fee_sats && p.failure_value_share >= p.capital_rate_per_block * 8 + p.lease_rate_ppm / 1e6);
    const plan = optimalSchedule(positionPath(demand), p);
    assert.deepEqual(plan.q, [100, 100, 101, 101]);
    assert.deepEqual(plan.levels, [101, 101, 101, 101]);
    assert.equal(simulate(demand, [100, 0, 0, 0], p), null, "the old counterexample is refused");
    const failing = direct(demand, [100, 100, 100, 100], p);
    assert.equal(failing.failures, 1);
    assert.ok(failing.cost_sats! > plan.cost_sats, `${failing.cost_sats} vs ${plan.cost_sats}`);
    // Every schedule from a coarse grid that the server may play.
    let played = 0;
    enumerate([0, 50, 99, 100, 101, 102], 4, (levels) => {
      const result = simulate(demand, levels, p);
      if (result === null) return;
      played++;
      assert.ok(result.cost_sats! + 1e-9 >= plan.cost_sats, `${levels} beats the DP`);
    });
    assert.ok(played > 100);
  }
});

let refusals = 0;
test("environment accounting equals independent simulation; rejections change only attempts", () => {
  const rng = stream("server-sizing-accounting");
  for (let trial = 0; trial < 30; trial++) {
    const input = synthetic(trial);
    const env = new ServerSizingEnv(input);
    const before = env.snapshot();
    const cap = 4 * positionPath(input.pilot).peak;
    const bad: Array<[unknown, string]> = [
      [null, "malformed"], ["resize", "malformed"], [{ tool: 7 }, "malformed"], [{ tool: "unknown" }, "unknown_tool"], [{ tool: "resize" }, "malformed"],
      [{ tool: "resize", args: {} }, "malformed"], [{ tool: "resize", args: { inbound_sats: "1" } }, "malformed"],
      [{ tool: "resize", args: { inbound_sats: 0.5 } }, "not_integer"], [{ tool: "resize", args: { inbound_sats: -1 } }, "below_minimum"],
      [{ tool: "resize", args: { inbound_sats: -1.5 } }, "not_integer"],
      [{ tool: "resize", args: { inbound_sats: cap + 1 } }, "over_budget"], [{ tool: "resize", args: { inbound_sats: 1e300 } }, "over_budget"],
    ];
    for (const [action, reason] of bad) {
      const attempts = env.budget().attempts;
      assert.equal(env.step(action).reason, reason);
      assert.equal(env.snapshot(), before);
      assert.equal(env.budget().attempts, attempts - 1);
      assert.equal(env.done(), false);
    }
    assert.equal(env.step({ tool: "resize", args: { inbound_sats: cap } }).accepted, true, "the cap itself is allowed");
    const levels: number[] = [cap];
    let refusedBelow = 0;
    while (!env.done()) {
      const v = env.view() as unknown as SizingView;
      if (v.position > 0) {
        // A target below the position is refused, costs an attempt, and changes nothing else.
        const held = env.snapshot(), attempts = env.budget().attempts;
        const refused = env.step({ tool: "resize", args: { inbound_sats: v.position - 1 } });
        assert.equal(refused.reason, "below_position");
        assert.equal(env.snapshot(), held);
        assert.equal(env.budget().attempts, attempts - 1);
        refusedBelow++;
      }
      const level = v.position + rng.int(v.max_inbound_sats - v.position + 1);
      levels.push(level);
      const attempts = env.budget().attempts;
      assert.equal(env.step({ tool: "resize", args: { inbound_sats: level } }).accepted, true);
      assert.equal(env.budget().attempts, attempts, "an accepted action spends no attempt");
    }
    assert.equal(levels.length, Math.ceil(positionPath(input.evaluation).end.length / (input.params.decision_interval_blocks / input.params.round_interval_blocks)));
    const out = env.finish();
    const expected = direct(input.evaluation, levels, input.params);
    for (const [metric, value] of Object.entries(expected)) close(out.metrics[metric]!, value);
    assert.deepEqual(env.finish(), out, "finish is idempotent");
    assert.equal(env.step({ tool: "hold" }).reason, "phase_closed");
    refusals += refusedBelow;
  }
  assert.ok(refusals > 10, "below_position was exercised");
});

test("a resize below the position is rejected as below_position and changes nothing but attempts; at the step it lands the capacity is the larger of the target and the position, and is charged so", () => {
  // a gets 10 at step 0 and 4 at step 2. Decisions at steps 0, 2, 4, 6; a resize lands one step later.
  const demand: DemandStream = new Map([["a", [{ in: 10, out: 0 }, { in: 0, out: 0 }, { in: 4, out: 0 }, ...zeros(5)]]]);
  const p = priced({ resize_fee_sats: 2, lease_rate_ppm: 1000, capital_rate_per_block: 0.01 });
  const env = new ServerSizingEnv(inputOf(demand, p));
  assert.equal(env.step({ tool: "resize", args: { inbound_sats: 20 } }).accepted, true);
  const view = env.view() as unknown as SizingView;
  assert.equal(view.position, 10);
  assert.equal(view.capacity_in_force, 20);
  assert.equal((view as unknown as Record<string, Json>).current_target_sats, undefined);
  const held = env.snapshot(), attempts = env.budget().attempts;
  const refused = env.step({ tool: "resize", args: { inbound_sats: 9 } });
  assert.deepEqual([refused.accepted, refused.reason], [false, "below_position"]);
  assert.equal(env.snapshot(), held);
  assert.equal(env.budget().attempts, attempts - 1);
  // 12 is at or above the position of 10, so it is accepted. Step 2 adds 4 under the old capacity of 20, so the position is 14
  // when the resize lands at step 3: the capacity becomes 14, not 12.
  assert.equal(env.step({ tool: "resize", args: { inbound_sats: 12 } }).accepted, true);
  const later = env.view() as unknown as SizingView;
  assert.equal(later.position, 14);
  assert.equal(later.capacity_in_force, 14, "max(12, 14)");
  assert.equal(later.pending_resize, null);
  while (!env.done()) env.step({ tool: "hold" });
  const m = env.finish().metrics;
  // Fees for two resizes, the lease on the 20 put in force at step 0, none on the decrease; 20 for steps 0 to 2, 14 for steps 3 to 7.
  close(m.resize_sats!, 2 + 2 + 20 * 0.001);
  close(m.capital_sats!, (3 * 20 + 5 * 14) * 0.01);
  assert.equal(m.resizes, 2);
  assert.equal(m.failures, 0);
  close(m.resize_sats!, direct(demand, [20, 12, 14, 14], p).resize_sats!);
  // A target equal to the capacity in force is a hold, and one the position lifts is still a resize that pays its fee.
  const again = new ServerSizingEnv(inputOf(demand, p));
  again.step({ tool: "resize", args: { inbound_sats: 20 } });
  again.step({ tool: "resize", args: { inbound_sats: 20 } });
  while (!again.done()) again.step({ tool: "hold" });
  assert.equal(again.finish().metrics.resizes, 1);
});

test("costs by hand: the first sizing pays the fee and the lease on its whole amount, an increase pays the lease, a decrease only the fee", () => {
  const demand: DemandStream = new Map([["a", zeros(8)]]);
  const p = priced({ resize_fee_sats: 2000, lease_rate_ppm: 1000, capital_rate_per_block: 0.000001, decision_interval_blocks: 2, resize_delay_blocks: 1 });
  const env = new ServerSizingEnv(inputOf(demand, p, { pilot: new Map([["a", [{ in: 1_000_000, out: 0 }, ...zeros(7)]]]) }));
  for (const level of [1_000_000, 500_000, 500_000, 700_000]) assert.equal(env.step({ tool: "resize", args: { inbound_sats: level } }).accepted, true);
  assert.equal(env.done(), true);
  const m = env.finish().metrics;
  // 2000 + 1000, then 2000, then nothing, then 2000 + 200.
  close(m.resize_sats!, 7200);
  assert.equal(m.resizes, 3);
  // Capacity by step: 1,000,000 for steps 0 to 2 (the decrease ordered at step 2 lands at 3), 500,000 for steps 3 to 6 (the increase ordered at step 6 lands at 7), 700,000 for step 7.
  close(m.capital_sats!, (3 * 1_000_000 + 4 * 500_000 + 700_000) * 0.000001);
  assert.equal(m.failures, 0);
});

test("delay boundaries, free equal-target holds, commit, and exhausted attempts hold the capacity to the horizon", () => {
  const demand: DemandStream = new Map([
    ["z-first", [{ in: 5, out: 5 }, { in: 0, out: 0 }, { in: 6, out: 0 }, { in: 0, out: 0 }, { in: 0, out: 0 }, { in: 0, out: 0 }]],
    ["a-second", zeros(6)],
  ]);
  const x = inputOf(demand, priced());
  const path = positionPath(demand);
  assert.equal(path.peak, 6);
  assert.equal(path.max[0], 5, "a receipt's peak survives its immediate spend");
  const plan = optimalSchedule(path, x.params);
  assert.equal(plan.q[0], 6, "the old level must cover step 2, before the delayed resize lands");
  const env = new ServerSizingEnv(x);
  env.step({ tool: "resize", args: { inbound_sats: 5 } });
  env.step({ tool: "resize", args: { inbound_sats: 6 } });
  assert.equal((env.view() as unknown as SizingView).failures, 1, "step 2 still uses capacity 5");
  assert.equal((env.view() as unknown as SizingView).capacity_in_force, 6, "the resize ordered at step 2 landed at step 3");
  env.step({ tool: "resize", args: { inbound_sats: 6 } });
  assert.equal(env.finish().metrics.resizes, 2, "a target equal to the capacity in force does not charge a fee");
  for (const end of ["commit", "attempts"]) {
    const e = new ServerSizingEnv(x);
    e.step({ tool: "resize", args: { inbound_sats: 6 } });
    const before = e.snapshot();
    if (end === "commit") e.step({ tool: "commit" });
    else {
      for (let i = 0; i < 32; i++) { e.step({ tool: "oops" }); assert.equal(e.snapshot(), before); }
      assert.equal(e.budget().attempts, 0);
      assert.equal(e.done(), true);
    }
    const actual = e.finish().metrics;
    const expected = direct(demand, [6, 6, 6], x.params);
    for (const [metric, value] of Object.entries(expected)) close(actual[metric]!, value);
  }
  // A hold at decision 0 leaves the capacity at zero: nothing is paid and every receipt fails.
  const idle = new ServerSizingEnv(x);
  while (!idle.done()) idle.step({ tool: "hold" });
  const m = idle.finish().metrics;
  assert.equal(m.resize_sats, 0);
  assert.equal(m.capital_sats, 0);
  assert.equal(m.failures, 2);
});

test("each step runs in insertion order, each holder's receipt then its spend; a spend a failed receipt left unfunded is dropped and is not a failure", () => {
  const step = (i: number, o: number): Step[] => [{ in: i, out: o }];
  const play = (demand: DemandStream, capacity: number): Record<string, number> => {
    const env = new ServerSizingEnv(inputOf(demand, priced({ decision_interval_blocks: 1, resize_delay_blocks: 0 }), { pilot: new Map([["p", [{ in: capacity, out: 0 }]]]) }));
    env.step({ tool: "resize", args: { inbound_sats: capacity } });
    while (!env.done()) env.step({ tool: "hold" });
    return env.finish().metrics;
  };
  // z receives 3 and spends 3, then a receives 5: with capacity 5, nothing fails if z comes first and a receipt fails if a does.
  assert.equal(play(new Map([["z", step(3, 3)], ["a", step(5, 0)]]), 5).failures, 0);
  assert.equal(play(new Map([["a", step(5, 0)], ["z", step(3, 3)]]), 5).failures, 1);
  // z's receipt of 10 fails at capacity 5; its spend of 4 is dropped, and the position stays 0 for the receipt of 5 after it.
  const dropped = play(new Map([["z", step(10, 4)], ["a", step(5, 0)]]), 5);
  assert.equal(dropped.failures, 1);
  assert.equal(dropped.failed_sats, 10);
  // Over two steps the dropped spend leaves room: z fails 10, then a receives 5 and 5 again is refused only if the position is 5.
  const two: DemandStream = new Map([["z", [{ in: 10, out: 4 }, { in: 0, out: 0 }]], ["a", [{ in: 5, out: 0 }, { in: 5, out: 5 }]]]);
  assert.equal(play(two, 5).failures, 2, "z's receipt, and a's second receipt because a's first one is still held");
});

test("the observation never shows the future: two evaluation streams equal before a step give equal views at every decision up to it", () => {
  let seed = 7;
  while (requiredLevels(positionPath(synthetic(seed).evaluation), synthetic(seed).params).q.length !== 4) seed++;
  const base = synthetic(seed);
  const cut = 2 * (base.params.decision_interval_blocks / base.params.round_interval_blocks);
  const rng = stream("server-sizing-future");
  const altered: DemandStream = new Map();
  for (const [name, series] of base.evaluation) {
    altered.set(name, series.map((s, t) => (t < cut ? s : { in: rng.int(4), out: 0 })));
  }
  const a = new ServerSizingEnv(base), b = new ServerSizingEnv({ ...base, evaluation: altered, evaluationPath: undefined });
  let compared = 0, differed = false;
  while (!a.done() && !b.done()) {
    const va = a.view() as unknown as SizingView, vb = b.view() as unknown as SizingView;
    if (va.step <= cut) { assert.deepEqual(va, vb, `views at step ${va.step}`); compared++; } else if (JSON.stringify(va) !== JSON.stringify(vb)) differed = true;
    assert.equal(va.evaluation_completed.length, va.decision_index);
    assert.ok(va.evaluation_completed.every((i) => i.end_step <= va.step && i.delay_end_step <= va.step));
    assert.equal((va as unknown as Record<string, Json>).evaluation, undefined);
    const action = va.decision_index === 0 ? { tool: "resize", args: { inbound_sats: va.max_inbound_sats } } : { tool: "hold" };
    assert.equal(a.step(action).accepted, true);
    assert.equal(b.step(action).accepted, true);
  }
  assert.ok(compared >= 3 && differed, "the streams do differ afterwards, and the views were compared before");
  // Completed intervals are the no-failure path's, whatever the actions: a server that holds at 0 and fails everything still sees them.
  const env = new ServerSizingEnv(base);
  const path = positionPath(base.evaluation);
  while (!env.done()) {
    const v = env.view() as unknown as SizingView;
    assert.deepEqual(v.evaluation_completed, intervalSummaries(path, base.params, v.step));
    assert.equal(v.pilot.peak, serverEnvelope(base.pilot).peak);
    env.step({ tool: "hold" });
  }
});

test("baselines: static_pilot is family 3's server-tier rule once; buffer_rule follows its stated rule on windows it has fully observed; random is seeded and in range; only the oracle is privileged", () => {
  let resizes = 0, holds = 0;
  for (let trial = 0; trial < 30; trial++) {
    const evaluated = synthetic(trial);
    const steps = positionPath(evaluated.evaluation).end.length;
    // A pilot drawn apart from the evaluation stream, of the same shape, as in the real cells.
    const input = { ...evaluated, pilot: randomDemand(stream("server-sizing-pilot", trial), evaluated.evaluation.size, steps), pilotPath: undefined };
    const interval = input.params.decision_interval_blocks / input.params.round_interval_blocks;
    const delay = input.params.resize_delay_blocks / input.params.round_interval_blocks;
    const pilotPeak = serverEnvelope(input.pilot).peak;
    const tracePilot = trace(input.pilot), traceEval = trace(input.evaluation);
    const rise = (tr: ReturnType<typeof trace>, start: number): number => Math.max(...tr.max.slice(start, Math.min(start + interval + delay, steps))) - tr.start[start]!;
    // static_pilot
    const stat = new ServerSizingEnv(input);
    const statAgent = new StaticPilot(margins);
    assert.deepEqual(statAgent.act({ view: stat.view() }), { tool: "resize", args: { inbound_sats: serverTierCapacity({ peak: pilotPeak, trough: 0 }, 0.25).inbound } });
    stat.step(statAgent.act({ view: stat.view() }));
    assert.deepEqual(statAgent.act({ view: stat.view() }), { tool: "commit" });
    // buffer_rule against the rule restated from the streams
    const env = new ServerSizingEnv(input);
    const agent = new BufferRule(margins);
    while (!env.done()) {
      const v = env.view() as unknown as SizingView;
      const rises: number[] = [0];
      for (let s = 0; s < steps; s += interval) rises.push(rise(tracePilot, s));
      for (let j = 0; (j + 1) * interval + delay <= v.step && (j + 1) * interval <= steps; j++) rises.push(rise(traceEval, j * interval));
      const b = 1.25 * Math.max(...rises);
      const wanted = v.decision_index === 0 || v.capacity_in_force < v.position + b || v.capacity_in_force > v.position + 3 * b
        ? { tool: "resize", args: { inbound_sats: Math.min(4 * pilotPeak, Math.ceil(v.position + 2 * b)) } } : { tool: "hold" };
      const action = agent.act({ view: v } as unknown as Json) as { tool: string };
      assert.deepEqual(action, wanted, `trial ${trial} decision ${v.decision_index}`);
      if (action.tool === "hold") holds++; else resizes++;
      env.step(action);
    }
  }
  assert.ok(resizes > 30 && holds > 10, `both branches ran (${resizes} resizes, ${holds} holds)`);
  // random: reproducible from the episode, uniform on [position, max(position, 2 x the pilot peak)], different across episodes.
  const peak = 1_000_000;
  const draw = (seed: number, task = "server_sizing/drift", position = 0): number[] => {
    const agent = new RandomSizing();
    agent.reset({ task, seed, cell: "single" });
    return Array.from({ length: 200 }, () => ((agent.act({ view: { position, pilot: { peak } } }) as { args: { inbound_sats: number } }).args.inbound_sats));
  };
  assert.deepEqual(draw(1), draw(1));
  assert.notDeepEqual(draw(1), draw(2));
  assert.notDeepEqual(draw(1), draw(1, "server_sizing/balanced"));
  const sample = draw(3);
  assert.ok(sample.every((n) => Number.isInteger(n) && n >= 0 && n <= 2 * peak));
  assert.ok(sample.some((n) => n < peak / 2) && sample.some((n) => n > 1.5 * peak), "spread over the whole range");
  const lifted = draw(3, "server_sizing/drift", 1_500_000);
  assert.ok(lifted.every((n) => n >= 1_500_000 && n <= 2 * peak) && new Set(lifted).size > 100, "never below the position");
  assert.ok(draw(3, "server_sizing/drift", 3_000_000).every((n) => n === 3_000_000), "above twice the peak it can only hold the position");
  // Only the oracle is privileged, and it refuses to start without the stream.
  const roster = serverSizingBaselines(margins);
  assert.deepEqual(roster.map((a) => a.id), ["static_pilot", "buffer_rule", "random", "oracle"]);
  assert.deepEqual(roster.filter((a) => a.privileged).map((a) => a.id), ["oracle"]);
  assert.throws(() => new Oracle().reset({ task: "t", seed: 0, cell: "c" }), /evaluation stream/);
});

test("the oracle plays the DP through act, and refuses a plan above the cap", async () => {
  const input = synthetic(5);
  const row = await runEpisode(new ServerSizingEnv(input), new Oracle());
  const plan = optimalSchedule(positionPath(input.evaluation), input.params);
  assert.equal(row.rejections.length, 0);
  assert.equal(row.metrics.failures, 0);
  close(row.metrics.cost_sats!, plan.cost_sats);
  // A cap below the plan's highest level makes the plan infeasible, never a silent clip.
  assert.throws(() => optimalSchedule(positionPath(input.evaluation), input.params, Math.max(...plan.q) - 1), /no never-failing schedule/);
  await assert.rejects(runEpisode(new ServerSizingEnv({ ...input, max_inbound_pilot_multiple: 0.5 }), new Oracle()), /no never-failing schedule/);
  // On every small instance it is never rejected (its floors are the env's), never fails, and costs its DP value.
  for (let trial = 0; trial < 30; trial++) {
    const x = { ...synthetic(trial), max_inbound_pilot_multiple: 100 };
    const r = await runEpisode(new ServerSizingEnv(x), new Oracle());
    assert.equal(r.rejections.length, 0, `trial ${trial}`);
    assert.equal(r.metrics.failures, 0);
    close(r.metrics.cost_sats!, optimalSchedule(positionPath(x.evaluation), x.params).cost_sats);
  }
});

test("the gates fail when they should", () => {
  const row = (agent: string, value: number, failures = 0, seed = 0): EpisodeRow =>
    ({ task: "server_sizing/drift", seed, cell: "single", agent, value, metrics: { failures }, turns: 0, rejections: [] });
  const gates = (rows: EpisodeRow[], k42 = true): Record<string, boolean> => Object.fromEntries(
    serverSizingGates(null as never, { rows, checks: [{ id: "K42", pass: k42, detail: "" }] } as unknown as RunRecord).map((g) => [g.id, g.pass]));
  const good = [row("oracle", -10), row("static_pilot", -11), row("buffer_rule", -10.5), row("random", -15)];
  assert.deepEqual(gates(good), { K41: true, K42: true, K43: true });
  assert.equal(gates([row("oracle", -10), row("random", -9)]).K41, false, "a policy above the oracle");
  assert.equal(gates([row("static_pilot", -11)]).K41, false, "no oracle row");
  assert.equal(gates([row("oracle", -10, 1), row("static_pilot", -11)]).K43, false, "an oracle failure");
  assert.equal(gates([row("static_pilot", -11)]).K43, false, "no oracle row");
  assert.equal(gates(good, false).K42, false);
  assert.equal(gates([]).K41, false);
});

test("the report: roles, band, metrics, Amendment 10's six hypotheses, and one agent contrast per cell", () => {
  const specs = serverSizingTaskSpecs(root, manifest, config);
  assert.deepEqual(specs.map((t) => t.task), ["server_sizing/balanced", "server_sizing/correlated", "server_sizing/drift"]);
  for (const t of specs) {
    assert.equal(t.floor, "static_pilot");
    assert.equal(t.ceiling, "oracle");
    assert.equal(t.reference, "buffer_rule");
    assert.equal(t.band, 0.05);
    assert.deepEqual(t.metrics, ["cost_sats", "capital_sats", "resize_sats", "failure_sats", "failures", "resizes", "mean_capacity"]);
  }
  const contrasts = serverSizingContrasts(config);
  assert.equal(contrasts.length, 6);
  assert.ok(contrasts.every((c) => c.primary === true), "the frozen family's hypotheses are primary");
  for (const t of specs) {
    assert.deepEqual(contrasts.filter((c) => c.task === t.task).map((c) => [c.a, c.b]), [["buffer_rule", "static_pilot"], ["oracle", "buffer_rule"]]);
  }
  assert.equal(new Set(contrasts.map((c) => c.id)).size, 6);
  const agent = serverSizingAgentContrasts(config, "x@0");
  assert.deepEqual(agent.map((c) => [c.id, c.task, c.a, c.b, c.primary]), specs.map((t, i) => [`A${i + 1}`, t.task, "x@0", "buffer_rule", true]));
});

test("the config states the ceiling's conditions, marks every number invented, reuses family 3's cells, and is bound by the manifest", () => {
  const horizonBlocks = 5376 * 6;
  assert.ok(config.failure_fixed_sats >= config.resize_fee_sats);
  assert.ok(config.failure_value_share >= config.capital_rate_per_block * horizonBlocks + config.lease_rate_ppm / 1e6);
  assert.deepEqual(config.cells, { drift: "many_bursty_long", balanced: "many_bursty_balanced", correlated: "many_bursty_balanced_correlated" });
  assert.equal(config.decision_interval_blocks, 1008);
  assert.equal(config.resize_delay_blocks, 6);
  assert.equal(config.budget.attempts, 32);
  assert.equal(config.max_inbound_pilot_multiple, 16);
  const file = JSON.parse(readFileSync(join(root, "config/server_sizing.json"), "utf8")) as Record<string, unknown> & { provenance: Record<string, string> };
  const provenance = file.provenance;
  for (const key of Object.keys(file)) {
    if (key === "description" || key === "provenance") continue;
    assert.ok(typeof provenance[key] === "string" && provenance[key]!.startsWith("invented"), `${key} has an invented provenance line`);
  }
  assert.ok(/never-failing schedule optimal/.test(provenance.ceiling!) && /0\.0333/.test(provenance.ceiling!) && /never below the position/.test(provenance.ceiling!));
  assert.equal(manifest.config["config/server_sizing.json"], fileSha256(root, "config/server_sizing.json"));
  assert.equal(existsSync(join(root, "fixtures", "server_sizing")), false, "no fixture of this family: family 3's are reused");
  assert.ok(!manifest.fixtures.some((f) => f.family === "server_sizing"));
});


test("development seeds: K41-K43 hold, every baseline runs without rejections, and the oracle's cost is the direct simulation of its DP levels", async () => {
  const rows: EpisodeRow[] = [];
  for (const cell of Object.keys(config.cells).sort()) {
    for (const seed of SEED_BLOCKS.development) {
      const input = sizingInput(root, manifest, config, cell, seed);
      assert.equal(input.evaluationPath!.end.length, 5376);
      assert.equal(input.pilotPath!.end.length, 5376);
      assert.equal(input.params.round_interval_blocks, 6);
      const episode: EpisodeRow[] = [];
      for (const agent of serverSizingBaselines(margins)) {
        const row = await runEpisode(new ServerSizingEnv(input), agent);
        assert.equal(row.rejections.length, 0, `${cell} ${seed} ${agent.id}`);
        assert.ok(row.turns <= 32, `${cell} ${seed} ${agent.id}: ${row.turns} turns`);
        episode.push(row); rows.push(row);
      }
      const ceiling = episode.find((r) => r.agent === "oracle")!;
      assert.equal(ceiling.metrics.failures, 0);
      const plan = optimalSchedule(input.evaluationPath!, input.params);
      close(ceiling.metrics.cost_sats!, plan.cost_sats);
      // The cap (16 x the pilot peak) is set far above any level the oracle needs: on these seeds the highest is at most 0.22 of it
      // (correlated, seed 5: that evaluation stream peaks at 3.4 times its pilot's).
      const cap = input.max_inbound_pilot_multiple * input.pilotPath!.peak;
      assert.ok(Math.max(...plan.levels) <= 0.25 * cap, `${cell} ${seed}: the oracle's highest level ${Math.max(...plan.levels)} is near the cap ${cap}`);
      if (seed === 0) {
        // One seed per cell against the independent simulator, on the real stream.
        const simulated = direct(input.evaluation, plan.levels, input.params);
        close(simulated.cost_sats!, plan.cost_sats);
        assert.equal(simulated.failures, 0);
        const floor = episode.find((r) => r.agent === "static_pilot")!;
        const sized = serverTierCapacity({ peak: input.pilotPath!.peak, trough: 0 }, 0.25).inbound;
        const expectedFloor = direct(input.evaluation, new Array(32).fill(sized), input.params);
        for (const metric of ["cost_sats", "capital_sats", "resize_sats", "failure_sats", "failures"]) close(floor.metrics[metric]!, expectedFloor[metric]!);
        assert.equal(floor.metrics.resizes, 1);
      }
      for (const row of episode) assert.ok(row.value <= ceiling.value + 1e-9, `${cell} ${seed} ${row.agent} beats oracle`);
    }
  }
  const checks = serverSizingIdentityCheck(root, manifest, config)(rows);
  assert.ok(checks.every((c) => c.pass), JSON.stringify(checks));
  const record = { rows, checks } as RunRecord;
  for (const gate of serverSizingGates(null as never, record)) assert.ok(gate.pass, `${gate.id}: ${gate.detail}`);
});

test("LLM path with a mock server: the prompt gives the rules and prices, the turn the observation, a rejection is survived, and 32 holds run the episode", async () => {
  const { createServer } = await import("node:http");
  const { ChatAgent } = await import("../../agents/chat.ts");
  const { serverSizingPrompt } = await import("./prompt.ts");
  const input = sizingInput(root, manifest, config, "correlated", 2);
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      res.setHeader("content-type", "application/json");
      const content = requests.length === 1 ? '{"tool":"resize","args":{"inbound_sats":-1}}' : '{"tool":"hold"}';
      res.end(JSON.stringify({ choices: [{ message: { content, reasoning_content: "" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const agent = new ChatAgent({
      name: "mock", baseUrl: `http://127.0.0.1:${port}/v1`, model: "mock",
      sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, max_tokens: 256, seed: 1 }, thinking: false,
      identity: { model_sha256: "0".repeat(64), runtime: "mock" }, prompt: serverSizingPrompt(256), contextTurns: 0,
    });
    const row = await runEpisode(new ServerSizingEnv(input), agent);
    assert.equal(row.turns, 33);
    assert.deepEqual(row.rejections, [{ turn: 0, reason: "below_minimum" }]);
    assert.equal(row.metrics.resize_sats, 0);
    assert.equal(row.metrics.capital_sats, 0);
    assert.ok(row.metrics.failures! > 0);
    assert.equal(requests.length, 33);
    const system = requests[0]!.messages[0]!.content;
    assert.ok(!/\{\w+\}/.test(system), "no template placeholder is left unfilled");
    assert.ok(system.includes("INBOUND") && system.includes("failure_value_share") && system.includes("256 tokens"));
    assert.ok(system.includes("5376 steps") && system.includes("32 times") && system.includes("max_inbound_sats (") && !system.includes("TOKEN_LIMIT"));
    const example = Number(/"inbound_sats":(\d+)/.exec(system)![1]);
    assert.ok(example < input.pilotPath!.peak / 10, "the prompt's example is a round number far from a sound sizing");
    assert.ok(!/margin/.test(system), "no baseline margin is in the prompt");
    assert.ok(system.includes("can never be below the position you hold") && system.includes("larger of the target and your position"), "the position floor is stated");
    for (const [i, request] of requests.entries()) {
      assert.equal(request.messages.length, 2, "contextTurns 0: the system prompt and the current turn only");
      const turn = request.messages.at(-1)!.content;
      const v = JSON.parse(turn.split("\n").find((l) => l.startsWith("{"))!) as SizingView;
      assert.equal(v.capital_rate_per_block, config.capital_rate_per_block);
      assert.equal(v.failure_fixed_sats, config.failure_fixed_sats);
      assert.equal(v.decision_index, Math.max(0, i - 1));
      assert.equal(v.evaluation_completed.length, v.decision_index);
      assert.ok(v.evaluation_completed.every((s) => s.end_step <= v.step && s.delay_end_step <= v.step));
      assert.equal(v.pilot.intervals.length, 32);
      const fields = v as unknown as Record<string, Json>;
      assert.equal(fields.evaluation, undefined);
      assert.equal(fields.static_margin, undefined);
      assert.equal(fields.buffer_margin, undefined);
      assert.equal(fields.current_target_sats, undefined);
      if (i === 1) assert.ok(turn.startsWith("Your last action was rejected: inbound_sats cannot be negative."));
    }
  } finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
});
