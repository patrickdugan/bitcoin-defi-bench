// Payout functions, rounding, and CET calculation as dlcspecs specifies them (PayoutCurve.md,
// NumericOutcome.md). This module is the general and slow path: it evaluates any payout function
// in floating point at every outcome, as the specification describes, and is used to check the
// bench's exact fast path (contract.ts) and to reproduce the specification's test vectors.

import { prefixCount } from "./digits.ts";

export interface Point { x: number; y: number; }

export type Piece =
  | { kind: "polynomial"; points: Point[] }
  | { kind: "hyperbola"; usePositivePiece: boolean; f1: number; f2: number; a: number; b: number; c: number; d: number };

/** Pieces with their left endpoints, and the last endpoint (PayoutCurve.md, `payout_function`). */
export interface PayoutFunction { pieces: Array<{ left: Point; piece: Piece }>; last: Point; }

export interface RoundingInterval { begin: number; mod: number; }

function evaluatePiece(piece: Piece, left: Point, right: Point, x: number): number {
  if (piece.kind === "polynomial") {
    const pts = [left, ...piece.points, right];
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      let l = 1;
      for (let j = 0; j < pts.length; j++) if (j !== i) l *= (x - pts[j]!.x) / (pts[i]!.x - pts[j]!.x);
      sum += pts[i]!.y * l;
    }
    return sum;
  }
  const { a, b, c, d, f1, f2 } = piece;
  const t = x - f1;
  const root = Math.sqrt(t * t - 4 * a * b);
  const den = piece.usePositivePiece ? t + root : t - root;
  return (c * den) / (2 * a) + (2 * a * d) / den + f2;
}

/**
 * General function evaluation. PayoutCurve.md says an outcome equal to an endpoint returns that
 * endpoint's payout. For a polynomial piece that is the same thing, since endpoints are its
 * interpolation points. For a hyperbola piece the reference implementation that generated the
 * test vectors (rust-dlc, `HyperbolaPayoutCurvePiece::evaluate`) evaluates the curve at its
 * endpoints too and never reads their payouts; the hyperbola vector, whose endpoint payouts are
 * placeholders of 0, reproduces only that way (56 CETs, against 65 by the text). This follows the
 * implementation. The bench's own contract is unaffected: its curve meets its endpoints.
 */
export function evaluate(fn: PayoutFunction, x: number): number {
  const ends = [...fn.pieces.map((p) => p.left), fn.last];
  for (let i = 0; i < fn.pieces.length; i++) {
    const left = ends[i]!;
    const right = ends[i + 1]!;
    if (x < left.x || x > right.x) continue;
    const piece = fn.pieces[i]!.piece;
    if (piece.kind === "polynomial" && (x === left.x || x === right.x)) return x === left.x ? left.y : right.y;
    return evaluatePiece(piece, left, right, x);
  }
  throw new Error(`outcome ${x} is outside the payout function's domain`);
}

/** The rounding modulus at an outcome: the last interval that begins at or before it, else 1. */
export function modAt(intervals: readonly RoundingInterval[], x: number): number {
  let mod = 1;
  for (const r of intervals) { if (r.begin <= x) mod = r.mod; else break; }
  return mod;
}

/** The closer of value − (value mod R) and that plus R, rounding up on a tie (NumericOutcome.md). */
export function roundPayout(value: number, mod: number): number {
  const lower = value - (((value % mod) + mod) % mod);
  const upper = lower + mod;
  return value - lower < upper - value ? lower : upper;
}

/** Rounded, then clamped to [0, total collateral]: the modified function CETs are built from. */
export function modifiedPayout(fn: PayoutFunction, intervals: readonly RoundingInterval[], total: number, x: number): number {
  const v = roundPayout(evaluate(fn, x), modAt(intervals, x));
  return Math.min(total, Math.max(0, v));
}

export interface Run { start: number; end: number; payout: number; }

/** Maximal intervals of constant modified payout over [0, base^numDigits − 1], by evaluating every outcome. */
export function runsByScan(payoutAt: (x: number) => number, maxOutcome: number): Run[] {
  const runs: Run[] = [];
  let start = 0;
  let current = payoutAt(0);
  for (let x = 1; x <= maxOutcome; x++) {
    const v = payoutAt(x);
    if (v !== current) { runs.push({ start, end: x - 1, payout: current }); start = x; current = v; }
  }
  runs.push({ start, end: maxOutcome, payout: current });
  return runs;
}

/** The number of CETs (adaptor signatures per party) for a set of runs. */
export const cetCount = (runs: readonly Run[], base: number, numDigits: number): number =>
  runs.reduce((n, r) => n + prefixCount(r.start, r.end, base, numDigits), 0);
