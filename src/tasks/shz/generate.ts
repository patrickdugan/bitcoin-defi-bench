// Fixtures for family 13 (docs/tasks.md §16): one hedging episode per seed and cell. A fixture holds
// the true mark of every step, the federation's HOLD steps, the price move over the standard tier's
// 200 ms lag, the hedge target after each balance flow, and the mark packet the agent's relay shows
// at every step, with its kind. Everything an outcome depends on is computed here and hash-bound.

import { createHash } from "node:crypto";
import { canonical } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";

export const FIXTURE_VERSION = "shz-fixture/v0";
export const VERSION_TAG = "bitcoin-defi-bench/v0|shz";

export const TIERS = ["standard", "premium"] as const;
export type Tier = (typeof TIERS)[number];

/** What the agent's relay shows at a step. Only `genuine` is a packet the federation certified for this step with a price. */
export const PACKET_KINDS = ["genuine", "hold", "timeout", "forged", "under_signed", "stale_source", "replayed"] as const;
export type PacketKind = (typeof PACKET_KINDS)[number];
export const BAD_KINDS = ["forged", "under_signed", "stale_source", "replayed"] as const;

export interface CellParams {
  sigma_bps: number;
  jump_ppm: number;
  jump_bps: [number, number];
  jump_up_ppm: number;
  hold_start_ppm: number;
  hold_steps: [number, number];
  bad_ppm: number;
  bad_deviation_bps: [number, number];
}

export interface FederationPolicy {
  members: number;
  quorum: number;
  max_packet_age_ms: number;
  max_source_age_ms: number;
  max_future_ms: number;
  max_source_skew_ms: number;
  max_dispersion_bps: number;
}

export interface ShzConfig {
  steps: number;
  step_ms: number;
  origin_ms: number;
  receive_delay_ms: number;
  slots_per_step: number;
  slot_ms: number;
  start_price_usd: [number, number];
  target_usd: [number, number];
  target_step_usd: number;
  full_hedge_lots: number;
  target_lots: [number, number];
  max_lots: number;
  margin_unit_divisor: number;
  max_margin_units: number;
  max_leverage: number;
  maintenance_bps: number;
  liquidation_discount_bps: number;
  ladder: { first_offset_bps: number; step_bps: number; levels: number; lots_per_level: number };
  tiers: { [tier in Tier]: { taker_ppm: number; delay_ms: number } };
  lightning: { base_fee_msat: number; fee_ppm: number };
  capital_ppm_per_step: number;
  federation: FederationPolicy;
  lead_move: { survival: Array<[number, number]>; tail_bps_per_decade: number; max_bps: number };
  flows: { probability_ppm: number; two_lot_ppm: number };
  packets: { four_signer_ppm: number; timeout_ppm: number; replay_max_steps: number };
  cells: { [cell: string]: CellParams };
  budget: { attempts: number; probes: number };
}

export interface Source { name: string; ts_ms: number; price_usd: number | null; }
export interface Signature { member: number; key: string; }
export interface Packet {
  seq: number;
  boundary_ms: number;
  status: "VALID" | "HOLD";
  price_usd: number | null;
  hold_reason: number | null;
  sources: Source[];
  signatures: Signature[];
}

export interface ShzFixture {
  version: string;
  seed: number;
  cell: string;
  steps: number;
  step_ms: number;
  origin_ms: number;
  lot_usd: number;
  start_price_usd: number;
  balance_sats_start: number;
  margin_unit_sats: number;
  /** The federation's pinned member keys (x-only, hex), index 0 to 4. */
  members: string[];
  /** True mark at every step boundary, 0 to steps; marks[steps] is the maturity attestation. Hidden. */
  marks: number[];
  /** 1 where the federation has no verified mark (HOLD or quorum timeout), for steps 1 to steps − 1. Hidden. */
  hold: number[];
  /** Signed move in USD over the standard tier's 200 ms lag after each slot's boundary, [step][slot]. Hidden. */
  delta_usd: number[][];
  /** Hedge target in lots in force from each step, after that step's balance flow. */
  target_lots: number[];
  /** The holder's balance in sats at each step, after its flow. */
  balance_sats: number[];
  /** The packet the agent's relay shows at each slot of each step (null: none), and its kind (hidden), [step][slot]. */
  packets: Array<Array<{ kind: PacketKind; packet: Packet | null }>>;
}

export const fixturePath = (cell: string, seed: number): string => `fixtures/shz/${cell}/seed-${String(seed).padStart(4, "0")}.json`;
export const fixtureBytes = (fixture: ShzFixture): string => `${canonical(fixture)}\n`;

const between = (rng: Stream, [lo, hi]: [number, number]): number => lo + rng.int(hi - lo + 1);
const chance = (rng: Stream, ppm: number): boolean => rng.int(1_000_000) < ppm;
const keyOf = (...labels: Array<string | number>): string => createHash("sha256").update([VERSION_TAG, "key", ...labels].join("|")).digest("hex");

