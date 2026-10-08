import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../harness/json.ts";
import { stream } from "../../harness/prng.ts";
import { nip19Decode, nip19Encode } from "./bech32.ts";
import { eventId, serializeForId, signEvent, verifyEvent, type NostrEvent } from "./event.ts";
import { MAX_PLAINTEXT, calcPaddedLen, conversationKey, decrypt, encrypt, messageKeys } from "./nip44.ts";
import { TWO_DAYS, chatMessage, drawSecret, unwrap, wrapForAll } from "./nip59.ts";
import { CryptoError, bytesToHex, hexToBytes, publicKey, schnorrSign, schnorrVerify } from "./secp256k1.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const data = (file: string): Buffer => readFileSync(join(root, "data/nostr", file));
const provenance = JSON.parse(data("provenance.json").toString("utf8")) as { vectors: Array<{ file: string; sha256: string }> };

test("vector files are byte-identical to their pinned sources", () => {
  for (const v of provenance.vectors) assert.equal(sha256(readFileSync(join(root, v.file))), v.sha256, v.file);
});

test("BIP-340: every published vector signs and verifies as stated", () => {
  // Upstream stores the file with CRLF line ends; it is kept byte for byte.
  const rows = data("bip340-test-vectors.csv").toString("utf8").trim().split(/\r?\n/).slice(1);
  assert.equal(rows.length, 19);
  for (const row of rows) {
    const [index, secret, pub, aux, message, signature, result, comment] = row.split(",");
    const msg = hexToBytes(message!);
    if (secret) {
      const sk = hexToBytes(secret, 32);
      assert.equal(bytesToHex(publicKey(sk)), pub!.toLowerCase(), `vector ${index}: public key`);
      assert.equal(bytesToHex(schnorrSign(msg, sk, hexToBytes(aux!, 32))), signature!.toLowerCase(), `vector ${index}: signature`);
    }
    let ok: boolean;
    try { ok = schnorrVerify(msg, hexToBytes(pub!), hexToBytes(signature!)); } catch { ok = false; }
    assert.equal(ok, result === "TRUE", `vector ${index}: verification (${comment || "no comment"})`);
  }
});

const nip44 = JSON.parse(data("nip44.vectors.json").toString("utf8")).v2;

test("NIP-44: conversation keys, message keys, and padded lengths", () => {
  for (const v of nip44.valid.get_conversation_key) {
    assert.equal(bytesToHex(conversationKey(hexToBytes(v.sec1), hexToBytes(v.pub2))), v.conversation_key);
  }
  const conv = hexToBytes(nip44.valid.get_message_keys.conversation_key);
  for (const v of nip44.valid.get_message_keys.keys) {
    const keys = messageKeys(conv, hexToBytes(v.nonce));
    assert.equal(bytesToHex(keys.chachaKey), v.chacha_key);
    assert.equal(bytesToHex(keys.chachaNonce), v.chacha_nonce);
    assert.equal(bytesToHex(keys.hmacKey), v.hmac_key);
  }
  for (const [unpadded, padded] of nip44.valid.calc_padded_len) assert.equal(calcPaddedLen(unpadded), padded, `length ${unpadded}`);
});

test("NIP-44: encrypt and decrypt both ways, as the vector file's guidance prescribes", () => {
  for (const v of nip44.valid.encrypt_decrypt) {
    const sec1 = hexToBytes(v.sec1);
    const sec2 = hexToBytes(v.sec2);
    const conv12 = conversationKey(sec1, publicKey(sec2));
    assert.equal(bytesToHex(conv12), v.conversation_key);
    assert.equal(encrypt(v.plaintext, conv12, hexToBytes(v.nonce)), v.payload);
    const conv21 = conversationKey(sec2, publicKey(sec1));
    assert.equal(bytesToHex(conv21), v.conversation_key);
    assert.equal(decrypt(v.payload, conv21), v.plaintext);
  }
  for (const v of nip44.valid.encrypt_decrypt_long_msg) {
    const plaintext = v.pattern.repeat(v.repeat);
    assert.equal(sha256(Buffer.from(plaintext, "utf8")), v.plaintext_sha256);
    const payload = encrypt(plaintext, hexToBytes(v.conversation_key), hexToBytes(v.nonce));
    assert.equal(sha256(Buffer.from(payload, "utf8")), v.payload_sha256);
    assert.equal(decrypt(payload, hexToBytes(v.conversation_key)), plaintext);
  }
});

