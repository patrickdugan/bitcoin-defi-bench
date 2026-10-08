// Family 9, cells `nostr/mesh_outage` and `nostr/mesh_partial` (docs/tasks.md §10.6): deliver
// private messages from a phone in a moving crowd, over the bitchat Bluetooth mesh, its couriers,
// and, where a device has internet, its Nostr path. The delivery rules are the whitepaper's (v2.0,
// pinned in data/nostr/provenance.json); the ciphers are opaque, so an envelope is delivered or not.
//
// Simplifications, each declared: a directed flood reaches every device within TTL hops in the step
// it is sent and costs one transmission per relaying device; source routing is not modeled;
// couriers hand half their copy budget to each newly met device; a courier within TTL hops of the
// recipient makes a relayed handover at most once per interval; delivery acks reach the sender at
// once. Positions follow seeded random-waypoint walks.

import { accept, reject, type Agent, type Outcome, type StepResult } from "../../harness/agent.ts";
import type { Json } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";
import { between, Idle, NostrEnv, VERSION_TAG } from "./sim.ts";

export const MESH_VERSION = "nostr-mesh-fixture/v0";

export interface MeshConfig {
  devices: number;
  area_m: number;
  range_m: number;
  speed_m_per_step: [number, number];
  pause_steps: [number, number];
  horizon_steps: number;
  messages: number;
  value_sats: [number, number];
  deadline_steps: [number, number];
  favorite_ppm: number;
  cost_per_transmission_sats: number;
  ttl_spec: number;
  courier_count_spec: number;
  copy_budget_spec: { initial: number; max: number };
  deposit_quota_spec: { favorite: number; verified: number };
  relayed_handover_interval_steps_spec: number;
  online: { device_ppm: number; windows: number; window_steps: [number, number] };
  budget: { attempts: number; probes: number };
}

export interface MeshMessage { id: string; to: string; value_sats: number; deadline: number; favorite: boolean; }

export interface MeshFixture {
  version: string;
  seed: number;
  cell: "mesh_outage" | "mesh_partial";
  params: { range_m: number; horizon_steps: number; ttl: number; couriers: number; copy_initial: number; copy_max: number; quota_favorite: number; quota_verified: number; handover_interval: number; cost_per_transmission_sats: number };
  agent: string;
  /** Per device: waypoints [x, y, step], positions interpolated between them. */
  walks: { [device: string]: Array<[number, number, number]> };
  /** The agent's mutual favorites (other than recipients flagged favorite, which are included). */
  favorites: string[];
  /** Per device: steps with internet, as [from, to] inclusive. Empty in mesh_outage. */
  online: { [device: string]: Array<[number, number]> };
  messages: MeshMessage[];
}

const deviceId = (i: number): string => `d${String(i).padStart(2, "0")}`;

