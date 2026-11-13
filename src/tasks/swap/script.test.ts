import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { G, N, bigIntToBytes, bytesToBigInt, bytesToHex, hexToBytes, multiply } from "../nostr/secp256k1.ts";
import {
  bip143Sighash, claimWitness, compressedPubkey, dsha256, ecdsaSign, hash160, htlcScript, p2wpkhScriptPubKey,
  p2wshScriptPubKey, parseHtlc, refundWitness, segwitAddress, serializeTx, sha256, txid, vsize, weight, type Htlc, type Tx,
} from "./script.ts";

const hex = (s: string): Uint8Array => hexToBytes(s);
const rev = (s: string): string => bytesToHex(hex(s).slice().reverse());

// BIP 173 examples (https://raw.githubusercontent.com/bitcoin/bips/master/bip-0173.mediawiki): public key
// 0279BE66..., and the P2WSH examples use "key OP_CHECKSIG" as the script.
const G33 = hex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");

test("BIP 173: P2WSH and P2WPKH addresses for the generator-point examples", () => {
  const script = new Uint8Array([0x21, ...G33, 0xac]);
  const program = sha256(script);
  assert.equal(segwitAddress("bc", 0, program), "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3");
  assert.equal(segwitAddress("tb", 0, program), "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7");
  assert.equal(bytesToHex(p2wshScriptPubKey(script)), "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262");
  assert.equal(segwitAddress("bc", 0, hash160(G33)), "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  assert.equal(segwitAddress("tb", 0, hash160(G33)), "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
  assert.equal(bytesToHex(p2wpkhScriptPubKey(hash160(G33))), "0014751e76e8199196d454941c45d1b3a323f1433bd6");
});

test("BIP 350: bech32m vectors (https://raw.githubusercontent.com/bitcoin/bips/master/bip-0350.mediawiki)", () => {
  // scriptPubKey 5120 <32-byte program> is witness version 1.
  assert.equal(
    segwitAddress("bc", 1, hex("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")),
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
  );
  assert.equal(
    segwitAddress("tb", 1, hex("000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433")),
    "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c",
  );
  assert.equal(
    segwitAddress("bc", 16, hex("751e")),
    "BC1SW50QGDZ25J".toLowerCase(),
  );
});

// BIP 143 "Native P2WPKH" example (https://raw.githubusercontent.com/bitcoin/bips/master/bip-0143.mediawiki).
const bip143Tx: Tx = {
  version: 1,
  inputs: [
    { txid: rev("fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f"), vout: 0, sequence: 0xffffffee, witness: [] },
    { txid: rev("ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a"), vout: 1, sequence: 0xffffffff, witness: [] },
  ],
  outputs: [
    { value: 112340000n, scriptPubKey: hex("76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac") },
    { value: 223450000n, scriptPubKey: hex("76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac") },
  ],
  locktime: 0x11,
};

test("BIP 143 native P2WPKH: unsigned serialization and sighash", () => {
  assert.equal(
    bytesToHex(serializeTx(bip143Tx, false)),
    "0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000",
  );
  // hashPrevouts, hashSequence, hashOutputs as quoted in the BIP.
  const prevouts = bip143Tx.inputs.map((i) => bytesToHex(hex(i.txid).slice().reverse()) + (i.vout === 0 ? "00000000" : "01000000")).join("");
  assert.equal(bytesToHex(dsha256(hex(prevouts))), "96b827c8483d4e9b96712b6713a7b68d6e8003a781feba36c31143470b4efd37");
  assert.equal(bytesToHex(dsha256(hex("eeffffffffffffff"))), "52b0a642eea2fb7ae638c36f6252b6750293dbe574a806984b8e4d8548339a3b");
  const outs = "202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac";
  assert.equal(bytesToHex(dsha256(hex(outs))), "863ef3e1a92afbfdb97f31ad0fc7683ee943e9abcf2501590ff8f6551f47e5e5");
  const sighash = bip143Sighash(bip143Tx, 1, hex("76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac"), 600000000n);
  assert.equal(bytesToHex(sighash), "c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670");
});

test("BIP 143 native P2WPKH: our deterministic signature equals the published one", () => {
  const secret = hex("619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9");
  const pub = compressedPubkey(secret);
  assert.equal(bytesToHex(pub), "025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357");
  const sighash = bip143Sighash(bip143Tx, 1, hex("76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac"), 600000000n);
  const sig = ecdsaSign(sighash, secret);
  assert.equal(
    bytesToHex(sig) + "01",
    "304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee01",
  );
});

// ---------- ECDSA ----------

const jwkKey = (secret: Uint8Array) => {
  const p = multiply(G, bytesToBigInt(secret))!;
  return createPublicKey({
    key: { kty: "EC", crv: "secp256k1", x: Buffer.from(bigIntToBytes(p.x)).toString("base64url"), y: Buffer.from(bigIntToBytes(p.y)).toString("base64url") },
    format: "jwk",
  });
};

// crypto.verify(null, ...) does not accept a raw digest for EC keys here, so verification goes through
// the "sha256" algorithm: we sign digest = sha256(msg) and node verifies msg, hashing it itself. The
// signer takes any 32-byte digest, so this checks the same ECDSA equation Bitcoin uses.
const verifies = (msg: Uint8Array, sig: Uint8Array, secret: Uint8Array): boolean =>
  verify("sha256", msg, { key: jwkKey(secret), dsaEncoding: "der" }, sig);

function strictDer(sig: Uint8Array): boolean {
  if (sig.length < 8 || sig.length > 72 || sig[0] !== 0x30 || sig[1] !== sig.length - 2 || sig[2] !== 2) return false;
  const lr = sig[3];
  if (5 + lr >= sig.length || sig[4 + lr] !== 2) return false;
  const ls = sig[5 + lr];
  if (lr + ls + 6 !== sig.length || lr === 0 || ls === 0) return false;
  if (sig[4] & 0x80 || (lr > 1 && sig[4] === 0 && !(sig[5] & 0x80))) return false;
  if (sig[6 + lr] & 0x80 || (ls > 1 && sig[6 + lr] === 0 && !(sig[7 + lr] & 0x80))) return false;
  return true;
}

test("ECDSA: signatures verify under node:crypto, are low-S, strict DER, and deterministic", () => {
  for (let i = 1; i <= 40; i++) {
    const secret = sha256(new TextEncoder().encode(`ecdsa-key-${i}`));
    const msg = new TextEncoder().encode(`ecdsa-message-${i}`);
    const digest = sha256(msg);
    const sig = ecdsaSign(digest, secret);
    assert.ok(verifies(msg, sig, secret), `signature ${i} verifies`);
    assert.ok(!verifies(digest, sig, secret), "wrong message fails");
    assert.ok(strictDer(sig), `strict DER ${i}`);
    const s = bytesToBigInt(sig.slice(6 + sig[3], 6 + sig[3] + sig[5 + sig[3]]));
    assert.ok(s <= N / 2n, "low-S");
    assert.equal(bytesToHex(ecdsaSign(digest, secret)), bytesToHex(sig), "deterministic");
  }
});

// ---------- HTLC ----------

const digest = sha256(new TextEncoder().encode("preimage"));
const claimPkh = hash160(compressedPubkey(sha256(new TextEncoder().encode("customer"))));
const refundPkh = hash160(compressedPubkey(sha256(new TextEncoder().encode("desk"))));
const htlc = (locktime: number): Htlc => ({ digest, claimPkh, refundPkh, locktime });

test("HTLC script: exact template and round trip across locktime encodings", () => {
  const s = htlcScript(htlc(900000));
  assert.equal(
    bytesToHex(s),
    `63a820${bytesToHex(digest)}8876a914${bytesToHex(claimPkh)}6703a0bb0db17576a914${bytesToHex(refundPkh)}6888ac`,
  );
  const encodings: Record<number, string> = { 1: "51", 16: "60", 17: "0111", 127: "017f", 128: "028000", 255: "02ff00", 256: "020001", 32767: "02ff7f", 32768: "03008000", 8388607: "03ffff7f", 8388608: "0400008000", 900000: "03a0bb0d", 499999999: "04ff64cd1d" };
  for (const [lt, push] of Object.entries(encodings)) {
    const script = htlcScript(htlc(Number(lt)));
    assert.equal(bytesToHex(script.slice(60, script.length - 28)), push, `push for ${lt}`);
    const parsed = parseHtlc(script);
    assert.ok(!("error" in parsed), `parse ${lt}`);
    if (!("error" in parsed)) {
      assert.equal(parsed.locktime, Number(lt));
      assert.deepEqual(parsed.digest, digest);
      assert.deepEqual(parsed.claimPkh, claimPkh);
      assert.deepEqual(parsed.refundPkh, refundPkh);
    }
  }
});

test("HTLC script: strict parser rejections", () => {
  const good = htlcScript(htlc(900000));
  const isError = (b: Uint8Array) => "error" in parseHtlc(b);
  assert.ok(!isError(good));
  // non-minimal locktime pushes: 1 as a 1-byte push, 17 padded, 16 as a push
  const withLock = (push: string) => new Uint8Array([...good.slice(0, 60), ...hex(push), ...good.slice(good.length - 28)]);
  assert.ok(isError(withLock("0101")), "1 must be OP_1");
  assert.ok(isError(withLock("0110")), "16 must be OP_16");
  assert.ok(isError(withLock("021100")), "17 padded with a zero byte");
  assert.ok(isError(withLock("03110000")), "padded zero high byte");
  assert.ok(isError(withLock("0400a10780")), "negative");
  assert.ok(isError(withLock("00")), "locktime 0 as OP_0");
  assert.ok(isError(withLock("0500f2052a01")), "five-byte push");
  assert.ok(isError(withLock("0400 65cd1d".replace(" ", ""))), "locktime 500,000,000");
  // changed opcode
  for (const idx of [0, 1, 2, 35, 36, 37, 38, 59, good.length - 1, good.length - 2]) {
    const bad = good.slice();
    bad[idx] ^= 0x01;
    assert.ok(isError(bad), `changed byte ${idx}`);
  }
  const swappedHash = good.slice();
  swappedHash[1] = 0xaa; // OP_HASH256 in place of OP_SHA256
  assert.ok(isError(swappedHash));
  const cltvToCsv = good.slice(); // OP_CHECKSEQUENCEVERIFY in place of OP_CHECKLOCKTIMEVERIFY
  cltvToCsv[good.length - 28] = 0xb2;
  assert.ok(isError(cltvToCsv));
  assert.ok(isError(new Uint8Array([...good, 0x00])), "trailing byte");
  assert.ok(isError(good.slice(0, good.length - 1)), "truncated");
  assert.ok(isError(good.slice(0, 40)), "short");
  assert.ok(isError(new Uint8Array(0)));
  assert.throws(() => htlcScript(htlc(0)));
  assert.throws(() => htlcScript(htlc(500_000_000)));
  assert.throws(() => htlcScript(htlc(1.5)));
});

test("claim and refund transaction sizes", () => {
  const customer = sha256(new TextEncoder().encode("customer"));
  const desk = sha256(new TextEncoder().encode("desk"));
  const preimage = sha256(new TextEncoder().encode("preimage"));
  const script = htlcScript(htlc(900000));
  const amount = 1_000_000n;
  const build = (locktime: number, sequence: number): Tx => ({
    version: 2,
    inputs: [{ txid: "11".repeat(32), vout: 0, sequence, witness: [] }],
    outputs: [{ value: amount - 300n, scriptPubKey: p2wpkhScriptPubKey(refundPkh) }],
    locktime,
  });
  const claim = build(0, 0xfffffffe);
  const csig = new Uint8Array([...ecdsaSign(bip143Sighash(claim, 0, script, amount), customer), 1]);
  claim.inputs[0].witness = claimWitness(csig, compressedPubkey(customer), preimage, script);
  const refund = build(900000, 0xfffffffe);
  const rsig = new Uint8Array([...ecdsaSign(bip143Sighash(refund, 0, script, amount), desk), 1]);
  refund.inputs[0].witness = refundWitness(rsig, compressedPubkey(desk), script);
  for (const tx of [claim, refund]) {
    assert.equal(vsize(tx), Math.ceil(weight(tx) / 4));
    assert.equal(weight(tx), serializeTx(tx, false).length * 3 + serializeTx(tx, true).length);
    assert.match(txid(tx), /^[0-9a-f]{64}$/);
  }
  // 41 bytes of non-witness input, 31-byte output, 10 bytes overhead = 82 non-witness bytes.
  assert.equal(serializeTx(claim, false).length, 82);
  assert.ok(vsize(claim) > vsize(refund), "the claim reveals a 32-byte preimage the refund does not");
  assert.ok(vsize(claim) - vsize(refund) >= 8 && vsize(claim) - vsize(refund) <= 9);
});
