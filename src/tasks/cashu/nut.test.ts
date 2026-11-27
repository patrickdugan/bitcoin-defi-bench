// The Cashu core against the published NUT vectors (data/cashu/nut-vectors.json, pinned in
// data/cashu/provenance.json). Every vector there is checked here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../harness/json.ts";
import { bytesToBigInt, hexToBytes } from "../nostr/secp256k1.ts";
import { blindMessage, compress, decompress, dleqNonce, dleqProve, dleqVerify, hashE, hashToCurve, keysetIdV1, makeProof, mintVerify, proofDleqValid, pubkeyOf, signBlinded, tryDecompress, unblind } from "./nut.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const V = JSON.parse(readFileSync(join(root, "data/cashu/nut-vectors.json"), "utf8"));
const big = (hex: string): bigint => bytesToBigInt(hexToBytes(hex));

test("the vector file is the one provenance pins", () => {
  const prov = JSON.parse(readFileSync(join(root, "data/cashu/provenance.json"), "utf8"));
  assert.equal(sha256(readFileSync(join(root, "data/cashu/nut-vectors.json"))), prov.vectors.sha256);
});

test("NUT-00 hash_to_curve: three messages", () => {
  for (const v of V.nut00_hash_to_curve) assert.equal(compress(hashToCurve(hexToBytes(v.message))), v.point, v.message);
});

test("NUT-00 blinded messages B_ = Y + rG", () => {
  for (const v of V.nut00_blinded_messages) assert.equal(compress(blindMessage(hashToCurve(hexToBytes(v.x)), big(v.r))), v.B_);
});

test("NUT-00 blinded signatures C_ = kB_", () => {
  for (const v of V.nut00_blinded_signatures) assert.equal(compress(signBlinded(big(v.k), decompress(v.B_))), v.C_);
});

test("NUT-00 round trip: unblinding gives k·Y, and only the signing key verifies it", () => {
  const k = 0x1234n;
  const y = hashToCurve(Buffer.from("secret", "utf8"));
  const r = 0x5678n;
  const c = unblind(signBlinded(k, blindMessage(y, r)), r, decompress(pubkeyOf(k)));
  assert.ok(mintVerify(k, "secret", c));
  assert.ok(!mintVerify(k + 1n, "secret", c));
});

test("NUT-12 hash_e", () => {
  const v = V.nut12_hash_e;
  assert.equal(hashE([decompress(v.R1), decompress(v.R2), decompress(v.K), decompress(v.C_)]).toString(16).padStart(64, "0"), v.e);
});

test("NUT-12 deterministic nonce: e and s", () => {
  const v = V.nut12_deterministic_nonce;
  const a = big(v.a);
  assert.equal(pubkeyOf(a), v.A);
  const blinded = decompress(v.B_);
  const signed = decompress(v.C_);
  assert.equal(compress(signBlinded(a, blinded)), v.C_);
  const d = dleqProve(a, blinded, signed);
  assert.equal(d.e.toString(16).padStart(64, "0"), v.e);
  assert.equal(d.s.toString(16).padStart(64, "0"), v.s);
  assert.equal(dleqProve(a, blinded, signed, dleqNonce(a, decompress(v.A), blinded, signed)).s, d.s);
  assert.ok(dleqVerify(decompress(v.A), blinded, signed, d));
});

test("NUT-12 DLEQ on a BlindSignature verifies, and fails when tampered", () => {
  const v = V.nut12_blind_signature_dleq;
  const d = { e: big(v.blind_signature.dleq.e), s: big(v.blind_signature.dleq.s) };
  assert.ok(dleqVerify(decompress(v.A), decompress(v.B_), decompress(v.blind_signature.C_), d));
  assert.ok(!dleqVerify(decompress(v.A), decompress(v.B_), decompress(v.blind_signature.C_), { e: d.e, s: d.s + 1n }));
  assert.ok(!dleqVerify(decompress(pubkeyOf(2n)), decompress(v.B_), decompress(v.blind_signature.C_), d));
});

test("NUT-12 DLEQ on a Proof (the receiver's offline check) verifies, and fails when tampered", () => {
  const v = V.nut12_proof_dleq;
  assert.ok(proofDleqValid(v.A, v.proof));
  assert.ok(!proofDleqValid(v.A, { ...v.proof, secret: `${v.proof.secret.slice(0, 63)}0` }));
  assert.ok(!proofDleqValid(v.A, { ...v.proof, dleq: { ...v.proof.dleq, r: v.proof.dleq.e } }));
  assert.ok(!proofDleqValid(pubkeyOf(2n), v.proof));
  assert.ok(!proofDleqValid(v.A, { ...v.proof, dleq: undefined }));
  assert.ok(!proofDleqValid(v.A, { ...v.proof, C: "02zz" }));
});

test("NUT-02 version 1 keyset id", () => {
  const v = V.nut02_keyset_id_v1;
  assert.equal(keysetIdV1(v.keys), v.id);
});

test("a proof made here verifies under its key and not under another; a forgery's DLEQ fails against the mint", () => {
  const k = 0xabcdefn;
  const keyset = keysetIdV1({ "1": pubkeyOf(k) });
  const good = makeProof(1, keyset, k, "a".repeat(64), 0x77n);
  assert.ok(proofDleqValid(pubkeyOf(k), good));
  assert.ok(mintVerify(k, good.secret, decompress(good.C)));
  const forged = makeProof(1, keyset, k, "b".repeat(64), 0x78n, 0x999n);
  assert.ok(!proofDleqValid(pubkeyOf(k), forged));
  assert.ok(proofDleqValid(pubkeyOf(0x999n), forged));
  assert.equal(tryDecompress("04" + "0".repeat(64)), null);
});
