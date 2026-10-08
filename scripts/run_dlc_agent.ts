// Run an LLM agent on family 10 alongside the baselines, with optional skills (docs/saturation.md).
//
//   node --experimental-strip-types scripts/run_dlc_agent.ts --block development \
//     --name bonsai-8b-nothink --base-url http://127.0.0.1:8094/v1 --model bonsai-8b \
//     --model-sha256 <sha256 of the GGUF> --runtime "<llama-server --version>" --skills dlc_design
//
// Same discipline as the family 6 agent script: a reply log for reruns after an infrastructure
// failure, every reply and skill call in the transcript, and a confirmatory block refused unless
// the family is frozen (family 10 is not yet).

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatAgent, type ChatOptions, type Exchange, type Reply } from "../src/agents/chat.ts";
import { skillsNamed } from "../src/agents/skills.ts";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable, type ReportSpec } from "../src/harness/table.ts";
import { dlcBaselines } from "../src/tasks/dlc/baselines.ts";
import { dlcPrompt } from "../src/tasks/dlc/prompt.ts";
import { dlcContrasts, dlcIdentityCheck, dlcReport, dlcTaskSpecs } from "../src/tasks/dlc/report.ts";
import { loadDlcConfig } from "../src/tasks/dlc/task.ts";

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
if (block === "confirmatory") requireFrozen(root, "dlc");

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const skills = skillsNamed(arg("skills", ""));
const name = arg("out", `v0-dlc-${arg("name")}${skills.length ? `-${skills.map((s) => s.name).join("+")}` : ""}-${block}`);

const transcript: Exchange[] = [];
// A design of twenty intervals is about three hundred tokens.
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
  prompt: dlcPrompt(maxTokens),
  skills,
  maxSkillCalls: Number(arg("max-skill-calls", "4")),
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
    const kind = exchange.skill ? ` skill ${exchange.skill.name}` : exchange.sent ? ` sent ${exchange.sent}` : "";
    console.error(`  ${exchange.episode.task} seed ${exchange.episode.seed} turn ${exchange.turn}${source}${kind}: ${exchange.reply.replace(/\s+/g, " ").slice(0, 140)}`);
  },
});

const manifest = readManifest(root);
const config = loadDlcConfig(root);
const note = arg("note", "");
const record = await executeRun({
  root, manifest, block, seeds,
  tasks: dlcTaskSpecs(root, manifest, config),
  baselines: dlcBaselines(config.default_floor_ratio),
  agents: [agent],
  checks: dlcIdentityCheck(root, manifest, config),
  notes: () => [
    ...(note !== "" ? [note] : []),
    ...(skills.length ? [`The agent carried the skills ${skills.map((s) => s.name).join(", ")}, each bound into its identifier; skill calls are capped at ${options.maxSkillCalls} per episode and cost no harness budget.`] : []),
    ...(agent.counts.replayed > 0 ? [`${agent.counts.replayed} model replies were replayed from the reply log of an earlier attempt of this run; ${agent.counts.served} came from the server in this invocation. Every episode and every baseline was executed again.`] : []),
  ],
  progress: (message) => console.error(message),
});

/** Agent report: one contrast per cell, agent − `uniform_tuned`. Descriptive until an amendment freezes family 10. */
const report: ReportSpec = {
  ...dlcReport(config),
  title: `Bitcoin DeFi Bench v0: family 10 (designing a numeric DLC), ${agent.id}`,
  contrasts: [
    ...Object.keys(config.cells).sort().map((cell, i) => ({ id: `A${i + 1}`, label: `\`${agent.id}\` − \`uniform_tuned\``, task: `dlc/${cell}`, a: agent.id, b: "uniform_tuned", primary: false })),
    ...dlcContrasts(config),
  ],
};

writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.transcript.jsonl`), transcript.map((t) => JSON.stringify(t)).join("\n") + "\n");
writeFileSync(join(out, `${name}.md`), renderTable(record, report));
rmSync(replyLog);
console.log(`wrote results/${name}.md, .json, and .transcript.jsonl (agent ${agent.id})`);
