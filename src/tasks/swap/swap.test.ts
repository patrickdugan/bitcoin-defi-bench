import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode } from "../../harness/episode.ts";
import type { Json } from "../../harness/json.ts";
import { swapWorkflowSkill } from "../../agents/skills.ts";
import { Careful, Idle, Oracle, Trusting, WORKFLOW, swapBaselines } from "./baselines.ts";
import { ALL_TOOLS, DAG_NEXT, NODE_TOOL, TOOL_NODE, allowedTools } from "./dag.ts";
import { SwapEnv } from "./env.ts";
import { generateFixture, type DeskType, type SwapConfig, type SwapFixture } from "./generate.ts";
import { swapPrompt } from "./prompt.ts";
import { parseHtlc } from "./script.ts";
import { ceilingOf, feeAt } from "./world.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const config = JSON.parse(readFileSync(join(root, "config/swap.json"), "utf8")) as SwapConfig;
const fixture = (cell: string, seed: number): SwapFixture => generateFixture(seed, cell, config.cells[cell]!, config);
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** The first seed in [0, 400) whose desk has this behaviour. */
function ofType(type: DeskType, cell = "calm", from = 0): SwapFixture {
  for (let seed = from; seed < 400; seed++) {
    const f = fixture(cell, seed);
    if (f.desk.type === type) return f;
  }
  throw new Error(`no ${type} desk in 400 seeds`);
}

const act = (env: SwapEnv, tool: string, args: Json = {}) => env.step({ tool, args });

test("the DAG is BitAgent's v3 graph: every edge lands on a node, complete is terminal, start opens at observe", () => {
  const nodes = Object.keys(DAG_NEXT);
  assert.equal(nodes.length, 13);
  for (const targets of Object.values(DAG_NEXT)) for (const t of targets) assert.ok(nodes.includes(t));
  assert.deepEqual(DAG_NEXT.complete, []);
  assert.deepEqual(allowedTools("start"), ["market.observe"]);
  assert.deepEqual(allowedTools("approval"), ["host.execute_approved", "host.refresh_evidence", "host.resume_persisted_state", "incident.revoke_and_freeze"]);
  assert.equal(ALL_TOOLS.length, 14);
  assert.ok(!ALL_TOOLS.includes("host.request_clarification"));
  for (const [node, tool] of Object.entries(NODE_TOOL)) assert.equal(TOOL_NODE[tool], node);
});

test("fixtures are deterministic and both scripts decode to the quote's terms", () => {
  const a = fixture("spiky", 3);
  assert.deepEqual(fixture("spiky", 3), a);
  assert.equal(a.fees.length, a.horizon_height - a.start_height + 1);
  const inHtlc = parseHtlc(Buffer.from(a.in_script, "hex"));
  assert.ok(!("error" in inHtlc));
  assert.equal(hex(inHtlc.digest), a.customer.digest);
  assert.equal(hex(inHtlc.claimPkh), a.desk.claim_pubkey_hash);
  assert.equal(hex(inHtlc.refundPkh), a.customer.refund_pubkey_hash);
  assert.equal(inHtlc.locktime, a.quote.in_timeout_height);
  const f = ofType("honest");
  const out = parseHtlc(Buffer.from(f.desk.payout_script!, "hex"));
  assert.ok(!("error" in out));
  assert.equal(hex(out.claimPkh), f.customer.claim_pubkey_hash);
  assert.equal(out.locktime, f.desk.lock_height! + config.out_timeout_blocks);
});

test("the host admits only allowed edges, and a rejection is the identity on state", () => {
  const env = new SwapEnv(fixture("calm", 0), config);
  const before = env.snapshot();
  assert.equal(act(env, "host.execute_approved").reason, "unknown_node");
  assert.equal(act(env, "host.sign_everything").reason, "unknown_tool");
  assert.equal(env.step("not an object").reason, "malformed");
  assert.equal(env.snapshot(), before);
  assert.equal(env.budget().attempts, config.budget.attempts - 3);
  assert.ok(act(env, "market.observe").accepted);
  assert.equal(act(env, "host.inspect_evidence", { action: "steal" }).reason, "malformed");
});

