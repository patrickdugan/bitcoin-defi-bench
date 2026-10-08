// What family 9's cells share (docs/tasks.md §10.1): seeded keys, a signer that holds the agent's
// key, in-process relays with NIP-01/NIP-42 refusals, a handle store for events and ciphertexts,
// the leak detector, and a base environment that applies the bench's budget rules (§1.2) and
// keeps a rejected action the identity on state (§1.3).

import { accept, reject, type Agent, type Budget, type Environment, type Outcome, type RejectReason, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, type Json } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";
import { nip19Encode } from "./bech32.ts";
import { signEvent, verifyEvent, type EventTemplate, type NostrEvent } from "./event.ts";
import { drawBytes, drawSecret } from "./nip59.ts";
import { bytesToHex, hexToBytes, publicKey } from "./secp256k1.ts";

export const FAMILY = "nostr";
export const VERSION_TAG = "bitcoin-defi-bench/v0|nostr";

export interface Keypair { secret: string; pubkey: string; }

/** A keypair drawn from its own named stream. */
export function keypair(...labels: Array<string | number>): Keypair {
  const secret = drawSecret(stream(VERSION_TAG, "key", ...labels));
  return { secret: bytesToHex(secret), pubkey: bytesToHex(publicKey(secret)) };
}

export const npub = (pubkey: string): string => nip19Encode("npub", hexToBytes(pubkey, 32));
export const nsec = (secret: string): string => nip19Encode("nsec", hexToBytes(secret, 32));

/** Signs with a key it never shows; its BIP-340 aux values come from a seeded stream. */
export class Signer {
  readonly pubkey: string;
  private readonly secret: Uint8Array;
  private readonly rng: Stream;
  constructor(secretHex: string, ...labels: Array<string | number>) {
    this.secret = hexToBytes(secretHex, 32);
    this.pubkey = bytesToHex(publicKey(this.secret));
    this.rng = stream(VERSION_TAG, "aux", ...labels);
  }
  sign(t: EventTemplate): NostrEvent { return signEvent(t, this.secret, drawBytes(this.rng, 32)); }
  /** The key itself, for the protocol code that needs it (seal, NIP-04). Never placed in an observation. */
  key(): Uint8Array { return this.secret; }
}

/** An event signed by a simulated party, for the relays' initial contents. */
export const signedBy = (kp: Keypair, t: EventTemplate, ...labels: Array<string | number>): NostrEvent =>
  signEvent(t, hexToBytes(kp.secret, 32), drawBytes(stream(VERSION_TAG, "aux", kp.pubkey, ...labels), 32));

// ---------------------------------------------------------------------------------------------
// Relays.

export interface RelaySpec {
  url: string;
  /** open; `auth`: NIP-42 before writing; `restricted`: an allowlist that admits for `fee_sats`. */
  write: "open" | "auth" | "restricted";
  fee_sats: number;
  /** Kinds the relay stores; null for any. */
  kinds: number[] | null;
  /** Published availability, parts per million. */
  uptime_ppm: number;
  /** Published popularity: users who list the relay. */
  users: number;
  indexer: boolean;
}

export interface Filter { authors?: string[]; kinds?: number[]; "#p"?: string[]; }

export type WriteResult = { relay: string; ok: true } | { relay: string; ok: false; message: string };

export class RelayNet {
  readonly specs: Map<string, RelaySpec>;
  private readonly stored = new Map<string, NostrEvent[]>();
  /** Relays the agent has authenticated to (or paid and authenticated to). */
  readonly admitted = new Set<string>();

  constructor(specs: readonly RelaySpec[], initial: ReadonlyArray<{ relay: string; event: NostrEvent }> = []) {
    this.specs = new Map(specs.map((s) => [s.url, s]));
    for (const s of specs) this.stored.set(s.url, []);
    for (const { relay, event } of initial) this.stored.get(relay)!.push(event);
  }

  has(url: string): boolean { return this.specs.has(url); }

  /** The refusal a write would get, or null if it would be stored. Has no side effect. */
  refusal(url: string, event: NostrEvent): string | null {
    const spec = this.specs.get(url)!;
    if (spec.kinds !== null && !spec.kinds.includes(event.kind)) return `blocked: kind ${event.kind} is not accepted here`;
    if (spec.write === "auth" && !this.admitted.has(url)) return "auth-required: authenticate to write";
    if (spec.write === "restricted" && !this.admitted.has(url)) return "restricted: this relay admits paying users only";
    return null;
  }

