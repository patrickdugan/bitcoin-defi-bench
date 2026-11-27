import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatAgent } from "../../agents/chat.ts";
import { echoSkillServer } from "../../agents/echo_mock.test_helper.ts";
import { SKILLS, cashuDeskSkill } from "../../agents/skills.ts";
import { runEpisode } from "../../harness/episode.ts";
import type { Json } from "../../harness/json.ts";
import { readManifest } from "../../harness/manifest.ts";
import { SEED_BLOCKS } from "../../harness/seeds.ts";
import { Desk, Idle, LATE_PLAN, PLAN, PROOF_GROVE, cashuBaselines, depositRefusal } from "./baselines.ts";
import { CashuEnv } from "./env.ts";
import { generateFixture, type CashuFixture, type DepositType, type TokenType } from "./generate.ts";
import { proofDleqValid, proofY } from "./nut.ts";
import { cashuPrompt } from "./prompt.ts";
import { cashuCells, cashuFixture, loadCashuConfig } from "./task.ts";
import { at, ceilingOf, defaultValue, exitRunway, lastExitBlock, moveOutFee, refreshFee, tokenMargin } from "./world.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const config = loadCashuConfig(root);
const manifest = readManifest(root);
const dev = (cell: string, seed: number): CashuFixture => cashuFixture(root, manifest, cell, seed);
const act = (env: CashuEnv, tool: string, args: Json = {}) => env.step({ tool, args });
const views = (env: CashuEnv) => env.view() as unknown as { height: number; pending: { deposits: Array<{ id: string }>; tokens: Array<{ id: string }> } };

/** The first development fixture of `cell` with a deposit or token of this type. */
function withDeposit(type: DepositType): { f: CashuFixture; id: string } {
  for (const seed of SEED_BLOCKS.development) {
    const f = dev("desk", seed);
    const d = f.deposits.find((x) => x.type === type);
    if (d) return { f, id: d.id };
  }
  throw new Error(`no ${type} deposit on the development seeds`);
}
function withToken(type: TokenType, cell = "desk"): { f: CashuFixture; id: string } {
  for (const seed of SEED_BLOCKS.development) {
    const f = dev(cell, seed);
    const t = f.tokens.find((x) => x.type === type);
    if (t) return { f, id: t.id };
  }
  throw new Error(`no ${type} token on the development seeds`);
}

/** Wait until the item's arrival block. */
function reach(env: CashuEnv, height: number): void {
  while (views(env).height < height) assert.ok(act(env, "wait", { blocks: height - views(env).height }).accepted);
}

test("fixtures are deterministic and match the manifest bytes", () => {
  const f = generateFixture(3, "desk", config.cells.desk!, config);
  assert.deepEqual(generateFixture(3, "desk", config.cells.desk!, config), f);
  assert.deepEqual(dev("desk", 3), JSON.parse(JSON.stringify(f)));
  assert.equal(f.fees.length, f.horizon_height - f.start_height + 1);
});

test("tokens carry real NUT-12 proofs: genuine and inactive-keyset proofs verify under the mint's keys; forgeries do not", () => {
  const counts: { [t: string]: number } = {};
  for (const cell of ["desk", "reserve_shortfall"]) {
    for (const seed of SEED_BLOCKS.development) {
      const f = dev(cell, seed);
      const keyOf = (id: string, amount: number): string | undefined => f.mint.keysets.find((k) => k.id === id)?.keys[String(amount)];
      for (const t of f.tokens) {
        counts[t.type] = (counts[t.type] ?? 0) + 1;
        assert.deepEqual(t.ys, t.token.proofs.map((p) => proofY(p.secret)));
        assert.equal(t.amount_sats, t.token.proofs.reduce((a, p) => a + p.amount, 0));
        for (const p of t.token.proofs) {
          const key = keyOf(p.id, p.amount);
          if (t.type === "unknown_keyset") { assert.equal(key, undefined); continue; }
          assert.ok(key, `${t.type} proof names a listed keyset`);
          assert.equal(proofDleqValid(key, p), t.type !== "forged", `${cell} ${seed} ${t.id} ${t.type}`);
        }
        if (t.type === "inactive_keyset") assert.equal(f.mint.keysets.find((k) => k.id === t.token.proofs[0]!.id)!.active, false);
      }
    }
  }
  for (const type of ["genuine", "inactive_keyset", "forged", "unknown_keyset", "spent"]) assert.ok((counts[type] ?? 0) > 0, `no ${type} token`);
});

