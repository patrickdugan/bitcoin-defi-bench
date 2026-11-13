// Fixtures for family 11 (docs/tasks.md §14): one swap per seed and cell. A fixture holds the quote,
// both HTLC scripts, the desk's hidden behaviour, and the clearing fee rate of every block to the
// horizon, computed once here and hash-bound.

import { bytesToHex } from "../nostr/secp256k1.ts";
import { canonical } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";
import { compressedPubkey, hash160, htlcScript, sha256 } from "./script.ts";

export const FIXTURE_VERSION = "swap-fixture/v0";
export const VERSION_TAG = "bitcoin-defi-bench/v0|swap";

export const DESK_TYPES = ["honest", "slow", "short_change", "double_spend", "short_timeout", "absent"] as const;
export type DeskType = (typeof DESK_TYPES)[number];

export interface CellParams {
  spike_ppm: number;
  spike_multiplier: [number, number];
  spike_blocks: [number, number];
  spike_after_lock: [number, number];
}

export interface SwapConfig {
  start_height: [number, number];
  amount_sats: [number, number];
  amount_step_sats: number;
  desk_fee_ppm: number;
  swap_value_ppm: number;
  in_timeout_blocks: number;
  out_timeout_blocks: number;
  horizon_after_in_timeout: number;
  desk_lock_delay: { prompt: number; slow: [number, number] };
  short_change_ppm: [number, number];
  reorg_depth: [number, number];
  short_timeout_blocks: [number, number];
  vbytes: { fund: number; claim: number; refund: number };
  wallet_buffer_sats: number;
  fallback_fee_multiplier: number;
  max_fee_rate: number;
  fees: { base_sat_vb: [number, number]; walk_sigma: number; min_sat_vb: number };
  desks: { [type in DeskType]: number };
  cells: { [cell: string]: CellParams };
  budget: { attempts: number; probes: number };
}

export interface Quote {
  amount_in_sats: number;
  amount_out_sats: number;
  desk_fee_sats: number;
  swap_value_sats: number;
  /** The customer's refund height (the in-HTLC's CLTV). The quote is good only at the start height. */
  in_timeout_height: number;
  /** How many blocks after its lock confirms the desk promises before it can refund. */
  out_timeout_blocks: number;
}

export interface SwapFixture {
  version: string;
  seed: number;
  cell: string;
  start_height: number;
  horizon_height: number;
  quote: Quote;
  vbytes: { fund: number; claim: number; refund: number };
  customer: { claim_pubkey_hash: string; refund_pubkey_hash: string; digest: string; preimage: string };
  /** The in-HTLC the customer funds: the desk claims with the preimage, the customer refunds after the in-timeout. */
  in_script: string;
  desk: {
    claim_pubkey_hash: string;
    refund_pubkey_hash: string;
    /** Hidden from the agent from here down. */
    type: DeskType;
    lock_height: number | null;
    out_timeout_height: number | null;
    amount_out_sats: number | null;
    reorg_height: number | null;
    /** The payout HTLC: the customer claims with the preimage, the desk refunds after out_timeout_height. */
    payout_script: string | null;
  };
  /** Clearing fee rate of each block from start_height to horizon_height, sat/vB: a transaction bidding at least this confirms in that block. */
  fees: number[];
  spike: { start_height: number; blocks: number; multiplier: number } | null;
}

export const fixturePath = (cell: string, seed: number): string => `fixtures/swap/${cell}/seed-${String(seed).padStart(4, "0")}.json`;
export const fixtureBytes = (fixture: SwapFixture): string => `${canonical(fixture)}\n`;

const between = (rng: Stream, [lo, hi]: [number, number]): number => lo + rng.int(hi - lo + 1);

/** A deterministic throwaway key: SHA-256 of its labels, used as a secp256k1 secret. */
export const keySecret = (...labels: Array<string | number>): Uint8Array => sha256(new TextEncoder().encode([VERSION_TAG, "key", ...labels].join("|")));
const pkh = (secret: Uint8Array): string => bytesToHex(hash160(compressedPubkey(secret)));

function drawDesk(rng: Stream, weights: SwapConfig["desks"]): DeskType {
  const total = DESK_TYPES.reduce((a, t) => a + weights[t], 0);
  let x = rng.int(total);
  for (const t of DESK_TYPES) {
    if (x < weights[t]) return t;
    x -= weights[t];
  }
  throw new Error("unreachable");
}

