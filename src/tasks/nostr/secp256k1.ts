// secp256k1 and BIP-340 Schnorr signatures in BigInt, for family 9 (docs/tasks.md §10). Nostr
// events are signed with BIP-340 (NIP-01) and NIP-44 derives its conversation key from unhashed
// secp256k1 ECDH, and Node's crypto offers neither, so the bench carries its own. No dependency.
//
// This is a simulator's implementation, checked against the published BIP-340 and NIP-44 vectors.
// It is variable-time and keeps secrets in garbage-collected BigInts: never use it to hold a real key.

import { createHash } from "node:crypto";

export const P = 2n ** 256n - 2n ** 32n - 977n;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

export class CryptoError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "CryptoError";
  }
}

const mod = (a: bigint, m: bigint = P): bigint => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

function pow(base: bigint, exponent: bigint, m: bigint = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

const inv = (a: bigint, m: bigint = P): bigint => {
  if (mod(a, m) === 0n) throw new CryptoError("inverse of zero");
  return pow(a, m - 2n, m);
};

/** An affine point; null is the point at infinity. */
export type Point = { x: bigint; y: bigint } | null;
/** Jacobian coordinates (X, Y, Z) with x = X/Z², y = Y/Z³; Z = 0 is infinity. */
type Jacobian = [bigint, bigint, bigint];

export const G: Point = { x: GX, y: GY };

function double([x, y, z]: Jacobian): Jacobian {
  if (y === 0n || z === 0n) return [0n, 1n, 0n];
  const ysq = (y * y) % P;
  const s = (4n * x * ysq) % P;
  const m = (3n * x * x) % P; // a = 0 on secp256k1
  const nx = mod(m * m - 2n * s);
  const ny = mod(m * (s - nx) - 8n * ysq * ysq);
  const nz = (2n * y * z) % P;
  return [nx, ny, nz];
}

function add(p: Jacobian, q: Jacobian): Jacobian {
  if (p[2] === 0n) return q;
  if (q[2] === 0n) return p;
  const [x1, y1, z1] = p;
  const [x2, y2, z2] = q;
  const z1z1 = (z1 * z1) % P;
  const z2z2 = (z2 * z2) % P;
  const u1 = (x1 * z2z2) % P;
  const u2 = (x2 * z1z1) % P;
  const s1 = (((y1 * z2) % P) * z2z2) % P;
  const s2 = (((y2 * z1) % P) * z1z1) % P;
  if (u1 === u2) return s1 === s2 ? double(p) : [0n, 1n, 0n];
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hh = (h * h) % P;
  const hhh = (h * hh) % P;
  const v = (u1 * hh) % P;
  const nx = mod(r * r - hhh - 2n * v);
  const ny = mod(r * (v - nx) - s1 * hhh);
  const nz = (((z1 * z2) % P) * h) % P;
  return [nx, ny, nz];
}

const toJacobian = (p: Point): Jacobian => (p === null ? [0n, 1n, 0n] : [p.x, p.y, 1n]);

function toAffine([x, y, z]: Jacobian): Point {
  if (z === 0n) return null;
  const zi = inv(z);
  const zi2 = (zi * zi) % P;
  return { x: (x * zi2) % P, y: (((y * zi2) % P) * zi) % P };
}

/** k · point by double-and-add. Variable-time. */
export function multiply(point: Point, k: bigint): Point {
  let scalar = mod(k, N);
  let result: Jacobian = [0n, 1n, 0n];
  let addend = toJacobian(point);
  while (scalar > 0n) {
    if (scalar & 1n) result = add(result, addend);
    addend = double(addend);
    scalar >>= 1n;
  }
  return toAffine(result);
}

export const pointAdd = (p: Point, q: Point): Point => toAffine(add(toJacobian(p), toJacobian(q)));

export const bytesToBigInt = (bytes: Uint8Array): bigint => (bytes.length === 0 ? 0n : BigInt(`0x${Buffer.from(bytes).toString("hex")}`));

export function bigIntToBytes(n: bigint, length = 32): Uint8Array {
  if (n < 0n || n >= 1n << BigInt(8 * length)) throw new CryptoError("integer out of range");
  return Uint8Array.from(Buffer.from(n.toString(16).padStart(2 * length, "0"), "hex"));
}

export function hexToBytes(hex: string, length?: number): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new CryptoError("invalid hex");
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  if (length !== undefined && bytes.length !== length) throw new CryptoError(`expected ${length} bytes, got ${bytes.length}`);
  return bytes;
}