test("deposit evidence shows what Proof Grove's checks look at", () => {
  const view = (f: CashuFixture, id: string) => {
    const env = new CashuEnv(f, config);
    reach(env, f.deposits.find((d) => d.id === id)!.arrival);
    const v = env.view() as unknown as Parameters<typeof depositRefusal>[0];
    return { v, d: v.pending.deposits.find((x) => x.id === id)! };
  };
  const refusal = (type: DepositType): string | null => { const { f, id } = withDeposit(type); const { v, d } = view(f, id); return depositRefusal(v, d, false); };
  assert.equal(refusal("genuine"), null);
  assert.equal(refusal("forged_proof"), null, "a forged proof looks right until the verifier runs");
  assert.equal(refusal("reorged"), null, "a reorganized payment looks right until the chain is checked");
  assert.equal(refusal("operator_report"), "verified_evidence_required");
  assert.equal(refusal("wrong_amount"), "wrong_amount");
  assert.equal(refusal("wrong_script"), "wrong_payment_script");
  assert.equal(refusal("reused_script"), "deposit_script_reused");
});

test("a rejection is the identity on state and costs one attempt; checks cost probes", () => {
  const { f, id } = withDeposit("genuine");
  const env = new CashuEnv(f, config);
  reach(env, f.deposits.find((d) => d.id === id)!.arrival);
  const before = env.snapshot();
  const budget = env.budget();
  assert.equal(act(env, "deposit.sign_everything").reason, "unknown_tool");
  assert.equal(act(env, "deposit.admit", { deposit: "nope" }).reason, "unknown_id");
  assert.equal(env.step("not an object").reason, "malformed");
  assert.equal(act(env, "mint.move_out", { amount_sats: 1.5 }).reason, "not_integer");
  assert.equal(act(env, "mint.move_out", { amount_sats: f.float_sats + 1 }).reason, "over_budget");
  assert.equal(env.snapshot(), before);
  assert.equal(env.budget().attempts, budget.attempts - 5);
  assert.ok(act(env, "proof.verify", { deposit: id }).accepted);
  assert.equal(env.budget().probes, budget.probes - 1);
  assert.equal(env.budget().attempts, budget.attempts - 5);
});

test("Proof Grove's fee and runway rules, ported: its own refresh_fee test, the two recorded refreshes, the demo's exit budget", () => {
  const table = { base_fee_sat: 1, ppm_expiry_table: [{ expiry_blocks_threshold: 0, ppm: 1 }, { expiry_blocks_threshold: 100, ppm: 1000 }] };
  assert.equal(refreshFee(table, [{ amount_sats: 1, expiry_height: 10 }, { amount_sats: 1, expiry_height: 10 }], 0), 2);
  assert.equal(refreshFee(table, [{ amount_sats: 10000, expiry_height: 100 }], 0), 11);
  // The fitted schedule at its 4,000 ppm tier: 2,148 sats on 499,400 and 190 on 10,000.
  assert.equal(refreshFee(config.refresh_fee, [{ amount_sats: 499_400, expiry_height: 100 }], 0), 2148);
  assert.equal(refreshFee(config.refresh_fee, [{ amount_sats: 10_000, expiry_height: 100 }], 0), 190);
  assert.equal(moveOutFee(config, 10_000), 190);
  assert.equal(exitRunway(config), 24);
  assert.equal(config.exit.vbytes * 5, 3180 + 645);
  assert.deepEqual(PLAN, config.plan, "the reference's margins, written in its source, are the config's");
  assert.ok(LATE_PLAN.refresh_before < PLAN.refresh_before);
});

