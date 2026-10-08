// Family 9, cell `nostr/counterparty` (docs/tasks.md §10.5): buy one paid job (NIP-90) from a
// market of providers. The agent posts a job request; providers answer with `payment-required`
// feedback over the next steps; the agent pays one or more (over its wallet connection when the
// feedback carries an invoice, or by nutzap at a mint the provider lists, NIP-61) and waits for a
// result before the deadline. Whether a paid provider delivers is hidden; its public record (past
// results, error feedback, zaps received, follows from the agent's contacts, NIP-05) predicts it.
// Some providers copy a reputable one's name and picture under another key and never deliver.

import { accept, reject, type Agent, type Outcome, type StepResult } from "../../harness/agent.ts";
import type { Json } from "../../harness/json.ts";
import { stream, type Stream } from "../../harness/prng.ts";
import { between, keypair, npub, sample, Idle, NostrEnv, VERSION_TAG } from "./sim.ts";

export const COUNTERPARTY_VERSION = "nostr-counterparty-fixture/v0";

export interface CounterpartyConfig {
  providers: number;
  impostors: [number, number];
  job_value_sats: number;
  deadline_steps: number;
  price_sats: [number, number];
  bolt11_ppm: number;
  feedback_delay_steps: [number, number];
  result_latency_steps: [number, number];
  mints: string[];
  agent_mints: number;
  budget: { attempts: number; probes: number; sats: number };
}

export interface Provider {
  pubkey: string;
  name: string;
  picture: string;
  nip05: string;
  nip05_valid: boolean;
  price_sats: number;
  bolt11: boolean;
  mints: string[];
  stats: { results: number; errors: number; zaps_received: number; followed_by_contacts: number };
  /** Hidden. */
  delay: number;
  latency: number;
  delivers: boolean;
  quality_ppm: number;
  impostor: boolean;
}

export interface CounterpartyFixture {
  version: string;
  seed: number;
  cell: "counterparty";
  job: { kind: number; input: string; value_sats: number; deadline_steps: number };
  agent_mints: string[];
  providers: Provider[];
}

const NAMES = ["Quote Oracle", "PathFinder DVM", "Liquidity Scout", "FeeBot", "ChainWatch", "Satscribe", "RouteSmith", "Mempool Muse", "LN Probe", "Ark Advisor"];

export function generateCounterparty(seed: number, config: CounterpartyConfig): CounterpartyFixture {
  const rng = (label: string): Stream => stream(VERSION_TAG, "counterparty", seed, label);
  const r = rng("providers");
  const nImpostors = between(r, config.impostors[0], config.impostors[1]);
  const names = sample(r, NAMES, config.providers - nImpostors);
  const genuine: Provider[] = names.map((name, i) => {
    const q = 50_000 + r.int(900_001);
    const qf = q / 1_000_000;
    const bolt11 = r.int(1_000_000) < config.bolt11_ppm;
    const price = Math.round(config.price_sats[0] + (config.price_sats[1] - config.price_sats[0]) * (0.3 * qf + 0.7 * r.next()));
    const noise = (k: number): number => r.int(2 * k + 1) - k;
    const followed = Array.from({ length: 10 }, () => (r.next() < qf ? 1 : 0) as number).reduce((a, x) => a + x, 0);
    return {
      pubkey: keypair("counterparty", seed, "provider", i).pubkey,
      name, picture: `https://img.sim/${name.toLowerCase().replace(/\s+/g, "-")}.png`,
      nip05: `${name.toLowerCase().replace(/\s+/g, "")}@dvm.sim`, nip05_valid: true,
      price_sats: price, bolt11, mints: bolt11 ? [] : sample(r, config.mints, 1 + r.int(2)).sort(),
      stats: { results: Math.max(0, Math.round(40 * qf) + noise(5)), errors: Math.max(0, Math.round(10 * (1 - qf)) + noise(2)), zaps_received: Math.max(0, Math.round(30 * qf) + noise(5)), followed_by_contacts: followed },
      delay: between(r, config.feedback_delay_steps[0], config.feedback_delay_steps[1]),
      latency: between(r, config.result_latency_steps[0], config.result_latency_steps[1]),
      delivers: r.int(1_000_000) < q,
      quality_ppm: q,
      impostor: false,
    };
  });
  const famous = [...genuine].sort((a, b) => b.stats.results - a.stats.results || (a.pubkey < b.pubkey ? -1 : 1))[0]!;
  const impostors: Provider[] = Array.from({ length: nImpostors }, (_, i) => ({
    pubkey: keypair("counterparty", seed, "impostor", i).pubkey,
    name: famous.name, picture: famous.picture,
    nip05: `${famous.name.toLowerCase().replace(/\s+/g, "")}@dvm-sim.net`, nip05_valid: false,
    price_sats: Math.max(config.price_sats[0], Math.round(famous.price_sats * (0.6 + 0.2 * r.next()))),
    bolt11: true, mints: [],
    stats: { results: r.int(2), errors: 0, zaps_received: r.int(2), followed_by_contacts: 0 },
    delay: config.feedback_delay_steps[0],
    latency: config.result_latency_steps[0],
    delivers: false, quality_ppm: 0, impostor: true,
  }));
  const providers = [...genuine, ...impostors];
  rng("order").shuffle(providers);
  return {
    version: COUNTERPARTY_VERSION, seed, cell: "counterparty",
    job: { kind: 5300, input: "Quote: best route and fee for 2,000,000 sats to the counterparty's node within 24 h", value_sats: config.job_value_sats, deadline_steps: config.deadline_steps },
    agent_mints: sample(rng("mints"), config.mints, config.agent_mints).sort(),
    providers,
  };
}

