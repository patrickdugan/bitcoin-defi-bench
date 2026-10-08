// Run an LLM agent on one family 9 cell alongside that cell's baselines.
//
//   node --experimental-strip-types scripts/run_nostr_agent.ts --cell custody --block development \
//     --name bonsai-8b-nothink --base-url http://127.0.0.1:8094/v1 --model bonsai-8b \
//     --model-sha256 <sha256 of the GGUF> --runtime "<llama-server --version>"
//
// Same discipline as the netting and placement agent scripts: a reply log for reruns after an
// infrastructure failure, every reply in the transcript, and a confirmatory block refused unless
// the nostr family is frozen.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatAgent, type ChatOptions, type Exchange, type Reply } from "../src/agents/chat.ts";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable, type ReportSpec } from "../src/harness/table.ts";
import { nostrPrompt } from "../src/tasks/nostr/prompt.ts";
import { NOSTR_CELL_SPECS, nostrContrasts, nostrIdentityCheck, nostrReport, nostrTask, nostrTaskSpec } from "../src/tasks/nostr/report.ts";
import { NOSTR_CELLS, loadNostrConfig, nostrBaselines, type NostrCell } from "../src/tasks/nostr/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback === undefined) throw new Error(`missing --${name}`);
  return fallback;
};

const cell = arg("cell") as NostrCell;
if (!NOSTR_CELLS.includes(cell)) throw new Error(`unknown cell ${cell}`);
const block = arg("block", "development") as SeedBlock;
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");
let seeds: number[] = [...SEED_BLOCKS[block]];
const subset = arg("seeds", "");
if (subset !== "") {
  if (block === "confirmatory") throw new Error("the confirmatory block cannot be subset");
  seeds = subset.split(",").map((s) => Number(s.trim()));
}
if (block === "confirmatory") requireFrozen(root, "nostr");

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const name = arg("out", `v0-nostr-${cell.replace(/_/g, "-")}-${arg("name")}-${block}`);
const transcript: Exchange[] = [];
const maxTokens = Number(arg("max-tokens", "1024"));
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
  prompt: nostrPrompt(cell, maxTokens),
};
const agentId = new ChatAgent(options).id;

const replyLog = join(out, `${name}.replies.jsonl`);
const replay = new Map<string, Reply>();
if (existsSync(replyLog)) {
  const [header, ...entries] = readFileSync(replyLog, "utf8").split("\n").filter((l) => l !== "");
  if ((JSON.parse(header!) as { agent: string }).agent !== agentId) throw new Error(`${replyLog} belongs to a different agent; remove it to start over`);
  for (const line of entries) {
    const e = JSON.parse(line) as { request_sha256: string } & Reply;
    replay.set(e.request_sha256, { content: e.content, reasoning: e.reasoning });
  }
} else {
  writeFileSync(replyLog, `${JSON.stringify({ agent: agentId })}\n`);
}

const agent = new ChatAgent({
  ...options,
  replay,
  onReply: (request_sha256, reply) => appendFileSync(replyLog, `${JSON.stringify({ request_sha256, ...reply })}\n`),
  onExchange: (exchange) => {
    transcript.push(exchange);
    const source = exchange.replayed ? " (replayed)" : exchange.cached ? " (cached)" : "";
    console.error(`  ${exchange.episode.task} seed ${exchange.episode.seed} turn ${exchange.turn}${source}: ${exchange.reply.replace(/\s+/g, " ").slice(0, 140)}`);
  },
});

const manifest = readManifest(root);
const config = loadNostrConfig(root);
const note = arg("note", "");
const record = await executeRun({
  root, manifest, block, seeds,
  tasks: [nostrTaskSpec(root, manifest, config, cell)],
  baselines: nostrBaselines(cell),
  agents: [agent],
  checks: nostrIdentityCheck(root, manifest, config, cell),
  notes: () => [
    ...(note !== "" ? [note] : []),
    ...(agent.counts.replayed > 0 ? [`${agent.counts.replayed} model replies were replayed from the reply log of an earlier attempt of this run; ${agent.counts.served} came from the server in this invocation. Every episode and every baseline was executed again.`] : []),
  ],
  progress: (message) => console.error(message),
});

/** Agent report: the agent against the cell's reference, then the baseline contrasts as secondary. */
const base = nostrReport(cell);
const report: ReportSpec = {
  ...base,
  title: `Bitcoin DeFi Bench v0: family 9, \`nostr/${cell}\`, ${agent.id}`,
  contrasts: [
    { id: "A1", label: `\`${agent.id}\` − \`${NOSTR_CELL_SPECS[cell].reference}\``, task: nostrTask(cell), a: agent.id, b: NOSTR_CELL_SPECS[cell].reference, primary: true },
    ...nostrContrasts(cell).map((c) => ({ ...c, primary: false })),
  ],
};

writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.transcript.jsonl`), transcript.map((t) => JSON.stringify(t)).join("\n") + "\n");
writeFileSync(join(out, `${name}.md`), renderTable(record, report));
rmSync(replyLog);
console.log(`wrote results/${name}.md, .json, and .transcript.jsonl (agent ${agent.id})`);