test("idle earns exactly the host's defaults; the oracle earns exactly the ceiling and no baseline beats it; the reference admits nothing bad", async () => {
  for (const cell of cashuCells(config)) {
    for (const seed of SEED_BLOCKS.development) {
      const f = dev(cell, seed);
      const ceiling = ceilingOf(config, f).value;
      for (const agent of cashuBaselines()) {
        const row = await runEpisode(new CashuEnv(f, config), agent);
        if (agent.id === "idle") assert.equal(row.value, defaultValue(config, f), `${cell} ${seed}`);
        if (agent.id === "oracle") assert.equal(row.value, ceiling, `${cell} ${seed}`);
        if (agent.id === "proof_grove") assert.equal(row.metrics.admitted_bad! + row.metrics.accepted_bad!, 0, `${cell} ${seed}`);
        assert.ok(row.value <= ceiling, `${agent.id} beat the oracle on ${cell} ${seed}`);
        assert.equal(row.rejections.length, 0, `${agent.id} ${cell} ${seed}`);
      }
    }
  }
});

test("smoke: the reference sits between the floor and the ceiling in every cell", async () => {
  for (const cell of cashuCells(config)) {
    let ref = 0; let floor = 0; let ceil = 0;
    for (const seed of SEED_BLOCKS.development) {
      const f = dev(cell, seed);
      ref += (await runEpisode(new CashuEnv(f, config), new Desk("proof_grove", PROOF_GROVE))).value;
      floor += defaultValue(config, f);
      ceil += ceilingOf(config, f).value;
    }
    assert.ok(floor < ref && ref <= ceil, `${cell}: floor ${floor}, reference ${ref}, ceiling ${ceil}`);
  }
});

test("trusting the mint's state report accepts a forgery and pays for the goods", async () => {
  const { f, id } = withToken("forged");
  const t = f.tokens.find((x) => x.id === id)!;
  const env = new CashuEnv(f, config);
  reach(env, t.arrival);
  const state = act(env, "mint.check_state", { token: id });
  assert.ok((state.result as { states: Array<{ state: string }> }).states.every((s) => s.state === "UNSPENT"), "NUT-07 knows nothing of a Y it never signed");
  assert.equal((act(env, "token.accept", { token: id }).result as { swap: string }).swap, "refused by the mint");
  act(env, "end");
  assert.equal(env.finish().metrics.accepted_bad, 1);
  const spentCase = withToken("spent");
  const env2 = new CashuEnv(spentCase.f, config);
  reach(env2, spentCase.f.tokens.find((x) => x.id === spentCase.id)!.arrival);
  assert.ok((act(env2, "mint.check_state", { token: spentCase.id }).result as { states: Array<{ state: string }> }).states.every((s) => s.state === "SPENT"));
  assert.equal(tokenMargin(config, 10_000), 200);
});

test("a deposit on a reorganized payment passes the verifier and fails the chain check; admitting it costs its amount less the fee", () => {
  const { f, id } = withDeposit("reorged");
  const d = f.deposits.find((x) => x.id === id)!;
  const env = new CashuEnv(f, config);
  reach(env, d.arrival);
  assert.equal((act(env, "proof.verify", { deposit: id }).result as { valid: boolean }).valid, true);
  assert.equal((act(env, "chain.check", { deposit: id }).result as { matches_evidence: boolean }).matches_evidence, false);
  assert.ok(act(env, "deposit.admit", { deposit: id }).accepted);
  act(env, "end");
  const o = env.finish();
  assert.equal(o.metrics.admitted_bad, 1);
});

test("the Ark server offline refuses a refresh; an exit inside the runway is refused; the watcher exits at twice the rate", async () => {
  let found = false;
  for (const seed of SEED_BLOCKS.development) {
    const f = dev("operator_outage", seed);
    if (f.outage === null) continue;
    const v = f.vtxos.find((x) => lastExitBlock(config, x) >= f.outage!.start);
    if (!v) continue;
    const env = new CashuEnv(f, config);
    reach(env, f.outage.start);
    if (views(env).height !== f.outage.start) continue;
    assert.equal(act(env, "ark.refresh", { vtxos: [v.id] }).reason, "phase_closed");
    found = true;
    break;
  }
  assert.ok(found, "an outage covering a live VTXO");
  const f = dev("operator_outage", 0);
  const v = f.vtxos[0]!;
  const env = new CashuEnv(f, config);
  reach(env, lastExitBlock(config, v));
  if (views(env).height === lastExitBlock(config, v)) {
    assert.ok(act(env, "wait", { blocks: 1 }).accepted);
    assert.equal(act(env, "ark.exit", { vtxos: [v.id] }).reason, "unknown_id", "the watcher already exited it");
  }
  const row = await runEpisode(new CashuEnv(f, config), new Idle());
  assert.equal(row.metrics.watcher_exits, f.vtxos.length);
  assert.equal(row.metrics.exit_fees, f.vtxos.reduce((a, x) => a + config.exit.vbytes * config.exit.armed_multiplier * at(f, f.fees, lastExitBlock(config, x)), 0));
});

