// The TRM complex: the package compiler, the rules against each package's own skill, the pipeline's
// stages, and the gate. A complex whose proposer always fails the rules, or always proposes the
// skill's action, must play the skill's baseline exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, Environment } from "../harness/agent.ts";
import { lastOf, observationOf, runEpisode } from "../harness/episode.ts";
import type { Json } from "../harness/json.ts";
import { readManifest } from "../harness/manifest.ts";
import { SEED_BLOCKS } from "../harness/seeds.ts";
import { loadNostrConfig, nostrBaselines, nostrEpisodes, type NostrCell } from "../tasks/nostr/task.ts";
import { serverSizingBaselines } from "../tasks/server_sizing/baselines.ts";
import { loadServerSizingConfig, serverSizingEpisodes } from "../tasks/server_sizing/task.ts";
import { COMMON_ATOMS, COMMON_RULES, Gate, TrmComplex, compilePackage, verify, type ComplexRecord, type GateJson, type PackageCode } from "./complex.ts";
import { loadPackage } from "./complex/packages.ts";
import { SKILLS } from "./skills.ts";
import { train } from "./trm.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = readManifest(root);
const sizingConfig = loadServerSizingConfig(root);
const nostrConfig = loadNostrConfig(root);

const CASES: Array<{ file: string; baseline: string; envs: (seed: number) => Environment[]; reference: () => Agent }> = [
  ...Object.keys(sizingConfig.cells).sort().map((cell) => ({ file: "server_sizing", baseline: "buffer_rule", envs: (seed: number) => serverSizingEpisodes(root, manifest, sizingConfig, cell, seed), reference: () => serverSizingBaselines(sizingConfig).find((b) => b.id === "buffer_rule")! })),
  ...([["custody", "policy"], ["custody_hot", "policy"], ["publish", "outbox"], ["private", "nip17"], ["counterparty", "reputation"], ["mesh_outage", "bitchat_router"], ["mesh_partial", "bitchat_router"]] as Array<[NostrCell, string]>).map(([cell, baseline]) => ({
    file: cell.startsWith("mesh") ? "nostr_mesh" : `nostr_${cell}`, baseline, envs: (seed: number) => nostrEpisodes(root, manifest, nostrConfig, cell, seed), reference: () => nostrBaselines(cell).find((b) => b.id === baseline)!,
  })),
];

const constantGate = (file: string, constant: string): Gate => {
  const pkg = loadPackage(file);
  return new Gate({ kind: "trm-gate", package: { name: pkg.name, sha256: pkg.sha256 }, menu: pkg.gate, constant, models: [], training: null });
};

/** A proposer that is not a language model: a fixed rule, with an identity. */
class Scripted implements Agent {
  readonly id: string;
  private readonly rule: (o: Json, history: Json[]) => Json;
  private history: Json[] = [];
  constructor(id: string, rule: (o: Json, history: Json[]) => Json) { this.id = id; this.rule = rule; }
  describe(): Json { return { scripted: this.id }; }
  reset(): void { this.history = []; }
  act(o: Json): Json { this.history.push(o); return this.rule(o, this.history); }
}

test("the compiler holds the code to exactly what the package declares", () => {
  const code: PackageCode = { skill: SKILLS.capacity_plan!, atoms: { ...COMMON_ATOMS }, rules: { ...COMMON_RULES }, operators: { reference: (t) => t.reference } };
  const head = "(complex x)\n(skill capacity_plan)\n";
  const atoms = Object.keys(COMMON_ATOMS).map((a) => `(atom ${a})`).join("\n");
  const rules = Object.keys(COMMON_RULES).map((r) => `(rule ${r})`).join("\n");
  const ok = `${head}${atoms}\n${rules}\n(operator reference)\n(gate commit reference)\n`;
  assert.equal(compilePackage(ok, code).atoms.length, Object.keys(COMMON_ATOMS).length);
  assert.throws(() => compilePackage(ok.replace("(atom turn)\n", ""), code), /implemented atom not declared: turn/);
  assert.throws(() => compilePackage(`${ok}(atom unheard-of)\n`, code), /declared atom not implemented: unheard-of/);
  assert.throws(() => compilePackage(ok.replace("(gate commit reference)", "(gate reference commit)"), code), /menu is commit followed/);
  assert.throws(() => compilePackage(ok.replace("capacity_plan", "custody_policy"), code), /declares skill custody_policy/);
  assert.throws(() => compilePackage(`${ok}(atom turn)\n`, code), /declared twice/);
});

