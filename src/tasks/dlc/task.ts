// Family 10 wiring: config, fixtures, episodes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment } from "../../harness/agent.ts";
import { ManifestError, loadFixture, type Manifest } from "../../harness/manifest.ts";
import { DlcEnv } from "./env.ts";
import { fixturePath, type DlcConfig, type DlcFixture } from "./generate.ts";

/** Practical-equivalence band in ln cost, about 5% of the contract's expected cost, as family 6. Chosen in prereg/v0.md Amendment 4. */
export const DLC_BAND = 0.05;

export function loadDlcConfig(root: string): DlcConfig {
  return JSON.parse(readFileSync(join(root, "config/dlc.json"), "utf8")) as DlcConfig;
}

const loaded = new Map<string, DlcFixture>();

export function dlcFixture(root: string, manifest: Manifest, cell: string, seed: number): DlcFixture {
  const path = fixturePath(cell, seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  const key = `${root}|${path}|${entry.sha256}`;
  let fixture = loaded.get(key);
  if (!fixture) { fixture = loadFixture<DlcFixture>(root, manifest, path); loaded.set(key, fixture); }
  return fixture;
}

/** One episode per seed per cell. */
export function dlcEpisodes(root: string, manifest: Manifest, config: DlcConfig, cell: string, seed: number): Environment[] {
  return [new DlcEnv(dlcFixture(root, manifest, cell, seed), config)];
}
