// Train a complex package's gate on the proposer's own development near-misses.
//
//   node --experimental-strip-types scripts/train_complex_gate.ts --package server_sizing
//   ... --package server_sizing --curriculum skill
//
// The curriculum is the proposer's own development transcripts: real failures, not synthetic ones (the
// paper's §6 found that gates trained on synthetic defects do not transfer). By default the proposer
// is bare Bonsai 8B and the gate is written to <package>.json. With --curriculum skill the proposer is
// the skill agent of the same cell (the combo), its skill calls are skipped and only its actions are
// read, and the gate is written to <package>.skill-proposer.json.
// Each episode is replayed in a fresh environment from the logged actions, and the replay must reach
// the recorded row. A row is a turn whose proposal passes the package's rules and differs from the
// skill's action; nothing else reaches the gate. Its label comes from two rollouts on the same
// development seed, each following the skill after the turn: one sends the proposal, the other the
// skill's action. The label is commit when the proposal's rollout scores strictly higher, else the
// skill's action. Training uses development seeds 0 to 5, validation 6 and 7, five network seeds,
// and the majority at play. With fewer than 20 rows, or labels that never disagree, the gate is the
// majority label as a constant rule and no network is trained. Development seeds only: the
// confirmatory block is never read.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Environment } from "../src/harness/agent.ts";
import { lastOf, observationOf } from "../src/harness/episode.ts";
import { canonical, type Json } from "../src/harness/json.ts";
import { readManifest } from "../src/harness/manifest.ts";
import type { RunRecord } from "../src/harness/run.ts";
import { loadNostrConfig, nostrEpisodes, type NostrCell } from "../src/tasks/nostr/task.ts";
import { loadServerSizingConfig, serverSizingEpisodes } from "../src/tasks/server_sizing/task.ts";
import { features, verify, type GateJson, type Turn } from "../src/agents/complex.ts";
import { loadPackage } from "../src/agents/complex/packages.ts";
import { train, type TrmRow } from "../src/agents/trm.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback === undefined) throw new Error(`missing --${name}`);
  return fallback;
};

const file = arg("package");
const curriculum = arg("curriculum", "bare");
if (curriculum !== "bare" && curriculum !== "skill") throw new Error("--curriculum must be bare or skill");
const pkg = loadPackage(file);
const skill = pkg.code.skill;
const manifest = readManifest(root);
const sizingConfig = loadServerSizingConfig(root);
const nostrConfig = loadNostrConfig(root);

/** The bare development runs whose proposals make the curriculum. */
const SOURCES: { [file: string]: string[] } = {
  server_sizing: ["v0-server-sizing-bonsai-8b-nothink-development"],
  nostr_custody: ["v0-nostr-custody-bonsai-8b-nothink-development"],
  nostr_custody_hot: ["v0-nostr-custody-hot-bonsai-8b-nothink-development"],
  nostr_publish: ["v0-nostr-publish-bonsai-8b-nothink-development"],
  nostr_private: ["v0-nostr-private-bonsai-8b-nothink-development"],
  nostr_counterparty: ["v0-nostr-counterparty-bonsai-8b-nothink-development"],
  nostr_mesh: ["v0-nostr-mesh-outage-bonsai-8b-nothink-development", "v0-nostr-mesh-partial-bonsai-8b-nothink-development"],
};
/** The skill agents' development runs, for a proposer that carries the skill. `private`'s did not complete (it outgrew the context), so its package has none. */
const SKILL_SOURCES: { [file: string]: string[] } = {
  server_sizing: ["v0-server-sizing-bonsai-8b-nothink-capacity_plan-development"],
  nostr_custody: ["v0-nostr-custody-bonsai-8b-nothink-custody_policy-development"],
  nostr_custody_hot: ["v0-nostr-custody-hot-bonsai-8b-nothink-inbox_policy-development"],
  nostr_publish: ["v0-nostr-publish-bonsai-8b-nothink-outbox_plan-development"],
  nostr_private: [],
  nostr_counterparty: ["v0-nostr-counterparty-bonsai-8b-nothink-buyer_plan-development"],
  nostr_mesh: ["v0-nostr-mesh-outage-bonsai-8b-nothink-mesh_router-development", "v0-nostr-mesh-partial-bonsai-8b-nothink-mesh_router-development"],
};
const sources = (curriculum === "skill" ? SKILL_SOURCES : SOURCES)[file]!;
const TRAIN_SEEDS = [0, 1, 2, 3, 4, 5];
const VALIDATION_SEEDS = [6, 7];
const NETWORK_SEEDS = [0, 1, 2, 3, 4];
const MIN_ROWS = 20;

