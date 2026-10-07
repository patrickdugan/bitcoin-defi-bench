// Family 6 wiring: config, fixtures, episodes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment } from "../../harness/agent.ts";
import { ManifestError, loadFixture, type Manifest } from "../../harness/manifest.ts";
import { NettingEnv, type NettingConfig } from "./env.ts";
import { fixturePath, type NettingFixture } from "./generate.ts";

/** Practical-equivalence band in ln cost, about 5% of settlement cost. Chosen in prereg/v0.md Amendment 3. */
export const NETTING_BAND = 0.05;

export function loadNettingConfig(root: string): NettingConfig {
  return JSON.parse(readFileSync(join(root, "config/netting.json"), "utf8")) as NettingConfig;
}

const loaded = new Map<string, NettingFixture>();

export function nettingFixture(root: string, manifest: Manifest, cell: string, seed: number): NettingFixture {
  const path = fixturePath(cell, seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  const key = `${root}|${path}|${entry.sha256}`;
  let fixture = loaded.get(key);
  if (!fixture) { fixture = loadFixture<NettingFixture>(root, manifest, path); loaded.set(key, fixture); }
  return fixture;
}

/** One episode per seed per cell. */
export function nettingEpisodes(root: string, manifest: Manifest, config: NettingConfig, cell: string, seed: number): Environment[] {
  return [new NettingEnv(nettingFixture(root, manifest, cell, seed), config)];
}
