import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode } from "../../harness/episode.ts";
import { readManifest } from "../../harness/manifest.ts";
import { stream } from "../../harness/prng.ts";
import { dlcBaselines } from "./baselines.ts";
import { Model, evaluateDesign, optimize, segmentsOf, type Contract, type Design, type Menu } from "./contract.ts";
import { menuOf, modelFor, parseDesign } from "./designs.ts";
import { binaryPrefixCount, groupByIgnoringDigits, prefixCount } from "./digits.ts";
import { DlcEnv, viewOf } from "./env.ts";
import { fixtureBytes, generateFixture } from "./generate.ts";
import { cetCount, modifiedPayout, runsByScan, type PayoutFunction, type Piece } from "./payout.ts";
import { dlcFixture, loadDlcConfig } from "./task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const config = loadDlcConfig(root);
const manifest = readManifest(root);

test("numeric outcome compression: the specification's examples", () => {
  // NumericOutcomeCompression.md, concrete example: [135677, 138621] in base 10 needs 20 prefixes.
  const base10 = groupByIgnoringDigits(135677, 138621, 10, 6);
  assert.equal(base10.length, 20);
  assert.ok(base10.every((p) => p[0] === 1 && p[1] === 3), "every prefix carries the shared digits 13");
  assert.deepEqual(base10[0], [1, 3, 5, 6, 7, 7]);
  assert.deepEqual(base10[base10.length - 1], [1, 3, 8, 6, 2, 1]);
  // The endpoint optimization example: [2200, 4999] becomes 22__, 23__ … 29__, 3___, 4___.
  assert.deepEqual(groupByIgnoringDigits(2200, 4999, 10, 4), [[2, 2], [2, 3], [2, 4], [2, 5], [2, 6], [2, 7], [2, 8], [2, 9], [3], [4]]);
  // The binary example, [5677, 8621] in 14 digits. The narrative counts 14 before introducing the
  // endpoint optimization; the algorithm merges 10000110101100 with the endpoint 8621 into one prefix.
  const binary = groupByIgnoringDigits(5677, 8621, 2, 14);
  assert.equal(binary.length, 13);
  assert.deepEqual(binary[binary.length - 1], [1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0]);
  // The total optimization, and its refusal for a single-outcome DLC.
  assert.deepEqual(groupByIgnoringDigits(4, 7, 2, 4), [[0, 1]]);
  assert.throws(() => groupByIgnoringDigits(0, 15, 2, 4), /only one outcome/);
});

test("the prefix counters equal the length of the specification's grouping", () => {
  const rng = stream("dlc-test", "prefix");
  for (const [base, digits] of [[2, 12], [10, 5], [3, 7]] as const) {
    const max = base ** digits - 1;
    for (let k = 0; k < 400; k++) {
      const a = rng.int(max + 1);
      const b = rng.int(max + 1);
      const [s, e] = a <= b ? [a, b] : [b, a];
      if (s === 0 && e === max) continue;
      const n = groupByIgnoringDigits(s, e, base, digits).length;
      assert.equal(prefixCount(s, e, base, digits), n, `base ${base} [${s}, ${e}]`);
      if (base === 2) assert.equal(binaryPrefixCount(s, e, digits), n, `binary [${s}, ${e}]`);
    }
  }
  // Intervals around every power of two, where the bit tricks are most likely to slip.
  for (let k = 1; k < 20; k++) for (const [s, e] of [[2 ** k - 1, 2 ** k], [2 ** k, 2 ** (k + 1) - 1], [1, 2 ** k], [2 ** k - 3, 2 ** k + 5]]) {
    if (s! < 0 || e! > 2 ** 20 - 1) continue;
    assert.equal(binaryPrefixCount(s!, e!, 20), groupByIgnoringDigits(s!, e!, 2, 20).length, `[${s}, ${e}]`);
  }
});

const vectorsDir = join(root, "vendor/dlcspecs/test/test_vectors");

