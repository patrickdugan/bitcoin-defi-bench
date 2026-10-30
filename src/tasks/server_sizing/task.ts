// Family 4 wiring: config, and the episode inputs from family 3's committed fixtures. The three
// cells reuse family 3's fixtures and streams unchanged: no fixture of this family exists. The
// evaluation stream is regenerated from the fixture's seed and refused if it does not hash to the
// bound value; so is the pilot stream.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixture, type Manifest } from "../../harness/manifest.ts";
import { fixturePath, loadStream, type SettlementFixture } from "../settlement_object/generate.ts";
import { positionPath, type SizingParams } from "./plan.ts";
import { ServerSizingEnv, type SizingInput } from "./env.ts";

/** Practical-equivalence band in ln cost, as families 6, 7, and 10. Not yet preregistered. */
export const SERVER_SIZING_BAND = 0.05;

export interface ServerSizingConfig {
  capital_rate_per_block: number;
  decision_interval_blocks: number;
  resize_delay_blocks: number;
  resize_fee_sats: number;
  lease_rate_ppm: number;
  failure_fixed_sats: number;
  failure_value_share: number;
  static_margin: number;
  buffer_margin: number;
  max_inbound_pilot_multiple: number;
  budget: { attempts: number };
  /** Cell → the family 3 cell whose fixtures and streams it reuses. */
  cells: { [cell: string]: string };
}

export function loadServerSizingConfig(root: string): ServerSizingConfig {
  return JSON.parse(readFileSync(join(root, "config/server_sizing.json"), "utf8")) as ServerSizingConfig;
}

// Keep only the most recent pair of streams: each holds over a million holder-rounds, so retaining
// every seed would be wasteful. Episodes run seed by seed, so the agents of one seed share it.
let current: { key: string; input: SizingInput } | null = null;

export function sizingInput(root: string, manifest: Manifest, config: ServerSizingConfig, cell: string, seed: number): SizingInput {
  const source = config.cells[cell];
  if (!source) throw new Error(`unknown server_sizing cell ${cell}`);
  const path = fixturePath(source, seed);
  const entry = manifest.fixtures.find((f) => f.path === path);
  const key = `${root}|${path}|${entry?.sha256}|${cell}|${JSON.stringify(config)}`;
  if (current?.key !== key) {
    const fixture = loadFixture<SettlementFixture>(root, manifest, path);
    const pilot = loadStream(fixture, "pilot");
    const evaluation = loadStream(fixture, "evaluation");
    const params: SizingParams = {
      round_interval_blocks: fixture.protocol.round_interval_blocks,
      decision_interval_blocks: config.decision_interval_blocks, resize_delay_blocks: config.resize_delay_blocks,
      capital_rate_per_block: config.capital_rate_per_block, resize_fee_sats: config.resize_fee_sats,
      lease_rate_ppm: config.lease_rate_ppm, failure_fixed_sats: config.failure_fixed_sats,
      failure_value_share: config.failure_value_share,
    };
    current = { key, input: {
      seed, cell, pilot, evaluation, params, attempts: config.budget.attempts, max_inbound_pilot_multiple: config.max_inbound_pilot_multiple,
      pilotPath: positionPath(pilot), evaluationPath: positionPath(evaluation),
    } };
  }
  return current.input;
}

/** One episode per seed per cell. */
export function serverSizingEpisodes(root: string, manifest: Manifest, config: ServerSizingConfig, cell: string, seed: number): ServerSizingEnv[] {
  return [new ServerSizingEnv(sizingInput(root, manifest, config, cell, seed))];
}
