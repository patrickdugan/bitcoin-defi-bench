// Family 9 wiring: config, fixtures, episodes, for the seven cells of docs/tasks.md §10.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Agent, Environment } from "../../harness/agent.ts";
import { canonical, sha256 } from "../../harness/json.ts";
import { ManifestError, loadFixture, type FixtureEntry, type Manifest } from "../../harness/manifest.ts";
import { CounterpartyEnv, COUNTERPARTY_VERSION, counterpartyBaselines, generateCounterparty, type CounterpartyConfig, type CounterpartyFixture } from "./counterparty.ts";
import { CustodyEnv, CUSTODY_VERSION, custodyBaselines, custodyFixtureCheck, generateCustody, type CustodyConfig, type CustodyFixture } from "./custody.ts";
import { CustodyHotEnv, CUSTODY_HOT_VERSION, custodyHotBaselines, custodyHotFixtureCheck, generateCustodyHot, type CustodyHotConfig, type CustodyHotFixture } from "./custody_hot.ts";
import { MeshEnv, MESH_VERSION, meshBaselines, generateMesh, type MeshConfig, type MeshFixture } from "./mesh.ts";
import { PrivateEnv, PRIVATE_VERSION, privateBaselines, generatePrivate, type PrivateConfig, type PrivateFixture } from "./private.ts";
import { PublishEnv, PUBLISH_VERSION, publishBaselines, generatePublish, type PublishConfig, type PublishFixture } from "./publish.ts";

export interface NostrConfig {
  version: string;
  custody: CustodyConfig;
  custody_hot: CustodyHotConfig;
  publish: PublishConfig;
  private: PrivateConfig;
  counterparty: CounterpartyConfig;
  mesh: MeshConfig;
}

export const NOSTR_CELLS = ["counterparty", "custody", "custody_hot", "mesh_outage", "mesh_partial", "private", "publish"] as const;
export type NostrCell = (typeof NOSTR_CELLS)[number];

export const loadNostrConfig = (root: string): NostrConfig => JSON.parse(readFileSync(join(root, "config/nostr.json"), "utf8")) as NostrConfig;

export const nostrFixturePath = (cell: string, seed: number): string => `fixtures/nostr/${cell}/seed-${String(seed).padStart(4, "0")}.json`;
export const nostrFixtureBytes = (fixture: unknown): string => `${canonical(fixture)}\n`;

export const generatorVersion = (cell: NostrCell): string => ({
  counterparty: COUNTERPARTY_VERSION, custody: CUSTODY_VERSION, custody_hot: CUSTODY_HOT_VERSION,
  mesh_outage: MESH_VERSION, mesh_partial: MESH_VERSION, private: PRIVATE_VERSION, publish: PUBLISH_VERSION,
})[cell];

/** Generate one fixture. Generators check their own labels against the stated policy where a ceiling depends on it. */
export function generateNostr(cell: NostrCell, seed: number, config: NostrConfig): unknown {
  switch (cell) {
    case "custody": { const f = generateCustody(seed, config.custody); custodyFixtureCheck(f); return f; }
    case "custody_hot": { const f = generateCustodyHot(seed, config.custody_hot); custodyHotFixtureCheck(f); return f; }
    case "publish": return generatePublish(seed, config.publish);
    case "private": return generatePrivate(seed, config.private);
    case "counterparty": return generateCounterparty(seed, config.counterparty);
    case "mesh_outage": return generateMesh(seed, "mesh_outage", config.mesh);
    case "mesh_partial": return generateMesh(seed, "mesh_partial", config.mesh);
  }
}

/** Write every fixture of the family for the given seeds (only where the bytes differ) and return their manifest entries. */
export function buildNostrFixtures(root: string, config: NostrConfig, seeds: readonly number[]): { entries: FixtureEntry[]; written: number } {
  const entries: FixtureEntry[] = [];
  let written = 0;
  for (const cell of NOSTR_CELLS) {
    for (const seed of seeds) {
      const path = nostrFixturePath(cell, seed);
      const text = nostrFixtureBytes(generateNostr(cell, seed, config));
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      if (!existsSync(full) || readFileSync(full, "utf8") !== text) { writeFileSync(full, text); written += 1; }
      entries.push({ path, family: "nostr", seed, generator: generatorVersion(cell), sha256: sha256(text) });
    }
  }
  return { entries, written };
}

const loaded = new Map<string, unknown>();

export function nostrFixture<T>(root: string, manifest: Manifest, cell: NostrCell, seed: number): T {
  const path = nostrFixturePath(cell, seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  const key = `${root}|${path}|${entry.sha256}`;
  if (!loaded.has(key)) loaded.set(key, loadFixture<T>(root, manifest, path));
  return loaded.get(key) as T;
}

/** One episode per seed per cell. */
export function nostrEpisodes(root: string, manifest: Manifest, config: NostrConfig, cell: NostrCell, seed: number): Environment[] {
  switch (cell) {
    case "custody": return [new CustodyEnv(nostrFixture<CustodyFixture>(root, manifest, cell, seed), config.custody)];
    case "custody_hot": return [new CustodyHotEnv(nostrFixture<CustodyHotFixture>(root, manifest, cell, seed), config.custody_hot)];
    case "publish": return [new PublishEnv(nostrFixture<PublishFixture>(root, manifest, cell, seed), config.publish)];
    case "private": return [new PrivateEnv(nostrFixture<PrivateFixture>(root, manifest, cell, seed), config.private)];
    case "counterparty": return [new CounterpartyEnv(nostrFixture<CounterpartyFixture>(root, manifest, cell, seed), config.counterparty)];
    case "mesh_outage": case "mesh_partial": return [new MeshEnv(nostrFixture<MeshFixture>(root, manifest, cell, seed), config.mesh)];
  }
}

export const nostrBaselines = (cell: NostrCell): Agent[] => ({
  custody: custodyBaselines, custody_hot: custodyHotBaselines, publish: publishBaselines, private: privateBaselines,
  counterparty: counterpartyBaselines, mesh_outage: meshBaselines, mesh_partial: meshBaselines,
})[cell]();
