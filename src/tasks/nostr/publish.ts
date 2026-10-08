// Family 9, cell `nostr/publish` (docs/tasks.md §10.3): get three notes in front of the agent's
// followers and the counterparties they mention, under a budget of relay writes. Outbox-aware
// followers read the write relays named in the agent's kind-10002 list (NIP-65); legacy followers
// read only their own read relays; a mentioned user reads mentions on its own read relays. Relays
// refuse (NIP-42 auth, a paid allowlist, kinds they do not store), and some are down when readers
// look, which only the privileged ceiling knows.

import { accept, reject, type Agent, type Outcome, type StepResult } from "../../harness/agent.ts";
import { isObject, type Json } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";
import type { NostrEvent } from "./event.ts";
import { between, keypair, newest, npub, relayUrl, relaysOf, sample, signedBy, Idle, NostrEnv, RelayNet, Signer, VERSION_TAG, type RelaySpec } from "./sim.ts";

export const PUBLISH_VERSION = "nostr-publish-fixture/v0";
export const NOW = 1_790_000_000;

export interface PublishConfig {
  relays: number;
  indexers: number;
  write_policy_ppm: { open: number; auth: number; restricted: number };
  restricted_fee_sats: [number, number];
  uptime_ppm: [number, number];
  followers: number;
  outbox_follower_ppm: number;
  mentions: number;
  notes: number;
  read_relays_per_user_spec: [number, number];
  value_per_follower_sats: number;
  value_per_mention_sats: number;
  budget: { attempts: number; probes: number; sats: number };
}

export interface Reader { pubkey: string; outbox: boolean; read_relays: string[]; }
export interface NoteTemplate { id: string; content: string; tags: string[][]; }

export interface PublishFixture {
  version: string;
  seed: number;
  cell: "publish";
  agent: { pubkey: string; secret: string };
  relays: RelaySpec[];
  /** Hidden: relays that are down when readers look. */
  down_at_read: string[];
  followers: Reader[];
  mentions: Reader[];
  notes: NoteTemplate[];
  initial: Array<{ relay: string; event: NostrEvent }>;
}