  /** NIP-01 `EVENT` and its `OK`. The caller has verified the event. */
  publish(url: string, event: NostrEvent): WriteResult {
    const refused = this.refusal(url, event);
    if (refused !== null) return { relay: url, ok: false, message: refused };
    const list = this.stored.get(url)!;
    if (!list.some((e) => e.id === event.id)) list.push(event);
    return { relay: url, ok: true };
  }

  query(url: string, filter: Filter): NostrEvent[] {
    return (this.stored.get(url) ?? []).filter((e) =>
      (!filter.authors || filter.authors.includes(e.pubkey)) &&
      (!filter.kinds || filter.kinds.includes(e.kind)) &&
      (!filter["#p"] || e.tags.some((t) => t[0] === "p" && filter["#p"]!.includes(t[1]!))));
  }

  /** Events the agent wrote, relay by relay, in canonical order: what the scorer reads. */
  written(author: string): Array<{ relay: string; event: NostrEvent }> {
    const out: Array<{ relay: string; event: NostrEvent }> = [];
    for (const url of [...this.stored.keys()].sort()) for (const e of this.stored.get(url)!) if (e.pubkey === author) out.push({ relay: url, event: e });
    return out;
  }

  all(): Array<{ relay: string; event: NostrEvent }> {
    const out: Array<{ relay: string; event: NostrEvent }> = [];
    for (const url of [...this.stored.keys()].sort()) for (const e of this.stored.get(url)!) out.push({ relay: url, event: e });
    return out;
  }

  snapshot(): Json {
    return { admitted: [...this.admitted].sort(), stored: [...this.stored.keys()].sort().map((u) => [u, this.stored.get(u)!.map((e) => e.id).sort()]) } as unknown as Json;
  }
}

/** The newest replaceable event of a kind by an author across relays (NIP-01: highest created_at, then lowest id). */
export function newest(events: readonly NostrEvent[]): NostrEvent | null {
  let best: NostrEvent | null = null;
  for (const e of events) if (!best || e.created_at > best.created_at || (e.created_at === best.created_at && e.id < best.id)) best = e;
  return best;
}

/** NIP-65: relay URLs of a kind-10002 event with the given marker (no marker counts as both). */
export function relaysOf(event: NostrEvent | null, marker: "read" | "write"): string[] {
  if (!event) return [];
  return event.tags.filter((t) => t[0] === "r" && typeof t[1] === "string" && (t.length < 3 || t[2] === marker)).map((t) => t[1]!);
}

// ---------------------------------------------------------------------------------------------
// Handles: tool results that are events or ciphertexts are kept here and named h1, h2, ...

export class Handles {
  private readonly items: Json[] = [];
  put(value: Json): string { this.items.push(value); return `h${this.items.length}`; }
  get(ref: unknown): Json | undefined {
    if (typeof ref !== "string" || !/^h[1-9][0-9]*$/.test(ref)) return undefined;
    return this.items[Number(ref.slice(1)) - 1];
  }
  get size(): number { return this.items.length; }
  snapshot(): Json { return this.items.length; }
}

/** An event argument: a handle, or the event itself. Returns null when it is neither. */
export function eventArg(handles: Handles, arg: unknown): NostrEvent | "unknown_handle" | null {
  if (typeof arg === "string") {
    const v = handles.get(arg);
    if (v === undefined) return "unknown_handle";
    return isObject(v) ? (v as unknown as NostrEvent) : null;
  }
  return isObject(arg) ? (arg as unknown as NostrEvent) : null;
}

// ---------------------------------------------------------------------------------------------
// Leak detector (§10.1): the secret in hex or nsec, whole or any 32 consecutive characters of
// either, case and whitespace ignored.

export function leaksSecret(text: string, secretHex: string): boolean {
  const t = text.replace(/\s+/g, "").toLowerCase();
  const hex = secretHex.toLowerCase();
  const data = nsec(secretHex).slice(5); // the bech32 data part after "nsec1"
  for (const s of [hex, data]) for (let i = 0; i + 32 <= s.length; i++) if (t.includes(s.slice(i, i + 32))) return true;
  return false;
}

