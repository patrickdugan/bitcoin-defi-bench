// Run a TRM complex (src/agents/complex.ts) on family 4 or one family 9 cell, alongside the baselines.
//
//   node --experimental-strip-types scripts/run_complex_agent.ts --family server_sizing --block development \
//     --name bonsai-8b-nothink --base-url http://127.0.0.1:8094/v1 --model bonsai-8b \
//     --model-sha256 <sha256 of the GGUF> --runtime "<llama-server --version>"
//   ... --family nostr --cell custody ...
//
// The proposer is the bare agent the family's own agent script builds from the same flags, so its
// identifier is that agent's. The complex's identifier binds it, the package text, the skill, and
// the gate file. Same discipline as the agent scripts: a reply log for reruns after an infrastructure
// failure, every reply in the transcript, and a confirmatory block refused unless the family is
// frozen. Each turn's typed record (atoms, verdict, stage, what was sent) goes to `<name>.records.jsonl`.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatAgent, type ChatOptions, type Exchange, type Reply } from "../src/agents/chat.ts";
import { Gate, TrmComplex, type ComplexRecord, type GateJson } from "../src/agents/complex.ts";
import { loadPackage, packageFileFor } from "../src/agents/complex/packages.ts";
import type { Agent } from "../src/harness/agent.ts";
import type { EpisodeRow } from "../src/harness/episode.ts";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type Check, type SeedBlock, type TaskSpec } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable, type ContrastSpec, type ReportSpec } from "../src/harness/table.ts";
import { nostrPrompt } from "../src/tasks/nostr/prompt.ts";
import { NOSTR_CELL_SPECS, nostrContrasts, nostrIdentityCheck, nostrReport, nostrTask, nostrTaskSpec } from "../src/tasks/nostr/report.ts";
import { NOSTR_CELLS, loadNostrConfig, nostrBaselines, type NostrCell } from "../src/tasks/nostr/task.ts";
import { serverSizingBaselines } from "../src/tasks/server_sizing/baselines.ts";
import { serverSizingPrompt } from "../src/tasks/server_sizing/prompt.ts";
import { serverSizingAgentContrasts, serverSizingContrasts, serverSizingIdentityCheck, serverSizingReport, serverSizingTaskSpecs } from "../src/tasks/server_sizing/report.ts";
import { loadServerSizingConfig } from "../src/tasks/server_sizing/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback === undefined) throw new Error(`missing --${name}`);
  return fallback;
};

const family = arg("family") as "server_sizing" | "nostr";
if (family !== "server_sizing" && family !== "nostr") throw new Error("--family must be server_sizing or nostr");
const cell = family === "nostr" ? (arg("cell") as NostrCell) : undefined;
if (family === "nostr" && !NOSTR_CELLS.includes(cell!)) throw new Error(`unknown cell ${cell}`);
const block = arg("block", "development") as SeedBlock;
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");
let seeds: number[] = [...SEED_BLOCKS[block]];
const subset = arg("seeds", "");
if (subset !== "") {
  if (block === "confirmatory") throw new Error("the confirmatory block cannot be subset");
  seeds = subset.split(",").map((s) => Number(s.trim()));
}
if (block === "confirmatory") requireFrozen(root, family);

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const prefix = family === "server_sizing" ? "v0-server-sizing" : `v0-nostr-${cell!.replace(/_/g, "-")}`;
const name = arg("out", `${prefix}-${arg("name")}-trm-complex-${block}`);

// The proposer: exactly the options of the family's bare agent script.
const maxTokens = Number(arg("max-tokens", family === "server_sizing" ? "256" : "1024"));
const options: ChatOptions = {
  name: arg("name"),
  baseUrl: arg("base-url"),
  model: arg("model"),
  sampling: {
    temperature: Number(arg("temperature", "0.7")), top_p: Number(arg("top-p", "0.8")), top_k: Number(arg("top-k", "20")),
    max_tokens: maxTokens, seed: Number(arg("seed", "20261001")),
  },
  thinking: arg("thinking", "false") === "true",
  identity: { model_sha256: arg("model-sha256"), runtime: arg("runtime") },
  prompt: family === "server_sizing" ? serverSizingPrompt(maxTokens) : nostrPrompt(cell!, maxTokens),
  ...(family === "server_sizing" ? { contextTurns: Number(arg("context-turns", "0")) } : {}),
};

const pkgFile = packageFileFor(family, cell);
const pkg = loadPackage(pkgFile);
const gate = new Gate(JSON.parse(readFileSync(join(root, "src", "agents", "complex", "gates", `${pkgFile}.json`), "utf8")) as GateJson);
const complexName = `${arg("name")}-trm-complex`;
const complexId = new TrmComplex({ name: complexName, proposer: new ChatAgent(options), pkg, gate }).id;

