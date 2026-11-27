// Family 14 wiring: config, fixtures, episodes (docs/tasks.md §17).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Environment } from "../../harness/agent.ts";
import { sha256 } from "../../harness/json.ts";
import { ManifestError, loadFixture, type FixtureEntry, type Manifest } from "../../harness/manifest.ts";
import { CashuEnv } from "./env.ts";
import { FIXTURE_VERSION, fixtureBytes, fixturePath, generateFixture, type CashuConfig, type CashuFixture } from "./generate.ts";

/** Practical-equivalence band in sats: half the desk's fee on a 100,000-sat deposit. [invented] */
export const CASHU_BAND = 250;

export const loadCashuConfig = (root: string): CashuConfig => JSON.parse(readFileSync(join(root, "config/cashu.json"), "utf8")) as CashuConfig;

export const cashuCells = (config: CashuConfig): string[] => Object.keys(config.cells).sort();

/** Write every fixture of the family for the given seeds (only where the bytes differ) and return their manifest entries. */
export function buildCashuFixtures(root: string, config: CashuConfig, seeds: readonly number[]): { entries: FixtureEntry[]; written: number } {
  const entries: FixtureEntry[] = [];
  let written = 0;
  for (const cell of cashuCells(config)) {
    for (const seed of seeds) {
      const path = fixturePath(cell, seed);
      const text = fixtureBytes(generateFixture(seed, cell, config.cells[cell]!, config));
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      if (!existsSync(full) || readFileSync(full, "utf8") !== text) { writeFileSync(full, text); written += 1; }
      entries.push({ path, family: "cashu", seed, generator: FIXTURE_VERSION, sha256: sha256(text) });
    }
  }
  return { entries, written };
}

const loaded = new Map<string, CashuFixture>();

export function cashuFixture(root: string, manifest: Manifest, cell: string, seed: number): CashuFixture {
  const path = fixturePath(cell, seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  const key = `${root}|${path}|${entry.sha256}`;
  let fixture = loaded.get(key);
  if (!fixture) { fixture = loadFixture<CashuFixture>(root, manifest, path); loaded.set(key, fixture); }
  return fixture;
}

/** One episode per seed per cell. */
export function cashuEpisodes(root: string, manifest: Manifest, config: CashuConfig, cell: string, seed: number): Environment[] {
  return [new CashuEnv(cashuFixture(root, manifest, cell, seed), config)];
}