/** Run fund_in through the whole DAG pass from start. */
function fundPass(env: SwapEnv): void {
  for (const [tool, args] of [["market.observe", {}], ["host.inspect_evidence", { action: "fund_in" }], ["host.validate_arguments", {}], ["host.simulate_action", {}], ["host.display_exact_effects_and_fees", {}], ["wallet.request_approval", {}], ["host.execute_approved", {}], ["host.verify_effect", {}], ["host.reconcile_ledger", {}], ["host.persist_verified_state", {}]] as const) {
    assert.ok(act(env, tool, args as Json).accepted, tool);
  }
}

/** An honest desk whose clearing rate stays above 1 sat/vB through its window, so a 1 sat/vB claim stays pending. */
function honestAboveOne(): SwapFixture {
  for (let seed = 0; seed < 400; seed++) {
    const f = fixture("calm", seed);
    if (f.desk.type !== "honest") continue;
    let ok = true;
    for (let h = f.desk.lock_height!; h <= f.desk.out_timeout_height! + 1; h++) if (feeAt(f, h) <= 1) ok = false;
    if (ok) return f;
  }
  throw new Error("none");
}

test("refunds wait for the locktime, an approval is good only in its block, and a replacement must bid more", () => {
  const f = honestAboveOne();
  const env = new SwapEnv(f, config);
  fundPass(env);
  assert.ok(act(env, "market.observe").accepted);
  assert.ok(act(env, "host.hold_for_review", { blocks: f.desk.lock_height! - f.start_height }).accepted);
  assert.ok(act(env, "market.observe").accepted);
  assert.ok(act(env, "host.inspect_evidence", { action: "refund_in" }).accepted);
  assert.equal(act(env, "host.validate_arguments", { fee_rate: 5 }).reason, "not_final");
  assert.ok(act(env, "market.observe").accepted);
  assert.ok(act(env, "host.inspect_evidence", { action: "claim_out" }).accepted);
  assert.equal(act(env, "host.validate_arguments", { fee_rate: 2.5 }).reason, "not_integer");
  assert.ok(act(env, "host.validate_arguments", { fee_rate: 1 }).accepted);
  assert.ok(act(env, "host.simulate_action").accepted);
  assert.ok(act(env, "host.display_exact_effects_and_fees").accepted);
  // A block passes between display and approval: the approval is refused as stale.
  assert.ok(act(env, "host.hold_for_review", { blocks: 1 }).accepted);
  assert.ok(act(env, "host.refresh_evidence").accepted);
  assert.equal(act(env, "wallet.request_approval").reason, "stale");
  // Redo the pass in this block, broadcast at 1 sat/vB, then try to replace it at the same rate.
  assert.ok(act(env, "host.validate_arguments", { fee_rate: 1 }).accepted);
  for (const t of ["host.simulate_action", "host.display_exact_effects_and_fees", "wallet.request_approval", "host.execute_approved", "host.verify_effect", "host.reconcile_ledger", "host.persist_verified_state", "market.observe"]) assert.ok(act(env, t).accepted, t);
  assert.ok(act(env, "host.inspect_evidence", { action: "claim_out" }).accepted);
  assert.equal(act(env, "host.validate_arguments", { fee_rate: 1 }).reason, "below_minimum");
  assert.ok(act(env, "host.validate_arguments", { fee_rate: 2 }).accepted);
});

test("a quote not funded in its block expires and ends the phase at 0", () => {
  const env = new SwapEnv(ofType("honest"), config);
  assert.ok(act(env, "market.observe").accepted);
  assert.ok(act(env, "host.inspect_evidence", { action: "fund_in" }).accepted);
  assert.ok(act(env, "host.validate_arguments").accepted);
  assert.ok(act(env, "host.hold_for_review", { blocks: 1 }).accepted);
  assert.ok(env.done());
  assert.equal(env.finish().value, 0);
});

