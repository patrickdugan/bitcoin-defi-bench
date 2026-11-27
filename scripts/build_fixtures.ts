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
import { FIXTURE_VERSION as NETTING_VERSION, fixtureBytes as nettingBytes, fixturePath as nettingPath, generateFixture as generateNetting } from "../src/tasks/netting/generate.ts";
import { loadNettingConfig } from "../src/tasks/netting/task.ts";
import { FIXTURE_VERSION as DLC_VERSION, fixtureBytes as dlcBytes, fixturePath as dlcPath, generateFixture as generateDlc } from "../src/tasks/dlc/generate.ts";
import { loadDlcConfig } from "../src/tasks/dlc/task.ts";
import { FIXTURE_VERSION as PROOF_VERSION, fixtureBytes as proofBytes, fixturePath as proofPath, generateFixture as generateProof, loadCostTable } from "../src/tasks/proof_budget/generate.ts";
import { loadProofConfig } from "../src/tasks/proof_budget/task.ts";
import { FIXTURE_VERSION as BONDING_VERSION, fixtureBytes as bondingBytes, fixturePath as bondingPath, generateFixture as generateBonding } from "../src/tasks/bonding/generate.ts";
import { loadBondingConfig } from "../src/tasks/bonding/task.ts";
import { FIXTURE_VERSION as ROUTING_VERSION, fixtureBytes as routingBytes, fixturePath as routingPath, generateFixture as generateRouting } from "../src/tasks/routing/generate.ts";
import { NOSTR_CELLS, buildNostrFixtures, loadNostrConfig } from "../src/tasks/nostr/task.ts";
import { bitvm3Cells, buildBitvm3Fixtures, loadBitvm3Config } from "../src/tasks/bitvm3/task.ts";
import { buildSwapFixtures, loadSwapConfig, swapCells } from "../src/tasks/swap/task.ts";
import { buildCashuFixtures, cashuCells, loadCashuConfig } from "../src/tasks/cashu/task.ts";
import { buildShzFixtures, loadShzConfig, shzCells } from "../src/tasks/shz/task.ts";

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

// Family 6: clearing instances, small enough to commit whole.
const netting = loadNettingConfig(root);
for (const cell of Object.keys(netting.cells).sort()) {
  mkdirSync(join(root, "fixtures/netting", cell), { recursive: true });
  for (const seed of [...SEED_BLOCKS.development, ...SEED_BLOCKS.confirmatory]) {
    const text = nettingBytes(generateNetting(seed, cell, netting.cells[cell]!, netting.market));
    if (writeIfChanged(join(root, nettingPath(cell, seed)), text)) written += 1;
    entries.push({ path: nettingPath(cell, seed), family: "netting", seed, generator: NETTING_VERSION, sha256: sha256(text) });
  }
  console.log(`netting/${cell}: ${SEED_BLOCKS.development.length + SEED_BLOCKS.confirmatory.length} fixtures`);
}

// Family 10: one contract per seed and cell, with its menus.
const dlc = loadDlcConfig(root);
for (const cell of Object.keys(dlc.cells).sort()) {
  mkdirSync(join(root, "fixtures/dlc", cell), { recursive: true });
  for (const seed of [...SEED_BLOCKS.development, ...SEED_BLOCKS.confirmatory]) {
    const text = dlcBytes(generateDlc(seed, cell, dlc.cells[cell]!, dlc));
    if (writeIfChanged(join(root, dlcPath(cell, seed)), text)) written += 1;
    entries.push({ path: dlcPath(cell, seed), family: "dlc", seed, generator: DLC_VERSION, sha256: sha256(text) });
  }
  console.log(`dlc/${cell}: ${SEED_BLOCKS.development.length + SEED_BLOCKS.confirmatory.length} fixtures`);
}

// Family 9: seven cells, each fixture a whole episode's world (keys, relays, requests, walks).
const nostr = buildNostrFixtures(root, loadNostrConfig(root), [...SEED_BLOCKS.development, ...SEED_BLOCKS.confirmatory]);
entries.push(...nostr.entries);
written += nostr.written;
console.log(`nostr: ${nostr.entries.length} fixtures over ${NOSTR_CELLS.length} cells`);