function envFor(task: string, seed: number): Environment {
  const [family, cell] = task.split("/") as [string, string];
  if (family === "server_sizing") return serverSizingEpisodes(root, manifest, sizingConfig, cell, seed)[0]!;
  if (family === "nostr") return nostrEpisodes(root, manifest, nostrConfig, cell as NostrCell, seed)[0]!;
  throw new Error(`no environment for ${task}`);
}

/** Replay `prefix`, send `first`, then follow the skill to the end; the episode's native value. */
function rollout(task: string, seed: number, prefix: readonly Json[], first: Json): number {
  const env = envFor(task, seed);
  const history: Json[] = [];
  let last: Json = null;
  let turn = 0;
  const step = (choose: () => Json): void => {
    const o = observationOf(env, turn, last);
    history.push(JSON.parse(JSON.stringify(o)) as Json);
    last = lastOf(env.step(choose()));
    turn += 1;
  };
  for (const a of prefix) step(() => a);
  if (!env.done()) step(() => first);
  for (let guard = 0; !env.done(); guard++) {
    if (guard > 10000) throw new Error(`${task} seed ${seed}: rollout did not end`);
    step(() => skill.run(history.at(-1)!, {}, history));
  }
  return env.finish().value;
}

interface Row extends TrmRow { seed: number; task: string; turn: number; margin: number; proposal: Json; reference: Json }
const rows: Row[] = [];
let episodes = 0;
let turns = 0;
let illegal = 0;
let agreeing = 0;
for (const source of sources) {
  const record = JSON.parse(readFileSync(join(root, "results", `${source}.json`), "utf8")) as RunRecord;
  const agentId = record.agents.find((a) => !a.baseline)!.id;
  const byEpisode = new Map<string, Array<{ turn: number; action: Json }>>();
  for (const line of readFileSync(join(root, "results", `${source}.transcript.jsonl`), "utf8").split("\n")) {
    if (line === "") continue;
    const x = JSON.parse(line) as { episode: { task: string; seed: number }; turn: number; action: Json; skill?: unknown };
    if (x.skill) {
      if (curriculum === "bare") throw new Error(`${source} carries skill calls; the curriculum is the bare proposer's`);
      continue;
    }
    const key = `${x.episode.task}|${x.episode.seed}`;
    if (!byEpisode.has(key)) byEpisode.set(key, []);
    byEpisode.get(key)!.push({ turn: x.turn, action: x.action });
  }
  for (const [key, exchanges] of byEpisode) {
    const [task, seedText] = key.split("|") as [string, string];
    const seed = Number(seedText);
    const actions = exchanges.sort((a, b) => a.turn - b.turn).map((x) => x.action);
    // Replay: the observations the proposer saw, and the recorded row as a check.
    const env = envFor(task, seed);
    const history: Json[] = [];
    let last: Json = null;
    for (let t = 0; t < actions.length; t++) {
      history.push(JSON.parse(JSON.stringify(observationOf(env, t, last))) as Json);
      last = lastOf(env.step(actions[t]!));
    }
    const recorded = record.rows.find((r) => r.agent === agentId && r.task === task && r.seed === seed)!;
    if (!env.done() || env.finish().value !== recorded.value) throw new Error(`${source} ${key}: the replay does not reach the recorded row`);
    episodes += 1;
    for (let t = 0; t < actions.length; t++) {
      turns += 1;
      const h = history.slice(0, t + 1);
      const proposal = actions[t]!;
      const reference = skill.run(h[t]!, {}, h);
      const turn: Turn = { observation: h[t]!, history: h, proposal, reference };
      if (verify(pkg, turn, proposal) !== null) { illegal += 1; continue; }
      if (canonical(proposal) === canonical(reference)) { agreeing += 1; continue; }
      const commit = rollout(task, seed, actions.slice(0, t), proposal);
      const skillValue = rollout(task, seed, actions.slice(0, t), reference);
      rows.push({ x: features(pkg, turn), y: commit > skillValue ? 0 : 1, seed, task, turn: t, margin: commit - skillValue, proposal, reference });
    }
  }
}

