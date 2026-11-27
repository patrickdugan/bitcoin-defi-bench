// Family 13 wiring: config, fixtures, episodes (docs/tasks.md §16).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Environment } from "../../harness/agent.ts";
import { sha256 } from "../../harness/json.ts";
import { ManifestError, loadFixture, type FixtureEntry, type Manifest } from "../../harness/manifest.ts";
import { ShzEnv } from "./env.ts";
import { FIXTURE_VERSION, fixtureBytes, fixturePath, generateFixture, type ShzConfig, type ShzFixture } from "./generate.ts";

/** Practical-equivalence band in sats: about what one lot's take costs at the first ladder level. [invented] */
export const SHZ_BAND = 1_000;

export const loadShzConfig = (root: string): ShzConfig => JSON.parse(readFileSync(join(root, "config/shz.json"), "utf8")) as ShzConfig;

export const shzCells = (config: ShzConfig): string[] => Object.keys(config.cells).sort();

/** Write every fixture of the family for the given seeds (only where the bytes differ) and return their manifest entries. */
export function buildShzFixtures(root: string, config: ShzConfig, seeds: readonly number[]): { entries: FixtureEntry[]; written: number } {
  const entries: FixtureEntry[] = [];
  let written = 0;
  for (const cell of shzCells(config)) {
    for (const seed of seeds) {
      const path = fixturePath(cell, seed);
      const text = fixtureBytes(generateFixture(seed, cell, config.cells[cell]!, config));
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      if (!existsSync(full) || readFileSync(full, "utf8") !== text) { writeFileSync(full, text); written += 1; }
      entries.push({ path, family: "shz", seed, generator: FIXTURE_VERSION, sha256: sha256(text) });
    }
  }
  return { entries, written };
}

const loaded = new Map<string, ShzFixture>();

export function shzFixture(root: string, manifest: Manifest, cell: string, seed: number): ShzFixture {
  const path = fixturePath(cell, seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  const key = `${root}|${path}|${entry.sha256}`;
  let fixture = loaded.get(key);
  if (!fixture) { fixture = loadFixture<ShzFixture>(root, manifest, path); loaded.set(key, fixture); }
  return fixture;
}

/** One episode per seed per cell. */
export function shzEpisodes(root: string, manifest: Manifest, config: ShzConfig, cell: string, seed: number): Environment[] {
  return [new ShzEnv(shzFixture(root, manifest, cell, seed), config)];
}
