// Fixtures for family 2. A routing episode runs on a family 1 fixture: its topology, capacities,
// balances, and the stationary and shifted demand streams. Family 1's fixtures are frozen, so the
// third regime, diffuse demand (Spiral's `public_demand_stream` with no hotspot draws), lives in a
// family 2 fixture that names its family 1 fixture by path and SHA-256. The diffuse stream is
// regenerated from the same named random stream as family 1's, taking every draw on every step, so
// on every step that is not a hotspot draw the diffuse demand is the stationary one.

import { canonical } from "../../harness/json.ts";
import { stream } from "../../harness/prng.ts";
import type { Demand, PlacementConfig, PlacementFixture } from "../placement/generate.ts";

export const FIXTURE_VERSION = "routing-fixture/v0";

export const ROUTING_REGIMES = ["diffuse", "stationary", "shift"] as const;
export type RoutingRegime = (typeof ROUTING_REGIMES)[number];

export interface RoutingFixture {
  version: string;
  seed: number;
  placement: { path: string; sha256: string };
  demand_diffuse: Demand[];
}

/** The diffuse stream: family 1's draws (placement/generate.ts, `demandStreams`) with every step a uniform pair. */
export function diffuseStream(fixture: PlacementFixture, config: PlacementConfig): Demand[] {
  const rng = stream("placement/demand", fixture.seed, fixture.sample.attempt);
  const nodes = fixture.nodes;
  const out: Demand[] = [];
  for (let i = 0; i < config.steps; i++) {
    rng.next(); // the hotspot draw, unused here
    rng.next(); // the direction draw, unused here
    const a = rng.int(nodes.length);
    let b = rng.int(nodes.length - 1);
    if (b >= a) b += 1;
    const sats = rng.pick(config.amounts);
    out.push([nodes[a]!, nodes[b]!, sats]);
  }
  return out;
}

export function generateFixture(placement: PlacementFixture, placementPath: string, placementSha256: string, config: PlacementConfig): RoutingFixture {
  return { version: FIXTURE_VERSION, seed: placement.seed, placement: { path: placementPath, sha256: placementSha256 }, demand_diffuse: diffuseStream(placement, config) };
}

export const fixtureBytes = (fixture: RoutingFixture): string => `${canonical(fixture)}\n`;

export const fixturePath = (seed: number): string => `fixtures/routing/seed-${String(seed).padStart(4, "0")}.json`;