const count = (rs: Row[], y: number): number => rs.filter((r) => r.y === y).length;
const trainRows = rows.filter((r) => TRAIN_SEEDS.includes(r.seed));
const validationRows = rows.filter((r) => VALIDATION_SEEDS.includes(r.seed));
const summary = {
  curriculum: sources, episodes, turns, illegal_proposals: illegal, agreeing_proposals: agreeing,
  rows: rows.length, train_rows: trainRows.length, validation_rows: validationRows.length,
  labels: { commit: count(rows, 0), reference: count(rows, 1) },
  commit_margin_mean: rows.length ? rows.reduce((s, r) => s + r.margin, 0) / rows.length : 0,
};

let gate: GateJson;
if (rows.length < MIN_ROWS || count(trainRows, 0) === 0 || count(trainRows, 1) === 0 || validationRows.length === 0) {
  const constant = count(rows, 0) > count(rows, 1) ? "commit" : "reference";
  gate = { kind: "trm-gate", package: { name: pkg.name, sha256: pkg.sha256 }, menu: pkg.gate, constant, models: [], training: { ...summary, rule: `constant: fewer than ${MIN_ROWS} rows, one label in training, or no validation rows` } as unknown as Json };
} else {
  const fits = NETWORK_SEEDS.map((seed) => train(trainRows, validationRows, { seed, k: pkg.gate.length }));
  const vote = (x: readonly number[]): number => {
    const v = pkg.gate.map(() => 0);
    for (const f of fits) v[f.model.predict(x)]! += 1;
    let best = pkg.gate.length - 1;
    for (let i = 0; i < v.length; i++) if (v[i]! > v[best]!) best = i;
    return best;
  };
  const accuracy = (rs: Row[]): number => rs.filter((r) => vote(r.x) === r.y).length / Math.max(1, rs.length);
  // A network earns its place only by beating, on the validation seeds, the constant rule of the training majority.
  const majority = count(trainRows, 0) > count(trainRows, 1) ? 0 : 1;
  const constantAccuracy = count(validationRows, majority) / validationRows.length;
  const networks = { network_seeds: NETWORK_SEEDS, checkpoints: fits.map((f) => f.step), validation_accuracy: fits.map((f) => f.valAccuracy), majority_train_accuracy: accuracy(trainRows), majority_validation_accuracy: accuracy(validationRows), constant_validation_accuracy: constantAccuracy };
  gate = accuracy(validationRows) > constantAccuracy
    ? { kind: "trm-gate", package: { name: pkg.name, sha256: pkg.sha256 }, menu: pkg.gate, constant: null, models: fits.map((f) => f.model.toJson()), training: { ...summary, ...networks } as unknown as Json }
    : { kind: "trm-gate", package: { name: pkg.name, sha256: pkg.sha256 }, menu: pkg.gate, constant: pkg.gate[majority === 0 ? 0 : pkg.gate.length - 1]!, models: [], training: { ...summary, ...networks, rule: "constant: the networks' majority did not beat the training majority's constant rule on the validation seeds" } as unknown as Json };
}
if (process.argv.includes("--show-commits")) {
  for (const r of rows.filter((x) => x.y === 0)) console.error(`commit ${r.task} seed ${r.seed} turn ${r.turn} +${r.margin}: proposal ${JSON.stringify(r.proposal).slice(0, 160)} | skill ${JSON.stringify(r.reference).slice(0, 160)}`);
}
const out = join(root, "src", "agents", "complex", "gates", `${file}${curriculum === "skill" ? ".skill-proposer" : ""}.json`);
writeFileSync(out, `${JSON.stringify(gate)}\n`);
console.log(JSON.stringify({ package: file, constant: gate.constant, ...(gate.training as object) }, null, 1));