export function generatePublish(seed: number, config: PublishConfig): PublishFixture {
  const rng = (label: string): Stream => stream(VERSION_TAG, "publish", seed, label);
  const me = keypair("publish", seed, "agent");
  const r = rng("relays");
  const relays: RelaySpec[] = [];
  const weight = new Map<string, number>();
  for (let i = 1; i <= config.relays; i++) {
    const url = relayUrl(i);
    const indexer = i <= config.indexers;
    const draw = r.int(1_000_000);
    const write = indexer ? "open" : draw < config.write_policy_ppm.open ? "open" : draw < config.write_policy_ppm.open + config.write_policy_ppm.auth ? "auth" : "restricted";
    const uptime = between(r, config.uptime_ppm[0], config.uptime_ppm[1]);
    weight.set(url, 1 + r.int(10));
    relays.push({ url, write, fee_sats: write === "restricted" ? between(r, config.restricted_fee_sats[0], config.restricted_fee_sats[1]) : 0, kinds: indexer ? [0, 3, 10002, 10050] : null, uptime_ppm: uptime, users: 0, indexer });
  }
  const down = rng("down");
  const downAtRead = relays.filter((x) => down.int(1_000_000) >= x.uptime_ppm).map((x) => x.url);
  const ordinary = relays.filter((x) => !x.indexer).map((x) => x.url);
  const u = rng("users");
  const pickRelays = (): string[] => {
    const k = between(u, config.read_relays_per_user_spec[0], config.read_relays_per_user_spec[1]);
    const chosen: string[] = [];
    while (chosen.length < k) {
      const total = ordinary.filter((x) => !chosen.includes(x)).reduce((a, x) => a + weight.get(x)!, 0);
      let t = u.int(total);
      for (const x of ordinary) {
        if (chosen.includes(x)) continue;
        t -= weight.get(x)!;
        if (t < 0) { chosen.push(x); break; }
      }
    }
    return chosen.sort();
  };
  const followers: Reader[] = Array.from({ length: config.followers }, (_, i) => ({ pubkey: keypair("publish", seed, "follower", i).pubkey, outbox: u.int(1_000_000) < config.outbox_follower_ppm, read_relays: pickRelays() }));
  const mentionKeys = Array.from({ length: config.mentions }, (_, i) => keypair("publish", seed, "mention", i));
  const mentions: Reader[] = mentionKeys.map((kp) => ({ pubkey: kp.pubkey, outbox: true, read_relays: pickRelays() }));
  for (const x of relays) x.users = [...followers, ...mentions].filter((f) => f.read_relays.includes(x.url)).length * 25 + between(u, 0, 40);
  const initial: Array<{ relay: string; event: NostrEvent }> = [];
  const indexers = relays.filter((x) => x.indexer).map((x) => x.url);
  mentionKeys.forEach((kp, i) => {
    const e = signedBy(kp, { kind: 10002, content: "", tags: mentions[i]!.read_relays.map((x) => ["r", x, "read"]), created_at: NOW - 86_400 }, "10002");
    for (const x of [...indexers, ...mentions[i]!.read_relays]) initial.push({ relay: x, event: e });
  });
  // Followers' lists are on the indexers too, so an agent can see where its legacy followers read.
  followers.forEach((f, i) => {
    const kp = keypair("publish", seed, "follower", i);
    const e = signedBy(kp, { kind: 10002, content: "", tags: f.read_relays.map((x) => ["r", x, "read"]), created_at: NOW - 86_400 }, "10002");
    for (const x of indexers) initial.push({ relay: x, event: e });
  });
  const n = rng("notes");
  const notes: NoteTemplate[] = Array.from({ length: config.notes }, (_, i) => {
    const tagged = sample(n, mentions.map((m) => m.pubkey), between(n, 0, 3)).sort();
    return { id: `n${i + 1}`, content: `Offer ${i + 1}: selling inbound liquidity at ${between(n, 200, 900)} ppm, DM for terms.`, tags: tagged.map((p) => ["p", p]) };
  });
  return { version: PUBLISH_VERSION, seed, cell: "publish", agent: me, relays, down_at_read: downAtRead, followers, mentions, notes, initial };
}

/** Where the agent's events sit: each note's placements (with the p tags each copy carries) and each copy of its relay list. */
export interface Placement {
  lists: Array<{ relay: string; created_at: number; id: string; write: string[] }>;
  notes: Map<string, Array<{ relay: string; tagged: Set<string> }>>;
}

export function placementOf(f: PublishFixture, events: ReadonlyArray<{ relay: string; event: NostrEvent }>): Placement {
  const p: Placement = { lists: [], notes: new Map(f.notes.map((n) => [n.id, []])) };
  for (const { relay, event } of events) {
    if (event.pubkey !== f.agent.pubkey) continue;
    if (event.kind === 10002) p.lists.push({ relay, created_at: event.created_at, id: event.id, write: relaysOf(event, "write") });
    if (event.kind === 1) {
      const note = f.notes.find((x) => x.content === event.content);
      if (note) p.notes.get(note.id)!.push({ relay, tagged: new Set(event.tags.filter((t) => t[0] === "p").map((t) => t[1]!)) });
    }
  }
  return p;
}

