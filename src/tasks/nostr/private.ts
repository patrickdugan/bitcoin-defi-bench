// Family 9, cell `nostr/private` (docs/tasks.md §10.4): deliver private messages so that only the
// recipient can read them and relays learn as little as possible. Recipients are NIP-17-ready (a
// kind-10050 DM relay list), legacy (no kind 10050, but a history of kind-4 messages), or not ready
// (neither; NIP-17 says not to send). Delivery is computed: each recipient's simulated client reads
// its relays and opens what it finds with its own key.

import { accept, reject, type Agent, type Outcome, type StepResult } from "../../harness/agent.ts";
import { isObject, type Json } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";
import { nip19Decode } from "./bech32.ts";
import { makeRumor, verifyEvent, verifyRumor, type NostrEvent, type Rumor } from "./event.ts";
import { nip04Decrypt, nip04Encrypt } from "./nip04.ts";
import { CHAT_KIND, SEAL_KIND, WRAP_KIND, drawBytes, seal, unwrap, wrap } from "./nip59.ts";
import { bytesToHex, hexToBytes } from "./secp256k1.ts";
import { between, keypair, npub, relayUrl, sample, signedBy, Idle, NostrEnv, RelayNet, Signer, VERSION_TAG, type RelaySpec } from "./sim.ts";

export const PRIVATE_VERSION = "nostr-private-fixture/v0";
export const NOW = 1_790_000_000;

export interface PrivateConfig {
  relays: number;
  indexers: number;
  messages: number;
  recipient_ppm: { ready: number; legacy: number; not_ready: number };
  dm_relays_spec: [number, number];
  read_relays_per_user_spec: [number, number];
  auth_dm_relay_ppm: number;
  value_sats: [number, number];
  nip04_discount_ppm: number;
  budget: { attempts: number; probes: number };
}

export type RecipientType = "ready" | "legacy" | "not_ready";
export interface Recipient { name: string; pubkey: string; secret: string; type: RecipientType; read_relays: string[]; dm_relays: string[]; }
export interface PrivateMessage { id: string; to: string; name: string; text: string; value_sats: number; }

export interface PrivateFixture {
  version: string;
  seed: number;
  cell: "private";
  agent: { pubkey: string; secret: string };
  relays: RelaySpec[];
  recipients: Recipient[];
  initial: Array<{ relay: string; event: NostrEvent }>;
  messages: PrivateMessage[];
}

const NAMES = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi", "ivan", "judy"];
const TEXTS = ["Invoice for the quote: lnbcsim{n}n1 due by block 870{n}.", "The settlement price we agreed is {n} sats per contract.", "Meet the courier at gate {n}; bring the hardware wallet.", "Channel open confirmed, funding outpoint ends in {n}.", "Your share of the pool is {n} sats, payable Friday."];

