// Fixtures for family 14 (docs/tasks.md §17): one desk episode per seed and cell. A fixture holds every
// event of the horizon with its hidden truth, the mint's keysets and round reports, the operator's
// outage, the fee and quote paths, and real Cashu proofs made with nut.ts from seeded keys, computed
// once here and hash-bound.

import { canonical, sha256 } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";
import { N, bytesToBigInt } from "../nostr/secp256k1.ts";
import { keysetIdV1, makeProof, proofY, pubkeyOf, type ProofJson } from "./nut.ts";

export const FIXTURE_VERSION = "cashu-fixture/v0";
export const VERSION_TAG = "bitcoin-defi-bench/v0|cashu";

export const DEPOSIT_TYPES = ["genuine", "forged_proof", "operator_report", "wrong_amount", "wrong_script", "reused_script", "reorged"] as const;
export type DepositType = (typeof DEPOSIT_TYPES)[number];
export const TOKEN_TYPES = ["genuine", "inactive_keyset", "forged", "unknown_keyset", "spent"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

export interface CellParams {
  deposits: number;
  tokens: number;
  withdrawals: number;
  vtxos: number;
  outage_ppm: number;
  outage_start_after: [number, number];
  outage_blocks: [number, number];
  shortfall_ppm: number;
  onset_round: [number, number];
  failure_ppm: number;
  resolve_after_onset: [number, number];
  budget: { attempts: number; probes: number };
}

export interface FeeSchedule { base_fee_sat: number; ppm_expiry_table: Array<{ expiry_blocks_threshold: number; ppm: number }> }

export interface CashuConfig {
  start_height: [number, number];
  horizon_blocks: number;
  round_blocks: number;
  rules: { min_confirmations: number; max_tip_lag: number };
  desk_fee_ppm: number;
  token_margin_ppm: number;
  deposit_amount_sats: [number, number];
  deposit_amount_step_sats: number;
  wrong_amount_short_ppm: [number, number];
  operator_report_genuine_ppm: number;
  deposit_confirmations: [number, number];
  keyset_exponents: [number, number];
  token_exponents: [number, number];
  token_proofs: [number, number];
  float_sats: [number, number];
  float_step_sats: number;
  withdrawal: { amount_sats: [number, number]; amount_step_sats: number; deadline_blocks: number; quote_zero_ppm: number; quote_ppm: [number, number]; fee_limit_sats: number };
  vtxo: { amount_sats: [number, number]; amount_step_sats: number; expiry_after_start: [number, number] };
  refresh_fee: FeeSchedule;
  move_out_fee: { base_fee_sat: number; ppm: number };
  exit: { vbytes: number; exit_delta_blocks: number; waves: number; armed_multiplier: number };
  plan: { refresh_before: number; exit_before: number };
  fees: { base_sat_vb: [number, number]; walk_sigma: number; min_sat_vb: number };
  mint: { outstanding_sats: [number, number]; reserve_buffer_ppm: [number, number]; short_reserve_ppm: [number, number] };
  deposit_types: { [type in DepositType]: number };
  token_types: { [type in TokenType]: number };
  cells: { [cell: string]: CellParams };
}

export interface Intent { id: string; rail: "cashu" | "ark"; amount_sats: number; script_sha256: string; beneficiary: string }

/** What the depositor submits: Proof Grove's Evidence, without the desk's own chain view. */
export interface Evidence {
  kind: "m16-proof" | "operator-report";
  txid: string;
  vout: number;
  value_sats: number;
  script_sha256: string;
  block_hash: string;
  block_height: number;
  confirmations: number;
  tip_height: number;
  statement_sha256: string | null;
  proof_sha256: string | null;
}

export interface DepositEvent {
  id: string;
  arrival: number;
  intent: Intent;
  evidence: Evidence;
  /** Hidden from here down. */
  type: DepositType;
  /** What the payment delivers to this intent if admitted: the intent's amount, a short payment, or nothing. */
  received_sats: number;
  /** What the pinned verifier returns on the statement and proof. */
  proof_valid: boolean;
  /** The active chain's block at evidence.block_height, as the desk's own Core would report it. */
  active_block_hash: string;
}

export interface TokenEvent {
  id: string;
  arrival: number;
  amount_sats: number;
  token: { unit: "sat"; proofs: ProofJson[] };
  /** Hidden from here down. */
  type: TokenType;
  /** NUT-07 Y of each proof, in proof order. */
  ys: string[];
  /** The payer already redeemed these proofs: the mint has every Y in its spent set. */
  spent: boolean;
}

export interface WithdrawalEvent { id: string; arrival: number; amount_sats: number; deadline: number }

export interface Vtxo { id: string; amount_sats: number; expiry_height: number }

export interface Keyset { id: string; unit: "sat"; active: boolean; keys: { [amount: string]: string } }

export interface Report { round: number; height: number; reserve_sats: number; outstanding_sats: number }

export interface CashuFixture {
  version: string;
  seed: number;
  cell: string;
  start_height: number;
  horizon_height: number;
  float_sats: number;
  /** Clearing on-chain fee rate of each block from start_height to horizon_height, sat/vB. */
  fees: number[];
  /** The Bark/CDK processor's withdrawal quote in each block, ppm of the amount. */
  quotes: number[];
  /** Blocks [start, end) in which the Ark server is offline; hidden. */
  outage: { start: number; end: number } | null;
  deposits: DepositEvent[];
  tokens: TokenEvent[];
  withdrawals: WithdrawalEvent[];
  vtxos: Vtxo[];
  mint: {
    keysets: Keyset[];
    /** Round reports from start_height on; the mint publishes none after it halts. */
    reports: Report[];
    /** Hidden: the block at whose start the mint halts and its holders' ecash is lost, or null. */
    failure_height: number | null;
    shortfall: { onset: number; resolve: number | null } | null;
  };
}

export const fixturePath = (cell: string, seed: number): string => `fixtures/cashu/${cell}/seed-${String(seed).padStart(4, "0")}.json`;
export const fixtureBytes = (fixture: CashuFixture): string => `${canonical(fixture)}\n`;

const between = (rng: Stream, [lo, hi]: [number, number]): number => lo + rng.int(hi - lo + 1);
const stepped = (rng: Stream, [lo, hi]: [number, number], step: number): number => lo + step * rng.int(Math.floor((hi - lo) / step) + 1);
const ppmDraw = (rng: Stream, ppm: number): boolean => rng.int(1_000_000) < ppm;

function weighted<T extends string>(rng: Stream, types: readonly T[], weights: { [t in T]: number }): T {
  const total = types.reduce((a, t) => a + weights[t], 0);
  let x = rng.int(total);
  for (const t of types) {
    if (x < weights[t]) return t;
    x -= weights[t];
  }
  throw new Error("unreachable");
}

/** A deterministic hex label: SHA-256 of the version tag and the labels. */
export const label = (...parts: Array<string | number>): string => sha256([VERSION_TAG, ...parts].join("|"));
/** A deterministic scalar in [1, n − 1]. */
export const scalar = (...parts: Array<string | number>): bigint => (bytesToBigInt(Buffer.from(label(...parts), "hex")) % (N - 1n)) + 1n;

function keyset(cell: string, seed: number, name: string, [lo, hi]: [number, number], active: boolean): { keyset: Keyset; secret: (amount: number) => bigint } {
  const keys: { [amount: string]: string } = {};
  for (let e = lo; e <= hi; e++) keys[String(2 ** e)] = pubkeyOf(scalar(cell, seed, "keyset", name, 2 ** e));
  return { keyset: { id: keysetIdV1(keys), unit: "sat", active, keys }, secret: (amount) => scalar(cell, seed, "keyset", name, amount) };
}

export function generateFixture(seed: number, cell: string, params: CellParams, config: CashuConfig): CashuFixture {
  const rng = (name: string): Stream => stream(VERSION_TAG, cell, seed, name);
  const h0 = between(rng("start"), config.start_height);
  const horizon = h0 + config.horizon_blocks;
  const last = horizon - 1;

  // The fee path, as family 11 draws it, and the processor's quote path.
  const f = rng("fees");
  const [lo, hi] = config.fees.base_sat_vb;
  let walk = Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * f.next());
  const fees: number[] = [];
  for (let h = h0; h <= horizon; h++) {
    if (h > h0) walk *= Math.exp(config.fees.walk_sigma * f.normal());
    fees.push(Math.max(config.fees.min_sat_vb, Math.round(walk)));
  }
  const q = rng("quotes");
  const quotes: number[] = [];
  for (let h = h0; h <= horizon; h++) quotes.push(ppmDraw(q, config.withdrawal.quote_zero_ppm) ? 0 : between(q, config.withdrawal.quote_ppm));

  const o = rng("outage");
  let outage: CashuFixture["outage"] = null;
  if (ppmDraw(o, params.outage_ppm)) {
    const start = h0 + between(o, params.outage_start_after);
    outage = { start, end: start + between(o, params.outage_blocks) };
  }

  // The mint: one active and one inactive keyset, round reports, and in reserve_shortfall a public shortfall.
  const active = keyset(cell, seed, "active", config.keyset_exponents, true);
  const inactive = keyset(cell, seed, "inactive", config.keyset_exponents, false);
  const attacker = keyset(cell, seed, "attacker", config.token_exponents, true);
  const m = rng("mint");
  const outstanding = between(m, config.mint.outstanding_sats);
  const buffer = between(m, config.mint.reserve_buffer_ppm);
  const short = between(m, config.mint.short_reserve_ppm);
  let shortfall: CashuFixture["mint"]["shortfall"] = null;
  let failure: number | null = null;
  if (ppmDraw(m, params.shortfall_ppm)) {
    const onset = h0 + config.round_blocks * between(m, params.onset_round);
    const after = between(m, params.resolve_after_onset);
    if (ppmDraw(m, params.failure_ppm)) {
      failure = Math.min(last, onset + after);
      shortfall = { onset, resolve: null };
    } else {
      shortfall = { onset, resolve: h0 + config.round_blocks * Math.ceil((onset + after - h0) / config.round_blocks) };
    }
  }
  const reports: Report[] = [];
  for (let round = 0; h0 + round * config.round_blocks <= last; round++) {
    const height = h0 + round * config.round_blocks;
    if (failure !== null && height >= failure) break;
    const inShortfall = shortfall !== null && height >= shortfall.onset && (shortfall.resolve === null || height < shortfall.resolve);
    const reserve = Math.round(outstanding * (inShortfall ? short : 1_000_000 + buffer) / 1_000_000);
    reports.push({ round, height, reserve_sats: reserve, outstanding_sats: outstanding });
  }

  const floatSats = stepped(rng("float"), config.float_sats, config.float_step_sats);

  // Deposits: draw arrivals and types, then number them in arrival order.
  const d = rng("deposits");
  const rawDeposits = Array.from({ length: params.deposits }, () => ({ arrival: h0 + d.int(config.horizon_blocks), type: weighted(d, DEPOSIT_TYPES, config.deposit_types), draw: d.int(2 ** 30) }));
  rawDeposits.sort((a, b) => a.arrival - b.arrival || a.draw - b.draw);
  const deposits: DepositEvent[] = [];
  for (const [i, raw] of rawDeposits.entries()) {
    const id = `d${String(i + 1).padStart(2, "0")}`;
    const r = stream(VERSION_TAG, cell, seed, "deposit", id);
    const amount = stepped(r, config.deposit_amount_sats, config.deposit_amount_step_sats);
    const confirmations = between(r, config.deposit_confirmations);
    const blockHeight = raw.arrival - confirmations + 1;
    let type: DepositType = raw.type;
    const earlier = deposits.filter((x) => x.type === "genuine");
    if (type === "reused_script" && earlier.length === 0) type = "genuine";
    const intent: Intent = { id: `intent-${id}`, rail: r.int(2) === 0 ? "cashu" : "ark", amount_sats: amount, script_sha256: label(cell, seed, id, "script"), beneficiary: `user-${label(cell, seed, id, "beneficiary").slice(0, 12)}` };
    let evidence: Evidence = {
      kind: "m16-proof", txid: label(cell, seed, id, "txid"), vout: r.int(4), value_sats: amount, script_sha256: intent.script_sha256,
      block_hash: label(cell, seed, "block", blockHeight), block_height: blockHeight, confirmations, tip_height: raw.arrival,
      statement_sha256: label(cell, seed, id, "statement"), proof_sha256: label(cell, seed, id, "proof"),
    };
    let received = amount;
    let proofValid = true;
    let activeBlock = evidence.block_hash;
    if (type === "forged_proof") { received = 0; proofValid = false; }
    if (type === "operator_report") {
      evidence = { ...evidence, kind: "operator-report", statement_sha256: null, proof_sha256: null };
      proofValid = false;
      if (!ppmDraw(r, config.operator_report_genuine_ppm)) received = 0;
    }
    if (type === "wrong_amount") {
      const value = amount - Math.round(amount * between(r, config.wrong_amount_short_ppm) / 1_000_000);
      evidence = { ...evidence, value_sats: value };
      received = value;
    }
    if (type === "wrong_script") { evidence = { ...evidence, script_sha256: label(cell, seed, id, "other-script") }; received = 0; }
    if (type === "reorged") { activeBlock = label(cell, seed, "replacement-block", blockHeight); received = 0; }
    if (type === "reused_script") {
      // One payment, two recipients: the earlier intent's script and payment, claimed for a new beneficiary.
      const original = earlier[r.int(earlier.length)]!;
      intent.script_sha256 = original.intent.script_sha256;
      intent.amount_sats = original.intent.amount_sats;
      evidence = { ...original.evidence, confirmations: original.evidence.confirmations + raw.arrival - original.arrival, tip_height: raw.arrival };
      activeBlock = original.active_block_hash;
      received = 0;
    }
    deposits.push({ id, arrival: raw.arrival, intent, evidence, type, received_sats: received, proof_valid: proofValid, active_block_hash: activeBlock });
  }

  // Tokens: real proofs under the mint's keysets, or forged ones.
  const t = rng("tokens");
  const rawTokens = Array.from({ length: params.tokens }, () => ({ arrival: h0 + t.int(config.horizon_blocks), type: weighted(t, TOKEN_TYPES, config.token_types), draw: t.int(2 ** 30) }));
  rawTokens.sort((a, b) => a.arrival - b.arrival || a.draw - b.draw);
  const tokens: TokenEvent[] = rawTokens.map((raw, i) => {
    const id = `t${String(i + 1).padStart(2, "0")}`;
    const r = stream(VERSION_TAG, cell, seed, "token", id);
    const exps: number[] = [];
    for (let e = config.token_exponents[0]; e <= config.token_exponents[1]; e++) exps.push(e);
    r.shuffle(exps);
    const chosen = exps.slice(0, between(r, config.token_proofs)).sort((a, b) => b - a);
    const proofs = chosen.map((e, j) => {
      const amount = 2 ** e;
      const secret = label(cell, seed, id, "secret", j);
      const blind = scalar(cell, seed, id, "r", j);
      switch (raw.type) {
        case "genuine": case "spent": return makeProof(amount, active.keyset.id, active.secret(amount), secret, blind);
        case "inactive_keyset": return makeProof(amount, inactive.keyset.id, inactive.secret(amount), secret, blind);
        case "forged": return makeProof(amount, active.keyset.id, active.secret(amount), secret, blind, attacker.secret(amount));
        case "unknown_keyset": return makeProof(amount, attacker.keyset.id, attacker.secret(amount), secret, blind);
      }
    });
    return {
      id, arrival: raw.arrival, amount_sats: proofs.reduce((a, p) => a + p.amount, 0), token: { unit: "sat" as const, proofs },
      type: raw.type, ys: proofs.map((p) => proofY(p.secret)), spent: raw.type === "spent",
    };
  });

  const w = rng("withdrawals");
  const rawWithdrawals = Array.from({ length: params.withdrawals }, () => ({ arrival: h0 + w.int(config.horizon_blocks - config.withdrawal.deadline_blocks), amount: stepped(w, config.withdrawal.amount_sats, config.withdrawal.amount_step_sats), draw: w.int(2 ** 30) }));
  rawWithdrawals.sort((a, b) => a.arrival - b.arrival || a.draw - b.draw);
  const withdrawals = rawWithdrawals.map((raw, i) => ({ id: `w${String(i + 1).padStart(2, "0")}`, arrival: raw.arrival, amount_sats: raw.amount, deadline: raw.arrival + config.withdrawal.deadline_blocks }));

  const v = rng("vtxos");
  const vtxos = Array.from({ length: params.vtxos }, (_, i) => ({ id: `vtxo-${i + 1}`, amount_sats: stepped(v, config.vtxo.amount_sats, config.vtxo.amount_step_sats), expiry_height: h0 + between(v, config.vtxo.expiry_after_start) }));

  return {
    version: FIXTURE_VERSION, seed, cell, start_height: h0, horizon_height: horizon, float_sats: floatSats, fees, quotes, outage,
    deposits, tokens, withdrawals, vtxos,
    mint: { keysets: [active.keyset, inactive.keyset], reports, failure_height: failure, shortfall },
  };
}