export function generateMesh(seed: number, cell: "mesh_outage" | "mesh_partial", config: MeshConfig): MeshFixture {
  const rng = (label: string): Stream => stream(VERSION_TAG, "mesh", cell, seed, label);
  const w = rng("walks");
  const walks: MeshFixture["walks"] = {};
  const devices = Array.from({ length: config.devices }, (_, i) => deviceId(i));
  for (const d of devices) {
    const pts: Array<[number, number, number]> = [[w.int(config.area_m + 1), w.int(config.area_m + 1), 0]];
    while (pts[pts.length - 1]![2] < config.horizon_steps) {
      const [x, y, t] = pts[pts.length - 1]!;
      const pause = between(w, config.pause_steps[0], config.pause_steps[1]);
      if (pause > 0) pts.push([x, y, t + pause]);
      const [, , t2] = pts[pts.length - 1]!;
      const nx = w.int(config.area_m + 1);
      const ny = w.int(config.area_m + 1);
      const speed = between(w, config.speed_m_per_step[0], config.speed_m_per_step[1]);
      const steps = Math.max(1, Math.ceil(Math.hypot(nx - x, ny - y) / speed));
      pts.push([nx, ny, t2 + steps]);
    }
    walks[d] = pts;
  }
  const agent = deviceId(0);
  const m = rng("messages");
  const recipients = devices.slice(1);
  m.shuffle(recipients);
  const messages: MeshMessage[] = recipients.slice(0, config.messages).sort().map((to, i) => ({
    id: `x${i + 1}`, to,
    value_sats: between(m, config.value_sats[0], config.value_sats[1]),
    deadline: between(m, config.deadline_steps[0], config.deadline_steps[1]),
    favorite: m.int(1_000_000) < config.favorite_ppm,
  }));
  const fav = rng("favorites");
  const favorites = devices.filter((d) => d !== agent && (messages.some((x) => x.to === d && x.favorite) || (!messages.some((x) => x.to === d) && fav.int(10) === 0)));
  const online: MeshFixture["online"] = {};
  if (cell === "mesh_partial") {
    const o = rng("online");
    for (const d of devices) {
      // The agent and every favorite recipient draw like any device: nothing guarantees a path.
      if (o.int(1_000_000) >= config.online.device_ppm) continue;
      const wins: Array<[number, number]> = [];
      for (let k = 0; k < config.online.windows; k++) {
        const len = between(o, config.online.window_steps[0], config.online.window_steps[1]);
        const start = o.int(config.horizon_steps - len + 1);
        wins.push([start, start + len - 1]);
      }
      online[d] = wins.sort((a, b) => a[0] - b[0]);
    }
  }
  return {
    version: MESH_VERSION, seed, cell,
    params: {
      range_m: config.range_m, horizon_steps: config.horizon_steps, ttl: config.ttl_spec, couriers: config.courier_count_spec,
      copy_initial: config.copy_budget_spec.initial, copy_max: config.copy_budget_spec.max,
      quota_favorite: config.deposit_quota_spec.favorite, quota_verified: config.deposit_quota_spec.verified,
      handover_interval: config.relayed_handover_interval_steps_spec, cost_per_transmission_sats: config.cost_per_transmission_sats,
    },
    agent, walks, favorites, online, messages,
  };
}

/** The moving crowd: positions, links, and hop distances at each step, computed once and cached. */
export class MeshWorld {
  readonly devices: string[];
  readonly horizon: number;
  readonly ttl: number;
  private readonly fixture: MeshFixture;
  private readonly adjacency = new Map<number, Map<string, string[]>>();

  constructor(fixture: MeshFixture) {
    this.fixture = fixture;
    this.devices = Object.keys(fixture.walks).sort();
    this.horizon = fixture.params.horizon_steps;
    this.ttl = fixture.params.ttl;
  }

