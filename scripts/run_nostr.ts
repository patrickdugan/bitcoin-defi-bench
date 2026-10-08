// Run the family 9 baselines and write one results table per cell.
//
//   node --experimental-strip-types scripts/run_nostr.ts --block development
//   node --experimental-strip-types scripts/run_nostr.ts --block development --cells custody,private
//   node --experimental-strip-types scripts/run_nostr.ts --block confirmatory
//
// Each cell is its own run record, because each has its own baselines (docs/tasks.md §10). The
// confirmatory block is refused unless prereg/v0.md lists the nostr family as frozen.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "../src/harness/manifest.ts";
import { executeRun, type SeedBlock } from "../src/harness/run.ts";
import { SEED_BLOCKS, requireFrozen } from "../src/harness/seeds.ts";
import { renderTable } from "../src/harness/table.ts";
import { nostrIdentityCheck, nostrReport, nostrTaskSpec } from "../src/tasks/nostr/report.ts";
import { NOSTR_CELLS, loadNostrConfig, nostrBaselines, type NostrCell } from "../src/tasks/nostr/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const block = arg("block", "development") as SeedBlock;
if (block !== "development" && block !== "confirmatory") throw new Error("--block must be development or confirmatory");
if (block === "confirmatory") requireFrozen(root, "nostr");
const cells = arg("cells", NOSTR_CELLS.join(",")).split(",").map((c) => c.trim()) as NostrCell[];
for (const c of cells) if (!NOSTR_CELLS.includes(c)) throw new Error(`unknown cell ${c}`);

const manifest = readManifest(root);
const config = loadNostrConfig(root);
const out = join(root, "results");
mkdirSync(out, { recursive: true });
for (const cell of cells) {
  const record = await executeRun({
    root, manifest, block,
    seeds: [...SEED_BLOCKS[block]],
    tasks: [nostrTaskSpec(root, manifest, config, cell)],
    baselines: nostrBaselines(cell),
    checks: nostrIdentityCheck(root, manifest, config, cell),
    progress: (message) => console.error(message),
  });
  const name = `v0-nostr-${cell.replace(/_/g, "-")}-baselines-${block}`;
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
  writeFileSync(join(out, `${name}.md`), renderTable(record, nostrReport(cell)));
  console.log(`wrote results/${name}.md and results/${name}.json`);
}