/** The value of a placement in sats, before fees, given which relays are up when readers look. */
export function reachValue(f: PublishFixture, config: PublishConfig, p: Placement, up: (relay: string) => boolean): { value: number; followers: number; mentions: number } {
  const indexers = new Set(f.relays.filter((x) => x.indexer).map((x) => x.url));
  let followersReached = 0;
  let mentionsReached = 0;
  for (const note of f.notes) {
    const copies = p.notes.get(note.id)!.filter((c) => up(c.relay));
    if (copies.length === 0) continue;
    const at = new Set(copies.map((c) => c.relay));
    for (const fol of f.followers) {
      let sources: string[];
      if (fol.outbox) {
        const visible = p.lists.filter((l) => up(l.relay) && (indexers.has(l.relay) || fol.read_relays.includes(l.relay)));
        let best: (typeof visible)[number] | null = null;
        for (const l of visible) if (!best || l.created_at > best.created_at || (l.created_at === best.created_at && l.id < best.id)) best = l;
        sources = best ? best.write : [];
      } else sources = fol.read_relays;
      if (sources.some((s) => at.has(s))) followersReached += 1;
    }
    for (const tag of note.tags) {
      const m = f.mentions.find((x) => x.pubkey === tag[1]);
      if (m && copies.some((c) => c.tagged.has(m.pubkey) && m.read_relays.includes(c.relay))) mentionsReached += 1;
    }
  }
  return { value: followersReached * config.value_per_follower_sats + mentionsReached * config.value_per_mention_sats, followers: followersReached, mentions: mentionsReached };
}

export class PublishEnv extends NostrEnv {
  readonly task = "nostr/publish";
  readonly seed: number;
  private readonly fixture: PublishFixture;
  private readonly config: PublishConfig;
  private readonly signer: Signer;
  private readonly net: RelayNet;
  private fees = 0;
  private writes = 0;
  protected readonly toolTable;

  constructor(fixture: PublishFixture, config: PublishConfig) {
    super({ attempts: config.budget.attempts, probes: config.budget.probes, blocks: 0, sats: config.budget.sats });
    this.fixture = fixture;
    this.config = config;
    this.seed = fixture.seed;
    this.signer = new Signer(fixture.agent.secret, "publish", fixture.seed);
    this.net = new RelayNet(fixture.relays, fixture.initial);
    this.toolTable = {
      fetch: { cost: "probes" as const, handler: (a: Record<string, unknown>) => this.fetch(a) },
      sign: { cost: "probes" as const, handler: (a: Record<string, unknown>) => this.sign(a) },
      auth: { cost: "attempts" as const, handler: (a: Record<string, unknown>) => this.auth(a) },
      publish: { cost: "free" as const, handler: (a: Record<string, unknown>) => this.publish(a) },
    };
  }

  private fetch(a: Record<string, unknown>): StepResult {
    if (typeof a.relay !== "string") return reject("malformed");
    if (!this.net.has(a.relay)) return reject("unknown_id");
    const authors = Array.isArray(a.authors) && a.authors.every((x) => typeof x === "string") ? (a.authors as string[]) : undefined;
    const kinds = Array.isArray(a.kinds) && a.kinds.every((k) => Number.isInteger(k)) ? (a.kinds as number[]) : undefined;
    if ((a.authors !== undefined && !authors) || (a.kinds !== undefined && !kinds)) return reject("malformed");
    const events = this.net.query(a.relay, { ...(authors ? { authors } : {}), ...(kinds ? { kinds } : {}) });
    return accept({ relay: a.relay, events: events.slice(0, 100) as unknown as Json });
  }

  private sign(a: Record<string, unknown>): StepResult {
    const t = a.template;
    if (!isObject(t)) return reject("malformed");
    let e: NostrEvent;
    try { e = this.signer.sign({ kind: t.kind as number, content: t.content as string, tags: t.tags as string[][], created_at: Number.isInteger(t.created_at) ? (t.created_at as number) : NOW }); } catch { return reject("malformed"); }
    return accept({ handle: this.handles.put(e as unknown as Json), id: e.id });
  }

  /** NIP-42. A restricted relay admits after its fee is paid from the sats budget. */
  private auth(a: Record<string, unknown>): StepResult {
    if (typeof a.relay !== "string") return reject("malformed");
    const spec = this.net.specs.get(a.relay);
    if (!spec) return reject("unknown_id");
    if (this.net.admitted.has(a.relay)) return reject("duplicate");
    if (spec.write === "restricted") {
      if (spec.fee_sats > this.sats) return reject("over_budget");
      this.sats -= spec.fee_sats;
      this.fees += spec.fee_sats;
    }
    this.net.admitted.add(a.relay);
    return accept({ relay: a.relay, authenticated: true, fee_sats: spec.write === "restricted" ? spec.fee_sats : 0 });
  }