  position(d: string, t: number): [number, number] {
    const pts = this.fixture.walks[d]!;
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1, t1] = pts[i]!;
      if (t <= t1) {
        const [x0, y0, t0] = pts[i - 1]!;
        if (t1 === t0) return [x1, y1];
        const f = (t - t0) / (t1 - t0);
        return [Math.round(x0 + (x1 - x0) * f), Math.round(y0 + (y1 - y0) * f)];
      }
    }
    const last = pts[pts.length - 1]!;
    return [last[0], last[1]];
  }

  links(t: number): Map<string, string[]> {
    let adj = this.adjacency.get(t);
    if (adj) return adj;
    adj = new Map(this.devices.map((d) => [d, [] as string[]]));
    const pos = this.devices.map((d) => this.position(d, t));
    const r2 = this.fixture.params.range_m ** 2;
    for (let i = 0; i < this.devices.length; i++) {
      for (let j = i + 1; j < this.devices.length; j++) {
        const dx = pos[i]![0] - pos[j]![0];
        const dy = pos[i]![1] - pos[j]![1];
        if (dx * dx + dy * dy <= r2) { adj.get(this.devices[i]!)!.push(this.devices[j]!); adj.get(this.devices[j]!)!.push(this.devices[i]!); }
      }
    }
    this.adjacency.set(t, adj);
    return adj;
  }

  /** Hop distances from a device, up to the TTL. */
  hops(from: string, t: number): Map<string, number> {
    const adj = this.links(t);
    const dist = new Map<string, number>([[from, 0]]);
    let frontier = [from];
    for (let depth = 1; depth <= this.ttl && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const u of frontier) for (const v of adj.get(u)!) if (!dist.has(v)) { dist.set(v, depth); next.push(v); }
      frontier = next;
    }
    return dist;
  }

  /** A directed flood from a device: whether it reaches the target, and how many devices transmit (every device that relays: depth below the TTL). */
  flood(from: string, to: string, t: number): { delivered: boolean; transmissions: number } {
    const dist = this.hops(from, t);
    let tx = 0;
    for (const d of dist.values()) if (d < this.ttl) tx += 1;
    return { delivered: dist.has(to), transmissions: tx };
  }

  online(d: string, t: number): boolean { return (this.fixture.online[d] ?? []).some(([a, b]) => t >= a && t <= b); }

  /** The first step at or after t when the device is online, or null. */
  nextOnline(d: string, t: number): number | null {
    for (let s = t; s <= this.horizon; s++) if (this.online(d, s)) return s;
    return null;
  }

  /**
   * Couriers: deposit at the given devices with the given copy budget, then simulate spray and
   * wait to the horizon. Returns the delivery step (or null) and the transmissions spent.
   */
  courier(depositors: string[], budget: number, to: string, t0: number): { delivered: number | null; transmissions: number } {
    const carriers = new Map<string, { budget: number; lastRelay: number }>(depositors.map((d) => [d, { budget, lastRelay: -Infinity }]));
    let tx = depositors.length;
    const interval = this.fixture.params.handover_interval;
    for (let t = t0; t <= this.horizon; t++) {
      const adj = this.links(t);
      for (const c of [...carriers.keys()].sort()) {
        if (c === to || adj.get(c)!.includes(to)) return { delivered: t, transmissions: tx + 1 };
      }
      for (const c of [...carriers.keys()].sort()) {
        const state = carriers.get(c)!;
        if (t - state.lastRelay < interval) continue;
        const dist = this.hops(c, t);
        if (dist.has(to)) {
          state.lastRelay = t;
          return { delivered: t, transmissions: tx + this.flood(c, to, t).transmissions };
        }
      }
      for (const c of [...carriers.keys()].sort()) {
        const state = carriers.get(c)!;
        for (const n of adj.get(c)!.slice().sort()) {
          if (state.budget < 2) break;
          if (carriers.has(n)) continue;
          const half = Math.floor(state.budget / 2);
          carriers.set(n, { budget: half, lastRelay: -Infinity });
          state.budget -= half;
          tx += 1;
        }
      }
    }
    return { delivered: null, transmissions: tx };
  }
}

interface Sent { message: string; via: string; step: number; delivered: number | null; transmissions: number; }

export class MeshEnv extends NostrEnv {
  readonly task: string;
  readonly seed: number;
  private readonly fixture: MeshFixture;
  private readonly world: MeshWorld;
  private step_ = 0;
  private readonly sent: Sent[] = [];
  private readonly deposits = new Map<string, number>();
  protected readonly toolTable;

  constructor(fixture: MeshFixture, config: MeshConfig) {
    super({ attempts: config.budget.attempts, probes: config.budget.probes, blocks: fixture.params.horizon_steps, sats: 0 });
    this.fixture = fixture;
    this.seed = fixture.seed;
    this.task = `nostr/${fixture.cell}`;
    this.world = new MeshWorld(fixture);
    this.toolTable = {
      neighbors: { cost: "probes" as const, handler: () => this.neighbors() },
      send: { cost: "attempts" as const, handler: (a: Record<string, unknown>) => this.send(a) },
      wait: { cost: "free" as const, handler: (a: Record<string, unknown>) => this.wait(a) },
    };
  }

  private deliveredAt(id: string): number | null {
    const steps = this.sent.filter((s) => s.message === id && s.delivered !== null).map((s) => s.delivered!);
    return steps.length ? Math.min(...steps) : null;
  }

  private neighbors(): StepResult {
    const adj = this.world.links(this.step_);
    const me = this.fixture.agent;
    const near = adj.get(me)!.slice().sort();
    const map: { [d: string]: string[] } = {};
    for (const n of near) map[n] = adj.get(n)!.slice().sort().slice(0, 10);
    const reachable = [...this.world.hops(me, this.step_).keys()].filter((d) => d !== me).sort();
    return accept({ step: this.step_, neighbors: near, map, reachable, online: this.world.online(me, this.step_) });
  }

