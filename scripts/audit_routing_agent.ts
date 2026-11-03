// Audit of a family 2 agent run whose rows are flagged `outside_calibration` (prereg/v0.md §9).
// The checks run in the order §9 lists them:
//
//   1. Identity controls. `prefix_oracle_3` equals `retry_wallet` in every episode of the record,
//      and a scripted retry wallet that reads only the request text, answering through the chat
//      adapter from a loopback server, delivers what the built-in `retry_wallet` delivered.
//   2. Observation leak. Each turn the model saw is re-rendered from a fresh environment and must
//      equal the transcript byte for byte; the view carries only public fields; and the three
//      balance models of a seed and regime, which differ only in hidden balances, must show the
//      same text at every turn whose earlier actions and outcomes agree.
//   3. Attempts charged. The logged actions, replayed through a fresh environment, reproduce the
//      agent's row (value, metrics, rejections); every rejection spends an attempt; no payment gets
//      more than the attempt budget.
//   4. Candidate order. The candidates of every turn are listed in catalog order, (hop count, node
//      sequence), which is a function of the public graph alone.
//
//   node --experimental-strip-types scripts/audit_routing_agent.ts \
//     --record results/v0-routing-<name>-confirmatory.json \
//     --transcript results/v0-routing-<name>-confirmatory.transcript.jsonl.gz

import { createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { ChatAgent, type Exchange } from "../src/agents/chat.ts";
import type { RunRecord } from "../src/harness/run.ts";
import { runEpisode, type EpisodeRow } from "../src/harness/episode.ts";
import { sha256, type Json } from "../src/harness/json.ts";
import { readManifest } from "../src/harness/manifest.ts";
import { cmpSeq } from "../src/harness/order.ts";
import type { BalanceModel } from "../src/tasks/placement/generate.ts";
import { loadPlacementConfig, placementFixture } from "../src/tasks/placement/task.ts";
import { RoutingEnv, type RoutingView } from "../src/tasks/routing/env.ts";
import type { RoutingRegime } from "../src/tasks/routing/generate.ts";
import { routingPrompt } from "../src/tasks/routing/prompt.ts";
import { routingTasks } from "../src/tasks/routing/report.ts";
import { demandsFor } from "../src/tasks/routing/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1]!;
};

const record = JSON.parse(readFileSync(arg("record"), "utf8")) as RunRecord;
const transcriptPath = arg("transcript");
const manifest = readManifest(root);
const config = loadPlacementConfig(root);
const agentId = record.agents.find((a) => !a.baseline)!.id;
const prompt = routingPrompt(Number((record.agents.find((a) => !a.baseline)!.details as { sampling: { max_tokens: number } }).sampling.max_tokens));
const tasks = new Map(routingTasks().map((t) => [t.task, t]));
const rowOf = (agent: string, task: string, seed: number): EpisodeRow => {
  const row = record.rows.find((r) => r.agent === agent && r.task === task && r.seed === seed);
  if (!row) throw new Error(`no ${agent} row for ${task} seed ${seed}`);
  return row;
};
const envFor = (task: string, seed: number): RoutingEnv => {
  const { model, regime } = tasks.get(task)!;
  return new RoutingEnv(placementFixture(root, manifest, seed), demandsFor(root, manifest, seed, regime), model, regime, config);
};
const failures: string[] = [];
const fail = (message: string): void => { if (failures.length < 20) console.error(`FAIL ${message}`); failures.push(message); };

// 1a. prefix_oracle_3 delivers exactly what retry_wallet delivers, episode by episode.
let identityEpisodes = 0;
for (const r of record.rows.filter((r) => r.agent === "retry_wallet")) {
  const p = rowOf("prefix_oracle_3", r.task, r.seed);
  if (p.metrics.delivery_hash !== r.metrics.delivery_hash || p.value !== r.value) fail(`prefix_oracle_3 differs from retry_wallet on ${r.task} seed ${r.seed}`);
  identityEpisodes += 1;
}
console.log(`1a identity: prefix_oracle_3 = retry_wallet in ${identityEpisodes} episodes`);