test("NIP-44: the extended length prefix, from the vectors written into the NIP itself", () => {
  // NIP-44 at the pin, "Extended length prefix test vectors": 'a' repeated, fixed key and nonce.
  const conv = hexToBytes("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
  const nonce = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
  const table: Array<[number, number, string, string]> = [
    [65535, 65536, "6e1bebca6a8229364a162a72ef064826c4cd7457bf54f190ef782bd9deff3e42", "6d8c2810d1e870fbaa1f0a0937126cca837a15f9260e27060c331d70a3c0bc84"],
    [65536, 65536, "bf718b6f653bebc184e1479f1935b8da974d701b893afcf49e701f3e2f9f9c5a", "b7b4edb36ba92e267d322d56d9aebc22e7fa96ff52e3c12adc07f07a43cbc616"],
    [65537, 81920, "008ffc88d3c96a9f307524eb361e47c5222a887fc45fa0c1fb8d429c5c23b430", "eeb7c7c5373894ea2c1547cfd3ccb15d5a0b2d619da852e5c79df792dcc9e435"],
  ];
  for (const [length, padded, plainHash, payloadHash] of table) {
    const plaintext = "a".repeat(length);
    assert.equal(calcPaddedLen(length), padded);
    assert.equal(sha256(Buffer.from(plaintext)), plainHash);
    const payload = encrypt(plaintext, conv, nonce);
    assert.equal(sha256(Buffer.from(payload)), payloadHash, `payload for length ${length}`);
    assert.equal(decrypt(payload, conv), plaintext);
  }
});

test("NIP-44: every invalid vector is refused", () => {
  for (const v of nip44.invalid.get_conversation_key) {
    assert.throws(() => conversationKey(hexToBytes(v.sec1), hexToBytes(v.pub2)), CryptoError, v.note);
  }
  for (const v of nip44.invalid.decrypt) {
    assert.throws(() => decrypt(v.payload, hexToBytes(v.conversation_key)), CryptoError, v.note);
  }
  // The vector file predates the extended prefix and still lists 65536 and above as invalid. Under
  // the amended text only 0 is invalid among them; 10,000,000 is refused here by the bench's cap.
  const conv = hexToBytes(nip44.valid.encrypt_decrypt[0].conversation_key);
  const nonce = hexToBytes(nip44.valid.encrypt_decrypt[0].nonce);
  assert.deepEqual(nip44.invalid.encrypt_msg_lengths, [0, 65536, 100000, 10000000]);
  assert.throws(() => encrypt("", conv, nonce), CryptoError);
  for (const length of [65536, 100000]) assert.equal(decrypt(encrypt("x".repeat(length), conv, nonce), conv).length, length);
  assert.ok(10000000 > MAX_PLAINTEXT);
  assert.throws(() => encrypt("x".repeat(10000000), conv, nonce), CryptoError);
});

test("NIP-19: the NIP's examples encode and decode both ways", () => {
  const cases: Array<["npub" | "nsec", string, string]> = [
    ["npub", "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6", "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"],
    ["npub", "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg", "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e"],
    ["nsec", "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5", "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa"],
  ];
  for (const [prefix, text, hex] of cases) {
    assert.equal(bytesToHex(nip19Decode(text, prefix)), hex);
    assert.equal(nip19Encode(prefix, hexToBytes(hex)), text);
  }
  assert.throws(() => nip19Decode(cases[0]![1], "nsec"), CryptoError);
  assert.throws(() => nip19Decode(`${cases[0]![1].slice(0, -1)}q`, "npub"), CryptoError);
});

test("NIP-59: the NIP's worked example verifies and opens with the recipient's key", () => {
  const ex = JSON.parse(data("nip59-example.json").toString("utf8")) as {
    author_secret: string; recipient_secret: string; wrapper_secret: string;
    rumor: Omit<NostrEvent, "sig">; seal: NostrEvent; wrap: NostrEvent;
  };
  const author = hexToBytes(ex.author_secret);
  const recipient = hexToBytes(ex.recipient_secret);
  assert.equal(bytesToHex(publicKey(author)), ex.rumor.pubkey);
  assert.equal(bytesToHex(publicKey(hexToBytes(ex.wrapper_secret))), ex.wrap.pubkey);
  assert.equal(bytesToHex(publicKey(recipient)), ex.wrap.tags[0]![1]);
  assert.equal(eventId(ex.rumor.pubkey, ex.rumor), ex.rumor.id);
  assert.ok(verifyEvent(ex.seal));
  assert.ok(verifyEvent(ex.wrap));
  // The example wraps a kind 1 to show the mechanism; opening it checks every layer but the kind.
  const opened = unwrap(ex.wrap, recipient);
  assert.deepEqual(opened.seal, ex.seal);
  assert.equal(opened.rumor.id, ex.rumor.id);
  assert.equal(opened.rumor.content, "Are you going to the party tonight?");
  assert.throws(() => unwrap(ex.wrap, author), CryptoError, "the author cannot open the recipient's wrap");
});

test("NIP-01: ids follow the serialization rule, and a changed field breaks the signature", () => {
  const secret = hexToBytes("0000000000000000000000000000000000000000000000000000000000000003");
  const pub = bytesToHex(publicKey(secret));
  const template = { created_at: 1700000000, kind: 1, tags: [["p", pub], ["t", "a\"b"]], content: "line\nbreak \\ \"quote\" tab\t café ⚡" };
  assert.equal(
    serializeForId(pub, template),
    `[0,"${pub}",1700000000,1,[["p","${pub}"],["t","a\\"b"]],"line\\nbreak \\\\ \\"quote\\" tab\\t café ⚡"]`,
  );
  const event = signEvent(template, secret, new Uint8Array(32));
  assert.ok(verifyEvent(event));
  assert.ok(!verifyEvent({ ...event, content: `${event.content}!` }));
  assert.ok(!verifyEvent({ ...event, created_at: event.created_at + 1 }));
  assert.ok(!verifyEvent({ ...event, sig: `${event.sig.slice(0, -1)}${event.sig.endsWith("0") ? "1" : "0"}` }));
  assert.throws(() => eventId(pub, { ...template, content: "bell\u0007" }), CryptoError);
  assert.throws(() => eventId(pub, { ...template, content: "\ud800" }), CryptoError);
});

test("NIP-17: a seeded wrap is reproducible, opens only for its parties, and tweaks time into the past", () => {
  const rng = stream("test", "nip17", "keys");
  const alice = drawSecret(rng);
  const bob = drawSecret(rng);
  const carol = drawSecret(rng);
  const bobPub = bytesToHex(publicKey(bob));
  const now = 1_790_000_000;
  const send = () => {
    const r = stream("test", "nip17", "send");
    return wrapForAll(chatMessage(alice, [bobPub], "invoice lnbc1... due in 10 blocks", now), alice, [bobPub], r, now);
  };
  const wraps = send();
  assert.deepEqual(wraps, send(), "same stream, same bytes");
  assert.deepEqual(wraps.map((w) => w.recipient), [bobPub, bytesToHex(publicKey(alice))], "one wrap to each receiver and one to the sender");
  for (const { wrap } of wraps) {
    assert.ok(wrap.created_at <= now && wrap.created_at >= now - TWO_DAYS);
    assert.ok(!wrap.content.includes("invoice"));
  }
  const opened = unwrap(wraps[0]!.wrap, bob);
  assert.equal(opened.rumor.content, "invoice lnbc1... due in 10 blocks");
  assert.equal(opened.rumor.created_at, now, "the rumor keeps the true time");
  assert.ok(opened.seal.created_at <= now && opened.seal.created_at >= now - TWO_DAYS);
  assert.equal(unwrap(wraps[1]!.wrap, alice).rumor.id, opened.rumor.id, "the sender's copy is the same rumor");
  assert.throws(() => unwrap(wraps[0]!.wrap, carol), CryptoError, "a third party cannot open it");
  const tampered = { ...wraps[0]!.wrap, content: wraps[0]!.wrap.content.replace(/^A./, "AA") };
  assert.throws(() => unwrap(tampered, bob), CryptoError);
});
