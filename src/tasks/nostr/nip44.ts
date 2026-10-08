// NIP-44 version 2: secp256k1 ECDH, HKDF-SHA256, padding, ChaCha20, HMAC-SHA256 with the nonce as
// associated data, base64. Followed step by step from the NIP's pseudocode at the pinned commit,
// including the extended length prefix added on 2026-06-28 (see docs/tasks.md §10.8 on the vector
// file that predates it). The nonce is the caller's: in the bench it comes from a seeded stream.

import { createCipheriv, createHmac, timingSafeEqual } from "node:crypto";
import { CryptoError, sharedX } from "./secp256k1.ts";

const SALT = Buffer.from("nip44-v2", "utf8");
const MIN_PLAINTEXT = 1;
const EXTENDED_PREFIX_THRESHOLD = 65536;
/**
 * The NIP lets an implementation cap payloads below the theoretical 2^32 − 1 bytes, and says it
 * should. The bench's messages are short; 1 MiB bounds any episode's memory. [invented]
 */
export const MAX_PLAINTEXT = 1 << 20;

const hmac = (key: Uint8Array, ...parts: Uint8Array[]): Buffer => {
  const h = createHmac("sha256", key);
  for (const part of parts) h.update(part);
  return h.digest();
};

/** HKDF-extract(IKM = shared_x, salt = "nip44-v2"). Symmetric: conv(a, B) = conv(b, A). */
export const conversationKey = (secret: Uint8Array, pub: Uint8Array): Uint8Array =>
  Uint8Array.from(hmac(SALT, sharedX(secret, pub)));

/** HKDF-expand(PRK = conversation key, info = nonce, L = 76), sliced 32 / 12 / 32. */
export function messageKeys(conversation: Uint8Array, nonce: Uint8Array): { chachaKey: Uint8Array; chachaNonce: Uint8Array; hmacKey: Uint8Array } {
  if (conversation.length !== 32) throw new CryptoError("invalid conversation_key length");
  if (nonce.length !== 32) throw new CryptoError("invalid nonce length");
  const blocks: Buffer[] = [];
  let previous: Uint8Array = new Uint8Array(0);
  for (let i = 1; blocks.length * 32 < 76; i++) {
    previous = hmac(conversation, previous, nonce, Uint8Array.of(i));
    blocks.push(Buffer.from(previous));
  }
  const okm = Buffer.concat(blocks).subarray(0, 76);
  return { chachaKey: okm.subarray(0, 32), chachaNonce: okm.subarray(32, 44), hmacKey: okm.subarray(44, 76) };
}

export function calcPaddedLen(unpadded: number): number {
  if (!Number.isSafeInteger(unpadded) || unpadded < 1) throw new CryptoError("invalid length");
  if (unpadded <= 32) return 32;
  let nextPower = 1; // 1 << (floor(log2(unpadded − 1)) + 1), computed without floating point
  while (nextPower <= unpadded - 1) nextPower *= 2;
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpadded - 1) / chunk) + 1);
}

export function pad(plaintext: string): Uint8Array {
  const unpadded = Buffer.from(plaintext, "utf8");
  const n = unpadded.length;
  if (n < MIN_PLAINTEXT || n > MAX_PLAINTEXT) throw new CryptoError("invalid plaintext length");
  const prefix = n >= EXTENDED_PREFIX_THRESHOLD ? Buffer.alloc(6) : Buffer.alloc(2);
  if (n >= EXTENDED_PREFIX_THRESHOLD) prefix.writeUInt32BE(n, 2);
  else prefix.writeUInt16BE(n, 0);
  return Uint8Array.from(Buffer.concat([prefix, unpadded, Buffer.alloc(calcPaddedLen(n) - n)]));
}

export function unpad(padded: Uint8Array): string {
  const buf = Buffer.from(padded);
  if (buf.length < 2) throw new CryptoError("invalid padding");
  const firstTwo = buf.readUInt16BE(0);
  let n: number;
  let prefixLen: number;
  if (firstTwo === 0) {
    if (buf.length < 6) throw new CryptoError("invalid padding");
    n = buf.readUInt32BE(2);
    if (n < EXTENDED_PREFIX_THRESHOLD) throw new CryptoError("invalid padding");
    prefixLen = 6;
  } else {
    n = firstTwo;
    prefixLen = 2;
  }
  const unpadded = buf.subarray(prefixLen, prefixLen + n);
  if (n === 0 || unpadded.length !== n || buf.length !== prefixLen + calcPaddedLen(n)) throw new CryptoError("invalid padding");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(unpadded); } catch { throw new CryptoError("plaintext is not UTF-8"); }
}

/** ChaCha20 (RFC 8439) with the block counter starting at 0, which is OpenSSL's 16-byte IV with a zero counter word. */
function chacha20(key: Uint8Array, nonce12: Uint8Array, data: Uint8Array): Uint8Array {
  const iv = Buffer.concat([Buffer.alloc(4), nonce12]);
  const cipher = createCipheriv("chacha20", key, iv);
  return Uint8Array.from(Buffer.concat([cipher.update(data), cipher.final()]));
}

function hmacAad(key: Uint8Array, message: Uint8Array, aad: Uint8Array): Uint8Array {
  if (aad.length !== 32) throw new CryptoError("AAD associated data must be 32 bytes");
  return Uint8Array.from(hmac(key, aad, message));
}

export function encrypt(plaintext: string, conversation: Uint8Array, nonce: Uint8Array): string {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversation, nonce);
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext));
  const mac = hmacAad(hmacKey, ciphertext, nonce);
  return Buffer.concat([Uint8Array.of(2), nonce, ciphertext, mac]).toString("base64");
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodePayload(payload: string): { nonce: Uint8Array; ciphertext: Uint8Array; mac: Uint8Array } {
  const plen = payload.length;
  if (plen === 0 || payload[0] === "#") throw new CryptoError("unknown version");
  if (plen < 132) throw new CryptoError("invalid payload size");
  // Refused before decoding when longer than the payload of a MAX_PLAINTEXT message, as the NIP advises.
  if (plen > Math.ceil((65 + 6 + calcPaddedLen(MAX_PLAINTEXT)) / 3) * 4) throw new CryptoError("invalid payload size");
  // Node's base64 decoder skips characters it does not know, so the alphabet and padding are checked first.
  if (!BASE64.test(payload)) throw new CryptoError("invalid base64");
  const data = Buffer.from(payload, "base64");
  const dlen = data.length;
  if (dlen < 99) throw new CryptoError("invalid data size");
  if (data[0] !== 2) throw new CryptoError(`unknown version ${data[0]}`);
  return { nonce: data.subarray(1, 33), ciphertext: data.subarray(33, dlen - 32), mac: data.subarray(dlen - 32) };
}

export function decrypt(payload: string, conversation: Uint8Array): string {
  const { nonce, ciphertext, mac } = decodePayload(payload);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(conversation, nonce);
  const calculated = hmacAad(hmacKey, ciphertext, nonce);
  if (!timingSafeEqual(calculated, mac)) throw new CryptoError("invalid MAC");
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
}
