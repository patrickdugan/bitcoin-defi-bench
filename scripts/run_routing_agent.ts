// Run an LLM agent on family 2 alongside the baselines.
//
//   node --experimental-strip-types scripts/run_routing_agent.ts --block development --seeds 0 \
//     --name bonsai-8b-nothink --base-url http://127.0.0.1:8094/v1 --model bonsai-8b \
//     --model-sha256 <sha256 of the GGUF> --runtime "<llama-server --version>"
//
// An episode is several hundred turns, one per attempt or skip, so the adapter sends the current
// turn alone (--context-turns 0 by default): the turn carries the whole history. A reply log makes
// a rerun after an infrastructure failure replay what was already answered.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatAgent, type ChatOptions, type Exchange, type Reply } from "../src/agents/chat.ts";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable, type ReportSpec } from "../src/harness/table.ts";
import { loadPlacementConfig, placementFixture } from "../src/tasks/placement/task.ts";
import { routingBaselines } from "../src/tasks/routing/baselines.ts";
import { routingPrompt } from "../src/tasks/routing/prompt.ts";
import { routingContrasts, routingIdentityCheck, routingReport, routingTaskSpecs, routingTasks } from "../src/tasks/routing/report.ts";
import { ROUTING_BAND } from "../src/tasks/routing/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback === undefined) throw new Error(`missing --${name}`);
  return fallback;
};

const block = arg("block", "development") as SeedBlock;
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");
let seeds: number[] = [...SEED_BLOCKS[block]];
const subset = arg("seeds", "");
if (subset !== "") {
  if (block === "confirmatory") throw new Error("the confirmatory block cannot be subset");
  seeds = subset.split(",").map((s) => Number(s.trim()));
}
if (block === "confirmatory") requireFrozen(root, "routing");

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const name = arg("out", `v0-routing-${arg("name")}-${block}`);

const transcript: Exchange[] = [];
const maxTokens = Number(arg("max-tokens", "128"));
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
  prompt: routingPrompt(maxTokens),
  contextTurns: Number(arg("context-turns", "0")),
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
    if (exchange.turn % 50 === 0) console.error(`  ${exchange.episode.task} seed ${exchange.episode.seed} turn ${exchange.turn}: ${exchange.reply.replace(/\s+/g, " ").slice(0, 100)}`);
  },
});

const manifest = readManifest(root);
const config = loadPlacementConfig(root);
const note = arg("note", "");
const record = await executeRun({
  root, manifest, block, seeds,
  tasks: routingTaskSpecs(root, manifest, config),
  baselines: routingBaselines((seed) => placementFixture(root, manifest, seed)),
  agents: [agent],
  checks: routingIdentityCheck(root, manifest, config),
  notes: () => [
    ...(note !== "" ? [note] : []),
    ...(agent.counts.replayed > 0 ? [`${agent.counts.replayed} model replies were replayed from the reply log of an earlier attempt of this run; ${agent.counts.served} came from the server in this invocation. Every episode and every baseline was executed again.`] : []),
  ],
  progress: (message) => console.error(message),
});

/**
 * Agent report: one primary contrast per task, agent − `retry_wallet`, adjusted over the nine tasks,
 * as prereg/v0.md §9 and Amendment 6 declare. A task whose adjusted interval is not inside ±1.0
 * point is flagged `outside_calibration` and is not reported as a result until audited.
 */
const report: ReportSpec = {
  ...routingReport,
  title: `Bitcoin DeFi Bench v0: family 2 (routing under hidden state), ${agent.id}`,
  contrasts: [
    ...routingTasks().map(({ task }, i) => ({ id: `A${i + 1}`, label: `\`${agent.id}\` − \`retry_wallet\``, task, a: agent.id, b: "retry_wallet", primary: true })),
    ...routingContrasts(),
  ],
  flags(analysis, task, id) {
    if (id !== agent.id) return [];
    const d = analysis.difference(task, id, "retry_wallet", routingTasks().length);
    return d.lo < -ROUTING_BAND || d.hi > ROUTING_BAND ? ["outside_calibration"] : [];
  },
};

writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.transcript.jsonl`), transcript.map((t) => JSON.stringify(t)).join("\n") + "\n");
writeFileSync(join(out, `${name}.md`), renderTable(record, report));
rmSync(replyLog);
console.log(`wrote results/${name}.md, .json, and .transcript.jsonl (agent ${agent.id})`);