test("every package's rules pass its own skill's action on every turn of the development seeds", () => {
  for (const c of CASES) {
    const pkg = loadPackage(c.file);
    for (const seed of SEED_BLOCKS.development) {
      const env = c.envs(seed)[0]!;
      const history: Json[] = [];
      let last: Json = null;
      for (let turn = 0; !env.done(); turn++) {
        history.push(JSON.parse(JSON.stringify(observationOf(env, turn, last))) as Json);
        const action = pkg.code.skill.run(history.at(-1)!, {}, history);
        const verdict = verify(pkg, { observation: history.at(-1)!, history, proposal: action, reference: action }, action);
        assert.equal(verdict, null, `${c.file} ${env.task} seed ${seed} turn ${turn}: ${verdict} on ${JSON.stringify(action)}`);
        last = lastOf(env.step(action));
      }
    }
  }
});

test("a complex whose proposer fails the rules on every turn is repaired to the skill's baseline exactly", async () => {
  for (const c of CASES) {
    const records: ComplexRecord[] = [];
    const agent = new TrmComplex({ name: "junk", proposer: new Scripted("junk", () => "no json here"), pkg: loadPackage(c.file), gate: constantGate(c.file, "commit"), onRecord: (r) => records.push(r) });
    for (const seed of SEED_BLOCKS.development.slice(0, 3)) {
      const a = await runEpisode(c.envs(seed)[0]!, agent);
      const b = await runEpisode(c.envs(seed)[0]!, c.reference());
      assert.equal(a.value, b.value, `${c.file} ${a.task} seed ${seed}`);
      assert.deepEqual(a.rejections, b.rejections);
    }
    assert.ok(records.length > 0 && records.every((r) => r.stage === "repair" && r.verdict?.startsWith("parses")), c.file);
  }
});

test("a complex whose proposer is the skill agrees on every turn and plays the baseline exactly", async () => {
  for (const c of CASES.filter((x) => x.file !== "server_sizing" || x.envs === CASES[0]!.envs)) {
    const pkg = loadPackage(c.file);
    const records: ComplexRecord[] = [];
    const proposer = new Scripted("skill", (o, h) => pkg.code.skill.run(o, {}, h));
    const agent = new TrmComplex({ name: "echo", proposer, pkg, gate: constantGate(c.file, "reference"), onRecord: (r) => records.push(r) });
    for (const seed of SEED_BLOCKS.development.slice(0, 3)) {
      assert.equal((await runEpisode(c.envs(seed)[0]!, agent)).value, (await runEpisode(c.envs(seed)[0]!, c.reference())).value, `${c.file} seed ${seed}`);
    }
    assert.ok(records.every((r) => r.stage === "agree"), c.file);
  }
});

test("a legal proposal that differs from the skill goes to the gate, which sends it or the skill's action", async () => {
  const hold = (): Json => ({ tool: "hold" });
  const env = (): Environment => serverSizingEpisodes(root, manifest, sizingConfig, "balanced", 0)[0]!;
  for (const [constant, sentHold] of [["commit", true], ["reference", false]] as const) {
    const records: ComplexRecord[] = [];
    const agent = new TrmComplex({ name: "hold", proposer: new Scripted("hold", hold), pkg: loadPackage("server_sizing"), gate: constantGate("server_sizing", constant), onRecord: (r) => records.push(r) });
    await runEpisode(env(), agent);
    const gated = records.filter((r) => r.stage === "gate");
    assert.ok(gated.length > 0);
    assert.ok(gated.every((r) => (JSON.stringify(r.sent) === JSON.stringify(hold())) === sentHold && r.choice === constant));
  }
});

test("the gate: majority over its networks, a tie to the skill's action, and its file bound into the complex's id", () => {
  const rows = [...Array(40).keys()].map((i) => ({ x: [i % 2, (i >> 1) % 2], y: i % 2 }));
  const fits = [0, 1, 2, 3].map((seed) => train(rows, rows, { seed, k: 2 }));
  const pkg = loadPackage("server_sizing");
  const file = (models: number[]): GateJson => ({ kind: "trm-gate", package: { name: pkg.name, sha256: pkg.sha256 }, menu: pkg.gate, constant: null, models: models.map((i) => fits[i]!.model.toJson()), training: null });
  const gate = new Gate(file([0, 1, 2]));
  assert.equal(gate.choose([1, 0]), "reference");
  assert.equal(gate.choose([0, 0]), "commit");
  const proposer = new Scripted("p", hold);
  const a = new TrmComplex({ name: "c", proposer, pkg, gate });
  const b = new TrmComplex({ name: "c", proposer, pkg, gate: new Gate(file([0, 1, 3])) });
  assert.notEqual(a.id, b.id);
  assert.throws(() => new TrmComplex({ name: "c", proposer, pkg: loadPackage("nostr_custody"), gate }), /was trained for package server_sizing/);
});

const hold = (): Json => ({ tool: "hold" });
