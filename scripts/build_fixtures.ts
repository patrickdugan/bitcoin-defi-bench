// Build the placement fixtures and the manifest from the public-gossip snapshot.
//
//   node --experimental-strip-types scripts/build_fixtures.ts
//
// Requires data/topology/20230716.gml.geo (fetch it with Spiral's scripts/fetch_ln_snapshot.py).
// Fixtures for the development and the confirmatory seed blocks are generated and hash-bound here.
// Nothing is routed: no simulation runs on any seed in this script.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH } from "../src/harness/agent.ts";
import { sha256 } from "../src/harness/json.ts";
import { buildManifest, manifestHash, vendoredCommit, type FixtureEntry } from "../src/harness/manifest.ts";
import { SEED_BLOCKS } from "../src/harness/seeds.ts";
import { FIXTURE_VERSION, fixtureBytes, fixturePath, generateFixture } from "../src/tasks/placement/generate.ts";
import { graphStats, parseGml } from "../src/tasks/placement/gml.ts";
import { loadPlacementConfig } from "../src/tasks/placement/task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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
  writeFileSync(join(root, fixturePath(seed)), text);
  entries.push({ path: fixturePath(seed), family: "placement", seed, generator: FIXTURE_VERSION, sha256: sha256(text) });
  console.log(`seed ${seed}: ${fixture.sample.id} attempt ${fixture.sample.attempt}, ${fixture.edges.length} edges`);
}
const manifest = buildManifest(root, BENCH, vendoredCommit(root), entries);
writeFileSync(join(root, "fixtures/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest ${manifestHash(manifest)} (${entries.length} fixtures, Spiral ${manifest.spiral.commit})`);
