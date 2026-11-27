// Family 12 wiring: config, fixtures, episodes (docs/tasks.md §15).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Environment } from "../../harness/agent.ts";
import { sha256 } from "../../harness/json.ts";
import { ManifestError, loadFixture, type FixtureEntry, type Manifest } from "../../harness/manifest.ts";
import { Bitvm3Env } from "./env.ts";
import { FIXTURE_VERSION, fixtureBytes, fixturePath, generateFixture, type Bitvm3Config, type Bitvm3Fixture } from "./generate.ts";

/** Practical-equivalence band in sats: a tenth of the smallest vault UTXO. [invented] */
export const BITVM3_BAND = 10_000;

export const loadBitvm3Config = (root: string): Bitvm3Config => JSON.parse(readFileSync(join(root, "config/bitvm3.json"), "utf8")) as Bitvm3Config;

export const bitvm3Cells = (config: Bitvm3Config): string[] => Object.keys(config.cells).sort();

/** Write every fixture of the family for the given seeds (only where the bytes differ) and return their manifest entries. */
export function buildBitvm3Fixtures(root: string, config: Bitvm3Config, seeds: readonly number[]): { entries: FixtureEntry[]; written: number } {
  const entries: FixtureEntry[] = [];
  let written = 0;
  for (const cell of bitvm3Cells(config)) {
    for (const seed of seeds) {
      const path = fixturePath(cell, seed);
      const text = fixtureBytes(generateFixture(seed, cell, config.cells[cell]!, config));
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      if (!existsSync(full) || readFileSync(full, "utf8") !== text) { writeFileSync(full, text); written += 1; }
      entries.push({ path, family: "bitvm3", seed, generator: FIXTURE_VERSION, sha256: sha256(text) });
    }
  }
  return { entries, written };
}

const loaded = new Map<string, Bitvm3Fixture>();

export function bitvm3Fixture(root: string, manifest: Manifest, cell: string, seed: number): Bitvm3Fixture {
  const path = fixturePath(cell, seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  const key = `${root}|${path}|${entry.sha256}`;
  let fixture = loaded.get(key);
  if (!fixture) { fixture = loadFixture<Bitvm3Fixture>(root, manifest, path); loaded.set(key, fixture); }
  return fixture;
}

/** One episode per seed per cell. */
export function bitvm3Episodes(root: string, manifest: Manifest, config: Bitvm3Config, cell: string, seed: number): Environment[] {
  return [new Bitvm3Env(bitvm3Fixture(root, manifest, cell, seed), config)];
}