test("the specification's single-oracle numeric test vectors: adaptor-signature counts", { skip: !existsSync(vectorsDir) && "vendor/dlcspecs is not checked out (see the README)" }, () => {
  type P = { eventOutcome: number; outcomePayout: number; extraPrecision: number };
  const pt = (p: P) => ({ x: p.eventOutcome, y: p.outcomePayout + p.extraPrecision / 65536 });
  for (const [file, expected] of [["single_oracle_numerical_test.json", 14], ["single_oracle_numerical_hyperbola_test.json", 56]] as const) {
    const j = JSON.parse(readFileSync(join(vectorsDir, file), "utf8"));
    const info = j.offer_message.message.contractInfo.singleContractInfo;
    const desc = info.contractInfo.contractDescriptor.numericOutcomeContractDescriptor;
    const fn: PayoutFunction = {
      pieces: desc.payoutFunction.payoutFunctionPieces.map((p: { endPoint: P; payoutCurvePiece: { polynomialPayoutCurvePiece?: { payoutPoints: P[] }; hyperbolaPayoutCurvePiece?: { usePositivePiece: boolean; translateOutcome: number; translatePayout: number; a: number; b: number; c: number; d: number } } }) => {
        const c = p.payoutCurvePiece;
        const piece: Piece = c.polynomialPayoutCurvePiece
          ? { kind: "polynomial", points: c.polynomialPayoutCurvePiece.payoutPoints.map(pt) }
          : { kind: "hyperbola", usePositivePiece: c.hyperbolaPayoutCurvePiece!.usePositivePiece, f1: c.hyperbolaPayoutCurvePiece!.translateOutcome, f2: c.hyperbolaPayoutCurvePiece!.translatePayout, a: c.hyperbolaPayoutCurvePiece!.a, b: c.hyperbolaPayoutCurvePiece!.b, c: c.hyperbolaPayoutCurvePiece!.c, d: c.hyperbolaPayoutCurvePiece!.d };
        return { left: pt(p.endPoint), piece };
      }),
      last: pt(desc.payoutFunction.lastEndpoint),
    };
    const intervals = desc.roundingIntervals.intervals.map((r: { beginInterval: number; roundingMod: number }) => ({ begin: r.beginInterval, mod: r.roundingMod }));
    const runs = runsByScan((x) => modifiedPayout(fn, intervals, info.totalCollateral, x), 2 ** desc.numDigits - 1);
    assert.equal(cetCount(runs, 2, desc.numDigits), expected, file);
    assert.equal(j.accept_message.message.cetAdaptorSignatures.ecdsaAdaptorSignatures.length, expected);
    assert.equal(j.sign_message.message.cetAdaptorSignatures.ecdsaAdaptorSignatures.length, expected);
  }
});

/** A small contract for brute force: 12 digits, small notional, so floating-point division is exact enough to agree with integer rounding. */
const small = (notional: number, spot: number, cpc: number): Contract => ({ num_digits: 12, notional_usd: notional, forecast: { spot_usd: spot, annual_volatility: 0.6, days: 30 }, capital_rate_annual: 0.05, sats_per_cet: cpc });

/** Brute force: evaluate the specification's modified payout at every outcome, then count and sum. */
function bruteForce(model: Model, design: Design): { cets: number; tracking: number } {
  const fn: PayoutFunction = { pieces: [{ left: { x: 0, y: design.collateral_sats }, piece: { kind: "polynomial", points: [] } }, { left: { x: 1, y: model.d }, piece: { kind: "hyperbola", usePositivePiece: true, f1: 0, f2: 0, a: 1, b: 0, c: 0, d: model.d } }], last: { x: model.maxOutcome, y: model.d / model.maxOutcome } };
  const intervals = design.rounding_intervals.map((r) => ({ begin: r.begin_interval, mod: r.rounding_mod }));
  const at = (x: number) => (x === 0 ? design.collateral_sats : modifiedPayout(fn, intervals, design.collateral_sats, x));
  const runs = runsByScan(at, model.maxOutcome);
  let tracking = 0;
  for (let x = 1; x <= model.maxOutcome; x++) tracking += model.p[x]! * Math.abs(at(x) - Math.min(model.d / x, design.collateral_sats));
  return { cets: cetCount(runs, 2, model.contract.num_digits), tracking };
}

test("the exact fast path agrees with evaluating every outcome as the specification does", () => {
  const rng = stream("dlc-test", "brute");
  const mods = [1, 3, 10, 50, 100, 1000];
  for (let k = 0; k < 40; k++) {
    const model = new Model(small(1 + rng.int(9), 300 + rng.int(1500), 1));
    const C = Math.ceil(model.d / (50 + rng.int(500)));
    const begins = [...new Set(Array.from({ length: rng.int(5) }, () => rng.int(model.maxOutcome)))].sort((a, b) => a - b);
    const design: Design = { collateral_sats: C, rounding_intervals: begins.map((b) => ({ begin_interval: b, rounding_mod: mods[rng.int(mods.length)]! })) };
    const fast = evaluateDesign(model, design);
    const brute = bruteForce(model, design);
    assert.equal(fast.cets, brute.cets, `case ${k}: ${JSON.stringify(design)}`);
    assert.ok(Math.abs(fast.tracking_sats - brute.tracking) <= 1e-9 * Math.max(1, brute.tracking), `case ${k}: tracking ${fast.tracking_sats} vs ${brute.tracking}`);
  }
});

