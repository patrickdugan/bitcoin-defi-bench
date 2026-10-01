// Family 1 wiring: which fixtures, cells, and tasks make up a run.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment } from "../../harness/agent.ts";
import { ManifestError, loadFixture, type Manifest } from "../../harness/manifest.ts";
import { PlacementEnv } from "./env.ts";
import { BALANCE_MODELS, REGIMES, fixturePath, type PlacementConfig, type PlacementFixture, type Regime } from "./generate.ts";

/** Practical-equivalence band in native units (success points), from the earlier Spiral preregistrations. */
export const PLACEMENT_BAND = 1.0;

export function loadPlacementConfig(root: string): PlacementConfig {
  return (JSON.parse(readFileSync(join(root, "config/placement.json"), "utf8")) as { parameters: PlacementConfig }).parameters;
}

const loaded = new Map<string, PlacementFixture>();

/** The fixture for a seed, hash-checked against the manifest the first time it is loaded in this process. */
export function placementFixture(root: string, manifest: Manifest, seed: number): PlacementFixture {
  const path = fixturePath(seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  const key = `${root}|${path}|${entry.sha256}`;
  let fixture = loaded.get(key);
  if (!fixture) {
    fixture = loadFixture<PlacementFixture>(root, manifest, path);
    loaded.set(key, fixture);
  }
  return fixture;
}

/** Fresh environments for one task on one seed: one episode per balance model. */
export function placementEpisodes(root: string, manifest: Manifest, config: PlacementConfig, task: string, seed: number): Environment[] {
  const regime = task.split("/")[1] as Regime;
  if (!REGIMES.includes(regime)) throw new Error(`unknown placement task ${task}`);
  const fixture = placementFixture(root, manifest, seed);
  return BALANCE_MODELS.map((model) => new PlacementEnv(fixture, model, regime, config));
}
