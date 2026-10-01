// Family 3 wiring: config, fixtures, and the per-seed simulation cache.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Environment } from "../../harness/agent.ts";
import { loadFixture, type Manifest } from "../../harness/manifest.ts";
import { SettlementEnv, Simulations, type SettlementConfig } from "./env.ts";
import { fixturePath, type Protocol, type SettlementFixture } from "./generate.ts";

/** Practical-equivalence band in ln 𝒟 (about 5% of liquidity duration). Chosen in prereg/v0.md §5. */
export const SETTLEMENT_BAND = 0.05;

export function loadSettlementConfig(root: string): SettlementConfig {
  return JSON.parse(readFileSync(join(root, "config/settlement_object.json"), "utf8")) as SettlementConfig;
}

/** The two protocol inputs this family reads, from config/protocol.json. */
export function loadProtocol(root: string): Protocol {
  const p = (JSON.parse(readFileSync(join(root, "config/protocol.json"), "utf8")) as { parameters: { [name: string]: { value: number } } }).parameters;
  return { lifetime_blocks: p.vtxo_lifetime_blocks!.value, round_interval_blocks: p.round_interval_blocks!.value };
}

// One fixture's streams and results are held at a time: a 200-agent stream is a few million steps.
let current: { key: string; sims: Simulations } | null = null;

export function simulationsFor(root: string, manifest: Manifest, config: SettlementConfig, cell: string, seed: number): Simulations {
  const path = fixturePath(cell, seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  const key = `${root}|${path}|${entry?.sha256}`;
  if (current?.key !== key) {
    current = { key, sims: new Simulations(loadFixture<SettlementFixture>(root, manifest, path), config.epsilon) };
  }
  return current.sims;
}

/** One episode per seed per cell. */
export function settlementEpisodes(root: string, manifest: Manifest, config: SettlementConfig, cell: string, seed: number): Environment[] {
  return [new SettlementEnv(simulationsFor(root, manifest, config, cell, seed), config)];
}
