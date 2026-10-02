// Build every fixture and the manifest.
//
//   node --experimental-strip-types scripts/build_fixtures.ts
//
// Placement fixtures need data/topology/20230716.gml.geo (fetch it with Spiral's
// scripts/fetch_ln_snapshot.py); settlement-object fixtures need only their seeds. Fixtures for
// each family's development and reported seed blocks are generated and hash-bound here. Nothing is
// routed or simulated: this script decides no outcome on any seed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH } from "../src/harness/agent.ts";
import { sha256 } from "../src/harness/json.ts";
import { buildManifest, manifestHash, vendoredCommit, type FixtureEntry } from "../src/harness/manifest.ts";
import { SEED_BLOCKS } from "../src/harness/seeds.ts";
import { FIXTURE_VERSION, fixtureBytes, fixturePath, generateFixture } from "../src/tasks/placement/generate.ts";
import { graphStats, parseGml } from "../src/tasks/placement/gml.ts";
import { loadPlacementConfig } from "../src/tasks/placement/task.ts";
import { FIXTURE_VERSION as SETTLEMENT_VERSION, fixtureBytes as settlementBytes, fixturePath as settlementPath, generateFixture as generateSettlement } from "../src/tasks/settlement_object/generate.ts";
import { loadProtocol, loadSettlementConfig } from "../src/tasks/settlement_object/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Write only when the bytes differ, so rebuilding on an unchanged tree touches nothing a running job might be reading. */
function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
}
let written = 0;
const topology = (JSON.parse(readFileSync(join(root, "config/placement.json"), "utf8")) as { topology: { member: string; member_sha256: string } }).topology;
const snapshotPath = join(root, "data/topology", topology.member);
const bytes = readFileSync(snapshotPath);
const snapshotSha = sha256(bytes);
if (snapshotSha !== topology.member_sha256) throw new Error(`snapshot SHA-256 mismatch: ${snapshotSha}`);

const graph = parseGml(bytes.toString("utf8"));
const stats = graphStats(graph);
// The statistics Spiral recorded for this snapshot (output/public_topology_eval/summary.json).
const expected = { nodes: 15100, edges: 64212, components: 15, largest: 15071, max_degree: 2293 };
if (JSON.stringify(stats) !== JSON.stringify(expected)) throw new Error(`snapshot statistics differ from the recorded ones: ${JSON.stringify(stats)}`);

const config = loadPlacementConfig(root);
const entries: FixtureEntry[] = [];
const seeds = [...SEED_BLOCKS.development, ...SEED_BLOCKS.confirmatory];
mkdirSync(join(root, "fixtures/placement"), { recursive: true });
for (const seed of seeds) {
  const fixture = generateFixture(graph, snapshotSha, seed, config);
  const text = fixtureBytes(fixture);
  if (writeIfChanged(join(root, fixturePath(seed)), text)) written += 1;
  entries.push({ path: fixturePath(seed), family: "placement", seed, generator: FIXTURE_VERSION, sha256: sha256(text) });
  console.log(`seed ${seed}: ${fixture.sample.id} attempt ${fixture.sample.attempt}, ${fixture.edges.length} edges`);
}
// Family 3: demand-stream fixtures. Each holds its cell parameters and the SHA-256 of its streams;
// the streams are regenerated from the seed when loaded.
const settlement = loadSettlementConfig(root);
const protocol = loadProtocol(root);
for (const cell of Object.keys(settlement.cells).sort()) {
  mkdirSync(join(root, "fixtures/settlement_object", cell), { recursive: true });
  for (const seed of [...SEED_BLOCKS.development, ...SEED_BLOCKS.confirmatory]) {
    const text = settlementBytes(generateSettlement(seed, cell, settlement.cells[cell]!, protocol));
    if (writeIfChanged(join(root, settlementPath(cell, seed)), text)) written += 1;
    entries.push({ path: settlementPath(cell, seed), family: "settlement_object", seed, generator: SETTLEMENT_VERSION, sha256: sha256(text) });
  }
  console.log(`settlement_object/${cell}: ${SEED_BLOCKS.development.length + SEED_BLOCKS.confirmatory.length} fixtures`);
}

const manifest = buildManifest(root, BENCH, vendoredCommit(root), entries);
writeIfChanged(join(root, "fixtures/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest ${manifestHash(manifest)} (${entries.length} fixtures, ${written} written, Spiral ${manifest.spiral.commit})`);
