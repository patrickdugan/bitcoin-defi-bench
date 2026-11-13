// The chain, the mempool, and the desk for family 11 (docs/tasks.md §14). Deterministic: every block's
// clearing fee rate is in the fixture, and a transaction bidding at least that rate confirms in that
// block. The customer acts only through the host (env.ts); this file applies what the host broadcasts
// and plays the desk.
//
// The rules, in the order they apply within a block:
//   1. a double-spending desk's reorganization removes its lock, and any claim confirmed on top of it;
//   2. the desk's lock confirms at its lock height;
//   3. once the preimage has been broadcast, the desk claims the in-HTLC in the next block, outbidding
//      any refund (the preimage spends it before the timeout and races the refund after it);
//   4. the customer's claim confirms if the lock stands, the block is after the claim's broadcast, the
//      claim bids at least the clearing rate, and the block is at or below the desk's refund height;
//   5. after its refund height the desk refunds an unclaimed payout, outbidding any claim;
//   6. the customer's refund confirms after the in-timeout if it bids at least the clearing rate and
//      the in-HTLC is still there;
//   7. at the in-timeout height the host broadcasts the armed refund, unless a refund is already out
//      or the preimage is.

import type { SwapConfig, SwapFixture } from "./generate.ts";

export interface Broadcast { fee_rate: number; height: number; }

export interface SwapState {
  height: number;
  funded: boolean;
  /** Height at which the preimage was first broadcast, or null. */
  revealed: number | null;
  claim: Broadcast | null;
  claimConfirmed: number | null;
  claimBroadcasts: number;
  refund: (Broadcast & { by: "customer" | "host" }) | null;
  refundConfirmed: number | null;
  inTakenByDesk: number | null;
  payoutRefundedByDesk: number | null;
  lockConflicted: boolean;
}

export const initialState = (f: SwapFixture): SwapState => ({
  height: f.start_height, funded: false, revealed: null, claim: null, claimConfirmed: null, claimBroadcasts: 0,
  refund: null, refundConfirmed: null, inTakenByDesk: null, payoutRefundedByDesk: null, lockConflicted: false,
});

export const feeAt = (f: Pick<SwapFixture, "start_height" | "fees">, height: number): number => {
  const i = height - f.start_height;
  if (i < 0 || i >= f.fees.length) throw new Error(`no fee rate for height ${height}`);
  return f.fees[i]!;
};

/** The desk's lock is confirmed and stands at `height`. */
export const lockStands = (f: SwapFixture, s: SwapState, height: number): boolean =>
  s.funded && f.desk.lock_height !== null && height >= f.desk.lock_height && !(f.desk.reorg_height !== null && height >= f.desk.reorg_height);

export const lockConfirmations = (f: SwapFixture, s: SwapState): number =>
  lockStands(f, s, s.height) ? s.height - f.desk.lock_height! + 1 : 0;

/** The in-HTLC is confirmed and unspent. Funding confirms in the block after the start height. */
export const inUnspent = (f: SwapFixture, s: SwapState): boolean =>
  s.funded && s.height >= f.start_height + 1 && s.refundConfirmed === null && s.inTakenByDesk === null;

/** No customer action can change the outcome any more. */
export const settled = (s: SwapState): boolean => s.claimConfirmed !== null || s.refundConfirmed !== null || s.inTakenByDesk !== null;