  private send(a: Record<string, unknown>): StepResult {
    const msg = this.fixture.messages.find((m) => m.id === a.message);
    if (!msg) return reject("unknown_id");
    const me = this.fixture.agent;
    if (a.via === "mesh") {
      const f = this.world.flood(me, msg.to, this.step_);
      this.sent.push({ message: msg.id, via: "mesh", step: this.step_, delivered: f.delivered ? this.step_ : null, transmissions: f.transmissions });
      return accept({ message: msg.id, via: "mesh", transmissions: f.transmissions, delivered: f.delivered });
    }
    if (a.via === "nostr") {
      if (!msg.favorite) return reject("relay_refused", { detail: "the Nostr path is open only to mutual favorites" });
      if (!this.world.online(me, this.step_)) return reject("relay_refused", { detail: "no internet on this device now" });
      const at = this.world.nextOnline(msg.to, this.step_);
      this.sent.push({ message: msg.id, via: "nostr", step: this.step_, delivered: at, transmissions: 0 });
      return accept({ message: msg.id, via: "nostr", queued_on_relays: true });
    }
    if (a.via === "courier") {
      const copies = a.copies === undefined ? this.fixture.params.copy_initial : a.copies;
      if (typeof copies !== "number" || !Number.isInteger(copies) || copies < 1 || copies > this.fixture.params.copy_max) return reject("out_of_grid");
      const p = this.fixture.params;
      const eligible = this.world.links(this.step_).get(me)!.slice().sort()
        .filter((n) => n !== msg.to && (this.deposits.get(n) ?? 0) < (this.fixture.favorites.includes(n) ? p.quota_favorite : p.quota_verified))
        .slice(0, p.couriers);
      if (eligible.length === 0) return reject("no_link", { detail: "no eligible courier in range" });
      for (const n of eligible) this.deposits.set(n, (this.deposits.get(n) ?? 0) + 1);
      const c = this.world.courier(eligible, copies, msg.to, this.step_);
      this.sent.push({ message: msg.id, via: "courier", step: this.step_, delivered: c.delivered, transmissions: c.transmissions });
      return accept({ message: msg.id, via: "courier", couriers: eligible });
    }
    return reject("malformed");
  }

  private wait(a: Record<string, unknown>): StepResult {
    const steps = a.steps;
    if (typeof steps !== "number" || !Number.isInteger(steps) || steps <= 0) { this.spendAttempt(); return reject("not_integer"); }
    if (steps > this.blocks) { this.spendAttempt(); return reject("over_budget"); }
    this.blocks -= steps;
    this.step_ += steps;
    if (this.blocks === 0) this.closed = true;
    return accept({ step: this.step_ });
  }

  view(): Json {
    const f = this.fixture;
    return {
      me: f.agent,
      step: this.step_,
      horizon: f.params.horizon_steps,
      online: this.world.online(f.agent, this.step_),
      rules: { ttl: f.params.ttl, couriers: f.params.couriers, copies_default: f.params.copy_initial, copies_max: f.params.copy_max, cost_per_transmission_sats: f.params.cost_per_transmission_sats },
      messages: f.messages.map((m) => {
        const d = this.deliveredAt(m.id);
        return { ...m, delivered: d !== null && d <= this.step_ };
      }) as unknown as Json,
    };
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    let value = 0;
    let delivered = 0;
    let late = 0;
    const tx = this.sent.reduce((a, s) => a + s.transmissions, 0);
    for (const m of this.fixture.messages) {
      const d = this.deliveredAt(m.id);
      if (d !== null && d <= m.deadline) { value += m.value_sats; delivered += 1; } else if (d !== null) late += 1;
    }
    value -= tx * this.fixture.params.cost_per_transmission_sats;
    return { value, metrics: { delivered, late, transmissions: tx, sends: this.sent.length, by_courier: this.sent.filter((s) => s.via === "courier").length, by_nostr: this.sent.filter((s) => s.via === "nostr").length } };
  }

  protected state(): Json { return { step: this.step_, sent: this.sent as unknown as Json, deposits: [...this.deposits.entries()].sort() as unknown as Json }; }
  privileged(): Json { return this.fixture as unknown as Json; }
}

// ---------------------------------------------------------------------------------------------
// Baselines.

interface MView { me: string; step: number; horizon: number; online: boolean; rules: { copies_default: number }; messages: Array<MeshMessage & { delivered: boolean }>; }
interface MLast { accepted: boolean; result: { reachable?: string[]; online?: boolean } | null; }