// 1b. A retry wallet scripted from the request text alone, through the chat adapter.
const scriptedReply = (user: string): string => {
  const block = user.slice(user.lastIndexOf("Candidates (index hops fee_msat path):"), user.lastIndexOf("Already tried for this payment:"));
  const candidates = [...block.matchAll(/^(\d+) (\d+) (\d+) (\S+)$/gm)].map((m) => ({ index: +m[1]!, hops: +m[2]!, fee: +m[3]!, path: m[4]!.split(">") }));
  const tried = user.slice(user.lastIndexOf("Already tried for this payment:")).match(/: ([^\n]*)/)![1]!;
  const n = tried === "nothing" ? 0 : tried.split(", ").length;
  const next = [...candidates].sort((a, b) => a.fee - b.fee || a.hops - b.hops || cmpSeq(a.path, b.path))[n];
  return next ? JSON.stringify({ tool: "attempt", args: { candidate: next.index } }) : JSON.stringify({ tool: "skip" });
};
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: scriptedReply(body.messages.at(-1)!.content), reasoning_content: "" } }] }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
let scriptedEpisodes = 0;
try {
  const port = (server.address() as { port: number }).port;
  const scripted = new ChatAgent({
    name: "scripted-retry-wallet", baseUrl: `http://127.0.0.1:${port}/v1`, model: "scripted",
    sampling: { temperature: 0, top_p: 1, top_k: 1, max_tokens: 128, seed: 0 }, thinking: false,
    identity: { model_sha256: "0".repeat(64), runtime: "scripted" }, prompt, contextTurns: 0,
  });
  for (const task of tasks.keys()) {
    for (const seed of record.seeds) {
      const row = await runEpisode(envFor(task, seed), scripted);
      const base = rowOf("retry_wallet", task, seed);
      if (row.metrics.delivery_hash !== base.metrics.delivery_hash || row.value !== base.value || row.metrics.failed_attempts !== base.metrics.failed_attempts) fail(`scripted retry wallet differs from retry_wallet on ${task} seed ${seed}`);
      scriptedEpisodes += 1;
    }
  }
} finally { server.close(); }
console.log(`1b identity: the scripted retry wallet through the chat adapter = retry_wallet in ${scriptedEpisodes} episodes`);

// 2–4. Replay the transcript through fresh environments.
const PUBLIC_VIEW_KEYS = ["attempts_left", "candidates", "demand", "history", "horizon", "tried"].join(",");
const textByPrefix = new Map<string, { text: string; models: Set<BalanceModel> }>();
let comparedAcrossModels = 0;
let turns = 0;
let rendered = 0;
let rejectionsCharged = 0;
let replayedEpisodes = 0;
let current: { key: string; task: string; seed: number; env: RoutingEnv; turn: number; last: Json; prefix: string; rejections: EpisodeRow["rejections"] } | null = null;

const closeEpisode = (): void => {
  if (!current) return;
  const { env, task, seed } = current;
  if (!env.done()) { fail(`${task} seed ${seed}: transcript ends before the episode does`); return; }
  const out = env.finish();
  const row = rowOf(agentId, task, seed);
  if (out.value !== row.value || JSON.stringify(out.metrics) !== JSON.stringify(row.metrics)) fail(`${task} seed ${seed}: replayed outcome differs from the record`);
  if (JSON.stringify(current.rejections) !== JSON.stringify(row.rejections)) fail(`${task} seed ${seed}: replayed rejections differ from the record`);
  if (current.turn !== row.turns) fail(`${task} seed ${seed}: ${current.turn} turns replayed, ${row.turns} recorded`);
  replayedEpisodes += 1;
};

