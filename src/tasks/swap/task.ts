// Family 11 wiring: config, fixtures, episodes (docs/tasks.md §14).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Environment } from "../../harness/agent.ts";
import { sha256 } from "../../harness/json.ts";
import { ManifestError, loadFixture, type FixtureEntry, type Manifest } from "../../harness/manifest.ts";
import { SwapEnv } from "./env.ts";
import { FIXTURE_VERSION, fixtureBytes, fixturePath, generateFixture, type SwapConfig, type SwapFixture } from "./generate.ts";

/** Practical-equivalence band in sats: a tenth of the smallest swap's value. [invented] */
export const SWAP_BAND = 750;

export const loadSwapConfig = (root: string): SwapConfig => JSON.parse(readFileSync(join(root, "config/swap.json"), "utf8")) as SwapConfig;

export const swapCells = (config: SwapConfig): string[] => Object.keys(config.cells).sort();

/** Write every fixture of the family for the given seeds (only where the bytes differ) and return their manifest entries. */
export function buildSwapFixtures(root: string, config: SwapConfig, seeds: readonly number[]): { entries: FixtureEntry[]; written: number } {
  const entries: FixtureEntry[] = [];
  let written = 0;
  for (const cell of swapCells(config)) {
    for (const seed of seeds) {
      const path = fixturePath(cell, seed);
      const text = fixtureBytes(generateFixture(seed, cell, config.cells[cell]!, config));
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      if (!existsSync(full) || readFileSync(full, "utf8") !== text) { writeFileSync(full, text); written += 1; }
      entries.push({ path, family: "swap", seed, generator: FIXTURE_VERSION, sha256: sha256(text) });
    }
  }
  return { entries, written };
}

const loaded = new Map<string, SwapFixture>();

export function swapFixture(root: string, manifest: Manifest, cell: string, seed: number): SwapFixture {
  const path = fixturePath(cell, seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  const key = `${root}|${path}|${entry.sha256}`;
  let fixture = loaded.get(key);
  if (!fixture) { fixture = loadFixture<SwapFixture>(root, manifest, path); loaded.set(key, fixture); }
  return fixture;
}

/** One episode per seed per cell. */
export function swapEpisodes(root: string, manifest: Manifest, config: SwapConfig, cell: string, seed: number): Environment[] {
  return [new SwapEnv(swapFixture(root, manifest, cell, seed), config)];
}
