// Demand streams for the settlement-object family (docs/tasks.md §4.1). Time advances in steps of
// one round interval; in each step each agent may receive and may spend. The two corner cells take
// their parameters from the pinned corner test in vendor/spiral/model/server.test.ts. The rest of
// the generator (the common-shock share, per-agent streams, the funded-spend rule) is the bench's.
//
// A stream is too large to commit (hundreds of thousands of integers), so a fixture stores the
// cell parameters and the SHA-256 of each stream. The stream is regenerated from the seed when it
// is loaded and refused if its hash differs.

import { createHash } from "node:crypto";
import { canonical } from "../../harness/json.ts";
import { nodeId } from "../../harness/order.ts";
import { stream as rngStream } from "../../harness/prng.ts";

export const FIXTURE_VERSION = "settlement-fixture/v0";
export const STREAM_KINDS = ["evaluation", "pilot"] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

/** One step of one agent's demand; the shape channelLiquidityDuration takes. */
export interface Step { out: number; in: number; }
/** Agent name → steps. Keys are inserted in sorted order. */
export type DemandStream = Map<string, Step[]>;

/** Probabilities are integers in parts per million, so a fixture holds integers and strings only. */
export interface CellParams {
  agents: number;
  base: { in_sats: number; out_sats: number; jitter_sats: number };
  burst: { p_in_ppm: number; in_sats: number; p_out_ppm: number; out_sats: number };
  common_shock_share_ppm: number;
  horizon_lifetimes: number;
}

export interface Protocol { lifetime_blocks: number; round_interval_blocks: number; }

export interface StreamSummary { sha256: string; receipts: number; spends: number; volume_in: number; volume_out: number; }

export interface SettlementFixture {
  version: string;
  seed: number;
  cell: string;
  params: CellParams;
  protocol: Protocol;
  steps: number;
  streams: { [kind in StreamKind]: StreamSummary };
}

export const stepsOf = (params: CellParams, protocol: Protocol): number => {
  const steps = (params.horizon_lifetimes * protocol.lifetime_blocks) / protocol.round_interval_blocks;
  if (!Number.isInteger(steps)) throw new Error("horizon must be a whole number of rounds");
  return steps;
};

export function generateStream(seed: number, cell: string, kind: StreamKind, params: CellParams, protocol: Protocol): DemandStream {
  const steps = stepsOf(params, protocol);
  const { base, burst } = params;
  const million = 1_000_000;
  // Population-wide burst indicators for each step.
  const common = rngStream("settlement/common", seed, cell, kind);
  const commonIn: boolean[] = [];
  const commonOut: boolean[] = [];
  for (let t = 0; t < steps; t++) {
    commonIn.push(common.next() * million < burst.p_in_ppm);
    commonOut.push(common.next() * million < burst.p_out_ppm);
  }
  const out: DemandStream = new Map();
  for (let a = 0; a < params.agents; a++) {
    const name = nodeId(a, "a");
    // One stream per agent, and every draw taken on every step, so changing the population size or
    // a probability cannot shift another agent's draws.
    const rng = rngStream("settlement/agent", seed, cell, kind, name);
    const series: Step[] = [];
    let running = 0;
    for (let t = 0; t < steps; t++) {
      const follows = rng.next() * million < params.common_shock_share_ppm;
      const ownIn = rng.next() * million < burst.p_in_ppm;
      const ownOut = rng.next() * million < burst.p_out_ppm;
      const jitterIn = Math.floor(rng.next() * base.jitter_sats);
      const jitterOut = Math.floor(rng.next() * base.jitter_sats);
      const inflow = ((follows ? commonIn[t]! : ownIn) ? burst.in_sats : 0) + (base.in_sats > 0 ? base.in_sats + jitterIn : 0);
      let outflow = ((follows ? commonOut[t]! : ownOut) ? burst.out_sats : 0) + (base.out_sats > 0 ? base.out_sats + jitterOut : 0);
      // Funded-spend rule: keep a spend only if the agent could fund it with every receipt delivered.
      // A spend no object could serve says nothing about the object, so it is not in the stream.
      running += inflow;
      if (outflow > running) outflow = 0; else running -= outflow;
      series.push({ out: outflow, in: inflow });
    }
    out.set(name, series);
  }
  return out;
}

export function summarize(stream: DemandStream): StreamSummary {
  const hash = createHash("sha256");
  let receipts = 0, spends = 0, volumeIn = 0, volumeOut = 0;
  for (const [name, series] of stream) {
    hash.update(`${name}:${series.length}\n`);
    const buffer = Buffer.alloc(series.length * 8);
    series.forEach((s, t) => {
      buffer.writeUInt32LE(s.in, t * 8);
      buffer.writeUInt32LE(s.out, t * 8 + 4);
      if (s.in) { receipts += 1; volumeIn += s.in; }
      if (s.out) { spends += 1; volumeOut += s.out; }
    });
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), receipts, spends, volume_in: volumeIn, volume_out: volumeOut };
}

export function generateFixture(seed: number, cell: string, params: CellParams, protocol: Protocol): SettlementFixture {
  const streams = {} as { [kind in StreamKind]: StreamSummary };
  for (const kind of STREAM_KINDS) streams[kind] = summarize(generateStream(seed, cell, kind, params, protocol));
  return { version: FIXTURE_VERSION, seed, cell, params, protocol, steps: stepsOf(params, protocol), streams };
}

/** Regenerate a fixture's stream and refuse it if it does not hash to the bound value. */
export function loadStream(fixture: SettlementFixture, kind: StreamKind): DemandStream {
  const stream = generateStream(fixture.seed, fixture.cell, kind, fixture.params, fixture.protocol);
  const actual = summarize(stream).sha256;
  if (actual !== fixture.streams[kind].sha256) {
    throw new Error(`settlement fixture ${fixture.cell} seed ${fixture.seed}: regenerated ${kind} stream does not match its bound hash`);
  }
  return stream;
}

export const fixtureBytes = (fixture: SettlementFixture): string => `${canonical(fixture)}\n`;

export const fixturePath = (cell: string, seed: number): string => `fixtures/settlement_object/${cell}/seed-${String(seed).padStart(4, "0")}.json`;
