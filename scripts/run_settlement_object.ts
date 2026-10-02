// Run the family 3 baselines and write the results table.
//
//   node --experimental-strip-types scripts/run_settlement_object.ts --block development
//   node --experimental-strip-types scripts/run_settlement_object.ts --block confirmatory
//
// The confirmatory block is refused unless prereg/v0.md lists the settlement_object family as
// frozen. Baselines run here in the same process and on the same seeds as any agent added to the
// run. The 200-agent cells make the confirmatory run long: allow about an hour.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable } from "../src/harness/table.ts";
import { settlementBaselines } from "../src/tasks/settlement_object/baselines.ts";
import { settlementReport, settlementTaskSpecs } from "../src/tasks/settlement_object/report.ts";
import { loadSettlementConfig } from "../src/tasks/settlement_object/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const block = arg("block", "development") as SeedBlock;
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");
if (block === "confirmatory") requireFrozen(root, "settlement_object");

const manifest = readManifest(root);
const config = loadSettlementConfig(root);
const record = await executeRun({
  root, manifest, block,
  seeds: [...SEED_BLOCKS[block]],
  tasks: settlementTaskSpecs(root, manifest, config),
  baselines: settlementBaselines(config),
  progress: (message) => console.error(message),
});

const out = join(root, "results");
mkdirSync(out, { recursive: true });
const name = arg("name", `v0-settlement-object-baselines-${block}`);
writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
writeFileSync(join(out, `${name}.md`), renderTable(record, settlementReport));
console.log(`wrote results/${name}.md and results/${name}.json`);
