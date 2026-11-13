// Checks the BIP 199 HTLC from src/tasks/swap/script.ts against Bitcoin Core on regtest: the P2WSH address
// must match Core's decodescript, and claim/refund transactions built and signed by our code must be
// accepted or rejected by Core's script interpreter as the contract intends.
//
//   node --experimental-strip-types scripts/swap_regtest.ts --rpc-url http://127.0.0.1:18643 \
//     --cookie <datadir>/regtest/.cookie --out results/v0-swap-htlc-regtest.json

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bytesToHex, hexToBytes } from "../src/tasks/nostr/secp256k1.ts";
import {
  bip143Sighash, claimWitness, compressedPubkey, ecdsaSign, hash160, htlcScript, p2wshScriptPubKey, refundWitness,
  segwitAddress, serializeTx, sha256, vsize, type Tx,
} from "../src/tasks/swap/script.ts";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}
const rpcUrl = arg("rpc-url");
const cookie = readFileSync(arg("cookie"), "utf8").trim();
const outPath = arg("out");
const auth = `Basic ${Buffer.from(cookie).toString("base64")}`;

async function rpc(method: string, params: unknown[] = [], wallet?: string): Promise<any> {
  const res = await fetch(wallet ? `${rpcUrl}/wallet/${wallet}` : rpcUrl, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "swap", method, params }),
  });
  const body = (await res.json()) as { result: unknown; error: { code: number; message: string } | null };
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code });
  return body.result;
}
const W = "swap";
const wallet = (method: string, params: unknown[] = []) => rpc(method, params, W);
const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = bytesToHex;

interface CaseResult {
  case: string;
  expected: "accepted" | "rejected";
  accepted: boolean;
  reject_reason: string | null;
  txid?: string;
  vsize_core?: number;
  vsize_ours?: number;
  confirmed?: boolean;
}

async function main() {
  const info = await rpc("getnetworkinfo");
  const chain = (await rpc("getblockchaininfo")).chain;
  if (chain !== "regtest") throw new Error(`refusing to run on chain ${chain}`);
  try {
    await rpc("createwallet", [W]);
  } catch {
    try {
      await rpc("loadwallet", [W]);
    } catch {
      /* already loaded */
    }
  }
  const mineTo = await wallet("getnewaddress");
  const mine = (n: number) => rpc("generatetoaddress", [n, mineTo]);
  if ((await rpc("getblockcount")) < 101) await mine(101);

  const customerKey = sha256(utf8("swap-regtest/customer"));
  const deskKey = sha256(utf8("swap-regtest/desk"));
  const customerPub = compressedPubkey(customerKey);
  const deskPub = compressedPubkey(deskKey);
  const preimage = sha256(utf8("swap-regtest/preimage"));
  const wrongPreimage = sha256(utf8("swap-regtest/wrong-preimage"));
  const tip0: number = await rpc("getblockcount");
  const locktime = tip0 + 10;
  const script = htlcScript({ digest: sha256(preimage), claimPkh: hash160(customerPub), refundPkh: hash160(deskPub), locktime });
  const address = segwitAddress("bcrt", 0, sha256(script));
  const decoded = await rpc("decodescript", [hex(script)]);
  const coreAddress: string = decoded.segwit.address;
  if (coreAddress !== address) throw new Error(`address mismatch: ours ${address}, Core ${coreAddress}`);
  if (hex(p2wshScriptPubKey(script)) !== decoded.segwit.hex) throw new Error("scriptPubKey mismatch");

  const AMOUNT = 1_000_000n;
  const fundTxids: string[] = [];
  for (let i = 0; i < 4; i++) fundTxids.push(await wallet("sendtoaddress", [address, 0.01]));
  await mine(1);
  const outpoints: { txid: string; vout: number }[] = [];
  for (const id of fundTxids) {
    const raw = await rpc("decoderawtransaction", [(await wallet("gettransaction", [id])).hex]);
    const out = raw.vout.find((o: any) => o.scriptPubKey.address === address);
    if (!out || Math.round(out.value * 1e8) !== Number(AMOUNT)) throw new Error("funding output not found");
    outpoints.push({ txid: id, vout: out.n });
  }

  const destSpk = hexToBytes((await wallet("getaddressinfo", [await wallet("getnewaddress")])).scriptPubKey);
  const build = (op: { txid: string; vout: number }, nLockTime: number): Tx => ({
    version: 2,
    inputs: [{ txid: op.txid, vout: op.vout, sequence: 0xfffffffe, witness: [] }],
    outputs: [{ value: AMOUNT - 300n, scriptPubKey: destSpk }],
    locktime: nLockTime,
  });
  const signed = (tx: Tx, key: Uint8Array) => new Uint8Array([...ecdsaSign(bip143Sighash(tx, 0, script, AMOUNT), key), 1]);

  const cases: CaseResult[] = [];
  async function attempt(name: string, expected: "accepted" | "rejected", tx: Tx): Promise<void> {
    const raw = hex(serializeTx(tx, true));
    const [res] = await rpc("testmempoolaccept", [[raw]]);
    const r: CaseResult = { case: name, expected, accepted: res.allowed === true, reject_reason: res.allowed ? null : String(res["reject-reason"]) };
    if (res.allowed) {
      r.txid = await rpc("sendrawtransaction", [raw]);
      r.vsize_core = (await rpc("decoderawtransaction", [raw])).vsize;
      r.vsize_ours = vsize(tx);
      await mine(1);
      r.confirmed = (await wallet("gettransaction", [r.txid])).confirmations >= 1;
    }
    cases.push(r);
  }

  const claim = build(outpoints[0], 0);
  claim.inputs[0].witness = claimWitness(signed(claim, customerKey), customerPub, preimage, script);
  await attempt("claim_right_preimage_customer_key", "accepted", claim);

  const wrong = build(outpoints[1], 0);
  wrong.inputs[0].witness = claimWitness(signed(wrong, customerKey), customerPub, wrongPreimage, script);
  await attempt("claim_wrong_preimage", "rejected", wrong);

  const deskClaim = build(outpoints[2], 0);
  deskClaim.inputs[0].witness = claimWitness(signed(deskClaim, deskKey), deskPub, preimage, script);
  await attempt("claim_branch_signed_by_desk_key", "rejected", deskClaim);

  const refund = build(outpoints[3], locktime);
  refund.inputs[0].witness = refundWitness(signed(refund, deskKey), deskPub, script);
  await attempt("refund_before_locktime", "rejected", refund);

  while ((await rpc("getblockcount")) < locktime) await mine(1);
  await attempt("refund_after_locktime", "accepted", refund);

  const all = cases.every((c) => (c.expected === "accepted") === c.accepted && (!c.accepted || (c.confirmed && c.vsize_core === c.vsize_ours)));
  const result = {
    core_subversion: info.subversion,
    chain,
    locktime,
    tip_at_end: await rpc("getblockcount"),
    script_hex: hex(script),
    address,
    core_decodescript_address: coreAddress,
    cases,
    all_as_expected: all,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${info.subversion} regtest ${address}: ${cases.map((c) => `${c.case}=${c.accepted ? "accepted" : "rejected"}`).join(", ")}; all_as_expected=${all}`);
  if (!all) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