export class NostrOnly implements Agent {
  readonly id = "nostr_only";
  private tried = new Set<string>();
  reset(): void { this.tried = new Set(); }
  act(o: Json): Json {
    const obs = o as unknown as { view: MView; budget: { attempts: number; blocks: number } };
    const v = obs.view;
    if (v.online) {
      const m = v.messages.find((x) => x.favorite && !x.delivered && !this.tried.has(x.id));
      if (m) { this.tried.add(m.id); return { tool: "send", args: { message: m.id, via: "nostr" } }; }
    }
    if (obs.budget.blocks <= 0 || v.messages.every((x) => !x.favorite || this.tried.has(x.id))) return { tool: "commit" };
    return { tool: "wait", args: { steps: 1 } };
  }
}

/** Every message over the mesh at once, and nothing else. */
export class FloodNow implements Agent {
  readonly id = "flood_now";
  private sent = new Set<string>();
  reset(): void { this.sent = new Set(); }
  act(o: Json): Json {
    const v = (o as unknown as { view: MView }).view;
    const m = v.messages.find((x) => !this.sent.has(x.id));
    if (!m) return { tool: "commit" };
    this.sent.add(m.id);
    return { tool: "send", args: { message: m.id, via: "mesh" } };
  }
}

export class RandomMesh implements Agent {
  readonly id = "random";
  private rng: Stream = stream(VERSION_TAG, "baseline", "mesh", "random", 0);
  reset(e?: { seed: number }): void { this.rng = stream(VERSION_TAG, "baseline", "mesh", "random", e?.seed ?? 0); }
  act(o: Json): Json {
    const obs = o as unknown as { view: MView; budget: { attempts: number; blocks: number } };
    const pending = obs.view.messages.filter((m) => !m.delivered);
    if (pending.length === 0 || (obs.budget.blocks <= 0 && obs.budget.attempts <= 1)) return { tool: "commit" };
    if (obs.budget.blocks > 0 && this.rng.int(2) === 0) return { tool: "wait", args: { steps: Math.min(obs.budget.blocks, 1 + this.rng.int(10)) } };
    const m = this.rng.pick(pending);
    const via = this.rng.pick(["mesh", "courier", "nostr"]);
    return { tool: "send", args: via === "courier" ? { message: m.id, via, copies: 4 } : { message: m.id, via } };
  }
}

/**
 * The whitepaper's router (§2): a live mesh route first, then Nostr between mutual favorites, then
 * couriers at the default copy budget; afterwards the outbox re-sends over the mesh when the
 * recipient becomes reachable, checking every ten steps.
 */
export class BitchatRouter implements Agent {
  readonly id = "bitchat_router";
  private routed = new Set<string>();
  private resends = new Map<string, number>();
  private reachable: Set<string> | null = null;
  private lastCheck = -Infinity;
  reset(): void { this.routed = new Set(); this.resends = new Map(); this.reachable = null; this.lastCheck = -Infinity; }
  act(o: Json): Json {
    const obs = o as unknown as { view: MView; budget: { attempts: number; probes: number; blocks: number }; last: MLast | null };
    const v = obs.view;
    if (obs.last?.accepted && obs.last.result?.reachable) { this.reachable = new Set(obs.last.result.reachable); this.lastCheck = v.step; }
    if (this.reachable === null || (v.step - this.lastCheck >= 10 && obs.budget.probes > 0)) { this.reachable = this.reachable ?? new Set(); this.lastCheck = v.step; return { tool: "neighbors" }; }
    for (const m of v.messages) {
      if (m.delivered || this.routed.has(m.id)) continue;
      this.routed.add(m.id);
      if (this.reachable.has(m.to)) return { tool: "send", args: { message: m.id, via: "mesh" } };
      if (m.favorite && v.online) return { tool: "send", args: { message: m.id, via: "nostr" } };
      return { tool: "send", args: { message: m.id, via: "courier", copies: v.rules.copies_default } };
    }
    if (obs.budget.attempts > 1) {
      const m = v.messages.find((x) => !x.delivered && this.reachable!.has(x.to) && (this.resends.get(x.id) ?? 0) < 8 && v.step <= x.deadline);
      if (m) { this.resends.set(m.id, (this.resends.get(m.id) ?? 0) + 1); this.reachable.delete(m.to); return { tool: "send", args: { message: m.id, via: "mesh" } }; }
    }
    if (obs.budget.blocks <= 0 || v.messages.every((x) => x.delivered || v.step > x.deadline)) return { tool: "commit" };
    return { tool: "wait", args: { steps: Math.min(obs.budget.blocks, 10) } };
  }
}

