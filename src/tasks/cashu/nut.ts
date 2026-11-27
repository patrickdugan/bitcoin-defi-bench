// The Cashu protocol core for family 14 (docs/tasks.md §17): NUT-00 hash_to_curve and the blind
// Diffie-Hellman key exchange, NUT-12 DLEQ proofs with the deterministic nonce, NUT-02 version 1
// keyset ids, and the NUT-07 point Y a state check names. Curve arithmetic is family 9's
// (src/tasks/nostr/secp256k1.ts); this file adds point encoding and the Cashu constructions on top.
// Checked against the published vectors in data/cashu/nut-vectors.json.
//
// A simulator's implementation: variable-time, secrets in BigInts. Never use it to hold a real key.

import { createHmac } from "node:crypto";
import { CryptoError, G, N, P, bigIntToBytes, bytesToBigInt, bytesToHex, hexToBytes, liftX, multiply, pointAdd, sha256Bytes, type Point } from "../nostr/secp256k1.ts";

export type Affine = { x: bigint; y: bigint };

const DOMAIN_SEPARATOR = Buffer.from("Secp256k1_HashToCurve_Cashu_", "utf8");
const DLEQ_NONCE_TAG = Buffer.from("Cashu_DLEQ_R_v1", "utf8");

const modN = (a: bigint): bigint => {
  const r = a % N;
  return r >= 0n ? r : r + N;
};

const affine = (p: Point, what: string): Affine => {
  if (p === null) throw new CryptoError(`${what} is the point at infinity`);
  return p;
};

/** SEC1 compressed encoding, 33 bytes as lowercase hex. */
export const compress = (p: Affine): string => `${p.y & 1n ? "03" : "02"}${p.x.toString(16).padStart(64, "0")}`;

/** SEC1 uncompressed encoding, 65 bytes. */
export const uncompressedBytes = (p: Affine): Uint8Array => Uint8Array.from([4, ...bigIntToBytes(p.x), ...bigIntToBytes(p.y)]);

/** Parse a SEC1 compressed point, or throw. */
export function decompress(hex: string): Affine {
  const bytes = hexToBytes(hex, 33);
  if (bytes[0] !== 2 && bytes[0] !== 3) throw new CryptoError("compressed point must start with 02 or 03");
  const even = liftX(bytesToBigInt(bytes.subarray(1)));
  return bytes[0] === 2 ? even : { x: even.x, y: P - even.y };
}

/** The point with this compressed encoding, or null if it is not one. */
export function tryDecompress(hex: unknown): Affine | null {
  if (typeof hex !== "string") return null;
  try { return decompress(hex); } catch { return null; }
}

const negate = (p: Affine): Affine => ({ x: p.x, y: P - p.y });
const mul = (p: Affine, k: bigint, what: string): Affine => affine(multiply(p, k), what);
const add = (p: Affine, q: Affine, what: string): Affine => affine(pointAdd(p, q), what);

/**
 * NUT-00 hash_to_curve: msg_hash = SHA256(DOMAIN_SEPARATOR ‖ message); for counter = 0, 1, … (uint32
 * little-endian), the first SHA256(msg_hash ‖ counter) that is the x-coordinate of a point gives that
 * point with even y, the point 02 ‖ x.
 */
export function hashToCurve(message: Uint8Array): Affine {
  const msgHash = sha256Bytes(DOMAIN_SEPARATOR, message);
  const counter = new Uint8Array(4);
  for (let i = 0; i < 2 ** 16; i++) {
    new DataView(counter.buffer).setUint32(0, i, true);
    try { return liftX(bytesToBigInt(sha256Bytes(msgHash, counter))); } catch { /* not on the curve: next counter */ }
  }
  throw new CryptoError("no point found");
}

/** A proof's secret is a string; hash_to_curve takes its UTF-8 bytes. */
export const secretPoint = (secret: string): Affine => hashToCurve(Buffer.from(secret, "utf8"));

/** NUT-07: the Y a state check names, compressed hex. */
export const proofY = (secret: string): string => compress(secretPoint(secret));

/** NUT-00 step 1 (wallet): B_ = Y + rG. */
export const blindMessage = (y: Affine, r: bigint): Affine => add(y, mul(G as Affine, r, "rG"), "B_");

/** NUT-00 step 2 (mint): C_ = kB_. */
export const signBlinded = (k: bigint, blinded: Affine): Affine => mul(blinded, k, "C_");

/** NUT-00 step 3 (wallet): C = C_ − rK. */
export const unblind = (signed: Affine, r: bigint, key: Affine): Affine => add(signed, negate(mul(key, r, "rK")), "C");

/** The mint's own check of a proof: k · hash_to_curve(secret) = C. */
export function mintVerify(k: bigint, secret: string, c: Affine): boolean {
  const kY = mul(secretPoint(secret), k, "kY");
  return kY.x === c.x && kY.y === c.y;
}

/** NUT-12 hash_e: SHA256 of the UTF-8 string that concatenates each point's uncompressed lowercase hex. */
export function hashE(points: readonly Affine[]): bigint {
  const text = points.map((p) => bytesToHex(uncompressedBytes(p))).join("");
  return bytesToBigInt(sha256Bytes(Buffer.from(text, "utf8")));
}