/** Advance one block, applying the rules in the header's order. */
export function advanceBlock(f: SwapFixture, config: SwapConfig, s: SwapState): void {
  const t = s.height + 1;
  const fee = feeAt(f, t);
  // 1. Reorganization.
  if (f.desk.reorg_height !== null && t === f.desk.reorg_height && s.funded) {
    s.lockConflicted = true;
    s.claimConfirmed = null;
  }
  const stands = lockStands(f, s, t);
  // 3. The desk spends the in-HTLC with the preimage.
  const inThere = s.funded && t >= f.start_height + 2 && s.refundConfirmed === null && s.inTakenByDesk === null;
  if (s.revealed !== null && s.revealed < t && inThere) s.inTakenByDesk = t;
  // 4. The customer's claim.
  const outTimeout = f.desk.out_timeout_height;
  if (s.claim && s.claimConfirmed === null && s.payoutRefundedByDesk === null && stands && outTimeout !== null
      && t > s.claim.height && s.claim.fee_rate >= fee && t <= outTimeout) {
    s.claimConfirmed = t;
  }
  // 5. The desk refunds an unclaimed payout.
  if (stands && outTimeout !== null && t > outTimeout && s.claimConfirmed === null && s.payoutRefundedByDesk === null) s.payoutRefundedByDesk = t;
  // 6. The refund.
  if (s.refund && s.refundConfirmed === null && s.inTakenByDesk === null && s.funded
      && t > f.quote.in_timeout_height && t > s.refund.height && s.refund.fee_rate >= fee) {
    s.refundConfirmed = t;
  }
  s.height = t;
  // 7. The armed refund, broadcast at the in-timeout height.
  if (t === f.quote.in_timeout_height && s.funded && s.refund === null && s.revealed === null && inUnspent(f, s)) {
    s.refund = { fee_rate: config.fallback_fee_multiplier * fee, height: t, by: "host" };
  }
}

export interface SwapOutcome {
  value: number;
  completed: boolean;
  refunded: boolean;
  lost: boolean;
  fees: number;
}

/** The customer's wallet change at the horizon, plus the swap's value if it completed. */
export function outcomeOf(f: SwapFixture, s: SwapState): SwapOutcome {
  if (!s.funded) return { value: 0, completed: false, refunded: false, lost: false, fees: 0 };
  const fundFee = f.vbytes.fund * feeAt(f, f.start_height);
  let value = -f.quote.amount_in_sats - fundFee;
  let fees = fundFee;
  const completed = s.claimConfirmed !== null;
  if (completed) {
    const claimFee = f.vbytes.claim * s.claim!.fee_rate;
    value += f.desk.amount_out_sats! - claimFee + f.quote.swap_value_sats;
    fees += claimFee;
  }
  const refunded = s.refundConfirmed !== null;
  if (refunded) {
    const refundFee = f.vbytes.refund * s.refund!.fee_rate;
    value += f.quote.amount_in_sats - refundFee;
    fees += refundFee;
  }
  return { value, completed, refunded, lost: !completed && !refunded, fees };
}

/**
 * The best value any policy can reach on this fixture, from the hidden desk and fee path. Funding is
 * possible only at the start height. A completed swap needs a claim that confirms in some block t
 * with lock_height < t <= out_timeout_height and that no reorganization undoes; the cheapest is to
 * broadcast at t - 1 bidding exactly that block's clearing rate, so the best claim fee is the lowest
 * clearing rate in the window. A refund costs fees and returns nothing more, so the alternative to
 * the best claim is not funding at all.
 */
export type PlanInput = Pick<SwapFixture, "start_height" | "quote" | "vbytes" | "fees"> & { desk: Pick<SwapFixture["desk"], "lock_height" | "out_timeout_height" | "amount_out_sats" | "reorg_height"> };

export function ceilingOf(f: PlanInput): { value: number; fund: boolean; claim_height: number | null; fee_rate: number | null } {
  const none = { value: 0, fund: false, claim_height: null, fee_rate: null };
  const d = f.desk;
  if (d.lock_height === null || d.out_timeout_height === null || d.amount_out_sats === null || d.reorg_height !== null) return none;
  let best: { t: number; fee: number } | null = null;
  for (let t = d.lock_height + 1; t <= d.out_timeout_height; t++) {
    const fee = feeAt(f, t);
    if (best === null || fee < best.fee) best = { t, fee };
  }
  if (best === null) return none;
  const value = d.amount_out_sats + f.quote.swap_value_sats - f.quote.amount_in_sats - f.vbytes.fund * feeAt(f, f.start_height) - f.vbytes.claim * best.fee;
  return value > 0 ? { value, fund: true, claim_height: best.t - 1, fee_rate: best.fee } : none;
}