/**
 * Ceiling, privileged: sees the whole future. Messages are planned in order of deadline; for each
 * it chooses, by simulation, the best of the mesh at any step, Nostr at the agent's first online
 * step, or couriers deposited at some step with 1, 2, 4, or 8 copies, given the courier quotas the
 * messages planned before it have used. It then plays the schedule. A reference, not a proven bound.
 */
export class MeshOracle implements Agent {
  readonly id = "oracle";
  readonly privileged = true;
  private schedule: Array<{ step: number; order: number; message: string; args: Json }> = [];
  reset(_e?: { seed: number }, privileged?: Json): void {
    this.schedule = [];
    const f = privileged as unknown as MeshFixture;
    if (!f || !f.walks) return;
    const world = new MeshWorld(f);
    const c = f.params.cost_per_transmission_sats;
    const used = new Map<string, number>();
    const quota = (n: string): number => (f.favorites.includes(n) ? f.params.quota_favorite : f.params.quota_verified);
    const couriersAt = (k: number, to: string): string[] => world.links(k).get(f.agent)!.slice().sort().filter((n) => n !== to && (used.get(n) ?? 0) < quota(n)).slice(0, f.params.couriers);
    const order = [...f.messages].sort((a, b) => a.deadline - b.deadline || (a.id < b.id ? -1 : 1));
    for (const m of order) {
      const pick: { best: { score: number; step: number; args: Json; couriers: string[] } | null } = { best: null };
      const consider = (score: number, step: number, args: Json, couriers: string[] = []): void => {
        const b = pick.best;
        if (score > 0 && (!b || score > b.score || (score === b.score && step < b.step))) pick.best = { score, step, args, couriers };
      };
      for (let k = 0; k <= m.deadline; k++) {
        const fl = world.flood(f.agent, m.to, k);
        if (fl.delivered) consider(m.value_sats - c * fl.transmissions, k, { message: m.id, via: "mesh" });
      }
      if (m.favorite) {
        const k = world.nextOnline(f.agent, 0);
        if (k !== null && k <= m.deadline) {
          const at = world.nextOnline(m.to, k);
          if (at !== null && at <= m.deadline) consider(m.value_sats, k, { message: m.id, via: "nostr" });
        }
      }
      for (let k = 0; k <= m.deadline; k++) {
        const near = couriersAt(k, m.to);
        if (near.length === 0) continue;
        for (const copies of [1, 2, 4, 8]) {
          const r = world.courier(near, copies, m.to, k);
          if (r.delivered !== null && r.delivered <= m.deadline) consider(m.value_sats - c * r.transmissions, k, { message: m.id, via: "courier", copies }, near);
        }
      }
      const best = pick.best;
      if (!best) continue;
      for (const n of best.couriers) used.set(n, (used.get(n) ?? 0) + 1);
      this.schedule.push({ step: best.step, order: this.schedule.length, message: m.id, args: best.args });
    }
    // Same-step sends go in planning order, so the courier quotas are spent as planned.
    this.schedule.sort((a, b) => a.step - b.step || a.order - b.order);
  }
  act(o: Json): Json {
    const obs = o as unknown as { view: MView; budget: { attempts: number; blocks: number } };
    const v = obs.view;
    while (this.schedule.length > 0 && this.schedule[0]!.step < v.step) this.schedule.shift();
    const now = this.schedule[0];
    if (!now) return { tool: "commit" };
    if (now.step === v.step) { this.schedule.shift(); return { tool: "send", args: now.args }; }
    return { tool: "wait", args: { steps: Math.min(obs.budget.blocks, now.step - v.step) } };
  }
}

export const meshBaselines = (): Agent[] => [new Idle(), new NostrOnly(), new FloodNow(), new RandomMesh(), new BitchatRouter(), new MeshOracle()];
