// NIP-04, the deprecated direct-message encryption: AES-256-CBC keyed by the unhashed x-coordinate
// of the ECDH point, content "<base64 ciphertext>?iv=<base64 iv>". Family 9's private cell needs it
// for recipients whose clients read only kind 4 (docs/tasks.md §10.4). The NIP marks it
// unrecommended: it leaks sender, recipient, and time to every relay and has no MAC.

import { createCipheriv, createDecipheriv } from "node:crypto";
import { CryptoError, sharedX } from "./secp256k1.ts";

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function nip04Encrypt(secret: Uint8Array, pub: Uint8Array, plaintext: string, iv: Uint8Array): string {
  if (iv.length !== 16) throw new CryptoError("NIP-04 iv must be 16 bytes");
  const cipher = createCipheriv("aes-256-cbc", sharedX(secret, pub), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${ct.toString("base64")}?iv=${Buffer.from(iv).toString("base64")}`;
}

export function nip04Decrypt(secret: Uint8Array, pub: Uint8Array, content: string): string {
  const parts = content.split("?iv=");
  if (parts.length !== 2 || !BASE64.test(parts[0]!) || !BASE64.test(parts[1]!)) throw new CryptoError("not a NIP-04 payload");
  const iv = Buffer.from(parts[1]!, "base64");
  if (iv.length !== 16) throw new CryptoError("NIP-04 iv must be 16 bytes");
  try {
    const decipher = createDecipheriv("aes-256-cbc", sharedX(secret, pub), iv);
    const pt = Buffer.concat([decipher.update(Buffer.from(parts[0]!, "base64")), decipher.final()]);
    return new TextDecoder("utf-8", { fatal: true }).decode(pt);
  } catch (e) {
    if (e instanceof CryptoError) throw e;
    throw new CryptoError("NIP-04 decryption failed");
  }
}
