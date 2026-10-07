// Fee-market sampler for family 8 (docs/tasks.md §9.1): the RPC sampling methodology.
//
//   node --experimental-strip-types scripts/sample_fees.ts --rpc http://127.0.0.1:8332 \
//     --cookie ~/.bitcoin/.cookie --interval 60 --hours 168 --out data/fees/<network>-<start>.jsonl
//
// Polls a Bitcoin Core node you run, over its JSON-RPC on the loopback interface, and appends one
// record per interval and one per new block. Nothing is sent to any other host; the node's
// credentials are read from its cookie file (or --user/--pass) and never written anywhere. The
// output is a data file, not a run: the bench reads a finished, hash-bound copy of it.
//
// Per interval: estimatesmartfee at the targets below (conservative mode), getmempoolinfo.
// Per new block: getblockstats with fee-rate percentiles and the block's size and count, so the
// series carries what actually confirmed and not only what the estimator said.
// The finished file's provenance (network, node version, interval, span) goes in its first line.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback === undefined) throw new Error(`missing --${name}`);
  return fallback;
};
const rpcUrl = new URL(arg("rpc", "http://127.0.0.1:8332"));
if (!["127.0.0.1", "localhost", "[::1]"].includes(rpcUrl.hostname)) throw new Error("the sampler talks to a loopback node only");
const auth = process.argv.includes("--cookie")
  ? readFileSync(arg("cookie"), "utf8").trim()
  : `${arg("user")}:${arg("pass")}`;
const intervalSeconds = Number(arg("interval", "60"));
const hours = Number(arg("hours", "168"));
const targets = [1, 2, 3, 6, 12, 24, 144];
const out = arg("out");

function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "1.0", id: method, method, params });
  return new Promise((resolve, reject) => {
    const req = request(rpcUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(auth).toString("base64")}`, "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result: unknown; error: { message: string } | null };
          if (data.error) reject(new Error(`${method}: ${data.error.message}`)); else resolve(data.result);
        } catch (e) { reject(e as Error); }
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`${method}: timeout`)));
    req.on("error", reject);
    req.end(body);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const chain = (await rpc("getblockchaininfo")) as { chain: string; blocks: number };
const net = (await rpc("getnetworkinfo")) as { version: number; subversion: string };
const started = new Date().toISOString();
if (!existsSync(out)) {
  writeFileSync(out, `${JSON.stringify({ kind: "fee-sample-provenance/v0", network: chain.chain, node: net.subversion, node_version: net.version, interval_seconds: intervalSeconds, targets, started })}\n`);
}
let lastHeight = chain.blocks;
const deadline = Date.now() + hours * 3600 * 1000;
console.error(`sampling ${chain.chain} via ${net.subversion} every ${intervalSeconds}s for ${hours}h into ${out}`);
while (Date.now() < deadline) {
  const t = new Date().toISOString();
  const estimates: { [target: string]: number | null } = {};
  for (const target of targets) {
    const e = (await rpc("estimatesmartfee", [target, "CONSERVATIVE"])) as { feerate?: number };
    estimates[String(target)] = e.feerate === undefined ? null : Math.round(e.feerate * 1e8 / 1000 * 100) / 100; // BTC/kvB → sat/vB
  }
  const mempool = (await rpc("getmempoolinfo")) as { size: number; bytes: number; mempoolminfee: number };
  appendFileSync(out, `${JSON.stringify({ kind: "tick", t, estimates_sat_vb: estimates, mempool_txs: mempool.size, mempool_vbytes: mempool.bytes, mempool_min_sat_vb: Math.round(mempool.mempoolminfee * 1e8 / 1000 * 100) / 100 })}\n`);
  const info = (await rpc("getblockchaininfo")) as { blocks: number };
  for (let h = lastHeight + 1; h <= info.blocks; h++) {
    const s = (await rpc("getblockstats", [h, ["height", "time", "feerate_percentiles", "avgfeerate", "minfeerate", "maxfeerate", "txs", "total_weight"]])) as Record<string, unknown>;
    appendFileSync(out, `${JSON.stringify({ kind: "block", t, ...s })}\n`);
  }
  lastHeight = info.blocks;
  await sleep(intervalSeconds * 1000);
}
console.error("done");
