import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode } from "../../harness/episode.ts";
import type { Json } from "../../harness/json.ts";
import { readManifest } from "../../harness/manifest.ts";
import { SEED_BLOCKS } from "../../harness/seeds.ts";
import { shzHedgeSkill } from "../../agents/skills.ts";
import { HEDGER, Hedger, Idle, Oracle, faultOf, shzBaselines, type ShzView } from "./baselines.ts";
import { ShzEnv } from "./env.ts";
import { generateFixture, leadMoveBps, type PacketKind, type ShzConfig, type ShzFixture } from "./generate.ts";
import { shzPrompt } from "./prompt.ts";
import { shzEpisodes } from "./task.ts";
import { ceilingOf, divFloor, idleValue, lnFee, packetFault, settle, takeOutcome, vSats } from "./world.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const config = JSON.parse(readFileSync(join(root, "config/shz.json"), "utf8")) as ShzConfig;
const fixture = (cell: string, seed: number, c: ShzConfig = config): ShzFixture => generateFixture(seed, cell, c.cells[cell]!, c);
const act = (env: ShzEnv, tool: string, args: Json = {}) => env.step({ tool, args });
const fed = (f: ShzFixture) => ({ ...config.federation, keys: f.members });
const nowAt = (f: ShzFixture, t: number, r: number): number => f.origin_ms + t * f.step_ms + r * config.slot_ms + config.receive_delay_ms;

/** The first (seed, step, slot) in [0, 400) of `cell` whose packet has this kind. */
function slotOfKind(kind: PacketKind, cell = "bad_marks"): { f: ShzFixture; t: number; r: number } {
  for (let seed = 0; seed < 400; seed++) {
    const f = fixture(cell, seed);
    for (let t = 0; t < f.steps; t++) for (let r = 0; r < config.slots_per_step; r++) if (f.packets[t]![r]!.kind === kind) return { f, t, r };
  }
  throw new Error(`no ${kind} packet in 400 seeds`);
}

test("fixtures are deterministic and well formed", () => {
  for (const cell of Object.keys(config.cells)) {
    const a = fixture(cell, 3);
    assert.deepEqual(fixture(cell, 3), a);
    assert.equal(a.marks.length, a.steps + 1);
    assert.equal(a.packets.length, a.steps);
    for (const row of a.packets) assert.equal(row.length, config.slots_per_step);
    assert.equal(a.hold[0], 0);
    assert.equal(a.hold[a.steps], 0);
    assert.equal(a.lot_usd * config.full_hedge_lots >= config.target_usd[0], true);
    for (const l of a.target_lots) assert.ok(l >= config.target_lots[0] && l <= config.target_lots[1]);
    for (let t = 0; t < a.steps; t++) for (const s of a.packets[t]!) assert.equal(a.hold[t] === 1, s.kind === "hold" || s.kind === "timeout");
  }
  const calm = fixture("calm", 0);
  assert.ok(calm.packets.every((row) => row.every((s) => s.kind === "genuine")));
});

test("the lead-move table is inverted exactly at its points, so the 200 ms move matches the latency study's quantiles", () => {
  for (const [x, ppm] of config.lead_move.survival) assert.ok(Math.abs(leadMoveBps(1 - ppm / 1_000_000, config.lead_move) - x) < 1e-9, `x ${x}`);
  assert.ok(leadMoveBps(1 - 1e-9, config.lead_move) <= config.lead_move.max_bps);
});

