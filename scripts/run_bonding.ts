// Run the family 5 baselines and write the results table.
//
//   node --experimental-strip-types scripts/run_bonding.ts --block development
//   node --experimental-strip-types scripts/run_bonding.ts --block confirmatory
//
// The confirmatory block is refused unless prereg/v0.md lists the bonding family as frozen.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable } from "../src/harness/table.ts";
import { bondingBaselines } from "../src/tasks/bonding/baselines.ts";
import { bondingIdentityCheck, bondingReport, bondingTaskSpecs } from "../src/tasks/bonding/report.ts";
import { loadBondingConfig } from "../src/tasks/bonding/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const block = arg("block", "development") as SeedBlock;
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");
if (block === "confirmatory") requireFrozen(root, "bonding");

const manifest = readManifest(root);
const config = loadBondingConfig(root);
const record = await executeRun({
  root, manifest, block,
  seeds: [...SEED_BLOCKS[block]],
  tasks: bondingTaskSpecs(root, manifest, config),
  baselines: bondingBaselines(),
  checks: bondingIdentityCheck(root, manifest, config),
  progress: (message) => console.error(message),
});

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const name = arg("name", `v0-bonding-baselines-${block}`);
writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.md`), renderTable(record, bondingReport(config)));
console.log(`wrote results/${name}.md and results/${name}.json`);