// Family 12: the claims against one vault per seed and cell, with their hidden classes, the chain's
// reorganizations, and every block's fee rate.
const bitvm3Config = loadBitvm3Config(root);
const bitvm3 = buildBitvm3Fixtures(root, bitvm3Config, [...SEED_BLOCKS.development, ...SEED_BLOCKS.confirmatory]);
entries.push(...bitvm3.entries);
written += bitvm3.written;
console.log(`bitvm3: ${bitvm3.entries.length} fixtures over ${bitvm3Cells(bitvm3Config).length} cells`);

// Family 11: one swap per seed and cell, with the desk's hidden behaviour and every block's fee rate.
const swapConfig = loadSwapConfig(root);
const swap = buildSwapFixtures(root, swapConfig, [...SEED_BLOCKS.development, ...SEED_BLOCKS.confirmatory]);
entries.push(...swap.entries);
written += swap.written;
console.log(`swap: ${swap.entries.length} fixtures over ${swapCells(swapConfig).length} cells`);

// Family 14: one desk episode per seed and cell, with every event's hidden truth and real Cashu proofs.
const cashuConfig = loadCashuConfig(root);
const cashu = buildCashuFixtures(root, cashuConfig, [...SEED_BLOCKS.development, ...SEED_BLOCKS.confirmatory]);
entries.push(...cashu.entries);
written += cashu.written;
console.log(`cashu: ${cashu.entries.length} fixtures over ${cashuCells(cashuConfig).length} cells`);

// Family 13: one hedging episode per seed and cell, with every step's mark, HOLD, 200 ms move, and packets.
const shzConfig = loadShzConfig(root);
const shz = buildShzFixtures(root, shzConfig, [...SEED_BLOCKS.development, ...SEED_BLOCKS.confirmatory]);
entries.push(...shz.entries);
written += shz.written;
console.log(`shz: ${shz.entries.length} fixtures over ${shzCells(shzConfig).length} cells`);

// Family 2: each names its family 1 fixture by hash and adds the diffuse demand stream.
mkdirSync(join(root, "fixtures/routing"), { recursive: true });
for (const seed of seeds) {
  const placementEntry = entries.find((e) => e.path === fixturePath(seed))!;
  const placement = JSON.parse(readFileSync(join(root, fixturePath(seed)), "utf8"));
  const text = routingBytes(generateRouting(placement, placementEntry.path, placementEntry.sha256, config));
  if (writeIfChanged(join(root, routingPath(seed)), text)) written += 1;
  entries.push({ path: routingPath(seed), family: "routing", seed, generator: ROUTING_VERSION, sha256: sha256(text) });
}
console.log(`routing: ${seeds.length} fixtures`);

// Family 5: one bonding decision per seed and cell, with the challengers' hidden rate and a sample of it.
const bonding = loadBondingConfig(root);
for (const cell of Object.keys(bonding.cells).sort()) {
  mkdirSync(join(root, "fixtures/bonding", cell), { recursive: true });
  for (const seed of seeds) {
    const text = bondingBytes(generateBonding(seed, cell, bonding.cells[cell]!, bonding));
    if (writeIfChanged(join(root, bondingPath(cell, seed)), text)) written += 1;
    entries.push({ path: bondingPath(cell, seed), family: "bonding", seed, generator: BONDING_VERSION, sha256: sha256(text) });
  }
  console.log(`bonding/${cell}: ${seeds.length} fixtures`);
}

// Family 7: the claims of one horizon per seed and cell, with the adopted prover measurement.
const proof = loadProofConfig(root);
const costTable = loadCostTable(root, proof);
for (const cell of Object.keys(proof.cells).sort()) {
  mkdirSync(join(root, "fixtures/proof_budget", cell), { recursive: true });
  for (const seed of [...SEED_BLOCKS.development, ...SEED_BLOCKS.confirmatory]) {
    const text = proofBytes(generateProof(seed, cell, proof.cells[cell]!, costTable));
    if (writeIfChanged(join(root, proofPath(cell, seed)), text)) written += 1;
    entries.push({ path: proofPath(cell, seed), family: "proof_budget", seed, generator: PROOF_VERSION, sha256: sha256(text) });
  }
  console.log(`proof_budget/${cell}: ${SEED_BLOCKS.development.length + SEED_BLOCKS.confirmatory.length} fixtures`);
}

const manifest = buildManifest(root, BENCH, vendoredCommit(root), entries);
writeIfChanged(join(root, "fixtures/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest ${manifestHash(manifest)} (${entries.length} fixtures, ${written} written, Spiral ${manifest.spiral.commit})`);
