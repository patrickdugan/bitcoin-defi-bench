// Run the family 6 baselines and write the results table.
//
//   node --experimental-strip-types scripts/run_netting.ts --block development
//   node --experimental-strip-types scripts/run_netting.ts --block confirmatory
//
// The confirmatory block is refused unless prereg/v0.md lists the netting family as frozen.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable } from "../src/harness/table.ts";
import { nettingBaselines } from "../src/tasks/netting/baselines.ts";
import { nettingIdentityCheck, nettingReport, nettingTaskSpecs } from "../src/tasks/netting/report.ts";
import { loadNettingConfig } from "../src/tasks/netting/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const block = arg("block", "development") as SeedBlock;
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");
if (block === "confirmatory") requireFrozen(root, "netting");

const manifest = readManifest(root);
const config = loadNettingConfig(root);
const record = await executeRun({
  root, manifest, block,
  seeds: [...SEED_BLOCKS[block]],
  tasks: nettingTaskSpecs(root, manifest, config),
  baselines: nettingBaselines(),
  checks: nettingIdentityCheck(root, manifest, config),
  progress: (message) => console.error(message),
});

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const name = arg("name", `v0-netting-baselines-${block}`);
writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.md`), renderTable(record, nettingReport));
console.log(`wrote results/${name}.md and results/${name}.json`);