export const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

export const sha256Bytes = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash("sha256");
  for (const part of parts) h.update(part);
  return Uint8Array.from(h.digest());
};

const tagHashes = new Map<string, Uint8Array>();

/** BIP-340 tagged hash: SHA256(SHA256(tag) ‖ SHA256(tag) ‖ msg). */
export function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
  let t = tagHashes.get(tag);
  if (!t) { t = sha256Bytes(Buffer.from(tag, "utf8")); tagHashes.set(tag, t); }
  return sha256Bytes(t, t, ...parts);
}

/** BIP-340 lift_x: the point with x-coordinate x and even y, or an error. */
export function liftX(x: bigint): { x: bigint; y: bigint } {
  if (x >= P) throw new CryptoError("x is not a field element");
  const c = mod(x * x * x + 7n);
  const y = pow(c, (P + 1n) / 4n);
  if ((y * y) % P !== c) throw new CryptoError("x is not on the curve");
  return { x, y: y & 1n ? P - y : y };
}

/** A secret key as a scalar in [1, n − 1], or an error. */
export function secretScalar(secret: Uint8Array): bigint {
  if (secret.length !== 32) throw new CryptoError("secret key must be 32 bytes");
  const d = bytesToBigInt(secret);
  if (d === 0n || d >= N) throw new CryptoError("secret key out of range");
  return d;
}

/** BIP-340 x-only public key of a secret key. */
export function publicKey(secret: Uint8Array): Uint8Array {
  const point = multiply(G, secretScalar(secret))!;
  return bigIntToBytes(point.x);
}

const xor = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((v, i) => v ^ b[i]!);

/** BIP-340 Sign(sk, m, a). The message may be of any length; Nostr signs a 32-byte event id. */
export function schnorrSign(message: Uint8Array, secret: Uint8Array, auxRand: Uint8Array): Uint8Array {
  if (auxRand.length !== 32) throw new CryptoError("aux_rand must be 32 bytes");
  const d0 = secretScalar(secret);
  const pPoint = multiply(G, d0)!;
  const d = pPoint.y & 1n ? N - d0 : d0;
  const px = bigIntToBytes(pPoint.x);
  const t = xor(bigIntToBytes(d), taggedHash("BIP0340/aux", auxRand));
  const k0 = mod(bytesToBigInt(taggedHash("BIP0340/nonce", t, px, message)), N);
  if (k0 === 0n) throw new CryptoError("nonce is zero");
  const rPoint = multiply(G, k0)!;
  const k = rPoint.y & 1n ? N - k0 : k0;
  const rx = bigIntToBytes(rPoint.x);
  const e = mod(bytesToBigInt(taggedHash("BIP0340/challenge", rx, px, message)), N);
  const sig = new Uint8Array(64);
  sig.set(rx, 0);
  sig.set(bigIntToBytes(mod(k + e * d, N)), 32);
  if (!schnorrVerify(message, px, sig)) throw new CryptoError("signature failed its own verification");
  return sig;
}

/** BIP-340 Verify(pk, m, sig). Returns false on any failure; never throws on bad input. */
export function schnorrVerify(message: Uint8Array, pub: Uint8Array, sig: Uint8Array): boolean {
  if (pub.length !== 32 || sig.length !== 64) return false;
  let pPoint: { x: bigint; y: bigint };
  try { pPoint = liftX(bytesToBigInt(pub)); } catch { return false; }
  const r = bytesToBigInt(sig.subarray(0, 32));
  const s = bytesToBigInt(sig.subarray(32, 64));
  if (r >= P || s >= N) return false;
  const e = mod(bytesToBigInt(taggedHash("BIP0340/challenge", sig.subarray(0, 32), pub, message)), N);
  const rPoint = pointAdd(multiply(G, s), multiply(pPoint, N - e));
  return rPoint !== null && (rPoint.y & 1n) === 0n && rPoint.x === r;
}

/** Unhashed ECDH as NIP-44 defines it: the x-coordinate of secret · lift_x(pub). */
export function sharedX(secret: Uint8Array, pub: Uint8Array): Uint8Array {
  if (pub.length !== 32) throw new CryptoError("public key must be 32 bytes");
  const point = multiply(liftX(bytesToBigInt(pub)), secretScalar(secret));
  if (point === null) throw new CryptoError("shared point is infinity");
  return bigIntToBytes(point.x);
}
