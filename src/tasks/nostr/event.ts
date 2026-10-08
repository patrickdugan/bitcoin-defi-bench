// NIP-01 events: the id is SHA-256 of a fixed JSON array, the signature is BIP-340 over the id.
// Family 9's tools sign through this module and its relays and recipients verify through it, so a
// malformed or mis-signed event is rejected by the same rule a relay applies.

import { CryptoError, bytesToHex, hexToBytes, publicKey, schnorrSign, schnorrVerify, sha256Bytes } from "./secp256k1.ts";

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** What a signer is asked to sign: everything but the key, id, and signature. */
export interface EventTemplate {
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** An unsigned event with its id, as NIP-59 calls a rumor. */
export type Rumor = Omit<NostrEvent, "sig">;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

const ESCAPES: { [c: string]: string } = { "\n": "\\n", '"': '\\"', "\\": "\\\\", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

/**
 * A string as NIP-01 serializes it: the seven listed characters escaped, everything else verbatim.
 * Other control characters and lone surrogates are refused rather than serialized, because
 * implementations disagree on them (JSON.stringify would write \u00XX where NIP-01 says verbatim)
 * and an id that two implementations compute differently is not an id.
 */
function nip01String(s: string): string {
  if (/[\u0000-\u0007\u000b\u000e-\u001f]/.test(s)) throw new CryptoError("control character with no NIP-01 escape");
  if (!s.isWellFormed()) throw new CryptoError("lone surrogate in event string");
  return `"${s.replace(/[\n"\\\r\t\b\f]/g, (c) => ESCAPES[c]!)}"`;
}

/** Check the shape of a template, or throw naming the first field that is wrong. */
export function checkTemplate(t: EventTemplate): void {
  if (!Number.isSafeInteger(t.created_at) || t.created_at < 0) throw new CryptoError("created_at must be a non-negative integer");
  if (!Number.isInteger(t.kind) || t.kind < 0 || t.kind > 65535) throw new CryptoError("kind must be an integer in [0, 65535]");
  if (!Array.isArray(t.tags) || !t.tags.every((tag) => Array.isArray(tag) && tag.every((v) => typeof v === "string"))) {
    throw new CryptoError("tags must be an array of arrays of strings");
  }
  if (typeof t.content !== "string") throw new CryptoError("content must be a string");
}

/** The NIP-01 serialization the id is taken over. */
export function serializeForId(pubkey: string, t: EventTemplate): string {
  if (!HEX64.test(pubkey)) throw new CryptoError("pubkey must be 64 lowercase hex characters");
  checkTemplate(t);
  const tags = `[${t.tags.map((tag) => `[${tag.map(nip01String).join(",")}]`).join(",")}]`;
  return `[0,"${pubkey}",${t.created_at},${t.kind},${tags},${nip01String(t.content)}]`;
}

export const eventId = (pubkey: string, t: EventTemplate): string =>
  bytesToHex(sha256Bytes(Buffer.from(serializeForId(pubkey, t), "utf8")));

const templateOf = (e: EventTemplate): EventTemplate => ({ created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content });

export function makeRumor(pubkey: string, t: EventTemplate): Rumor {
  const template = templateOf(t);
  return { ...template, pubkey, id: eventId(pubkey, template) };
}

/** Sign a template. aux is BIP-340's 32 bytes of auxiliary randomness, drawn by the caller. */
export function signEvent(t: EventTemplate, secret: Uint8Array, aux: Uint8Array): NostrEvent {
  const pubkey = bytesToHex(publicKey(secret));
  const rumor = makeRumor(pubkey, t);
  const sig = bytesToHex(schnorrSign(hexToBytes(rumor.id), secret, aux));
  return { ...rumor, sig };
}

/** Whether an event is well formed, its id is the hash of its fields, and its signature verifies. */
export function verifyEvent(e: unknown): e is NostrEvent {
  if (typeof e !== "object" || e === null) return false;
  const ev = e as Partial<NostrEvent>;
  if (typeof ev.id !== "string" || !HEX64.test(ev.id) || typeof ev.sig !== "string" || !HEX128.test(ev.sig)) return false;
  if (typeof ev.pubkey !== "string") return false;
  let id: string;
  try { id = eventId(ev.pubkey, ev as EventTemplate); } catch { return false; }
  if (id !== ev.id) return false;
  return schnorrVerify(hexToBytes(ev.id), hexToBytes(ev.pubkey), hexToBytes(ev.sig));
}

/** Whether a rumor's id matches its fields. A rumor has no signature to check. */
export function verifyRumor(r: unknown): r is Rumor {
  if (typeof r !== "object" || r === null) return false;
  const rumor = r as Partial<Rumor>;
  if (typeof rumor.id !== "string" || typeof rumor.pubkey !== "string") return false;
  try { return eventId(rumor.pubkey, rumor as EventTemplate) === rumor.id; } catch { return false; }
}
