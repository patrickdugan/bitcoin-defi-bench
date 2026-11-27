// Run the family 12 baselines and write the results table.
//
//   node --experimental-strip-types scripts/run_bitvm3.ts --block development
//
// The confirmatory block is refused unless prereg/v0.md lists the bitvm3 family as frozen.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable } from "../src/harness/table.ts";
import { bitvm3Baselines } from "../src/tasks/bitvm3/baselines.ts";
import { bitvm3IdentityCheck, bitvm3Report, bitvm3TaskSpecs } from "../src/tasks/bitvm3/report.ts";
import { loadBitvm3Config } from "../src/tasks/bitvm3/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const block = arg("block", "development") as SeedBlock;
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");
if (block === "confirmatory") requireFrozen(root, "bitvm3");

const manifest = readManifest(root);
const config = loadBitvm3Config(root);
const record = await executeRun({
  root, manifest, block,
  seeds: [...SEED_BLOCKS[block]],
  tasks: bitvm3TaskSpecs(root, manifest, config),
  baselines: bitvm3Baselines(),
  checks: bitvm3IdentityCheck(root, manifest),
  progress: (message) => console.error(message),
});

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const name = arg("name", `v0-bitvm3-baselines-${block}`);
writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.md`), renderTable(record, bitvm3Report(config, root, manifest)));
console.log(`wrote results/${name}.md and results/${name}.json`);
