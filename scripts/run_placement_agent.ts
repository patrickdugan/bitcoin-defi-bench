// Run an LLM agent on family 1 alongside the baselines, through an OpenAI-compatible endpoint on
// this machine, and write the results table, the run record, and the transcript.
//
//   node --experimental-strip-types scripts/run_placement_agent.ts --block development \
//     --name bonsai-8b-nothink --base-url http://127.0.0.1:8094/v1 --model bonsai-8b \
//     --model-sha256 <sha256 of the GGUF> --runtime "<llama-server --version>"
//
// The baselines run again here, in this process and on the same seeds. The confirmatory block is
// refused unless prereg/v0.md lists the placement family as frozen, and it cannot be subset.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatAgent, type Exchange } from "../src/agents/chat.ts";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable } from "../src/harness/table.ts";
import { placementBaselines } from "../src/tasks/placement/baselines.ts";
import { placementPrompt } from "../src/tasks/placement/prompt.ts";
import { placementAgentReport, placementIdentityCheck, placementTaskSpecs } from "../src/tasks/placement/report.ts";
import { loadPlacementConfig } from "../src/tasks/placement/task.ts";

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
  if (seeds.some((s) => !SEED_BLOCKS.development.includes(s as never))) throw new Error("--seeds must be development seeds");
}
if (block === "confirmatory") requireFrozen(root, "placement");

const transcript: Exchange[] = [];
// A valid action needs a few dozen tokens per placement; 512 holds about twenty placements.
const maxTokens = Number(arg("max-tokens", "512"));
const agent = new ChatAgent({
  name: arg("name"),
  baseUrl: arg("base-url"),
  model: arg("model"),
  sampling: {
    temperature: Number(arg("temperature", "0.7")), top_p: Number(arg("top-p", "0.8")), top_k: Number(arg("top-k", "20")),
    max_tokens: maxTokens, seed: Number(arg("seed", "20261001")),
  },
  thinking: arg("thinking", "false") === "true",
  identity: { model_sha256: arg("model-sha256"), runtime: arg("runtime") },
  prompt: placementPrompt(maxTokens),
  onExchange: (exchange) => {
    transcript.push(exchange);
    console.error(`  ${exchange.episode.task} seed ${exchange.episode.seed} ${exchange.episode.cell} turn ${exchange.turn}${exchange.cached ? " (cached)" : ""}: ${exchange.reply.replace(/\s+/g, " ").slice(0, 160)}`);
  },
});

const manifest = readManifest(root);
const config = loadPlacementConfig(root);
const record = await executeRun({
  root, manifest, block, seeds,
  tasks: placementTaskSpecs(root, manifest, config),
  baselines: placementBaselines(),
  agents: [agent],
  checks: placementIdentityCheck(root, manifest, config),
  progress: (message) => console.error(message),
});

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const name = arg("out", `v0-placement-${arg("name")}-${block}`);
writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.transcript.jsonl`), transcript.map((t) => JSON.stringify(t)).join("\n") + "\n");
writeFileSync(join(out, `${name}.md`), renderTable(record, placementAgentReport(agent.id, `Bitcoin DeFi Bench v0: family 1 (directional placement), ${agent.id}`)));
console.log(`wrote results/${name}.md, .json, and .transcript.jsonl (agent ${agent.id})`);