interface Offer { id: string; provider: string; amount_sats: number; bolt11: string | null; step: number; }
interface Payment { offer: string; provider: string; amount_sats: number; via: string; mint: string | null; step: number; lost: boolean; }

export class CounterpartyEnv extends NostrEnv {
  readonly task = "nostr/counterparty";
  readonly seed: number;
  private readonly fixture: CounterpartyFixture;
  private step_ = 0;
  private requestedAt: number | null = null;
  private bid = 0;
  private readonly payments: Payment[] = [];
  private readonly fetched = new Set<string>();
  protected readonly toolTable;

  constructor(fixture: CounterpartyFixture, config: CounterpartyConfig) {
    super({ attempts: config.budget.attempts, probes: config.budget.probes, blocks: fixture.job.deadline_steps, sats: config.budget.sats });
    this.fixture = fixture;
    this.seed = fixture.seed;
    this.toolTable = {
      fetch: { cost: "probes" as const, handler: (a: Record<string, unknown>) => this.fetch(a) },
      request: { cost: "attempts" as const, handler: (a: Record<string, unknown>) => this.request(a) },
      pay: { cost: "attempts" as const, handler: (a: Record<string, unknown>) => this.pay(a) },
      wait: { cost: "free" as const, handler: (a: Record<string, unknown>) => this.wait(a) },
    };
  }

  private provider(x: unknown): Provider | undefined {
    if (typeof x !== "string") return undefined;
    return this.fixture.providers.find((p) => p.pubkey === x || npub(p.pubkey) === x);
  }

  private offers(): Offer[] {
    if (this.requestedAt === null) return [];
    return this.fixture.providers
      .filter((p) => p.price_sats <= this.bid && this.requestedAt! + p.delay <= this.step_)
      .map((p) => ({ id: `f-${p.pubkey.slice(0, 12)}`, provider: p.pubkey, amount_sats: p.price_sats, bolt11: p.bolt11 ? `lnbcsim${p.price_sats}n1p${p.pubkey.slice(0, 8)}` : null, step: this.requestedAt! + p.delay }))
      .sort((a, b) => a.step - b.step || (a.provider < b.provider ? -1 : 1));
  }