/** |move| in bps with survival S: log-linear between the table's points, the last decade's slope beyond, capped. */
export function leadMoveBps(u: number, lead: ShzConfig["lead_move"]): number {
  const s = 1 - u; // (0, 1]
  const pts = lead.survival.map(([x, ppm]) => [x, ppm / 1_000_000] as const);
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, s0] = pts[i]!;
    const [x1, s1] = pts[i + 1]!;
    if (s <= s0 && s > s1) return Math.min(lead.max_bps, x0 + (x1 - x0) * (Math.log(s0) - Math.log(s)) / (Math.log(s0) - Math.log(s1)));
  }
  const [xl, sl] = pts[pts.length - 1]!;
  return Math.min(lead.max_bps, xl + lead.tail_bps_per_decade * Math.log10(sl / s));
}

function signers(rng: Stream, members: string[], count: number): Signature[] {
  const idx = Array.from({ length: members.length }, (_, i) => i);
  rng.shuffle(idx);
  return idx.slice(0, count).sort((a, b) => a - b).map((i) => ({ member: i, key: members[i]! }));
}

export function generateFixture(seed: number, cell: string, params: CellParams, config: ShzConfig): ShzFixture {
  const rng = (label: string): Stream => stream(VERSION_TAG, cell, seed, label);
  const T = config.steps;
  const q = rng("quote");
  const p0 = between(q, config.start_price_usd);
  const tSteps = Math.floor((config.target_usd[1] - config.target_usd[0]) / config.target_step_usd);
  const targetUsd = config.target_usd[0] + config.target_step_usd * q.int(tSteps + 1);
  const lotUsd = targetUsd / config.full_hedge_lots;
  if (!Number.isInteger(lotUsd)) throw new Error("the target must split into whole-dollar lots");
  const balance0 = Math.floor(targetUsd * 1e8 / p0);
  const unit = Math.ceil(balance0 / config.margin_unit_divisor);
  const members = Array.from({ length: config.federation.members }, (_, i) => keyOf(cell, seed, "member", i));

  // True marks: lognormal steps plus jumps.
  const path = rng("path");
  const jumps = rng("jumps");
  const marks: number[] = [p0];
  for (let t = 1; t <= T; t++) {
    let r = params.sigma_bps * path.normal();
    if (params.jump_ppm > 0 && chance(jumps, params.jump_ppm)) {
      const size = between(jumps, params.jump_bps);
      r += chance(jumps, params.jump_up_ppm) ? size : -size;
    }
    marks.push(Math.max(1, Math.round(marks[t - 1]! * Math.exp(r / 10_000))));
  }

  // The 200 ms move after each slot's boundary, calibrated to the latency study.
  const R = config.slots_per_step;
  const lead = rng("lead");
  const delta: number[][] = [];
  for (let t = 0; t < T; t++) {
    const row: number[] = [];
    for (let r = 0; r < R; r++) {
      const bps = leadMoveBps(lead.next(), config.lead_move);
      const sign = lead.int(2) === 0 ? 1 : -1;
      row.push(sign * Math.round(marks[t]! * bps / 10_000));
    }
    delta.push(row);
  }

  // Federation HOLD runs: no verified mark for the venue or the agent. Never at step 0 or at maturity.
  const h = rng("hold");
  const hold: number[] = Array.from({ length: T + 1 }, () => 0);
  for (let t = 1; t < T; t++) {
    if (hold[t] === 1 || params.hold_start_ppm === 0 || !chance(h, params.hold_start_ppm)) continue;
    const len = between(h, params.hold_steps);
    for (let j = t; j < Math.min(T, t + len); j++) hold[j] = 1;
    t += len;
  }

  // Balance flows, only at steps with a verified mark, after that step's settlement.
  const fl = rng("flows");
  const targetLots: number[] = [config.full_hedge_lots];
  const balances: number[] = [balance0];
  for (let t = 1; t < T; t++) {
    let lots = targetLots[t - 1]!;
    if (hold[t] === 0 && chance(fl, config.flows.probability_ppm)) {
      const size = chance(fl, config.flows.two_lot_ppm) ? 2 : 1;
      const dir = fl.int(2) === 0 ? 1 : -1;
      lots = Math.min(config.target_lots[1], Math.max(config.target_lots[0], lots + dir * size));
    }
    targetLots.push(lots);
    balances.push(balances[t - 1]! + (lots - targetLots[t - 1]!) * Math.floor(lotUsd * 1e8 / marks[t]!));
  }

  // The packets the agent's relay shows: one per slot, R slots a step, 200 ms apart. A federation HOLD
  // lasts the whole step; a bad packet is drawn for each slot on its own.
  const pk = rng("packets");
  const bad = rng("bad");
  const boundary = (t: number, r: number): number => config.origin_ms + t * config.step_ms + r * config.slot_ms;
  const seqOf = (t: number, r: number): number => t * R + r + 1;
  const count = (): number => chance(pk, config.packets.four_signer_ppm) ? config.federation.quorum : config.federation.members;
  const genuineAt = (t: number, r: number): Packet => {
    const a = pk.int(4);
    const b = boundary(t, r);
    return {
      seq: seqOf(t, r), boundary_ms: b, status: "VALID", price_usd: marks[t]!, hold_reason: null,
      sources: [{ name: "pyth_pro", ts_ms: b - pk.int(401), price_usd: marks[t]! + a }, { name: "chainlink_streams", ts_ms: b - (b % 1000), price_usd: marks[t]! - a }],
      signatures: signers(pk, members, count()),
    };
  };
  const packets: ShzFixture["packets"] = [];
  const genuine: Packet[][] = [];
  for (let t = 0; t < T; t++) {
    const row: Array<{ kind: PacketKind; packet: Packet | null }> = [];
    genuine.push([]);
    for (let r = 0; r < R; r++) {
      const b = boundary(t, r);
      if (hold[t] === 1) {
        if (chance(pk, config.packets.timeout_ppm)) { row.push({ kind: "timeout", packet: null }); continue; }
        const reason = 1 + pk.int(2);
        // HOLD 1: a source missing or stale; HOLD 2: the sources' timestamps or prices too far apart.
        const sources: Source[] = [{ name: "pyth_pro", ts_ms: b - pk.int(401), price_usd: null }, { name: "chainlink_streams", ts_ms: reason === 1 ? b - (b % 1000) : b - (b % 1000) - 1000, price_usd: null }];
        row.push({ kind: "hold", packet: { seq: seqOf(t, r), boundary_ms: b, status: "HOLD", price_usd: null, hold_reason: reason, sources, signatures: signers(pk, members, count()) } });
        continue;
      }
      const g = genuineAt(t, r);
      genuine[t]!.push(g);
      if (params.bad_ppm === 0 || !chance(bad, params.bad_ppm)) { row.push({ kind: "genuine", packet: g }); continue; }
      let kind: PacketKind = BAD_KINDS[bad.int(BAD_KINDS.length)]!;
      const earlier: Packet[] = [];
      for (let k = 1; k <= config.packets.replay_max_steps && t - k >= 0; k++) earlier.push(...genuine[t - k]!);
      if (kind === "replayed" && earlier.length === 0) kind = "forged";
      if (kind === "stale_source" && t === 0) kind = "forged";
      if (kind === "replayed") {
        row.push({ kind, packet: JSON.parse(JSON.stringify(earlier[bad.int(earlier.length)])) as Packet });
        continue;
      }
      if (kind === "stale_source") {
        // One source stuck at the previous step; a relay that widened its bounds midpoints it with the fresh one.
        const price = Math.round((marks[t]! + marks[t - 1]!) / 2);
        row.push({ kind, packet: { ...g, price_usd: price, sources: [{ name: "pyth_pro", ts_ms: g.sources[0]!.ts_ms, price_usd: marks[t]! }, { name: "chainlink_streams", ts_ms: boundary(t - 1, 0), price_usd: marks[t - 1]! }] } });
        continue;
      }
      // Forged or under-signed: a price off the mark by the deviation, sources made to agree with it.
      const d = between(bad, params.bad_deviation_bps) * (bad.int(2) === 0 ? 1 : -1);
      const price = Math.round(marks[t]! * (10_000 + d) / 10_000);
      const sources: Source[] = [{ name: "pyth_pro", ts_ms: g.sources[0]!.ts_ms, price_usd: price + 1 }, { name: "chainlink_streams", ts_ms: g.sources[1]!.ts_ms, price_usd: price - 1 }];
      let signatures: Signature[];
      if (kind === "under_signed") signatures = signers(bad, members, config.federation.quorum - 1);
      else {
        signatures = signers(bad, members, config.federation.quorum + bad.int(2));
        const i = bad.int(signatures.length);
        signatures[i] = { member: signatures[i]!.member, key: keyOf(cell, seed, "forged", t, r) };
      }
      row.push({ kind, packet: { ...g, price_usd: price, sources, signatures } });
    }
    packets.push(row);
  }

  return {
    version: FIXTURE_VERSION, seed, cell, steps: T, step_ms: config.step_ms, origin_ms: config.origin_ms,
    lot_usd: lotUsd, start_price_usd: p0, balance_sats_start: balance0, margin_unit_sats: unit, members,
    marks, hold, delta_usd: delta, target_lots: targetLots, balance_sats: balances, packets,
  };
}