test("the pinned policy passes every genuine packet and names the fault of each bad one", () => {
  for (const cell of Object.keys(config.cells)) {
    for (let seed = 0; seed < 8; seed++) {
      const f = fixture(cell, seed);
      for (let t = 0; t < f.steps; t++) for (let r = 0; r < config.slots_per_step; r++) {
        const { kind, packet } = f.packets[t]![r]!;
        const fault = packetFault(packet, fed(f), nowAt(f, t, r));
        if (kind === "genuine") assert.equal(fault, null, `${cell} ${seed} ${t}.${r}`);
        else assert.notEqual(fault, null, `${cell} ${seed} ${t}.${r} ${kind}`);
      }
    }
  }
  const expect: Array<[PacketKind, RegExp]> = [["forged", /not the member's/], ["under_signed", /quorum/], ["stale_source", /source timestamp|skewed/], ["replayed", /older than/], ["hold", /HOLD/], ["timeout", /no packet/]];
  for (const [kind, re] of expect) {
    const { f, t, r } = slotOfKind(kind);
    assert.match(packetFault(f.packets[t]![r]!.packet, fed(f), nowAt(f, t, r))!, re, kind);
  }
});

test("venue arithmetic: whole sats, the routing fee, and the three outcomes of a settlement", () => {
  assert.equal(divFloor(7, 2), 3);
  assert.equal(vSats(1_000, 100_000), 1_000_000);
  assert.equal(lnFee(config, 2_000_000), 201);
  assert.equal(lnFee(config, 50_000), 6);
  assert.equal(lnFee(config, 0), 0);
  const f = { lot_usd: 1_000 };
  // Margin of the full notional (1x) covers any rise: the short never closes.
  const covered = settle(f, config, 8, vSats(8_000, 100_000), 100_000, 300_000, 8);
  assert.equal(covered.liquidated || covered.bankrupt, false);
  assert.equal(covered.tracking, 0);
  // At 8x a 9% rise breaches maintenance (a 7% one does not): the short closes at 200 bps worse than the mark.
  assert.equal(settle(f, config, 8, 1_000_000, 100_000, 107_000, 8).liquidated, false);
  const thin = settle(f, config, 8, 1_000_000, 100_000, 109_000, 8);
  assert.equal(thin.liquidated, true);
  assert.equal(thin.penalty, vSats(8_000, 109_000) - vSats(8_000, 111_180));
  assert.equal(thin.lots_after, 0);
  // A 15% rise is past bankruptcy: the account loses exactly its margin.
  const broke = settle(f, config, 8, 1_000_000, 100_000, 115_000, 8);
  assert.equal(broke.bankrupt, true);
  assert.equal(broke.hedge, -1_000_000);
  assert.equal(broke.penalty, 0);
  // Unhedged, the tracking error is the target's whole sats change.
  assert.equal(settle(f, config, 0, 0, 100_000, 99_000, 8).tracking, vSats(8_000, 99_000) - vSats(8_000, 100_000));
});

test("a take on a packet that fails the policy fills only when its price is worse for the taker, around that price", () => {
  const { f, t, r } = slotOfKind("forged");
  const p = f.packets[t]![r]!.packet!.price_usd!;
  const mark = f.marks[t]!;
  const sell = takeOutcome(f, config, t, r, "sell", 1, "standard")!;
  const buy = takeOutcome(f, config, t, r, "buy", 1, "standard")!;
  assert.equal(sell.filled, p < mark);
  assert.equal(buy.filled, p > mark);
  const filled = sell.filled ? sell : buy;
  assert.equal(filled.rogue, true);
  assert.equal(filled.fills[0]!.price_usd, sell.filled ? divFloor(p * (10_000 - 15), 10_000) : Math.ceil(p * (10_000 + 15) / 10_000));
  assert.ok(filled.execution > 0);
});

test("the host refuses what the venue refuses, and a rejection is the identity on state", () => {
  const { f, t } = slotOfKind("hold");
  const env = new ShzEnv(f, config);
  const u = f.margin_unit_sats;
  const before = env.snapshot();
  assert.equal(env.step("nope").reason, "malformed");
  assert.equal(act(env, "short_everything").reason, "unknown_tool");
  assert.equal(act(env, "deposit", { sats: u + 1 }).reason, "out_of_grid");
  assert.equal(act(env, "deposit", { sats: 2.5 }).reason, "not_integer");
  assert.equal(act(env, "take", { side: "sell", lots: 8, tier: "standard" }).reason, "below_minimum");
  assert.equal(env.snapshot(), before);
  assert.equal(env.budget().attempts, config.budget.attempts - 5);
  assert.ok(act(env, "deposit", { sats: 4 * u }).accepted);
  assert.equal(act(env, "deposit", { sats: u }).reason, "duplicate");
  assert.equal(act(env, "take", { side: "buy", lots: 1 }).reason, "out_of_grid");
  assert.ok(act(env, "take", { side: "sell", lots: 8 }).accepted);
  assert.equal(act(env, "take", { side: "sell", lots: 1 }).reason, "duplicate");
  assert.equal(env.budget().attempts, 0);
  assert.ok(env.done());
  // The rest of the horizon runs on; the federation's HOLD step refuses a take.
  const env2 = new ShzEnv(f, config);
  for (let i = 0; i < t; i++) assert.ok(act(env2, "wait").accepted);
  assert.equal(act(env2, "take", { side: "sell", lots: 1 }).reason, "phase_closed");
  const env3 = new ShzEnv(f, config);
  assert.ok(act(env3, "refresh").accepted);
  assert.ok(act(env3, "refresh").accepted);
  assert.equal(act(env3, "refresh").reason, "phase_closed");
});

test("idle earns minus its tracking error; the oracle earns exactly the ceiling and no baseline beats it", async () => {
  for (const cell of Object.keys(config.cells)) {
    for (let seed = 0; seed < 8; seed++) {
      const f = fixture(cell, seed);
      const ceiling = ceilingOf(f, config).value;
      const values = new Map<string, number>();
      for (const agent of shzBaselines(config)) values.set(agent.id, (await runEpisode(new ShzEnv(f, config), agent)).value);
      assert.equal(values.get("idle"), idleValue(f, config), `${cell} ${seed}`);
      assert.equal(values.get("oracle"), ceiling, `${cell} ${seed}`);
      for (const [id, v] of values) assert.ok(v <= ceiling, `${id} beat the oracle on ${cell} ${seed}`);
    }
  }
});

/** Copy an episode's state; the fixture and config are read-only and shared. */
function cloneEnv(env: ShzEnv): ShzEnv {
  const c = Object.create(Object.getPrototypeOf(env)) as Record<string, unknown>;
  for (const [k, v] of Object.entries(env)) c[k] = k === "f" || k === "config" ? v : structuredClone(v);
  return c as unknown as ShzEnv;
}

/** Every sequence of moves the host admits, step by step: refreshes, one margin transfer and one take in either order, then wait. */
function bruteForce(f: ShzFixture, c: ShzConfig): number {
  let best = -Infinity;
  const u = f.margin_unit_sats;
  const visit = (env: ShzEnv): void => {
    if (env.done()) { best = Math.max(best, cloneEnv(env).finish().value); return; }
    const v = env.view() as unknown as ShzView;
    const units = v.account.margin_sats / u;
    const lots = v.account.short_lots;
    const margins: Json[] = [null, ...Array.from({ length: c.max_margin_units - units }, (_, i) => ({ tool: "deposit", args: { sats: (i + 1) * u } })), ...Array.from({ length: units }, (_, i) => ({ tool: "withdraw", args: { sats: (i + 1) * u } }))];
    const takes: Json[] = [null];
    for (let n2 = 0; n2 <= c.max_lots; n2++) for (const tier of ["standard", "premium"]) if (n2 !== lots) takes.push({ tool: "take", args: { side: n2 > lots ? "sell" : "buy", lots: Math.abs(n2 - lots), tier } });
    for (let r = v.slot; r < c.slots_per_step; r++) {
      for (const m of margins) for (const tk of takes) for (const order of m && tk ? [0, 1] : [0]) {
        const e = cloneEnv(env);
        for (let i = v.slot; i < r; i++) e.step({ tool: "refresh" });
        const moves = (order === 0 ? [m, tk] : [tk, m]).filter((x) => x !== null);
        let ok = true;
        for (const mv of moves) if (!e.step(mv).accepted) { ok = false; break; }
        if (!ok) continue;
        e.step({ tool: "wait" });
        visit(e);
      }
    }
  };
  visit(new ShzEnv(f, c));
  return best;
}

test("the ceiling is exact: no sequence of admitted moves beats the dynamic program on small instances", () => {
  const small: ShzConfig = { ...config, steps: 3, slots_per_step: 2, full_hedge_lots: 2, target_lots: [1, 2], max_lots: 2, margin_unit_divisor: 4, max_margin_units: 3, budget: { attempts: 99, probes: 99 },
    cells: { ...config.cells, bad_marks: { ...config.cells.bad_marks!, bad_ppm: 500_000, hold_start_ppm: 300_000 }, volatile: { ...config.cells.volatile!, jump_ppm: 400_000 } } };
  for (const cell of ["calm", "volatile", "bad_marks"]) {
    for (const seed of [0, 1]) {
      const f = generateFixture(seed, cell, small.cells[cell]!, small);
      assert.equal(bruteForce(f, small), ceilingOf(f, small).value, `${cell} ${seed}`);
    }
  }
});

test("bad packets cost the unverified hedger, the margin buffer pays in jumps, and the paid tier costs its fee", async () => {
  let rogue = 0;
  let liquidations = 0;
  for (let seed = 0; seed < 8; seed++) {
    const bad = fixture("bad_marks", seed);
    const u = await runEpisode(new ShzEnv(bad, config), new Hedger("unverified", { ...HEDGER, verify: false }));
    const h = await runEpisode(new ShzEnv(bad, config), new Hedger("hedger", HEDGER));
    rogue += u.metrics.rogue_fills!;
    assert.equal(h.metrics.rogue_fills, 0);
    const vol = fixture("volatile", seed);
    liquidations += (await runEpisode(new ShzEnv(vol, config), new Hedger("thin_margin", { ...HEDGER, buffer_bps: 0 }))).metrics.liquidations!;
    const p = await runEpisode(new ShzEnv(vol, config), new Hedger("premium_always", { ...HEDGER, tier: "premium" }));
    const s = await runEpisode(new ShzEnv(vol, config), new Hedger("hedger", HEDGER));
    assert.ok(p.metrics.taker_fee_sats! > 0 && s.metrics.taker_fee_sats === 0);
  }
  assert.ok(rogue > 0, "the unverified hedger traded on a bad packet");
  assert.ok(liquidations > 0, "a jump closed a thin margin");
});

test("episodes are deterministic", async () => {
  const f = fixture("bad_marks", 5);
  const a = new ShzEnv(f, config);
  const b = new ShzEnv(f, config);
  assert.deepEqual(await runEpisode(a, new Hedger("hedger", HEDGER)), await runEpisode(b, new Hedger("hedger", HEDGER)));
  assert.equal(a.snapshot(), b.snapshot());
  assert.equal((await runEpisode(new ShzEnv(f, config), new Idle())).value, idleValue(f, config));
  assert.equal((await runEpisode(new ShzEnv(f, config), new Oracle(config))).value, ceilingOf(f, config).value);
});

test("the shz_hedge skill returns hedger's next action at every turn, and the prompt renders", () => {
  for (const cell of Object.keys(config.cells)) {
    const f = fixture(cell, 2);
    const env = new ShzEnv(f, config);
    const history: Json[] = [];
    const policy = new Hedger("hedger", HEDGER);
    policy.reset();
    let last: Json = null;
    for (let turn = 0; !env.done() && turn < 400; turn++) {
      const o = { bench: "x", task: env.task, episode: { seed: f.seed, cell: env.cell, turn }, budget: { ...env.budget() }, tools: env.tools(), view: env.view(), last } as unknown as Json;
      history.push(o);
      const fromSkill = shzHedgeSkill.run(o, {}, history);
      assert.deepEqual(fromSkill, policy.act(JSON.parse(JSON.stringify(o)) as Json));
      if (turn === 0) {
        const p = shzPrompt(256);
        assert.match(p.system(o), /pinned policy/);
        assert.match(p.system(o), new RegExp(f.members[4]!));
        assert.match(p.turn(o), /Step 0 of 24, slot 0/);
        assert.equal(faultOf((o as { view: ShzView }).view) === null, f.packets[0]![0]!.kind === "genuine");
      }
      const r = env.step(fromSkill);
      last = { accepted: r.accepted, reason: r.reason, result: r.result } as Json;
    }
  }
});

test("a model that calls shz_hedge at every turn and sends its result scores hedger's value", async () => {
  const { ChatAgent } = await import("../../agents/chat.ts");
  const { echoSkillServer } = await import("../../agents/echo_mock.test_helper.ts");
  const manifest = readManifest(root);
  const m = await echoSkillServer("shz_hedge");
  try {
    for (const cell of Object.keys(config.cells).sort()) {
      for (const seed of SEED_BLOCKS.development.slice(0, 3)) {
        const agent = new ChatAgent({
          name: "mock", baseUrl: m.url, model: "mock", sampling: { temperature: 0, top_p: 1, top_k: 1, max_tokens: 256, seed: 0 }, thinking: false,
          identity: { model_sha256: "0".repeat(64), runtime: "mock" }, prompt: shzPrompt(256), skills: [shzHedgeSkill], maxSkillCalls: 1000, maxSkillCallsPerTurn: 1,
        });
        const row = await runEpisode(shzEpisodes(root, manifest, config, cell, seed)[0]!, agent);
        const ref = await runEpisode(shzEpisodes(root, manifest, config, cell, seed)[0]!, new Hedger("hedger", HEDGER));
        assert.equal(row.rejections.length, 0, `${cell} ${seed}`);
        assert.equal(row.value, ref.value, `${cell} ${seed}`);
        assert.deepEqual(row.metrics, ref.metrics);
      }
    }
  } finally { m.server.close(); }
});