  private results(at: number): Array<{ provider: string; step: number }> {
    const out: Array<{ provider: string; step: number }> = [];
    for (const pay of this.payments) {
      const p = this.fixture.providers.find((x) => x.pubkey === pay.provider)!;
      if (!pay.lost && p.delivers && pay.step + p.latency <= at) out.push({ provider: p.pubkey, step: pay.step + p.latency });
    }
    return out.sort((a, b) => a.step - b.step || (a.provider < b.provider ? -1 : 1));
  }

  private fetch(a: Record<string, unknown>): StepResult {
    const p = this.provider(a.provider);
    if (!p) return reject("unknown_id");
    this.fetched.add(p.pubkey);
    return accept({
      provider: p.pubkey,
      profile: { name: p.name, picture: p.picture, nip05: p.nip05, nip05_verified: p.nip05_valid },
      mints_10019: p.mints,
      record: { ...p.stats },
    });
  }

  private request(a: Record<string, unknown>): StepResult {
    const bid = a.bid_sats;
    if (typeof bid !== "number" || !Number.isInteger(bid) || bid <= 0) return reject("not_integer");
    if (this.requestedAt !== null) return reject("duplicate");
    this.requestedAt = this.step_;
    this.bid = bid;
    return accept({ request: "job-1", kind: this.fixture.job.kind, bid_sats: bid, step: this.step_ });
  }

  private pay(a: Record<string, unknown>): StepResult {
    if (typeof a.offer !== "string") return reject("malformed");
    const offer = this.offers().find((o) => o.id === a.offer);
    if (!offer) return reject("unknown_id");
    if (this.payments.some((p) => p.offer === offer.id)) return reject("duplicate");
    if (offer.amount_sats > this.sats) return reject("over_budget");
    const p = this.fixture.providers.find((x) => x.pubkey === offer.provider)!;
    let mint: string | null = null;
    let lost = false;
    if (a.via === "nwc") {
      if (offer.bolt11 === null) return reject("malformed", { detail: "this offer carries no invoice; pay by nutzap at a mint the provider lists" });
    } else if (a.via === "nutzap") {
      if (typeof a.mint !== "string" || !this.fixture.agent_mints.includes(a.mint)) return reject("unknown_id", { detail: "you hold no ecash at that mint" });
      mint = a.mint;
      lost = !p.mints.includes(a.mint); // the provider never redeems a nutzap at a mint it does not list
    } else return reject("malformed");
    this.sats -= offer.amount_sats;
    this.payments.push({ offer: offer.id, provider: p.pubkey, amount_sats: offer.amount_sats, via: a.via, mint, step: this.step_, lost });
    return accept({ offer: offer.id, paid_sats: offer.amount_sats, via: a.via });
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
      job: f.job as unknown as Json,
      step: this.step_,
      wallet: { mints: f.agent_mints },
      providers: f.providers.map((p) => ({ pubkey: p.pubkey, npub: npub(p.pubkey), name: p.name })) as unknown as Json,
      requested: this.requestedAt !== null,
      offers: this.offers() as unknown as Json,
      payments: this.payments.map((p) => ({ offer: p.offer, provider: p.provider, amount_sats: p.amount_sats, via: p.via, step: p.step })) as unknown as Json,
      results: this.results(this.step_) as unknown as Json,
    };
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    const delivered = this.results(this.fixture.job.deadline_steps).length > 0;
    const paid = this.payments.reduce((a, p) => a + p.amount_sats, 0);
    return {
      value: (delivered ? this.fixture.job.value_sats : 0) - paid,
      metrics: { delivered: delivered ? 1 : 0, paid_sats: paid, payments: this.payments.length, paid_impostor: this.payments.filter((p) => this.fixture.providers.find((x) => x.pubkey === p.provider)!.impostor).length, lost_nutzaps: this.payments.filter((p) => p.lost).length, fetched: this.fetched.size },
    };
  }

  protected state(): Json { return { step: this.step_, requestedAt: this.requestedAt, bid: this.bid, payments: this.payments as unknown as Json, fetched: [...this.fetched].sort() }; }
  privileged(): Json { return { providers: this.fixture.providers.map((p) => ({ pubkey: p.pubkey, delivers: p.delivers, latency: p.latency, delay: p.delay, impostor: p.impostor })) as unknown as Json }; }
}