export function generatePrivate(seed: number, config: PrivateConfig): PrivateFixture {
  const rng = (label: string): Stream => stream(VERSION_TAG, "private", seed, label);
  const me = keypair("private", seed, "agent");
  const r = rng("relays");
  const indexers = Array.from({ length: config.indexers }, (_, i) => relayUrl(i + 1));
  const relays: RelaySpec[] = [];
  for (let i = 1; i <= config.relays; i++) {
    const url = relayUrl(i);
    const indexer = i <= config.indexers;
    const write = indexer ? "open" : (r.int(1_000_000) < config.auth_dm_relay_ppm ? "auth" : "open");
    relays.push({ url, write, fee_sats: 0, kinds: indexer ? [0, 10002, 10050] : null, uptime_ppm: 1_000_000, users: between(r, 100, 5000), indexer });
  }
  const ordinary = relays.filter((x) => !x.indexer).map((x) => x.url);
  const u = rng("recipients");
  const names = sample(u, NAMES, config.messages);
  const recipients: Recipient[] = names.map((name, i) => {
    const kp = keypair("private", seed, "recipient", name);
    const draw = u.int(1_000_000);
    const type: RecipientType = draw < config.recipient_ppm.ready ? "ready" : draw < config.recipient_ppm.ready + config.recipient_ppm.legacy ? "legacy" : "not_ready";
    const read = sample(u, ordinary, between(u, config.read_relays_per_user_spec[0], config.read_relays_per_user_spec[1])).sort();
    const dm = type === "ready" ? sample(u, ordinary, between(u, config.dm_relays_spec[0], config.dm_relays_spec[1])).sort() : [];
    void i;
    return { name, pubkey: kp.pubkey, secret: kp.secret, type, read_relays: read, dm_relays: dm };
  });
  const initial: Array<{ relay: string; event: NostrEvent }> = [];
  const stranger = keypair("private", seed, "stranger");
  for (const rec of recipients) {
    const kp = { pubkey: rec.pubkey, secret: rec.secret };
    const list = signedBy(kp, { kind: 10002, content: "", tags: rec.read_relays.map((x) => ["r", x]), created_at: NOW - 86_400 }, "10002");
    for (const x of [...indexers, ...rec.read_relays]) initial.push({ relay: x, event: list });
    if (rec.type === "ready") {
      const dm = signedBy(kp, { kind: 10050, content: "", tags: rec.dm_relays.map((x) => ["relay", x]), created_at: NOW - 86_400 }, "10050");
      for (const x of [...indexers, ...rec.dm_relays]) initial.push({ relay: x, event: dm });
    }
    if (rec.type === "legacy") {
      const content = nip04Encrypt(hexToBytes(rec.secret), hexToBytes(stranger.pubkey), "see you at the meetup", drawBytes(stream(VERSION_TAG, "private", seed, "iv", rec.name), 16));
      const old = signedBy(kp, { kind: 4, content, tags: [["p", stranger.pubkey]], created_at: NOW - 3 * 86_400 }, "4");
      for (const x of rec.read_relays) initial.push({ relay: x, event: old });
    }
  }
  const t = rng("messages");
  const messages: PrivateMessage[] = recipients.map((rec, i) => ({
    id: `d${String(i + 1).padStart(2, "0")}`,
    to: rec.pubkey,
    name: rec.name,
    text: t.pick(TEXTS).replace(/\{n\}/g, String(between(t, 100, 999))),
    value_sats: between(t, config.value_sats[0], config.value_sats[1]),
  }));
  return { version: PRIVATE_VERSION, seed, cell: "private", agent: me, relays, recipients, initial, messages };
}

/** A pubkey given as hex or npub, as hex; null when it is neither. */
export function pubkeyArg(x: unknown): string | null {
  if (typeof x !== "string") return null;
  if (/^[0-9a-f]{64}$/.test(x)) return x;
  try { return bytesToHex(nip19Decode(x, "npub")); } catch { return null; }
}

export interface Delivery { nip17: boolean; nip04: boolean; exposed: boolean; }

/** What each recipient's client finds and can open, and whether any text went out in the clear. */
export function deliveries(f: PrivateFixture, net: RelayNet): Map<string, Delivery> {
  const out = new Map<string, Delivery>();
  const mine = net.written(f.agent.pubkey).map((x) => x.event);
  for (const m of f.messages) {
    const rec = f.recipients.find((x) => x.pubkey === m.to)!;
    const secret = hexToBytes(rec.secret);
    const exposed = mine.some((e) => e.content.includes(m.text));
    let nip17 = false;
    let nip04 = false;
    if (rec.type === "ready") {
      for (const url of rec.dm_relays) {
        for (const e of net.query(url, { kinds: [WRAP_KIND], "#p": [rec.pubkey] })) {
          try {
            const o = unwrap(e, secret);
            if (o.rumor.kind === CHAT_KIND && o.rumor.pubkey === f.agent.pubkey && o.rumor.content === m.text && o.rumor.tags.some((tg) => tg[0] === "p" && tg[1] === rec.pubkey)) nip17 = true;
          } catch { /* not for this client, or not openable: ignored as a client would */ }
        }
      }
    }
    if (rec.type !== "not_ready") {
      for (const url of rec.read_relays) {
        for (const e of net.query(url, { kinds: [4], authors: [f.agent.pubkey], "#p": [rec.pubkey] })) {
          try { if (nip04Decrypt(secret, hexToBytes(f.agent.pubkey), e.content) === m.text) nip04 = true; } catch { /* unreadable */ }
        }
      }
    }
    out.set(m.id, { nip17, nip04, exposed });
  }
  return out;
}