const input = createReadStream(transcriptPath);
const lines = createInterface({ input: transcriptPath.endsWith(".gz") ? input.pipe(createGunzip()) : input, crlfDelay: Infinity });
for await (const line of lines) {
  if (line === "") continue;
  const x = JSON.parse(line) as Exchange;
  if (x.skill) { fail(`${x.episode.task} seed ${x.episode.seed} turn ${x.turn}: a skill call in a run with no skills`); continue; }
  const key = `${x.episode.task}|${x.episode.seed}`;
  if (!current || current.key !== key) {
    closeEpisode();
    current = { key, task: x.episode.task, seed: x.episode.seed, env: envFor(x.episode.task, x.episode.seed), turn: 0, last: null, prefix: "", rejections: [] };
  }
  const c = current;
  if (x.turn !== c.turn) fail(`${key}: turn ${x.turn} where ${c.turn} was expected`);
  const view = c.env.view() as unknown as RoutingView;

  // 2. The text is the renderer's, from public fields only, and blind to the balance model.
  if (Object.keys(view).sort().join(",") !== PUBLIC_VIEW_KEYS) fail(`${key} turn ${c.turn}: view has fields ${Object.keys(view).join(",")}`);
  const text = prompt.turn({ view, last: c.last } as unknown as Json);
  if (text !== x.user) fail(`${key} turn ${c.turn}: the transcript's turn differs from the rendered one`);
  else rendered += 1;
  const { model, regime } = tasks.get(c.task)!;
  const same = `${regime}|${c.seed}|${c.turn}|${sha256(c.prefix)}`;
  const seen = textByPrefix.get(same);
  if (!seen) textByPrefix.set(same, { text: sha256(x.user), models: new Set([model]) });
  else {
    comparedAcrossModels += 1;
    if (seen.text !== sha256(x.user)) fail(`${regime} seed ${c.seed} turn ${c.turn}: balance models with the same history saw different text`);
    seen.models.add(model);
  }

  // 4. Catalog order: indices 0..n-1, strictly increasing under (hop count, node sequence).
  view.candidates.forEach((cand, i) => {
    if (cand.index !== i) fail(`${key} turn ${c.turn}: candidate ${i} has index ${cand.index}`);
    const prev = view.candidates[i - 1];
    if (prev && !(prev.hops < cand.hops || (prev.hops === cand.hops && cmpSeq(prev.path, cand.path) < 0))) fail(`${key} turn ${c.turn}: candidates out of catalog order at ${i}`);
  });

  // 3. Step with the logged action; a rejection must spend exactly one attempt.
  const demandBefore = view.demand.i;
  const budgetBefore = c.env.budget().attempts;
  const result = c.env.step(x.action);
  if (c.env.budget().attempts !== budgetBefore - (x.action !== null && typeof x.action === "object" && (x.action as { tool?: unknown }).tool === "skip" && result.accepted ? 0 : 1)) fail(`${key} turn ${c.turn}: the attempt budget moved wrongly`);
  if (!result.accepted && result.reason !== null) {
    c.rejections.push({ turn: c.turn, reason: result.reason });
    // The spent attempt is the payment's last try: in `tried` while it is open, in history once it closes.
    const history = (JSON.parse(c.env.snapshot()) as { history: RoutingView["history"]; tried: RoutingView["tried"] });
    const spent = c.env.done() || (c.env.view() as unknown as RoutingView).demand.i !== demandBefore ? history.history.at(-1)?.attempts.at(-1) : history.tried.at(-1);
    if (spent?.candidate === -1 && !spent.delivered) rejectionsCharged += 1;
    else fail(`${key} turn ${c.turn}: a rejection was not recorded as a spent attempt`);
  }
  if (!c.env.done()) {
    const after = c.env.view() as unknown as RoutingView;
    if (after.tried.length > config.max_route_attempts - 1) fail(`${key} turn ${c.turn}: a payment is past its attempt budget`);
  }
  c.prefix += `${JSON.stringify(x.action)}>${JSON.stringify(result.result)}|${result.reason ?? ""};`;
  c.last = { accepted: result.accepted, reason: result.reason, result: result.result } as Json;
  c.turn += 1;
  turns += 1;
}
closeEpisode();

const agentEpisodes = record.rows.filter((r) => r.agent === agentId).length;
if (replayedEpisodes !== agentEpisodes) fail(`${replayedEpisodes} episodes in the transcript, ${agentEpisodes} agent rows in the record`);
console.log(`2 observation: ${rendered} of ${turns} turns re-rendered byte for byte from public fields; ${comparedAcrossModels} turns compared across balance models with the same history`);
console.log(`3 attempts: ${replayedEpisodes} episodes replayed to the recorded row; ${rejectionsCharged} rejections each spent an attempt`);
console.log(`4 order: candidates in catalog order on every replayed turn`);
console.log(failures.length === 0 ? "audit: every check passes" : `audit: ${failures.length} failures`);
process.exit(failures.length === 0 ? 0 : 1);