  private publish(a: Record<string, unknown>): StepResult {
    const e = this.eventFrom(a.event);
    const urls = a.relays;
    if (!Array.isArray(urls) || urls.length === 0 || !urls.every((x) => typeof x === "string")) { this.spendAttempt(); return reject("malformed"); }
    if (typeof e === "string") { this.spendAttempt(); return reject(e); }
    if (e.pubkey !== this.signer.pubkey) { this.spendAttempt(); return reject("bad_event"); }
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
      relays: f.relays.map((r) => ({ url: r.url, write: r.write, fee_sats: r.fee_sats, kinds: r.kinds, uptime_ppm: r.uptime_ppm, users: r.users, indexer: r.indexer })) as unknown as Json,
      followers: f.followers.map((x) => x.pubkey),
      notes: f.notes as unknown as Json,
      value: { per_follower_sats: this.config.value_per_follower_sats, per_mention_sats: this.config.value_per_mention_sats },
    };
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    const down = new Set(this.fixture.down_at_read);
    const reach = reachValue(this.fixture, this.config, placementOf(this.fixture, this.net.written(this.fixture.agent.pubkey)), (r) => !down.has(r));
    return { value: reach.value - this.fees, metrics: { followers_reached: reach.followers, mentions_reached: reach.mentions, fees_sats: this.fees, relay_writes: this.writes } };
  }

  protected state(): Json { return { net: this.net.snapshot(), fees: this.fees, writes: this.writes }; }
  privileged(): Json { return { down_at_read: this.fixture.down_at_read, outbox_followers: this.fixture.followers.filter((f) => f.outbox).map((f) => f.pubkey) }; }
}

// ---------------------------------------------------------------------------------------------
// Baselines. A plan is a list of (event, relays) writes plus the relays to authenticate to; the
// agent signs the four events, authenticates, then writes, carrying handles between turns.

interface PubView {
  me: { pubkey: string };
  relays: Array<{ url: string; write: string; fee_sats: number; kinds: number[] | null; uptime_ppm: number; users: number; indexer: boolean }>;
  followers: string[];
  notes: NoteTemplate[];
  value: { per_follower_sats: number; per_mention_sats: number };
}
interface PubLast { accepted: boolean; result: { handle?: string; events?: NostrEvent[] } | null; }
interface PubBudget { attempts: number; sats: number; }

/** "list" is the agent's kind 10002 naming `write` as its write relays. */
export interface PublishPlan { auth: string[]; write: string[]; writes: Array<{ event: "list" | string; relays: string[] }>; }

abstract class PublishAgent implements Agent {
  abstract readonly id: string;
  private queue: Array<(last: PubLast | null) => Json | null> = [];
  private started = false;
  private readonly handles = new Map<string, string>();
  protected lists = new Map<string, string[]>();
  protected readonly fetchesLists: boolean = false;
  private budget: PubBudget = { attempts: 0, sats: 0 };
  reset(e?: { seed: number }, privileged?: Json): void { this.queue = []; this.started = false; this.handles.clear(); this.lists = new Map(); this.onReset(e?.seed ?? 0, privileged); }
  protected onReset(_seed: number, _privileged?: Json): void {}
  protected abstract plan(view: PubView, budget: PubBudget): PublishPlan;