export class PrivateEnv extends NostrEnv {
  readonly task = "nostr/private";
  readonly seed: number;
  private readonly fixture: PrivateFixture;
  private readonly config: PrivateConfig;
  private readonly signer: Signer;
  private readonly net: RelayNet;
  private readonly rng: Stream;
  private writes = 0;
  protected readonly toolTable;

  constructor(fixture: PrivateFixture, config: PrivateConfig) {
    super({ attempts: config.budget.attempts, probes: config.budget.probes, blocks: 0, sats: 0 });
    this.fixture = fixture;
    this.config = config;
    this.seed = fixture.seed;
    this.signer = new Signer(fixture.agent.secret, "private", fixture.seed);
    this.net = new RelayNet(fixture.relays, fixture.initial);
    this.rng = stream(VERSION_TAG, "private", fixture.seed, "env");
    this.toolTable = {
      fetch: { cost: "probes" as const, handler: (a: Record<string, unknown>) => this.fetch(a) },
      rumor: { cost: "probes" as const, handler: (a: Record<string, unknown>) => this.rumor(a) },
      seal: { cost: "probes" as const, handler: (a: Record<string, unknown>) => this.seal(a) },
      wrap: { cost: "probes" as const, handler: (a: Record<string, unknown>) => this.wrap(a) },
      legacy_dm: { cost: "probes" as const, handler: (a: Record<string, unknown>) => this.legacy(a) },
      sign: { cost: "probes" as const, handler: (a: Record<string, unknown>) => this.sign(a) },
      auth: { cost: "attempts" as const, handler: (a: Record<string, unknown>) => this.auth(a) },
      publish: { cost: "free" as const, handler: (a: Record<string, unknown>) => this.publish(a) },
    };
  }

  private fetch(a: Record<string, unknown>): StepResult {
    if (typeof a.relay !== "string") return reject("malformed");
    if (!this.net.has(a.relay)) return reject("unknown_id");
    const authors = Array.isArray(a.authors) ? a.authors.map(pubkeyArg) : undefined;
    if (authors?.some((x) => x === null)) return reject("malformed");
    const kinds = Array.isArray(a.kinds) && a.kinds.every((k) => Number.isInteger(k)) ? (a.kinds as number[]) : undefined;
    if (a.kinds !== undefined && kinds === undefined) return reject("malformed");
    const events = this.net.query(a.relay, { ...(authors ? { authors: authors as string[] } : {}), ...(kinds ? { kinds } : {}) });
    return accept({ relay: a.relay, events: events.slice(0, 50) as unknown as Json });
  }

