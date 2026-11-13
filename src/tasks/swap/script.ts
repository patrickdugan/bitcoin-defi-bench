// Bitcoin script and transaction core for the swap family: the BIP 199 hashed time-lock contract
// (HASHOP = OP_SHA256, TIMEOUTOP = OP_CHECKLOCKTIMEVERIFY), P2WSH/P2WPKH outputs, BIP 173/350 segwit
// addresses, BIP 141/144 transaction serialization and weight, BIP 143 signature hashing, and
// RFC 6979 deterministic low-S ECDSA with strict BIP 66 DER. Depends only on node:crypto and the
// bench's secp256k1 point arithmetic.
//
// This is a simulator's implementation, checked against the published BIP vectors and Bitcoin Core
// regtest (scripts/swap_regtest.ts). It is variable-time: never use it to hold a real key.

import { createHash, createHmac } from "node:crypto";
import { G, N, bigIntToBytes, bytesToBigInt, bytesToHex, hexToBytes, multiply } from "../nostr/secp256k1.ts";

export const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(b).digest());
export const dsha256 = (b: Uint8Array): Uint8Array => sha256(sha256(b));
export const hash160 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash("ripemd160").update(sha256(b)).digest());

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export function compressedPubkey(secret: Uint8Array): Uint8Array {
  const d = bytesToBigInt(secret);
  if (secret.length !== 32 || d <= 0n || d >= N) throw new Error("secret key out of range");
  const p = multiply(G, d);
  if (!p) throw new Error("point at infinity");
  return concat(Uint8Array.of(p.y % 2n === 0n ? 2 : 3), bigIntToBytes(p.x));
}

// ---------- HTLC script (BIP 199) ----------

export interface Htlc {
  digest: Uint8Array;
  claimPkh: Uint8Array;
  refundPkh: Uint8Array;
  locktime: number;
}

const OP_IF = 0x63, OP_ELSE = 0x67, OP_ENDIF = 0x68, OP_DROP = 0x75, OP_DUP = 0x76, OP_EQUALVERIFY = 0x88;
const OP_SHA256 = 0xa8, OP_HASH160 = 0xa9, OP_CHECKSIG = 0xac, OP_CLTV = 0xb1;

// Minimal CScriptNum bytes of a positive integer.
function scriptNum(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  while (v > 0) {
    out.push(v % 256);
    v = Math.floor(v / 256);
  }
  if (out[out.length - 1] & 0x80) out.push(0);
  return Uint8Array.from(out);
}

// Minimal push of a positive integer: OP_1..OP_16 or a direct push of its CScriptNum bytes.
function pushNumber(n: number): Uint8Array {
  if (n >= 1 && n <= 16) return Uint8Array.of(0x50 + n);
  const b = scriptNum(n);
  return concat(Uint8Array.of(b.length), b);
}

function checkHeight(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > 499_999_999) throw new Error("locktime must be a block height in [1, 499999999]");
}

export function htlcScript(h: Htlc): Uint8Array {
  if (h.digest.length !== 32) throw new Error("digest must be 32 bytes");
  if (h.claimPkh.length !== 20 || h.refundPkh.length !== 20) throw new Error("pubkey hashes must be 20 bytes");
  checkHeight(h.locktime);
  return concat(
    Uint8Array.of(OP_IF, OP_SHA256, 0x20), h.digest,
    Uint8Array.of(OP_EQUALVERIFY, OP_DUP, OP_HASH160, 0x14), h.claimPkh,
    Uint8Array.of(OP_ELSE), pushNumber(h.locktime),
    Uint8Array.of(OP_CLTV, OP_DROP, OP_DUP, OP_HASH160, 0x14), h.refundPkh,
    Uint8Array.of(OP_ENDIF, OP_EQUALVERIFY, OP_CHECKSIG),
  );
}

const PREFIX_LEN = 60; // 63 a8 20 <32> 88 76 a9 14 <20> 67
const SUFFIX_LEN = 28; // b1 75 76 a9 14 <20> 68 88 ac

