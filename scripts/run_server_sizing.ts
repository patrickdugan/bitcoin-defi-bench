// Run the family 4 baselines and write the results table.
//
//   node --experimental-strip-types scripts/run_server_sizing.ts --block development
//   node --experimental-strip-types scripts/run_server_sizing.ts --block confirmatory
//
// The confirmatory block is refused unless prereg/v0.md lists the server_sizing family as frozen.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable } from "../src/harness/table.ts";
import { serverSizingBaselines } from "../src/tasks/server_sizing/baselines.ts";
import { serverSizingIdentityCheck, serverSizingReport, serverSizingTaskSpecs } from "../src/tasks/server_sizing/report.ts";
import { loadServerSizingConfig } from "../src/tasks/server_sizing/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const block = arg("block", "development") as SeedBlock;
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");
if (block === "confirmatory") requireFrozen(root, "server_sizing");

const manifest = readManifest(root);
const config = loadServerSizingConfig(root);
const record = await executeRun({
  root, manifest, block,
  seeds: [...SEED_BLOCKS[block]],
  tasks: serverSizingTaskSpecs(root, manifest, config),
  baselines: serverSizingBaselines(config),
  checks: serverSizingIdentityCheck(root, manifest, config),
  progress: (message) => console.error(message),
});

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const name = arg("name", `v0-server-sizing-baselines-${block}`);
writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.md`), renderTable(record, serverSizingReport(config)));
console.log(`wrote results/${name}.md and results/${name}.json`);