test("the optimizer is exact: it matches enumeration of every design on a small menu", () => {
  const model = new Model(small(5, 900, 2));
  const menu: Menu = { breakpoints: [0, 400, 800, 1300], rounding_mods: [1, 20, 300], collateral_options: [Math.ceil(model.d / 300), Math.ceil(model.d / 500), Math.ceil(model.d / 700)] };
  let best = Number.POSITIVE_INFINITY;
  for (const C of menu.collateral_options) {
    for (let code = 0; code < menu.rounding_mods.length ** menu.breakpoints.length; code++) {
      let c = code;
      const intervals = menu.breakpoints.map((b) => { const m = menu.rounding_mods[c % 3]!; c = Math.floor(c / 3); return { begin_interval: b, rounding_mod: m }; });
      best = Math.min(best, evaluateDesign(model, { collateral_sats: C, rounding_intervals: intervals }).total_sats);
    }
  }
  const opt = optimize(model, menu);
  assert.ok(Math.abs(opt.costs.total_sats - best) <= 1e-9 * best, `optimizer ${opt.costs.total_sats}, enumeration ${best}`);
  assert.ok(Math.abs(evaluateDesign(model, opt.design).total_sats - opt.costs.total_sats) <= 1e-9 * best, "the optimizer's own accounting agrees with the evaluator");
});

test("the rounding rule: nearest multiple, ties up, then clamped; outcome 0 pays the collateral", () => {
  const model = new Model(small(1, 1000, 1)); // d = 1e8
  assert.equal(model.value(0, 10, 123), 123);
  assert.equal(model.value(1, 10, 2e8), 1e8); // d/1 = 1e8, already a multiple
  assert.equal(model.value(1, 10, 5e7), 5e7); // clamped
  // d/x = 1e8/3 = 33333333.33…: to the nearest 10 is 33333330, to the nearest 1000 is 33333000.
  assert.equal(model.value(3, 10, 2e8), 33333330);
  assert.equal(model.value(3, 1000, 2e8), 33333000);
  // A tie rounds up: d/x = 1e8/16 = 6250000, with modulus 1e6 that is 6.25e6 → 6e6 (not a tie); 1e8/80 = 1250000 → 1e6 with modulus 5e5 is a tie at 1.25e6 → 1.5e6.
  assert.equal(model.value(80, 500000, 2e8), 1500000);
  // Segments: an interval list that begins above 0 leaves modulus 1 below it (NumericOutcome.md).
  assert.deepEqual(segmentsOf(model, [{ begin_interval: 100, rounding_mod: 10 }]), [{ x0: 0, x1: 99, m: 1 }, { x0: 100, x1: 4095, m: 10 }]);
  assert.deepEqual(segmentsOf(model, []), [{ x0: 0, x1: 4095, m: 1 }]);
});

test("fixtures regenerate byte for byte from their seeds", () => {
  for (const cell of Object.keys(config.cells).sort()) {
    for (const seed of [0, 1, 1000]) {
      const committed = readFileSync(join(root, `fixtures/dlc/${cell}/seed-${String(seed).padStart(4, "0")}.json`), "utf8");
      assert.equal(fixtureBytes(generateFixture(seed, cell, config.cells[cell]!, config)), committed, `${cell} seed ${seed}`);
    }
  }
});

test("the environment: menus, rejections as identity, probes, and the penalty for offering nothing", async () => {
  const fixture = dlcFixture(root, manifest, "stable_30d", 0);
  const view = viewOf(fixture);
  const menu = menuOf(view);
  // Parser: every way out of the menu is named.
  assert.equal("reason" in parseDesign({ collateral_sats: 1, rounding_intervals: [] }, menu) && parseDesign({ collateral_sats: 1, rounding_intervals: [] }, menu).reason, "out_of_grid");
  assert.equal((parseDesign({ collateral_sats: menu.collateral_options[0]! + 0.5 }, menu) as { reason: string }).reason, "not_integer");
  assert.equal((parseDesign({ collateral_sats: menu.collateral_options[0], rounding_intervals: [{ begin_interval: 7, rounding_mod: 10 }] }, menu) as { reason: string }).reason, "out_of_grid");
  assert.equal((parseDesign({ collateral_sats: menu.collateral_options[0], rounding_intervals: [{ begin_interval: 0, rounding_mod: 7 }] }, menu) as { reason: string }).reason, "out_of_grid");
  assert.equal((parseDesign({ collateral_sats: menu.collateral_options[0], rounding_intervals: [{ begin_interval: menu.breakpoints[2], rounding_mod: 10 }, { begin_interval: menu.breakpoints[1], rounding_mod: 10 }] }, menu) as { reason: string }).reason, "malformed");
  assert.ok("design" in parseDesign({ collateral_sats: menu.collateral_options[0] }, menu), "no intervals is the specification's default");

  const env = new DlcEnv(fixture, config);
  const before = env.snapshot();
  const bad = env.step({ tool: "offer", args: { collateral_sats: 1 } });
  assert.equal(bad.accepted, false);
  assert.equal(env.snapshot(), before, "a rejected offer changes nothing");
  assert.equal(env.budget().attempts, config.budget.attempts - 1, "and still costs an attempt");
  const design = { collateral_sats: menu.collateral_options[3]!, rounding_intervals: [{ begin_interval: 0, rounding_mod: 1000 }] };
  const probe = env.step({ tool: "probe", args: design });
  assert.equal(probe.accepted, true);
  assert.equal(env.budget().probes, config.budget.probes - 1);
  const offered = env.step({ tool: "offer", args: design });
  assert.equal(offered.accepted, true);
  assert.equal(env.done(), true);
  const out = env.finish();
  assert.equal(out.metrics.cost_sats, evaluateDesign(modelFor(fixture.contract), design).total_sats);
  assert.deepEqual(probe.result, offered.result);

  const quitter = new DlcEnv(fixture, config);
  quitter.step({ tool: "commit" });
  assert.equal(quitter.finish().metrics.cost_sats, config.infeasible_penalty_factor * quitter.floorCost());
});