export function parseHtlc(script: Uint8Array): Htlc | { error: string } {
  const n = script.length;
  if (n < PREFIX_LEN + 1 + SUFFIX_LEN) return { error: "script too short" };
  const digest = script.slice(3, 35);
  const claimPkh = script.slice(39, 59);
  const lockPush = script.slice(PREFIX_LEN, n - SUFFIX_LEN);
  const refundPkh = script.slice(n - 23, n - 3);
  if (lockPush.length > 5) return { error: "locktime push too long or trailing bytes" };
  let locktime: number;
  const first = lockPush[0];
  if (first >= 0x51 && first <= 0x60) {
    if (lockPush.length !== 1) return { error: "bad locktime push" };
    locktime = first - 0x50;
  } else if (first >= 1 && first <= 4 && lockPush.length === 1 + first) {
    const b = lockPush.slice(1);
    if (b[b.length - 1] & 0x80) return { error: "negative locktime" };
    locktime = 0;
    for (let i = b.length - 1; i >= 0; i--) locktime = locktime * 256 + b[i];
  } else {
    return { error: "locktime is not a minimal push" };
  }
  if (locktime < 1 || locktime > 499_999_999) return { error: "locktime outside block-height range" };
  // Rebuild the exact template from the parsed fields and compare byte for byte.
  const expected = htlcScript({ digest, claimPkh, refundPkh, locktime });
  if (!equalBytes(expected, script)) return { error: "script does not match the HTLC template" };
  return { digest, claimPkh, refundPkh, locktime };
}

export const p2wshScriptPubKey = (script: Uint8Array): Uint8Array => concat(Uint8Array.of(0x00, 0x20), sha256(script));
export const p2wpkhScriptPubKey = (pkh: Uint8Array): Uint8Array => {
  if (pkh.length !== 20) throw new Error("pkh must be 20 bytes");
  return concat(Uint8Array.of(0x00, 0x14), pkh);
};

// ---------- segwit addresses (BIP 173 / BIP 350) ----------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function convertBits(data: Uint8Array, from: number, to: number): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & ((1 << to) - 1));
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  return out;
}

export function segwitAddress(hrp: string, version: number, program: Uint8Array): string {
  if (!Number.isInteger(version) || version < 0 || version > 16) throw new Error("witness version out of range");
  if (program.length < 2 || program.length > 40) throw new Error("witness program length out of range");
  if (version === 0 && program.length !== 20 && program.length !== 32) throw new Error("v0 program must be 20 or 32 bytes");
  const data = [version, ...convertBits(program, 8, 5)];
  const hrpExpanded = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  const constant = version === 0 ? 1 : 0x2bc830a3;
  const m = polymod([...hrpExpanded, ...data, 0, 0, 0, 0, 0, 0]) ^ constant;
  const checksum = Array.from({ length: 6 }, (_, i) => (m >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}

// ---------- transactions ----------

export interface TxIn {
  txid: string; // display hex, as RPC prints it
  vout: number;
  sequence: number;
  witness: Uint8Array[];
}
export interface TxOut {
  value: bigint;
  scriptPubKey: Uint8Array;
}
export interface Tx {
  version: number;
  inputs: TxIn[];
  outputs: TxOut[];
  locktime: number;
}

const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};
const u64 = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
function compact(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 255, n >> 8);
  return concat(Uint8Array.of(0xfe), u32(n));
}
const reversed = (hex: string): Uint8Array => hexToBytes(hex, 32).slice().reverse();
const outpoint = (i: TxIn): Uint8Array => concat(reversed(i.txid), u32(i.vout));
const serOut = (o: TxOut): Uint8Array => concat(u64(o.value), compact(o.scriptPubKey.length), o.scriptPubKey);

export function serializeTx(tx: Tx, withWitness: boolean): Uint8Array {
  const wit = withWitness && tx.inputs.some((i) => i.witness.length > 0);
  const parts: Uint8Array[] = [u32(tx.version)];
  if (wit) parts.push(Uint8Array.of(0, 1));
  parts.push(compact(tx.inputs.length));
  for (const i of tx.inputs) parts.push(outpoint(i), compact(0), u32(i.sequence));
  parts.push(compact(tx.outputs.length), ...tx.outputs.map(serOut));
  if (wit) {
    for (const i of tx.inputs) {
      parts.push(compact(i.witness.length));
      for (const w of i.witness) parts.push(compact(w.length), w);
    }
  }
  parts.push(u32(tx.locktime));
  return concat(...parts);
}