/**
 * NUT-12 deterministic nonce: r = HMAC-SHA256(key = a, data = "Cashu_DLEQ_R_v1" ‖ A ‖ B' ‖ C' ‖ ctr)
 * with the points uncompressed and ctr one byte from 0, retried while r is 0 or at least n.
 */
export function dleqNonce(a: bigint, pubA: Affine, blinded: Affine, signed: Affine): bigint {
  for (let ctr = 0; ctr < 256; ctr++) {
    const h = createHmac("sha256", Buffer.from(bigIntToBytes(a)))
      .update(DLEQ_NONCE_TAG).update(uncompressedBytes(pubA)).update(uncompressedBytes(blinded)).update(uncompressedBytes(signed)).update(Uint8Array.of(ctr))
      .digest();
    const r = bytesToBigInt(Uint8Array.from(h));
    if (r !== 0n && r < N) return r;
  }
  throw new CryptoError("no nonce found");
}

export interface Dleq { e: bigint; s: bigint }

/** NUT-12, mint side: prove log_G(A) = log_B'(C') with R1 = rG, R2 = rB', e = hash_e(R1, R2, A, C'), s = r + e·a. */
export function dleqProve(a: bigint, blinded: Affine, signed: Affine, nonce?: bigint): Dleq {
  const pubA = mul(G as Affine, a, "A");
  const r = nonce ?? dleqNonce(a, pubA, blinded, signed);
  const e = hashE([mul(G as Affine, r, "R1"), mul(blinded, r, "R2"), pubA, signed]);
  return { e, s: modN(r + e * a) };
}

/** NUT-12, on a BlindSignature: R1 = sG − eA, R2 = sB' − eC', and e = hash_e(R1, R2, A, C'). Never throws. */
export function dleqVerify(pubA: Affine, blinded: Affine, signed: Affine, d: Dleq): boolean {
  if (d.e < 0n || d.s < 0n || d.s >= N || d.e >= 2n ** 256n) return false;
  try {
    const r1 = pointAdd(multiply(G, d.s), multiply(pubA, N - modN(d.e)));
    const r2 = pointAdd(multiply(blinded, d.s), multiply(signed, N - modN(d.e)));
    if (r1 === null || r2 === null) return false;
    return hashE([r1, r2, pubA, signed]) === d.e;
  } catch { return false; }
}

/** A Cashu proof as a wallet holds it (NUT-00), with the NUT-12 DLEQ that carries r. */
export interface ProofJson { amount: number; id: string; secret: string; C: string; dleq?: { e: string; s: string; r: string } }

const memo = new Map<string, boolean>();

/**
 * NUT-12, on a Proof (the receiving wallet, offline): Y = hash_to_curve(secret), C' = C + rA,
 * B' = Y + rG, then the BlindSignature check. False on any malformed field. Memoized: a pure function.
 */
export function proofDleqValid(keyHex: string, proof: ProofJson): boolean {
  const key = `${keyHex}|${proof.secret}|${proof.C}|${proof.dleq?.e}|${proof.dleq?.s}|${proof.dleq?.r}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const d = proof.dleq;
    const pubA = decompress(keyHex);
    const c = decompress(proof.C);
    if (d && typeof proof.secret === "string" && /^[0-9a-f]{64}$/.test(d.e) && /^[0-9a-f]{64}$/.test(d.s) && /^[0-9a-f]{64}$/.test(d.r)) {
      const r = bytesToBigInt(hexToBytes(d.r));
      if (r > 0n && r < N) {
        const signed = add(c, mul(pubA, r, "rA"), "C'");
        const blinded = blindMessage(secretPoint(proof.secret), r);
        ok = dleqVerify(pubA, blinded, signed, { e: bytesToBigInt(hexToBytes(d.e)), s: bytesToBigInt(hexToBytes(d.s)) });
      }
    }
  } catch { ok = false; }
  memo.set(key, ok);
  return ok;
}

/** NUT-02 version 1 keyset id: "00" ‖ the first 14 hex characters of SHA256 of the compressed keys concatenated in amount order. */
export function keysetIdV1(keys: { [amount: string]: string }): string {
  const amounts = Object.keys(keys).map(Number).sort((a, b) => a - b);
  const bytes = sha256Bytes(...amounts.map((a) => hexToBytes(keys[String(a)]!, 33)));
  return `00${bytesToHex(bytes).slice(0, 14)}`;
}

export const scalarHex = (k: bigint): string => bytesToHex(bigIntToBytes(modN(k)));
export const pubkeyOf = (k: bigint): string => compress(mul(G as Affine, k, "kG"));

/**
 * One proof the way a mint and wallet make it: blind with r, sign with k, prove the DLEQ with the
 * deterministic nonce, unblind. With `signer` set, the signature and DLEQ come from that key instead
 * of the keyset's (a forgery: the DLEQ verifies against the signer's key, not the mint's).
 */
export function makeProof(amount: number, keysetId: string, k: bigint, secret: string, r: bigint, signer: bigint = k): ProofJson {
  const blinded = blindMessage(secretPoint(secret), r);
  const signed = signBlinded(signer, blinded);
  const d = dleqProve(signer, blinded, signed);
  const c = unblind(signed, r, mul(G as Affine, signer, "K"));
  return { amount, id: keysetId, secret, C: compress(c), dleq: { e: bytesToHex(bigIntToBytes(d.e)), s: scalarHex(d.s), r: scalarHex(r) } };
}