test("baselines on a development seed: ordered floor < reference ≤ exact, each through act", async () => {
  for (const cell of Object.keys(config.cells).sort()) {
    const fixture = dlcFixture(root, manifest, cell, 1);
    const rows = new Map<string, number>();
    for (const agent of dlcBaselines(config.default_floor_ratio)) {
      const row = await runEpisode(new DlcEnv(fixture, config), agent);
      assert.equal(row.rejections.length, 0, `${agent.id} on ${cell}`);
      rows.set(agent.id, row.value);
    }
    assert.ok(rows.get("uniform_tuned")! > rows.get("spec_default")!, `${cell}: reference above floor`);
    for (const [id, v] of rows) assert.ok(v <= rows.get("exact")! + 1e-9, `${cell}: ${id} above the ceiling`);
    assert.ok(rows.get("two_band")! >= rows.get("uniform_tuned")! - 1e-9, `${cell}: two_band includes the uniform designs`);
  }
});

test("the LLM path: the prompt lists every menu value, and a model that echoes dlc_design scores the ceiling", async () => {
  const { createServer } = await import("node:http");
  const { ChatAgent } = await import("../../agents/chat.ts");
  const { dlcDesignSkill } = await import("../../agents/skills.ts");
  const { dlcPrompt } = await import("./prompt.ts");
  const fixture = dlcFixture(root, manifest, "mobile_signer", 2);
  let planned: unknown = null;
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
      requests.push(body);
      const turn = body.messages.filter((m) => m.role === "assistant").length;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: turn === 0 ? '{"skill":"dlc_design","args":{}}' : JSON.stringify(planned), reasoning_content: "" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const agent = new ChatAgent({
      name: "mock", baseUrl: `http://127.0.0.1:${port}/v1`, model: "mock",
      sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, max_tokens: 1024, seed: 1 }, thinking: false,
      identity: { model_sha256: "0".repeat(64), runtime: "mock" }, prompt: dlcPrompt(1024), skills: [dlcDesignSkill],
      onExchange: (e) => { if (e.skill) planned = e.skill.result; },
    });
    const row = await runEpisode(new DlcEnv(fixture, config), agent);
    assert.equal(row.rejections.length, 0);
    const exact = await runEpisode(new DlcEnv(fixture, config), dlcBaselines(config.default_floor_ratio).find((a) => a.id === "exact")!);
    assert.equal(row.value, exact.value);
    const [system, first] = [requests[0]!.messages[0]!.content, requests[0]!.messages[1]!.content];
    for (const c of fixture.collateral_options) assert.ok(first.includes(`${c.collateral_sats} ${c.floor_price_usd} `), `collateral ${c.collateral_sats} listed`);
    for (const b of fixture.breakpoints) assert.ok(first.includes(`\n${b} `), `breakpoint ${b} listed`);
    assert.ok(!/\{\w+\}/.test(system.replace(/\{"[^}]*\}/g, "")), "no template placeholder is left unfilled");
    // The examples in the system prompt are valid designs, and expensive ones.
    const example = JSON.parse(system.split("\n").find((l) => l.startsWith('{"tool":"offer"'))!) as { args: unknown };
    const parsed = parseDesign(example.args, menuOf(viewOf(fixture)));
    assert.ok("design" in parsed);
    assert.ok(evaluateDesign(modelFor(fixture.contract), parsed.design).total_sats > 10 * exact.metrics.cost_sats!);
  } finally { server.close(); }
});