export const txid = (tx: Tx): string => bytesToHex(dsha256(serializeTx(tx, false)).slice().reverse());
export const weight = (tx: Tx): number => serializeTx(tx, false).length * 3 + serializeTx(tx, true).length;
export const vsize = (tx: Tx): number => Math.ceil(weight(tx) / 4);

// BIP 143 digest for SIGHASH_ALL (hashType 1) of a native segwit input.
export function bip143Sighash(tx: Tx, index: number, scriptCode: Uint8Array, amount: bigint, hashType = 1): Uint8Array {
  if (hashType !== 1) throw new Error("only SIGHASH_ALL is supported");
  const input = tx.inputs[index];
  if (!input) throw new Error("input index out of range");
  const hashPrevouts = dsha256(concat(...tx.inputs.map(outpoint)));
  const hashSequence = dsha256(concat(...tx.inputs.map((i) => u32(i.sequence))));
  const hashOutputs = dsha256(concat(...tx.outputs.map(serOut)));
  return dsha256(concat(
    u32(tx.version), hashPrevouts, hashSequence, outpoint(input),
    compact(scriptCode.length), scriptCode, u64(amount), u32(input.sequence),
    hashOutputs, u32(tx.locktime), u32(hashType),
  ));
}

// ---------- ECDSA (RFC 6979, low-S, strict DER) ----------

const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m;
function invert(a: bigint, m: bigint): bigint {
  let [r0, r1, s0, s1] = [m, mod(a, m), 0n, 1n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
}
const hmac = (key: Uint8Array, ...parts: Uint8Array[]): Uint8Array => {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

function* rfc6979(digest: Uint8Array, x: bigint): Generator<bigint> {
  const xb = bigIntToBytes(x);
  const h1 = bigIntToBytes(bytesToBigInt(digest) % N);
  let V: Uint8Array = new Uint8Array(32).fill(1);
  let K: Uint8Array = new Uint8Array(32);
  K = hmac(K, V, Uint8Array.of(0), xb, h1);
  V = hmac(K, V);
  K = hmac(K, V, Uint8Array.of(1), xb, h1);
  V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = bytesToBigInt(V);
    if (k >= 1n && k < N) yield k;
    K = hmac(K, V, Uint8Array.of(0));
    V = hmac(K, V);
  }
}

function derInt(v: bigint): Uint8Array {
  let b = bigIntToBytes(v);
  let start = 0;
  while (start < b.length - 1 && b[start] === 0) start++;
  b = b.slice(start);
  if (b[0] & 0x80) b = concat(Uint8Array.of(0), b);
  return concat(Uint8Array.of(0x02, b.length), b);
}

// DER signature without the hash-type byte. `digest` is the 32-byte hash that is signed directly.
export function ecdsaSign(digest: Uint8Array, secret: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new Error("digest must be 32 bytes");
  const d = bytesToBigInt(secret);
  if (secret.length !== 32 || d <= 0n || d >= N) throw new Error("secret key out of range");
  const z = bytesToBigInt(digest);
  for (const k of rfc6979(digest, d)) {
    const R = multiply(G, k);
    if (!R) continue;
    const r = mod(R.x, N);
    if (r === 0n) continue;
    let s = mod(invert(k, N) * (z + r * d), N);
    if (s === 0n) continue;
    if (s > N / 2n) s = N - s;
    const body = concat(derInt(r), derInt(s));
    return concat(Uint8Array.of(0x30, body.length), body);
  }
  throw new Error("unreachable");
}

// ---------- witnesses ----------

export const claimWitness = (sigDerWithType: Uint8Array, pubkey33: Uint8Array, preimage32: Uint8Array, script: Uint8Array): Uint8Array[] =>
  [sigDerWithType, pubkey33, preimage32, Uint8Array.of(1), script];
export const refundWitness = (sigDerWithType: Uint8Array, pubkey33: Uint8Array, script: Uint8Array): Uint8Array[] =>
  [sigDerWithType, pubkey33, new Uint8Array(0), script];