  act(o: Json): Json {
    const obs = o as unknown as { view: PubView; budget: PubBudget; last: PubLast | null };
    if (!this.started) {
      this.started = true;
      this.budget = { attempts: obs.budget.attempts, sats: obs.budget.sats };
      const v = obs.view;
      const indexer = v.relays.filter((r) => r.indexer).sort((a, b) => b.uptime_ppm - a.uptime_ppm)[0]!.url;
      if (this.fetchesLists) {
        const authors = [...v.followers, ...new Set(v.notes.flatMap((n) => n.tags.map((t) => t[1]!)))];
        this.queue.push(() => ({ tool: "fetch", args: { relay: indexer, authors, kinds: [10002] } }));
        this.queue.push((last) => { for (const e of last?.result?.events ?? []) this.lists.set(e.pubkey, relaysOf(e, "read")); return null; });
      }
      this.queue.push(() => { this.build(v); return null; });
    }
    while (this.queue.length > 0) {
      const next = this.queue.shift()!(obs.last);
      if (next !== null) return next;
    }
    return { tool: "commit" };
  }

  private build(v: PubView): void {
    const p = this.plan(v, this.budget);
    const events: Array<{ key: string; template: Json }> = [
      { key: "list", template: { kind: 10002, content: "", tags: p.write.map((r) => ["r", r]), created_at: NOW } },
      ...v.notes.map((n) => ({ key: n.id, template: { kind: 1, content: n.content, tags: n.tags, created_at: NOW } as Json })),
    ].filter((x) => p.writes.some((w) => w.event === x.key));
    for (const x of events) {
      this.queue.push(() => ({ tool: "sign", args: { template: x.template } }));
      this.queue.push((last) => { if (last?.accepted && last.result?.handle) this.handles.set(x.key, last.result.handle); return null; });
    }
    for (const r of p.auth) this.queue.push(() => ({ tool: "auth", args: { relay: r } }));
    for (const w of p.writes) this.queue.push(() => (this.handles.has(w.event) && w.relays.length > 0 ? { tool: "publish", args: { event: this.handles.get(w.event)!, relays: w.relays } } : null));
  }
}

/** Trim a plan's writes, in order, to the attempts and sats it can afford, authenticating where a relay needs it. */
function fit(v: PubView, p: PublishPlan, { attempts, sats }: PubBudget): PublishPlan {
  let left = attempts;
  const auth: string[] = [];
  const writes: PublishPlan["writes"] = [];
  let money = sats;
  for (const w of p.writes) {
    const relays: string[] = [];
    for (const r of w.relays) {
      const spec = v.relays.find((x) => x.url === r)!;
      const needsAuth = spec.write !== "open" && !auth.includes(r);
      const cost = 1 + (needsAuth ? 1 : 0);
      if (cost > left || (needsAuth && spec.write === "restricted" && spec.fee_sats > money)) continue;
      if (needsAuth) { auth.push(r); if (spec.write === "restricted") money -= spec.fee_sats; }
      left -= cost;
      relays.push(r);
    }
    writes.push({ event: w.event, relays });
  }
  return { auth, write: p.write, writes };
}

export class RandomPublish extends PublishAgent {
  readonly id = "random";
  private rng: Stream = stream(VERSION_TAG, "baseline", "publish", "random", 0);
  protected override onReset(seed: number): void { this.rng = stream(VERSION_TAG, "baseline", "publish", "random", seed); }
  protected plan(v: PubView): PublishPlan {
    const urls = v.relays.map((r) => r.url);
    const write = sample(this.rng, urls.filter((u) => !v.relays.find((r) => r.url === u)!.indexer), 2).sort();
    const writes = [{ event: "list", relays: sample(this.rng, urls, 4).sort() }, ...v.notes.map((n) => ({ event: n.id, relays: sample(this.rng, urls, 4).sort() }))];
    return { auth: [], write, writes };
  }
}

/** The most-used relays, with no lookups: what many clients do. */
export class Popular extends PublishAgent {
  readonly id = "popular";
  protected plan(v: PubView, budget: PubBudget): PublishPlan {
    const usable = v.relays.filter((r) => !r.indexer && r.write !== "restricted").sort((a, b) => b.users - a.users || (a.url < b.url ? -1 : 1));
    const write = usable.slice(0, 3).map((r) => r.url);
    const indexer = v.relays.filter((r) => r.indexer).sort((a, b) => b.uptime_ppm - a.uptime_ppm)[0]!.url;
    return fit(v, { auth: [], write, writes: [{ event: "list", relays: [...write, indexer] }, ...v.notes.map((n) => ({ event: n.id, relays: write }))] }, budget);
  }
}