const replyLog = join(out, `${name}.replies.jsonl`);
const replay = new Map<string, Reply>();
if (existsSync(replyLog)) {
  const [header, ...entries] = readFileSync(replyLog, "utf8").split("\n").filter((l) => l !== "");
  if ((JSON.parse(header!) as { agent: string }).agent !== complexId) throw new Error(`${replyLog} belongs to a different agent; remove it to start over`);
  for (const line of entries) {
    const e = JSON.parse(line) as { request_sha256: string } & Reply;
    replay.set(e.request_sha256, { content: e.content, reasoning: e.reasoning });
  }
} else {
  writeFileSync(replyLog, `${JSON.stringify({ agent: complexId })}\n`);
}

const transcript: Exchange[] = [];
const records: ComplexRecord[] = [];
const proposer = new ChatAgent({
  ...options,
  replay,
  onReply: (request_sha256, reply) => appendFileSync(replyLog, `${JSON.stringify({ request_sha256, ...reply })}\n`),
  onExchange: (exchange) => { transcript.push(exchange); },
});
const agent = new TrmComplex({
  name: complexName, proposer, pkg, gate,
  onRecord: (r) => {
    records.push(r);
    console.error(`  ${r.episode.task} seed ${r.episode.seed} turn ${r.turn} ${r.stage}${r.stage === "gate" ? ` ${r.choice}` : ""}: ${JSON.stringify(r.sent).slice(0, 120)}`);
  },
});
if (agent.id !== complexId) throw new Error("the complex's identifier changed when its proposer gained a reply log");

const manifest = readManifest(root);
const note = arg("note", "");
let tasks: TaskSpec[];
let baselines: Agent[];
let checks: (rows: EpisodeRow[]) => Check[];
let report: ReportSpec;
if (family === "server_sizing") {
  const config = loadServerSizingConfig(root);
  tasks = serverSizingTaskSpecs(root, manifest, config);
  baselines = serverSizingBaselines(config);
  checks = serverSizingIdentityCheck(root, manifest, config);
  report = { ...serverSizingReport(config), title: `Bitcoin DeFi Bench v0: family 4 (server inbound resizing), ${agent.id}`, contrasts: [...serverSizingAgentContrasts(config, agent.id), ...serverSizingContrasts(config).map((c): ContrastSpec => ({ ...c, primary: false }))] };
} else {
  const config = loadNostrConfig(root);
  tasks = [nostrTaskSpec(root, manifest, config, cell!)];
  baselines = nostrBaselines(cell!);
  checks = nostrIdentityCheck(root, manifest, config, cell!);
  report = { ...nostrReport(cell!), title: `Bitcoin DeFi Bench v0: family 9, \`nostr/${cell}\`, ${agent.id}`, contrasts: [
    { id: "A1", label: `\`${agent.id}\` − \`${NOSTR_CELL_SPECS[cell!].reference}\``, task: nostrTask(cell!), a: agent.id, b: NOSTR_CELL_SPECS[cell!].reference, primary: true },
    ...nostrContrasts(cell!).map((c) => ({ ...c, primary: false })),
  ] };
}

const record = await executeRun({
  root, manifest, block, seeds, tasks, baselines, agents: [agent], checks,
  notes: () => {
    const total = Object.values(agent.counts).reduce((a, b) => a + b, 0);
    return [
      ...(note !== "" ? [note] : []),
      `A TRM complex: the proposer \`${proposer.id}\` proposes each action; the package \`${pkg.name}\` (SHA-256 ${pkg.sha256.slice(0, 12)}) checks it against the cell's public rules, repairs a proposal that breaks one with the skill \`${pkg.skill}\`, and sends a legal proposal that differs from the skill's action only if the gate (SHA-256 ${gate.sha256.slice(0, 12)}${gate.file.constant !== null ? `, the constant rule ${gate.file.constant}` : `, ${gate.file.models.length} networks`}) says commit. Turns by stage: ${(["agree", "gate", "repair", "veto"] as const).map((s) => `${s} ${agent.counts[s]}`).join(", ")} of ${total}; the gate sent the proposal on ${records.filter((r) => r.stage === "gate" && r.choice === "commit").length}.`,
      ...(proposer.counts.replayed > 0 ? [`${proposer.counts.replayed} model replies were replayed from the reply log of an earlier attempt of this run; ${proposer.counts.served} came from the server in this invocation. Every episode and every baseline was executed again.`] : []),
    ];
  },
  progress: (message) => console.error(message),
});

writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.transcript.jsonl`), transcript.map((t) => JSON.stringify(t)).join("\n") + "\n");
writeFileSync(join(out, `${name}.records.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(join(out, `${name}.md`), renderTable(record, report));
rmSync(replyLog);
console.log(`wrote results/${name}.md, .json, .transcript.jsonl, and .records.jsonl (agent ${agent.id})`);