export function generateFixture(seed: number, cell: string, params: CellParams, config: SwapConfig): SwapFixture {
  const rng = (label: string): Stream => stream(VERSION_TAG, cell, seed, label);
  const q = rng("quote");
  const h0 = between(q, config.start_height);
  const steps = Math.floor((config.amount_sats[1] - config.amount_sats[0]) / config.amount_step_sats);
  const amountIn = config.amount_sats[0] + config.amount_step_sats * q.int(steps + 1);
  const deskFee = Math.round(amountIn * config.desk_fee_ppm / 1_000_000);
  const quote: Quote = {
    amount_in_sats: amountIn,
    amount_out_sats: amountIn - deskFee,
    desk_fee_sats: deskFee,
    swap_value_sats: Math.round(amountIn * config.swap_value_ppm / 1_000_000),
    in_timeout_height: h0 + config.in_timeout_blocks,
    out_timeout_blocks: config.out_timeout_blocks,
  };
  const horizon = quote.in_timeout_height + config.horizon_after_in_timeout;

  const preimage = sha256(new TextEncoder().encode([VERSION_TAG, "preimage", cell, seed].join("|")));
  const digest = sha256(preimage);
  const customer = { claim_pubkey_hash: pkh(keySecret(cell, seed, "customer-claim")), refund_pubkey_hash: pkh(keySecret(cell, seed, "customer-refund")), digest: bytesToHex(digest), preimage: bytesToHex(preimage) };
  const deskKeys = { claim_pubkey_hash: pkh(keySecret(cell, seed, "desk-claim")), refund_pubkey_hash: pkh(keySecret(cell, seed, "desk-refund")) };
  const inScript = htlcScript({ digest, claimPkh: Buffer.from(deskKeys.claim_pubkey_hash, "hex"), refundPkh: Buffer.from(customer.refund_pubkey_hash, "hex"), locktime: quote.in_timeout_height });

  const d = rng("desk");
  const type = drawDesk(d, config.desks);
  // The customer's funding confirms at h0 + 1; a desk locks after seeing it.
  const lock = type === "absent" ? null
    : type === "slow" ? h0 + 1 + between(d, config.desk_lock_delay.slow)
    : h0 + 1 + config.desk_lock_delay.prompt;
  const outTimeout = lock === null ? null : type === "short_timeout" ? lock + between(d, config.short_timeout_blocks) : lock + config.out_timeout_blocks;
  const amountOut = lock === null ? null : type === "short_change" ? quote.amount_out_sats - Math.round(amountIn * between(d, config.short_change_ppm) / 1_000_000) : quote.amount_out_sats;
  const reorg = type === "double_spend" && lock !== null ? lock + between(d, config.reorg_depth) : null;
  const payout = lock === null || outTimeout === null ? null
    : bytesToHex(htlcScript({ digest, claimPkh: Buffer.from(customer.claim_pubkey_hash, "hex"), refundPkh: Buffer.from(deskKeys.refund_pubkey_hash, "hex"), locktime: outTimeout }));

  const s = rng("spike");
  const spike = s.int(1_000_000) < params.spike_ppm
    ? { start_height: lock === null ? h0 + 2 + s.int(19) : lock + between(s, params.spike_after_lock), blocks: between(s, params.spike_blocks), multiplier: between(s, params.spike_multiplier) }
    : null;

  const f = rng("fees");
  const [lo, hi] = config.fees.base_sat_vb;
  let walk = Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * f.next());
  const fees: number[] = [];
  for (let h = h0; h <= horizon; h++) {
    if (h > h0) walk *= Math.exp(config.fees.walk_sigma * f.normal());
    const inSpike = spike !== null && h >= spike.start_height && h < spike.start_height + spike.blocks;
    fees.push(Math.max(config.fees.min_sat_vb, Math.round(walk * (inSpike ? spike.multiplier : 1))));
  }

  return {
    version: FIXTURE_VERSION, seed, cell, start_height: h0, horizon_height: horizon, quote, vbytes: { ...config.vbytes },
    customer, in_script: bytesToHex(inScript),
    desk: { ...deskKeys, type, lock_height: lock, out_timeout_height: outTimeout, amount_out_sats: amountOut, reorg_height: reorg, payout_script: payout },
    fees, spike,
  };
}
