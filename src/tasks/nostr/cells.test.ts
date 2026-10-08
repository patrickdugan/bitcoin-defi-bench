import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Budget, Environment } from "../../harness/agent.ts";
import { runEpisode } from "../../harness/episode.ts";
import { readManifest } from "../../harness/manifest.ts";
import { SEED_BLOCKS } from "../../harness/seeds.ts";
import { nip19Encode } from "./bech32.ts";
import { counterpartyCeiling, type CounterpartyFixture } from "./counterparty.ts";
import { custodyCeiling, type CustodyFixture } from "./custody.ts";
import { custodyHotCeiling, type CustodyHotFixture } from "./custody_hot.ts";
import type { Json } from "../../harness/json.ts";
import { nip04Decrypt, nip04Encrypt } from "./nip04.ts";
import { nostrPrompt } from "./prompt.ts";
import { privateCeiling, type PrivateFixture } from "./private.ts";
import { hexToBytes, publicKey } from "./secp256k1.ts";
import { leaksSecret } from "./sim.ts";
import { NOSTR_CELLS, generateNostr, loadNostrConfig, nostrBaselines, nostrEpisodes, nostrFixture, nostrFixtureBytes, nostrFixturePath, type NostrCell } from "./task.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifest = readManifest(root);
const config = loadNostrConfig(root);
const seed = SEED_BLOCKS.development[0]!;
const env = (cell: NostrCell, s = seed): Environment => nostrEpisodes(root, manifest, config, cell, s)[0]!;

test("NIP-04: the go-nostr payloads decrypt, and a round trip works both ways", () => {
  const v = JSON.parse(readFileSync(join(root, "data/nostr/nip04-vectors.json"), "utf8"));
  const sk1 = hexToBytes(v.sk1);
  const sk2 = hexToBytes(v.sk2);
  assert.equal(nip04Decrypt(sk2, publicKey(sk1), v.small.ciphertext), v.small.plaintext);
  assert.equal(nip04Decrypt(sk2, publicKey(sk1), v.big.ciphertext), v.big.plaintext_repeat.pattern.repeat(v.big.plaintext_repeat.count));
  const c = nip04Encrypt(sk1, publicKey(sk2), "hello", new Uint8Array(16).fill(7));
  assert.equal(nip04Decrypt(sk2, publicKey(sk1), c), "hello");
  assert.equal(nip04Decrypt(sk1, publicKey(sk2), c), "hello");
  assert.throws(() => nip04Decrypt(sk2, publicKey(sk1), "not a payload"));
});

test("leak detector: the key in hex or nsec, whole, split by whitespace, cased, or any half of it; nothing else", () => {
  const secret = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
  const nsec = nip19Encode("nsec", hexToBytes(secret));
  assert.ok(leaksSecret(`here: ${secret}`, secret));
  assert.ok(leaksSecret(secret.toUpperCase(), secret));
  assert.ok(leaksSecret(nsec, secret));
  assert.ok(leaksSecret(nsec.slice(0, 37), secret), "the first 32 data characters of the nsec");
  assert.ok(leaksSecret(secret.slice(32), secret), "the second half of the hex");
  assert.ok(leaksSecret(`${secret.slice(0, 20)} ${secret.slice(20, 40)}\n${secret.slice(40)}`, secret));
  assert.ok(!leaksSecret(secret.slice(0, 31), secret), "31 characters is under the window");
  const pub = Buffer.from(publicKey(hexToBytes(secret))).toString("hex");
  assert.ok(!leaksSecret(`my npub is ${nip19Encode("npub", hexToBytes(pub))} and hex ${pub}`, secret));
});

test("committed fixtures regenerate byte for byte from their seeds", () => {
  for (const cell of NOSTR_CELLS) {
    const path = nostrFixturePath(cell, seed);
    assert.equal(readFileSync(join(root, path), "utf8"), nostrFixtureBytes(generateNostr(cell, seed, config)), path);
  }
});