/** NIP-65 as written: own write relays, each tagged user's read relays, the list wherever it goes plus the indexers. */
export class Outbox extends PublishAgent {
  readonly id = "outbox";
  protected override readonly fetchesLists = true;
  protected plan(v: PubView, budget: PubBudget): PublishPlan {
    const usable = v.relays.filter((r) => !r.indexer && r.write !== "restricted").sort((a, b) => b.uptime_ppm - a.uptime_ppm || (a.url < b.url ? -1 : 1));
    const write = usable.slice(0, 2).map((r) => r.url);
    const indexers = v.relays.filter((r) => r.indexer).map((r) => r.url);
    const writes: PublishPlan["writes"] = [{ event: "list", relays: [...write, ...indexers] }];
    for (const n of v.notes) writes.push({ event: n.id, relays: write });
    for (const n of v.notes) {
      const extra = [...new Set(n.tags.flatMap((t) => this.lists.get(t[1]!) ?? []))].filter((r) => !write.includes(r) && v.relays.find((x) => x.url === r)!.write !== "restricted").sort();
      writes.push({ event: n.id, relays: extra });
    }
    return fit(v, { auth: [], write, writes }, budget);
  }
}

/**
 * Ceiling, privileged: knows which relays will be down and which followers' clients follow the
 * outbox model. Tries every write set of one to three up relays, places the list on the best up
 * indexer, spends what is left greedily on copies that reach legacy followers and mentions, and
 * keeps the plan the cell's own scoring rates highest. A reference, not a proven bound.
 */
export class MaxReach extends PublishAgent {
  readonly id = "max_reach";
  readonly privileged = true;
  protected override readonly fetchesLists = true;
  private down = new Set<string>();
  private outbox = new Set<string>();
  protected override onReset(_seed: number, privileged?: Json): void {
    const p = (privileged ?? {}) as { down_at_read?: string[]; outbox_followers?: string[] };
    this.down = new Set(p.down_at_read ?? []);
    this.outbox = new Set(p.outbox_followers ?? []);
  }