test("idle earns 0; the oracle earns exactly the ceiling and no baseline beats it", async () => {
  for (const cell of Object.keys(config.cells)) {
    for (let seed = 0; seed < 24; seed++) {
      const f = fixture(cell, seed);
      const ceiling = ceilingOf(f).value;
      const values = new Map<string, number>();
      for (const agent of swapBaselines()) values.set(agent.id, (await runEpisode(new SwapEnv(f, config), agent)).value);
      assert.equal(values.get("idle"), 0, `${cell} ${seed}`);
      assert.equal(values.get("oracle"), ceiling, `${cell} ${seed}`);
      for (const [id, v] of values) assert.ok(v <= ceiling, `${id} beat the oracle on ${cell} ${seed}`);
    }
  }
});

test("broadcasting the preimage on a lock that is reorganized out loses the in-payment; waiting refunds it", async () => {
  const f = ofType("double_spend");
  const fundFee = f.vbytes.fund * feeAt(f, f.start_height);
  const trusting = await runEpisode(new SwapEnv(f, config), new Trusting());
  assert.equal(trusting.value, -f.quote.amount_in_sats - fundFee);
  assert.equal(trusting.metrics.lost, 1);
  const careful = await runEpisode(new SwapEnv(f, config), new Careful("workflow", WORKFLOW));
  assert.equal(careful.metrics.refunded, 1);
  assert.equal(careful.metrics.revealed, 0);
  assert.equal(careful.metrics.host_refund, 1);
  const refundFee = f.vbytes.refund * config.fallback_fee_multiplier * feeAt(f, f.quote.in_timeout_height);
  assert.equal(careful.value, -fundFee - refundFee);
});

test("a claim that cannot confirm before the desk's refund height loses; the workflow freezes instead", async () => {
  const f = ofType("short_timeout");
  const careful = await runEpisode(new SwapEnv(f, config), new Careful("workflow", WORKFLOW));
  assert.equal(careful.metrics.revealed, 0);
  assert.equal(careful.metrics.refunded, 1);
  if (f.desk.out_timeout_height === f.desk.lock_height) {
    const trusting = await runEpisode(new SwapEnv(f, config), new Trusting());
    assert.equal(trusting.metrics.lost, 1);
  }
});

test("an absent desk: the armed refund returns the in-payment after the in-timeout", async () => {
  const f = ofType("absent");
  const row = await runEpisode(new SwapEnv(f, config), new Trusting());
  assert.equal(row.metrics.refunded, 1);
  assert.equal(row.metrics.host_refund, 1);
  assert.ok(row.value < 0 && row.value > -20_000);
  assert.equal((await runEpisode(new SwapEnv(f, config), new Oracle())).value, 0);
  assert.equal((await runEpisode(new SwapEnv(f, config), new Idle())).value, 0);
});

test("episodes are deterministic", async () => {
  const f = fixture("spiky", 5);
  const a = new SwapEnv(f, config);
  const b = new SwapEnv(f, config);
  const ra = await runEpisode(a, new Careful("workflow", WORKFLOW));
  const rb = await runEpisode(b, new Careful("workflow", WORKFLOW));
  assert.deepEqual(ra, rb);
  assert.equal(a.snapshot(), b.snapshot());
});

test("the swap_workflow skill returns the workflow's next action, and the prompt renders", async () => {
  const f = ofType("honest");
  const env = new SwapEnv(f, config);
  const history: Json[] = [];
  const policy = new Careful("workflow", WORKFLOW);
  policy.reset();
  let last: Json = null;
  for (let turn = 0; !env.done() && turn < 200; turn++) {
    const o = { bench: "x", task: env.task, episode: { seed: f.seed, cell: env.cell, turn }, budget: { ...env.budget() }, tools: env.tools(), view: env.view(), last } as unknown as Json;
    history.push(o);
    const fromSkill = swapWorkflowSkill.run(o, {}, history);
    const fromPolicy = policy.act(JSON.parse(JSON.stringify(o)) as Json);
    assert.deepEqual(fromSkill, fromPolicy);
    if (turn === 0) {
      const p = swapPrompt(256);
      assert.match(p.system(o), /BIP 199/);
      assert.match(p.turn(o), /Tools admitted now: market\.observe/);
    }
    const r = env.step(fromSkill);
    last = { accepted: r.accepted, reason: r.reason, result: r.result } as Json;
  }
  assert.equal(env.finish().metrics.completed, 1);
});