test("a mint halt takes the float the desk still holds; moving it out first keeps it", async () => {
  const seed = SEED_BLOCKS.development.find((s) => dev("reserve_shortfall", s).mint.failure_height !== null)!;
  const f = dev("reserve_shortfall", seed);
  const idle = await runEpisode(new CashuEnv(f, config), new Idle());
  assert.equal(idle.metrics.float_lost, f.float_sats);
  const ref = await runEpisode(new CashuEnv(f, config), new Desk("proof_grove", PROOF_GROVE));
  assert.equal(ref.metrics.float_lost, 0);
  assert.ok(ref.metrics.move_fees! > 0 && ref.metrics.move_fees! < f.float_sats / 100);
});

test("episodes are deterministic", async () => {
  const f = dev("desk", 5);
  const a = new CashuEnv(f, config);
  const b = new CashuEnv(f, config);
  assert.deepEqual(await runEpisode(a, new Desk("proof_grove", PROOF_GROVE)), await runEpisode(b, new Desk("proof_grove", PROOF_GROVE)));
  assert.equal(a.snapshot(), b.snapshot());
});

test("the cashu_desk skill is the reference's next action, and the prompt renders", () => {
  assert.equal(SKILLS.cashu_desk, cashuDeskSkill);
  const f = dev("desk", 2);
  const env = new CashuEnv(f, config);
  const policy = new Desk("proof_grove", PROOF_GROVE);
  let last: Json = null;
  for (let turn = 0; !env.done() && turn < 400; turn++) {
    const o = { bench: "x", task: env.task, episode: { seed: f.seed, cell: env.cell, turn }, budget: { ...env.budget() }, tools: env.tools(), view: env.view(), last } as unknown as Json;
    const fromSkill = cashuDeskSkill.run(o, {}, [o]);
    assert.deepEqual(fromSkill, policy.act(JSON.parse(JSON.stringify(o)) as Json));
    if (turn === 0) {
      const p = cashuPrompt(256);
      assert.match(p.system(o), /NUT-12 DLEQ/);
      assert.match(p.system(o), new RegExp(f.mint.keysets[0]!.id));
      assert.match(p.turn(o), /Probes left: 32/);
    }
    const r = env.step(fromSkill);
    last = { accepted: r.accepted, reason: r.reason, result: r.result } as Json;
  }
  assert.ok(env.done());
});

test("cashu_desk: a model that calls it at every turn and copies its result plays proof_grove exactly", async () => {
  const m = await echoSkillServer("cashu_desk");
  try {
    const agent = new ChatAgent({
      name: "echo", baseUrl: m.url, model: "mock", sampling: { temperature: 0, top_p: 1, top_k: 1, max_tokens: 256, seed: 0 }, thinking: false,
      identity: { model_sha256: "0".repeat(64), runtime: "mock" }, prompt: cashuPrompt(256), skills: [cashuDeskSkill], maxSkillCalls: 1000, maxSkillCallsPerTurn: 1, contextTurns: 1,
    });
    const reference = new Desk("proof_grove", PROOF_GROVE);
    for (const cell of cashuCells(config)) {
      for (const seed of SEED_BLOCKS.development.slice(0, 3)) {
        const a = await runEpisode(new CashuEnv(dev(cell, seed), config), agent);
        const b = await runEpisode(new CashuEnv(dev(cell, seed), config), reference);
        assert.equal(a.value, b.value, `${cell} seed ${seed}`);
        assert.deepEqual(a.metrics, b.metrics, `${cell} seed ${seed}`);
        assert.equal(a.rejections.length, 0);
      }
    }
  } finally { m.server.close(); }
});
