// Family 5 wiring: config, fixtures, episodes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment } from "../../harness/agent.ts";
import { ManifestError, loadFixture, type Manifest } from "../../harness/manifest.ts";
import { BondingEnv } from "./env.ts";
import { fixturePath, type BondingConfig, type BondingFixture } from "./generate.ts";

/** Practical-equivalence band in ln cost, as families 6, 7, and 10. Not yet preregistered. */
export const BONDING_BAND = 0.05;

export function loadBondingConfig(root: string): BondingConfig {
  return JSON.parse(readFileSync(join(root, "config/bonding.json"), "utf8")) as BondingConfig;
}

const loaded = new Map<string, BondingFixture>();

export function bondingFixture(root: string, manifest: Manifest, cell: string, seed: number): BondingFixture {
  const path = fixturePath(cell, seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  const key = `${root}|${path}|${entry.sha256}`;
  let fixture = loaded.get(key);
  if (!fixture) { fixture = loadFixture<BondingFixture>(root, manifest, path); loaded.set(key, fixture); }
  return fixture;
}

export function bondingEpisodes(root: string, manifest: Manifest, config: BondingConfig, cell: string, seed: number): Environment[] {
  return [new BondingEnv(bondingFixture(root, manifest, cell, seed), config)];
}
