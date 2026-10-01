// Run the family 3 baselines (pin-supported variant) and write the results table.
//
//   node --experimental-strip-types scripts/run_settlement_object.ts --block development
//   node --experimental-strip-types scripts/run_settlement_object.ts --block exploratory
//
// The family's preregistration sections are not frozen, so its reported block is exploratory
// (seeds 2000-2031, prereg/v0.md §11). A confirmatory block is refused until they are.

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
if (block === "confirmatory") requireFrozen(root, "settlement_object");
const seeds = block === "development" ? SEED_BLOCKS.development : block === "exploratory" ? SEED_BLOCKS.exploratory_settlement : null;
if (seeds === null) throw new Error("--block must be development or exploratory; the family is not frozen");

const manifest = readManifest(root);
const config = loadSettlementConfig(root);
const record = await executeRun({
  root, manifest, block,
  seeds: [...seeds],
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