  private rumor(a: Record<string, unknown>): StepResult {
    if (!Number.isInteger(a.kind) || typeof a.content !== "string" || !Array.isArray(a.tags) || !a.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return reject("malformed");
    let r: Rumor;
    try { r = makeRumor(this.signer.pubkey, { kind: a.kind as number, content: a.content, tags: a.tags as string[][], created_at: Number.isInteger(a.created_at) ? (a.created_at as number) : NOW }); } catch { return reject("malformed"); }
    return accept({ handle: this.handles.put(r as unknown as Json), id: r.id });
  }

  private seal(a: Record<string, unknown>): StepResult {
    const to = pubkeyArg(a.to);
    if (!to) return reject("malformed");
    const r = typeof a.rumor === "string" ? this.handles.get(a.rumor) : a.rumor;
    if (r === undefined) return reject("unknown_handle");
    if (!verifyRumor(r) || "sig" in (r as object)) return reject("bad_event");
    let s: NostrEvent;
    try { s = seal(r, this.signer.key(), to, this.rng, NOW); } catch { return reject("bad_event"); }
    return accept({ handle: this.handles.put(s as unknown as Json), id: s.id });
  }

  private wrap(a: Record<string, unknown>): StepResult {
    const to = pubkeyArg(a.to);
    if (!to) return reject("malformed");
    const s = this.eventFrom(a.seal);
    if (typeof s === "string") return reject(s);
    if (s.kind !== SEAL_KIND) return reject("bad_event");
    const w = wrap(s, to, this.rng, NOW);
    return accept({ handle: this.handles.put(w as unknown as Json), id: w.id });
  }

  private legacy(a: Record<string, unknown>): StepResult {
    const to = pubkeyArg(a.to);
    if (!to || typeof a.text !== "string" || a.text.length === 0) return reject("malformed");
    let content: string;
    try { content = nip04Encrypt(this.signer.key(), hexToBytes(to), a.text, drawBytes(this.rng, 16)); } catch { return reject("malformed"); }
    const e = this.signer.sign({ kind: 4, content, tags: [["p", to]], created_at: NOW });
    return accept({ handle: this.handles.put(e as unknown as Json), id: e.id });
  }

  private sign(a: Record<string, unknown>): StepResult {
    const t = a.template;
    if (!isObject(t)) return reject("malformed");
    let e: NostrEvent;
    try { e = this.signer.sign({ kind: t.kind as number, content: t.content as string, tags: t.tags as string[][], created_at: Number.isInteger(t.created_at) ? (t.created_at as number) : NOW }); } catch { return reject("malformed"); }
    return accept({ handle: this.handles.put(e as unknown as Json), id: e.id });
  }

  private auth(a: Record<string, unknown>): StepResult {
    if (typeof a.relay !== "string") return reject("malformed");
    const spec = this.net.specs.get(a.relay);
    if (!spec) return reject("unknown_id");
    if (spec.write === "restricted") return reject("relay_refused", { message: "restricted: this relay admits paying users only" });
    this.net.admitted.add(a.relay);
    return accept({ relay: a.relay, authenticated: true });
  }

  /** One attempt per relay written; the whole call is rejected, at the cost of one attempt, if the event or a relay is bad. */
  private publish(a: Record<string, unknown>): StepResult {
    const e = this.eventFrom(a.event);
    const urls = a.relays;
    if (!Array.isArray(urls) || urls.length === 0 || !urls.every((x) => typeof x === "string")) { this.spendAttempt(); return reject("malformed"); }
    if (typeof e === "string") { this.spendAttempt(); return reject(e); }
    if (urls.some((x) => !this.net.has(x as string))) { this.spendAttempt(); return reject("unknown_id"); }
    const distinct = [...new Set(urls as string[])];
    if (distinct.length > this.attempts) { this.spendAttempt(); return reject("over_budget"); }
    const results = distinct.map((u) => this.net.publish(u, e));
    this.writes += distinct.length;
    for (let i = 0; i < distinct.length; i++) this.spendAttempt();
    return accept({ id: e.id, results: results as unknown as Json });
  }

  view(): Json {
    const f = this.fixture;
    return {
      me: { npub: npub(f.agent.pubkey), pubkey: f.agent.pubkey },
      now: NOW,
      relays: f.relays.map((r) => ({ url: r.url, write: r.write, kinds: r.kinds, indexer: r.indexer })) as unknown as Json,
      messages: f.messages.map((m) => ({ id: m.id, to: m.to, to_npub: npub(m.to), name: m.name, text: m.text, value_sats: m.value_sats })) as unknown as Json,
      nip04_discount_ppm: this.config.nip04_discount_ppm,
    };
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    const d = deliveries(this.fixture, this.net);
    let value = 0;
    const m = { nip17_delivered: 0, nip04_delivered: 0, exposed: 0, relay_writes: this.writes };
    for (const msg of this.fixture.messages) {
      const x = d.get(msg.id)!;
      if (x.nip17) { value += msg.value_sats; m.nip17_delivered += 1; }
      else if (x.nip04) { value += msg.value_sats - Math.round((msg.value_sats * this.config.nip04_discount_ppm) / 1_000_000); m.nip04_delivered += 1; }
      if (x.exposed) { value -= msg.value_sats; m.exposed += 1; }
    }
    return { value, metrics: m };
  }

  protected state(): Json { return { net: this.net.snapshot(), writes: this.writes }; }
  privileged(): Json { return {}; }
}

/** The best attainable: NIP-17 to the ready, NIP-04 to the legacy, nothing to the not ready. */
export function privateCeiling(f: PrivateFixture, config: PrivateConfig): number {
  let v = 0;
  for (const m of f.messages) {
    const rec = f.recipients.find((x) => x.pubkey === m.to)!;
    if (rec.type === "ready") v += m.value_sats;
    if (rec.type === "legacy") v += m.value_sats - Math.round((m.value_sats * config.nip04_discount_ppm) / 1_000_000);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// Baselines. Each first learns its recipients' relay lists, then works through a plan of actions,
// carrying handles from one result to the next.

interface PView { me: { pubkey: string }; relays: Array<{ url: string; write: string; kinds: number[] | null; indexer: boolean }>; messages: PrivateMessage[]; }
interface PLast { accepted: boolean; result: { handle?: string; events?: NostrEvent[] } | null; }
type Step = (h: string | undefined) => Json | null;

abstract class PlanAgent implements Agent {
  abstract readonly id: string;
  protected steps: Step[] = [];
  protected started = false;
  protected lists = new Map<string, { read: string[]; dm: string[] | null; legacy: boolean }>();
  private fetchQueue: Array<{ relay: string; filter: Json; onEvents: (e: NostrEvent[]) => void }> = [];
  private pendingFetch: ((e: NostrEvent[]) => void) | null = null;

  reset(e?: { seed: number }): void { this.steps = []; this.started = false; this.lists = new Map(); this.fetchQueue = []; this.pendingFetch = null; this.onReset(e?.seed ?? 0); }
  protected onReset(_seed: number): void {}
  protected abstract plan(view: PView): void;
  /** Whether the agent looks for kind-4 history; only those that use NIP-04 selectively need to. */
  protected readonly checksLegacy: boolean = false;

  act(o: Json): Json {
    const obs = o as unknown as { view: PView; last: PLast | null };
    if (this.pendingFetch) { const cb = this.pendingFetch; this.pendingFetch = null; cb(obs.last?.accepted ? (obs.last.result?.events ?? []) : []); }
    if (!this.started) { this.started = true; this.queueDiscovery(obs.view); }
    const f = this.fetchQueue.shift();
    if (f) { this.pendingFetch = f.onEvents; return { tool: "fetch", args: { relay: f.relay, ...(f.filter as object) } }; }
    if (this.steps.length === 0 && !this.planned) { this.planned = true; this.plan(obs.view); }
    let handle: string | undefined = obs.last?.accepted ? obs.last.result?.handle : undefined;
    while (this.steps.length > 0) {
      const next = this.steps.shift()!(handle);
      if (next !== null) return next;
      handle = undefined;
    }
    return { tool: "commit" };
  }
  private planned = false;

  private queueDiscovery(view: PView): void {
    this.planned = false;
    const indexer = view.relays.find((r) => r.indexer)!.url;
    const authors = view.messages.map((m) => m.to);
    for (const a of authors) this.lists.set(a, { read: [], dm: null, legacy: false });
    this.fetchQueue.push({ relay: indexer, filter: { authors, kinds: [10002, 10050] }, onEvents: (events) => {
      for (const e of events) {
        const l = this.lists.get(e.pubkey);
        if (!l) continue;
        if (e.kind === 10002) l.read = e.tags.filter((t) => t[0] === "r").map((t) => t[1]!);
        if (e.kind === 10050) l.dm = e.tags.filter((t) => t[0] === "relay").map((t) => t[1]!);
      }
      if (!this.checksLegacy) return;
      for (const a of authors) {
        const l = this.lists.get(a)!;
        if (l.dm !== null || l.read.length === 0) continue;
        this.fetchQueue.push({ relay: l.read[0]!, filter: { authors: [a], kinds: [4] }, onEvents: (ev) => { l.legacy = ev.length > 0; } });
      }
    } });
  }

  protected authIfNeeded(view: PView, relay: string, done: Set<string>): void {
    const spec = view.relays.find((r) => r.url === relay)!;
    if (spec.write === "auth" && !done.has(relay)) { done.add(relay); this.steps.push(() => ({ tool: "auth", args: { relay } })); }
  }

  protected sendNip17(view: PView, m: PrivateMessage, relay: string, authed: Set<string>): void {
    this.authIfNeeded(view, relay, authed);
    this.steps.push(() => ({ tool: "rumor", args: { kind: 14, content: m.text, tags: [["p", m.to]] } }));
    this.steps.push((h) => (h ? { tool: "seal", args: { rumor: h, to: m.to } } : null));
    this.steps.push((h) => (h ? { tool: "wrap", args: { seal: h, to: m.to } } : null));
    this.steps.push((h) => (h ? { tool: "publish", args: { event: h, relays: [relay] } } : null));
  }

  protected sendNip04(view: PView, m: PrivateMessage, relay: string, authed: Set<string>): void {
    this.authIfNeeded(view, relay, authed);
    this.steps.push(() => ({ tool: "legacy_dm", args: { to: m.to, text: m.text } }));
    this.steps.push((h) => (h ? { tool: "publish", args: { event: h, relays: [relay] } } : null));
  }

  protected sendPlain(view: PView, m: PrivateMessage, relay: string, authed: Set<string>): void {
    this.authIfNeeded(view, relay, authed);
    this.steps.push(() => ({ tool: "sign", args: { template: { kind: 1, content: `@${m.name} ${m.text}`, tags: [["p", m.to]] } } }));
    this.steps.push((h) => (h ? { tool: "publish", args: { event: h, relays: [relay] } } : null));
  }
}

/** A public note that mentions the recipient: delivered in the clear. */
export class PlaintextMention extends PlanAgent {
  readonly id = "plaintext_mention";
  protected plan(view: PView): void {
    const authed = new Set<string>();
    for (const m of view.messages) { const l = this.lists.get(m.to)!; if (l.read[0]) this.sendPlain(view, m, l.read[0], authed); }
  }
}

export class RandomPrivate extends PlanAgent {
  readonly id = "random";
  private rng: Stream = stream(VERSION_TAG, "baseline", "private", "random", 0);
  protected override onReset(seed: number): void { this.rng = stream(VERSION_TAG, "baseline", "private", "random", seed); }
  protected plan(view: PView): void {
    const authed = new Set<string>();
    for (const m of view.messages) {
      const l = this.lists.get(m.to)!;
      const pool = [...l.read, ...(l.dm ?? [])];
      if (pool.length === 0) continue;
      const relay = this.rng.pick(pool);
      const scheme = this.rng.int(3);
      if (scheme === 0) this.sendNip17(view, m, relay, authed);
      else if (scheme === 1) this.sendNip04(view, m, relay, authed);
      else this.sendPlain(view, m, relay, authed);
    }
  }
}

/** NIP-04 to everyone's first read relay. */
export class LegacyEverywhere extends PlanAgent {
  readonly id = "legacy_everywhere";
  protected plan(view: PView): void {
    const authed = new Set<string>();
    for (const m of view.messages) { const l = this.lists.get(m.to)!; if (l.read[0]) this.sendNip04(view, m, l.read[0], authed); }
  }
}

/** NIP-17 to the ready, NIP-04 to those with a kind-4 history, nothing to the rest. */
export class Nip17 extends PlanAgent {
  readonly id = "nip17";
  protected override readonly checksLegacy = true;
  protected plan(view: PView): void {
    const authed = new Set<string>();
    for (const m of view.messages) {
      const l = this.lists.get(m.to)!;
      if (l.dm && l.dm[0]) this.sendNip17(view, m, l.dm[0], authed);
      else if (l.legacy && l.read[0]) this.sendNip04(view, m, l.read[0], authed);
    }
  }
}

export const privateBaselines = (): Agent[] => [new Idle(), new PlaintextMention(), new RandomPrivate(), new LegacyEverywhere(), new Nip17()];
