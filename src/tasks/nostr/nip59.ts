// NIP-59 gift wrap and NIP-17 private messages: an unsigned rumor, sealed (kind 13) under the
// sender's key, wrapped (kind 1059) under a one-time key with only the recipient in a p tag. The
// private cell scores delivery by unwrapping with the recipient's key (docs/tasks.md §10.4), so
// what a recipient can read is computed here, not assumed.
//
// Every random draw (wrapper keys, NIP-44 nonces, BIP-340 aux, timestamp tweaks) comes from the
// caller's seeded stream, so an episode is reproducible. A wallet must use a CSPRNG instead.

import type { Stream } from "../../harness/prng.ts";
import { makeRumor, signEvent, verifyEvent, verifyRumor, type EventTemplate, type NostrEvent, type Rumor } from "./event.ts";
import { conversationKey, decrypt, encrypt } from "./nip44.ts";
import { CryptoError, N, bytesToBigInt, bytesToHex, hexToBytes, publicKey } from "./secp256k1.ts";

/** NIP-17 and NIP-59: seal and wrap timestamps are tweaked up to two days into the past. */
export const TWO_DAYS = 2 * 24 * 60 * 60;
export const SEAL_KIND = 13;
export const WRAP_KIND = 1059;
export const EPHEMERAL_WRAP_KIND = 21059;
export const CHAT_KIND = 14;

export type Entropy = Pick<Stream, "int">;

export const drawBytes = (rng: Entropy, n: number): Uint8Array => Uint8Array.from({ length: n }, () => rng.int(256));

/** A uniformly drawn secret key in [1, n − 1]. */
export function drawSecret(rng: Entropy): Uint8Array {
  for (;;) {
    const candidate = drawBytes(rng, 32);
    const d = bytesToBigInt(candidate);
    if (d > 0n && d < N) return candidate;
  }
}

const parseJson = (text: string, what: string): unknown => {
  try { return JSON.parse(text); } catch { throw new CryptoError(`${what} is not JSON`); }
};

export function seal(rumor: Rumor, senderSecret: Uint8Array, recipient: string, rng: Entropy, now: number): NostrEvent {
  if (bytesToHex(publicKey(senderSecret)) !== rumor.pubkey) throw new CryptoError("the rumor's pubkey is not the sealing key's");
  const content = encrypt(JSON.stringify(rumor), conversationKey(senderSecret, hexToBytes(recipient, 32)), drawBytes(rng, 32));
  return signEvent({ kind: SEAL_KIND, tags: [], content, created_at: now - rng.int(TWO_DAYS + 1) }, senderSecret, drawBytes(rng, 32));
}

export function wrap(sealed: NostrEvent, recipient: string, rng: Entropy, now: number, kind: number = WRAP_KIND): NostrEvent {
  const wrapper = drawSecret(rng);
  const content = encrypt(JSON.stringify(sealed), conversationKey(wrapper, hexToBytes(recipient, 32)), drawBytes(rng, 32));
  return signEvent({ kind, tags: [["p", recipient]], content, created_at: now - rng.int(TWO_DAYS + 1) }, wrapper, drawBytes(rng, 32));
}

export interface Unwrapped {
  wrap: NostrEvent;
  seal: NostrEvent;
  rumor: Rumor;
}

/** Open a gift wrap with the recipient's key, checking every layer NIP-17 and NIP-59 require. */
export function unwrap(event: unknown, recipientSecret: Uint8Array): Unwrapped {
  if (!verifyEvent(event)) throw new CryptoError("gift wrap does not verify");
  if (event.kind !== WRAP_KIND && event.kind !== EPHEMERAL_WRAP_KIND) throw new CryptoError("not a gift wrap");
  const sealed = parseJson(decrypt(event.content, conversationKey(recipientSecret, hexToBytes(event.pubkey, 32))), "seal");
  if (!verifyEvent(sealed)) throw new CryptoError("seal does not verify");
  if (sealed.kind !== SEAL_KIND || sealed.tags.length !== 0) throw new CryptoError("seal must be kind 13 with no tags");
  const rumor = parseJson(decrypt(sealed.content, conversationKey(recipientSecret, hexToBytes(sealed.pubkey, 32))), "rumor");
  if (!verifyRumor(rumor)) throw new CryptoError("rumor id does not match its fields");
  if ("sig" in (rumor as object)) throw new CryptoError("rumor must be unsigned");
  if (rumor.pubkey !== sealed.pubkey) throw new CryptoError("rumor pubkey differs from the seal's: impersonation");
  return { wrap: event, seal: sealed, rumor: { id: rumor.id, pubkey: rumor.pubkey, created_at: rumor.created_at, kind: rumor.kind, tags: rumor.tags, content: rumor.content } };
}

/** A NIP-17 kind-14 chat message from the sender to the receivers. */
export function chatMessage(senderSecret: Uint8Array, receivers: readonly string[], content: string, createdAt: number, tags: string[][] = []): Rumor {
  const template: EventTemplate = { kind: CHAT_KIND, created_at: createdAt, content, tags: [...receivers.map((p) => ["p", p]), ...tags] };
  return makeRumor(bytesToHex(publicKey(senderSecret)), template);
}

/**
 * NIP-17 sending: one seal and one wrap per receiver, and one to the sender so the sender's other
 * clients can read the conversation. Each wrap belongs on that party's kind-10050 relays only.
 */
export function wrapForAll(rumor: Rumor, senderSecret: Uint8Array, receivers: readonly string[], rng: Entropy, now: number): Array<{ recipient: string; wrap: NostrEvent }> {
  const parties = [...new Set([...receivers, rumor.pubkey])];
  return parties.map((recipient) => ({ recipient, wrap: wrap(seal(rumor, senderSecret, recipient, rng, now), recipient, rng, now) }));
}