  protected plan(v: PubView, budget: PubBudget): PublishPlan {
    const up = (r: string): boolean => !this.down.has(r);
    const spec = (r: string) => v.relays.find((x) => x.url === r)!;
    const followers: Reader[] = v.followers.map((p) => ({ pubkey: p, outbox: this.outbox.has(p), read_relays: this.lists.get(p) ?? [] }));
    const mentions: Reader[] = [...new Set(v.notes.flatMap((n) => n.tags.map((t) => t[1]!)))].sort().map((p) => ({ pubkey: p, outbox: true, read_relays: this.lists.get(p) ?? [] }));
    // The cell's scoring, run on what the oracle knows; the agent's notes carry every template tag.
    const world = { relays: v.relays as unknown as RelaySpec[], followers, mentions, notes: v.notes } as unknown as PublishFixture;
    const rates = { value_per_follower_sats: v.value.per_follower_sats, value_per_mention_sats: v.value.per_mention_sats } as PublishConfig;
    const score = (p: PublishPlan): number => {
      const placement: Placement = { lists: [], notes: new Map(v.notes.map((n) => [n.id, []])) };
      for (const w of p.writes) for (const r of w.relays) {
        if (w.event === "list") placement.lists.push({ relay: r, created_at: NOW, id: "list", write: p.write });
        else placement.notes.get(w.event)!.push({ relay: r, tagged: new Set(v.notes.find((n) => n.id === w.event)!.tags.map((t) => t[1]!)) });
      }
      const fees = p.auth.reduce((a, r) => a + (spec(r).write === "restricted" ? spec(r).fee_sats : 0), 0);
      return reachValue(world, rates, placement, up).value - fees;
    };
    const legacy = followers.filter((f) => !f.outbox);
    const candidates = v.relays.filter((r) => !r.indexer && up(r.url)).map((r) => r.url);
    const indexer = v.relays.filter((r) => r.indexer && up(r.url)).sort((a, b) => b.uptime_ppm - a.uptime_ppm)[0]?.url;
    const subsets: string[][] = [[]];
    for (let i = 0; i < candidates.length; i++) {
      subsets.push([candidates[i]!]);
      for (let j = i + 1; j < candidates.length; j++) {
        subsets.push([candidates[i]!, candidates[j]!]);
        for (let k = j + 1; k < candidates.length; k++) subsets.push([candidates[i]!, candidates[j]!, candidates[k]!]);
      }
    }
    let best: { plan: PublishPlan; score: number } = { plan: { auth: [], write: [], writes: [] }, score: 0 };
    for (const write of subsets) {
      const listRelays = write.length > 0 && indexer ? [indexer, ...write] : [];
      const wanted: PublishPlan = { auth: [], write, writes: [...(listRelays.length ? [{ event: "list", relays: listRelays }] : []), ...v.notes.map((n) => ({ event: n.id, relays: write }))] };
      const plan = fit(v, wanted, budget);
      if (plan.writes.some((w, i) => w.relays.length < wanted.writes[i]!.relays.length)) continue;
      let used = plan.auth.length + plan.writes.reduce((a, w) => a + w.relays.length, 0);
      let money = budget.sats - plan.auth.reduce((a, r) => a + (spec(r).write === "restricted" ? spec(r).fee_sats : 0), 0);
      const placed = new Map<string, Set<string>>(v.notes.map((n) => [n.id, new Set(write)]));
      const admitted = new Set(plan.auth);
      // Outbox followers depend only on the write set; the greedy step adds legacy followers and mentions.
      const gain = (note: NoteTemplate, r: string): number => {
        const at = placed.get(note.id)!;
        let g = 0;
        for (const f of legacy) if (up(r) && f.read_relays.includes(r) && !f.read_relays.some((x) => at.has(x) && up(x))) g += v.value.per_follower_sats;
        for (const t of note.tags) {
          const m = mentions.find((x) => x.pubkey === t[1]);
          if (m && up(r) && m.read_relays.includes(r) && !m.read_relays.some((x) => at.has(x) && up(x))) g += v.value.per_mention_sats;
        }
        return g;
      };
      for (;;) {
        let pick: { note: NoteTemplate; relay: string; ratio: number; cost: number; fee: number } | null = null;
        for (const note of v.notes) for (const r of candidates) {
          if (placed.get(note.id)!.has(r)) continue;
          const s = spec(r);
          const needsAuth = s.write !== "open" && !admitted.has(r);
          const cost = 1 + (needsAuth ? 1 : 0);
          const fee = needsAuth && s.write === "restricted" ? s.fee_sats : 0;
          if (used + cost > budget.attempts || fee > money) continue;
          const g = gain(note, r) - fee;
          if (g <= 0) continue;
          const ratio = g / cost;
          if (!pick || ratio > pick.ratio) pick = { note, relay: r, ratio, cost, fee };
        }
        if (!pick) break;
        placed.get(pick.note.id)!.add(pick.relay);
        if (pick.cost === 2) { admitted.add(pick.relay); plan.auth.push(pick.relay); }
        used += pick.cost;
        money -= pick.fee;
        plan.writes.push({ event: pick.note.id, relays: [pick.relay] });
      }
      const final = { ...plan, auth: [...new Set(plan.auth)].sort() };
      const s = score(final);
      if (s > best.score) best = { plan: final, score: s };
    }
    return best.plan;
  }
}

export const publishBaselines = (): Agent[] => [new Idle(), new RandomPublish(), new Popular(), new Outbox(), new MaxReach()];