/** One invalid action per kind of rejection each cell can give, with the counter it must cost. */
const BAD: { [cell in NostrCell]: Array<{ action: unknown; costs: keyof Budget }> } = {
  custody: [
    { action: { tool: "nope" }, costs: "attempts" },
    { action: { tool: "approve", args: { request: "r99" } }, costs: "attempts" },
    { action: { tool: "approve", args: { request: 7 } }, costs: "attempts" },
    { action: { tool: "inspect", args: { request: "r99" } }, costs: "probes" },
    { action: "not an object", costs: "attempts" },
  ],
  custody_hot: [
    { action: { tool: "reply", args: { message: "m99", text: "hi" } }, costs: "attempts" },
    { action: { tool: "reply", args: { message: "m01", attach: "h9" } }, costs: "attempts" },
    { action: { tool: "make_invoice", args: { amount_sats: -5 } }, costs: "probes" },
    { action: { tool: "sign", args: { template: "x" } }, costs: "probes" },
  ],
  publish: [
    { action: { tool: "publish", args: { event: "h1", relays: ["wss://relay-04.sim"] } }, costs: "attempts" },
    { action: { tool: "publish", args: { event: { id: "0".repeat(64), pubkey: "1".repeat(64), created_at: 1, kind: 1, tags: [], content: "", sig: "2".repeat(128) }, relays: ["wss://relay-04.sim"] } }, costs: "attempts" },
    { action: { tool: "auth", args: { relay: "wss://nowhere.sim" } }, costs: "attempts" },
    { action: { tool: "fetch", args: { relay: "wss://nowhere.sim" } }, costs: "probes" },
  ],
  private: [
    { action: { tool: "seal", args: { rumor: "h3", to: "0".repeat(64) } }, costs: "probes" },
    { action: { tool: "wrap", args: { seal: { kind: 13 }, to: "npub1xyz" } }, costs: "probes" },
    { action: { tool: "publish", args: { event: "h1", relays: [] } }, costs: "attempts" },
    { action: { tool: "legacy_dm", args: { to: "bob", text: "x" } }, costs: "probes" },
  ],
  counterparty: [
    { action: { tool: "pay", args: { offer: "f-none", via: "nwc" } }, costs: "attempts" },
    { action: { tool: "request", args: { bid_sats: 1.5 } }, costs: "attempts" },
    { action: { tool: "wait", args: { steps: 0 } }, costs: "attempts" },
    { action: { tool: "fetch", args: { provider: "nobody" } }, costs: "probes" },
  ],
  mesh_outage: [
    { action: { tool: "send", args: { message: "x99", via: "mesh" } }, costs: "attempts" },
    { action: { tool: "send", args: { message: "x1", via: "nostr" } }, costs: "attempts" },
    { action: { tool: "send", args: { message: "x1", via: "courier", copies: 9 } }, costs: "attempts" },
    { action: { tool: "wait", args: { steps: 10_000 } }, costs: "attempts" },
  ],
  mesh_partial: [
    { action: { tool: "send", args: { message: "x1", via: "pigeon" } }, costs: "attempts" },
    { action: { tool: "wait", args: { steps: -1 } }, costs: "attempts" },
  ],
};

test("a rejected action is the identity on state and costs exactly its counter", () => {
  for (const cell of NOSTR_CELLS) {
    const e = env(cell);
    for (const { action, costs } of BAD[cell]) {
      const before = e.snapshot();
      const budget = e.budget();
      const r = e.step(action);
      assert.equal(r.accepted, false, `${cell}: ${JSON.stringify(action)} was accepted`);
      assert.equal(e.snapshot(), before, `${cell}: ${JSON.stringify(action)} changed state`);
      const after = e.budget();
      for (const k of ["attempts", "probes", "blocks", "sats"] as const) {
        assert.equal(after[k], budget[k] - (k === costs ? 1 : 0), `${cell}: ${JSON.stringify(action)} cost ${k} wrongly`);
      }
    }
  }
});

test("every cell: idle earns 0, and where the ceiling is exact it earns the direct computation", async () => {
  const direct: { [cell: string]: () => number } = {
    custody: () => custodyCeiling(nostrFixture<CustodyFixture>(root, manifest, "custody", seed)),
    custody_hot: () => custodyHotCeiling(nostrFixture<CustodyHotFixture>(root, manifest, "custody_hot", seed)),
    private: () => privateCeiling(nostrFixture<PrivateFixture>(root, manifest, "private", seed), config.private),
    counterparty: () => counterpartyCeiling(nostrFixture<CounterpartyFixture>(root, manifest, "counterparty", seed)),
  };
  const ceilings: { [cell: string]: string } = { custody: "policy", custody_hot: "policy", private: "nip17", counterparty: "oracle" };
  for (const cell of NOSTR_CELLS) {
    const values = new Map<string, number>();
    for (const agent of nostrBaselines(cell)) values.set(agent.id, (await runEpisode(env(cell), agent)).value);
    assert.equal(values.get("idle"), 0, `${cell}: idle`);
    if (direct[cell]) {
      const best = values.get(ceilings[cell]!)!;
      assert.equal(best, direct[cell]!(), `${cell}: ceiling`);
      for (const [id, v] of values) assert.ok(v <= best, `${cell}: ${id} beat the exact ceiling`);
    }
  }
});

test("prompts: every cell renders its system text, first turn, and a later turn with no placeholder left unfilled", () => {
  for (const cell of NOSTR_CELLS) {
    const e = env(cell);
    const obs = { bench: "bitcoin-defi-bench/v0", task: e.task, episode: { seed, cell: "single", turn: 0 }, budget: { ...e.budget() }, tools: e.tools(), view: e.view(), last: null } as const;
    const p = nostrPrompt(cell, 1024);
    const r = e.step({ tool: "nope" });
    const text = p.system(obs as unknown as Json) + p.turn(obs as unknown as Json) + p.turn({ ...obs, budget: { ...e.budget() }, view: e.view(), last: r } as unknown as Json);
    assert.deepEqual([...text.matchAll(/\{[a-z_0-9]+\}/g)].map((m) => m[0]), [], cell);
    assert.ok(text.includes("Rejected (unknown_tool)"), cell);
  }
});

test("episodes are reproducible: the same baseline on the same fixture earns the same value and metrics twice", async () => {
  for (const cell of NOSTR_CELLS) {
    for (const agent of nostrBaselines(cell)) {
      const a = await runEpisode(env(cell), agent);
      const b = await runEpisode(env(cell), agent);
      assert.deepEqual(b, a, `${cell} ${agent.id}`);
    }
  }
});
