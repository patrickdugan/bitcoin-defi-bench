// Run the family 11 baselines and write the results table.
//
//   node --experimental-strip-types scripts/run_swap.ts --block development
//
// The confirmatory block is refused unless prereg/v0.md lists the swap family as frozen.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable } from "../src/harness/table.ts";
import { swapBaselines } from "../src/tasks/swap/baselines.ts";
import { swapIdentityCheck, swapReport, swapTaskSpecs } from "../src/tasks/swap/report.ts";
import { loadSwapConfig } from "../src/tasks/swap/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const block = arg("block", "development") as SeedBlock;
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");
if (block === "confirmatory") requireFrozen(root, "swap");

const manifest = readManifest(root);
const config = loadSwapConfig(root);
const record = await executeRun({
  root, manifest, block,
  seeds: [...SEED_BLOCKS[block]],
  tasks: swapTaskSpecs(root, manifest, config),
  baselines: swapBaselines(),
  checks: swapIdentityCheck(root, manifest),
  progress: (message) => console.error(message),
});

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const name = arg("name", `v0-swap-baselines-${block}`);
writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.md`), renderTable(record, swapReport(config, root, manifest)));
console.log(`wrote results/${name}.md and results/${name}.json`);