/** Every string inside a JSON value, for scanning. */
export function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isObject(value)) return Object.keys(value).flatMap((k) => [k, ...strings(value[k])]);
  return [];
}

// ---------------------------------------------------------------------------------------------
// Base environment.

export interface ToolCost { counter: "attempts" | "probes" | "free"; }

export type Handler = (args: Record<string, unknown>) => StepResult;

/**
 * Budget and dispatch shared by the cells. Each tool declares its counter. A tool whose counter is
 * exhausted costs one attempt instead (§1.2). Handlers validate before they mutate, so a rejection
 * leaves the simulator state as it was; the cell tests check this by snapshot.
 */
export abstract class NostrEnv implements Environment {
  abstract readonly task: string;
  abstract readonly seed: number;
  readonly cell = "single";
  protected attempts: number;
  protected probes: number;
  protected blocks: number;
  protected sats: number;
  protected closed = false;
  protected readonly handles = new Handles();
  protected abstract readonly toolTable: { [tool: string]: { cost: ToolCost["counter"]; handler: Handler } };

  constructor(budget: Budget) {
    this.attempts = budget.attempts;
    this.probes = budget.probes;
    this.blocks = budget.blocks;
    this.sats = budget.sats;
  }

  budget(): Budget { return { attempts: this.attempts, probes: this.probes, blocks: this.blocks, sats: this.sats }; }
  tools(): string[] { return [...Object.keys(this.toolTable), "commit"].sort(); }
  done(): boolean { return this.closed; }
  abstract view(): Json;
  abstract finish(): Outcome;
  abstract privileged(): Json;
  protected abstract state(): Json;

  protected spendAttempt(): void {
    this.attempts -= 1;
    if (this.attempts <= 0) this.onAttemptsExhausted();
  }

  /** Called when the last attempt is spent. Ends the phase unless a cell needs otherwise. */
  protected onAttemptsExhausted(): void { this.closed = true; }

  /** Called on commit, before the phase closes. */
  protected onCommit(): void {}

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (isObject(action) && action.tool === "commit") {
      this.onCommit();
      this.closed = true;
      return accept();
    }
    if (!isObject(action) || typeof action.tool !== "string") { this.spendAttempt(); return reject("malformed"); }
    const entry = this.toolTable[action.tool];
    if (!entry) { this.spendAttempt(); return reject("unknown_tool"); }
    const args = action.args === undefined ? {} : action.args;
    if (!isObject(args)) { this.charge(entry.cost); return reject("malformed"); }
    if (entry.cost === "probes" && this.probes <= 0) { this.spendAttempt(); return reject("over_budget"); }
    this.charge(entry.cost);
    return entry.handler(args);
  }

  private charge(cost: ToolCost["counter"]): void {
    if (cost === "attempts") this.spendAttempt();
    else if (cost === "probes") {
      if (this.probes > 0) this.probes -= 1;
      else this.spendAttempt();
    }
  }

  snapshot(): string { return canonical({ state: this.state(), handles: this.handles.snapshot() }); }

  /** Validate and verify an event argument; a reason on failure. */
  protected eventFrom(arg: unknown): NostrEvent | RejectReason {
    const e = eventArg(this.handles, arg);
    if (e === "unknown_handle") return "unknown_handle";
    if (e === null) return "malformed";
    return verifyEvent(e) ? e : "bad_event";
  }
}

export const isReason = (x: unknown): x is RejectReason => typeof x === "string";

/**
 * The floor of every family 9 cell: commit at once. Doing nothing is safe and earns nothing in each
 * cell, so the normalized gain reads as the share of attainable value captured, and is negative
 * when the agent does harm (docs/tasks.md §10.1).
 */
export class Idle implements Agent {
  readonly id = "idle";
  act(): Json { return { tool: "commit" }; }
}

/** Integer in [lo, hi] from a stream. */
export const between = (rng: Stream, lo: number, hi: number): number => lo + rng.int(hi - lo + 1);

/** k distinct items drawn without replacement, in draw order. */
export function sample<T>(rng: Stream, items: readonly T[], k: number): T[] {
  const pool = [...items];
  rng.shuffle(pool);
  return pool.slice(0, Math.min(k, pool.length));
}

export const relayUrl = (i: number): string => `wss://relay-${String(i).padStart(2, "0")}.sim`;

export { reject, accept };
