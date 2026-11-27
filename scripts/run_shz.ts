// Run the family 13 baselines and write the results table.
//
//   node --experimental-strip-types scripts/run_shz.ts --block development
//
// The confirmatory block is refused unless prereg/v0.md lists the shz family as frozen.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable } from "../src/harness/table.ts";
import { shzBaselines } from "../src/tasks/shz/baselines.ts";
import { shzIdentityCheck, shzReport, shzTaskSpecs } from "../src/tasks/shz/report.ts";
import { loadShzConfig } from "../src/tasks/shz/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const block = arg("block", "development") as SeedBlock;
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");
if (block === "confirmatory") requireFrozen(root, "shz");

const manifest = readManifest(root);
const config = loadShzConfig(root);
const record = await executeRun({
  root, manifest, block,
  seeds: [...SEED_BLOCKS[block]],
  tasks: shzTaskSpecs(root, manifest, config),
  baselines: shzBaselines(config),
  checks: shzIdentityCheck(root, manifest, config),
  progress: (message) => console.error(message),
});

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const name = arg("name", `v0-shz-baselines-${block}`);
writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.md`), renderTable(record, shzReport(config, root, manifest)));
console.log(`wrote results/${name}.md and results/${name}.json`);
