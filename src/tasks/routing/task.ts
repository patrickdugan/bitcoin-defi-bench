// Family 2 wiring: fixtures and episodes. Parameters are family 1's (config/placement.json).

import type { Environment } from "../../harness/agent.ts";
import { ManifestError, loadFixture, type Manifest } from "../../harness/manifest.ts";
import type { BalanceModel, Demand, PlacementConfig } from "../placement/generate.ts";
import { placementFixture } from "../placement/task.ts";
import { RoutingEnv } from "./env.ts";
import { fixturePath, type RoutingFixture, type RoutingRegime } from "./generate.ts";

/** Practical-equivalence band in success points, as prereg/v0.md §5 states for family 2. */
export const ROUTING_BAND = 1.0;

const loaded = new Map<string, RoutingFixture>();

export function routingFixture(root: string, manifest: Manifest, seed: number): RoutingFixture {
  const path = fixturePath(seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  if (!entry) throw new ManifestError(path, "fixture is not listed in the manifest");
  const key = `${root}|${path}|${entry.sha256}`;
  let fixture = loaded.get(key);
  if (!fixture) {
    fixture = loadFixture<RoutingFixture>(root, manifest, path);
    const placement = manifest.fixtures.find((f) => f.path === fixture!.placement.path);
    if (!placement || placement.sha256 !== fixture.placement.sha256) throw new ManifestError(path, "names a family 1 fixture the manifest does not bind with that hash");
    loaded.set(key, fixture);
  }
  return fixture;
}

export function demandsFor(root: string, manifest: Manifest, seed: number, regime: RoutingRegime): Demand[] {
  if (regime === "diffuse") return routingFixture(root, manifest, seed).demand_diffuse;
  return placementFixture(root, manifest, seed).demand[regime];
}

/** One episode per seed per task. */
export function routingEpisodes(root: string, manifest: Manifest, config: PlacementConfig, model: BalanceModel, regime: RoutingRegime, seed: number): Environment[] {
  routingFixture(root, manifest, seed); // binds the family 2 fixture to its family 1 fixture
  return [new RoutingEnv(placementFixture(root, manifest, seed), demandsFor(root, manifest, seed, regime), model, regime, config)];
}