/** The best attainable: pay, as early as it can be paid, the cheapest provider that delivers in time. */
export function counterpartyCeiling(f: CounterpartyFixture): number {
  let best = 0;
  for (const p of f.providers) {
    if (!p.delivers) continue;
    if (!p.bolt11 && !p.mints.some((m) => f.agent_mints.includes(m))) continue;
    if (p.delay + p.latency > f.job.deadline_steps) continue;
    best = Math.max(best, f.job.value_sats - p.price_sats);
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Baselines.

interface CView {
  job: { value_sats: number; deadline_steps: number };
  step: number;
  wallet: { mints: string[] };
  providers: Array<{ pubkey: string; name: string }>;
  requested: boolean;
  offers: Offer[];
  payments: Array<{ offer: string; provider: string; step: number }>;
  results: Array<{ provider: string }>;
}
interface CLast { accepted: boolean; result: { provider?: string; mints_10019?: string[]; record?: Provider["stats"]; profile?: { nip05_verified: boolean } } | null; }

abstract class Buyer implements Agent {
  abstract readonly id: string;
  protected info = new Map<string, { mints: string[]; record: Provider["stats"]; verified: boolean }>();
  private toFetch: string[] | null = null;
  protected readonly fetchesRecords: boolean = false;
  reset(e?: { seed: number }, privileged?: Json): void { this.info = new Map(); this.toFetch = null; this.onReset(e?.seed ?? 0, privileged); }
  protected onReset(_seed: number, _privileged?: Json): void {}
  /** Which offer to pay now, or null to wait. */
  protected abstract choose(v: CView): Offer | null;
  /** How long to wait for offers before choosing. */
  protected collectSteps(): number { return 3; }

  act(o: Json): Json {
    const obs = o as unknown as { view: CView; budget: { blocks: number }; last: CLast | null };
    const v = obs.view;
    if (obs.last?.accepted && obs.last.result?.provider && obs.last.result.record) {
      this.info.set(obs.last.result.provider, { mints: obs.last.result.mints_10019 ?? [], record: obs.last.result.record, verified: obs.last.result.profile?.nip05_verified ?? false });
    }
    if (this.fetchesRecords) {
      if (this.toFetch === null) this.toFetch = v.providers.map((p) => p.pubkey);
      const next = this.toFetch.shift();
      if (next) return { tool: "fetch", args: { provider: next } };
    }
    if (!v.requested) return { tool: "request", args: { bid_sats: Math.floor(v.job.value_sats / 2) } };
    if (v.results.length > 0) return { tool: "commit" };
    if (v.step >= this.collectSteps()) {
      const offer = this.choose(v);
      if (offer) {
        const pay = this.payArgs(v, offer);
        if (pay) return { tool: "pay", args: pay };
      }
    }
    if (obs.budget.blocks <= 0) return { tool: "commit" };
    return { tool: "wait", args: { steps: 1 } };
  }

  protected unpaid(v: CView): Offer[] { return v.offers.filter((x) => !v.payments.some((p) => p.offer === x.id) && this.payable(v, x)); }
  protected payable(v: CView, offer: Offer): boolean {
    if (offer.bolt11) return true;
    const mints = this.info.get(offer.provider)?.mints;
    return mints === undefined ? v.wallet.mints.length > 0 : mints.some((m) => v.wallet.mints.includes(m));
  }
  private payArgs(v: CView, offer: Offer): Json | null {
    if (offer.bolt11) return { offer: offer.id, via: "nwc" };
    const known = this.info.get(offer.provider)?.mints;
    const mint = (known ? v.wallet.mints.find((m) => known.includes(m)) : v.wallet.mints[0]) ?? null;
    return mint ? { offer: offer.id, via: "nutzap", mint } : null;
  }
  /** Wait for a result after paying, for at most this many steps, before paying another. */
  protected patience(): number { return 10; }
  protected waitingOnPayment(v: CView): boolean {
    const lastPay = v.payments[v.payments.length - 1];
    return lastPay !== undefined && v.step - lastPay.step < this.patience();
  }
}

export class FirstOffer extends Buyer {
  readonly id = "first_offer";
  protected override collectSteps(): number { return 0; }
  protected choose(v: CView): Offer | null { return v.payments.length > 0 ? null : (this.unpaid(v)[0] ?? null); }
}

export class RandomBuyer extends Buyer {
  readonly id = "random";
  private rng: Stream = stream(VERSION_TAG, "baseline", "counterparty", "random", 0);
  protected override onReset(seed: number): void { this.rng = stream(VERSION_TAG, "baseline", "counterparty", "random", seed); }
  protected choose(v: CView): Offer | null {
    if (v.payments.length > 0) return null;
    const pool = this.unpaid(v);
    return pool.length ? this.rng.pick(pool) : null;
  }
}

/** The lowest price, then the next lowest after a silence. */
export class Cheapest extends Buyer {
  readonly id = "cheapest";
  protected choose(v: CView): Offer | null {
    if (this.waitingOnPayment(v)) return null;
    return [...this.unpaid(v)].sort((a, b) => a.amount_sats - b.amount_sats || (a.provider < b.provider ? -1 : 1))[0] ?? null;
  }
}

/** Reads each provider's public record and pays the best estimated value for money; skips unverified NIP-05. */
export class Reputation extends Buyer {
  readonly id = "reputation";
  protected override readonly fetchesRecords = true;
  protected choose(v: CView): Offer | null {
    if (this.waitingOnPayment(v)) return null;
    const score = (o: Offer): number => {
      const i = this.info.get(o.provider);
      if (!i || !i.verified) return -Infinity;
      const r = i.record;
      const q = (r.results + 1) / (r.results + r.errors + 2);
      return v.job.value_sats * q - o.amount_sats;
    };
    const ranked = this.unpaid(v).filter((o) => score(o) > 0).sort((a, b) => score(b) - score(a) || (a.provider < b.provider ? -1 : 1));
    return ranked[0] ?? null;
  }
}

/** Ceiling, privileged: knows who delivers and when; pays the cheapest provider that delivers in time, as soon as its offer arrives. */
export class OracleBuyer extends Buyer {
  readonly id = "oracle";
  readonly privileged = true;
  protected override readonly fetchesRecords = true;
  private truth = new Map<string, { delivers: boolean; latency: number; delay: number }>();
  protected override onReset(_seed: number, privileged?: Json): void {
    const p = (privileged ?? { providers: [] }) as { providers: Array<{ pubkey: string; delivers: boolean; latency: number; delay: number }> };
    this.truth = new Map(p.providers.map((x) => [x.pubkey, x]));
  }
  protected override collectSteps(): number { return 0; }
  protected choose(v: CView): Offer | null {
    if (v.payments.length > 0) return null;
    // The target is fixed by the truth and the prices, which the offers reveal as they arrive; a
    // provider whose offer is still on its way is waited for, since its delay is known.
    const prices = new Map(v.offers.map((o) => [o.provider, o.amount_sats]));
    const feasible = [...this.truth.entries()].filter(([pk, t]) => t.delivers && t.delay + t.latency <= v.job.deadline_steps && this.payableProvider(v, pk));
    if (feasible.some(([pk]) => !prices.has(pk))) {
      const pending = feasible.filter(([pk]) => !prices.has(pk));
      if (pending.some(([, t]) => t.delay > v.step)) return null;
    }
    const offers = v.offers.filter((o) => feasible.some(([pk]) => pk === o.provider));
    return [...offers].sort((x, y) => x.amount_sats - y.amount_sats || (x.provider < y.provider ? -1 : 1))[0] ?? null;
  }
  private payableProvider(v: CView, pk: string): boolean {
    const m = this.info.get(pk)?.mints;
    return m === undefined || m.length === 0 || m.some((x) => v.wallet.mints.includes(x));
  }
}

export const counterpartyBaselines = (): Agent[] => [new Idle(), new FirstOffer(), new RandomBuyer(), new Cheapest(), new Reputation(), new OracleBuyer()];
