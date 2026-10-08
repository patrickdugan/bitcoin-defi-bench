// Family 2: routing under hidden state (docs/tasks.md §3). The agent routes all 220 demands of a
// family 1 topology, with no placement, three attempts per demand, and terminal feedback only:
// delivered or not, never the failing edge. The last 110 demands are scored. A failed attempt and a
// rejected action change no balance; a delivered payment moves the same amount on every hop.

import { accept, reject, type Budget, type Environment, type Outcome, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, sha256, type Json } from "../../harness/json.ts";
import { cmpSeq } from "../../harness/order.ts";

/** A 48-bit digest of a delivery sequence, exact as a number, so rows can be compared trajectory by trajectory. */
export const deliveryHash = (deliveries: readonly boolean[]): number => parseInt(sha256(deliveries.map((d) => (d ? "1" : "0")).join("")).slice(0, 12), 16);
import type { BalanceModel, Demand, PlacementConfig, PlacementFixture } from "../placement/generate.ts";
import { Network } from "../placement/network.ts";
import { PathCatalog } from "../placement/paths.ts";
import type { RoutingRegime } from "./generate.ts";

export interface Candidate { index: number; path: string[]; fee_msat: number; hops: number; }
export interface Attempt { candidate: number; delivered: boolean; }
export interface HistoryEntry { i: number; source: string; target: string; sats: number; attempts: Attempt[]; delivered: boolean; skipped: boolean; }

export interface RoutingView {
  demand: { i: number; source: string; target: string; sats: number; scored: boolean };
  attempts_left: number;
  tried: Attempt[];
  candidates: Candidate[];
  history: HistoryEntry[];
  horizon: { demands: number; evaluation_start: number };
}

/** Candidates in the order a public wallet would try them: (fee, hop count, node sequence). */
export const publicOrder = (candidates: readonly Candidate[]): Candidate[] =>
  [...candidates].sort((a, b) => a.fee_msat - b.fee_msat || a.hops - b.hops || cmpSeq(a.path, b.path));

const catalogs = new WeakMap<PlacementFixture, PathCatalog>();
export function catalogOf(fixture: PlacementFixture, config: PlacementConfig): PathCatalog {
  let c = catalogs.get(fixture);
  if (!c) { c = new PathCatalog(Network.fromFixture(fixture, "uniform").adjacency(), config.candidate_path_limit); catalogs.set(fixture, c); }
  return c;
}

export function candidatesFor(net: Network, catalog: PathCatalog, demand: Demand): Candidate[] {
  const [source, target, sats] = demand;
  return catalog.paths(source, target).map((path, index) => ({ index, path, fee_msat: net.costMsat(path, sats), hops: path.length - 1 }));
}

export class RoutingEnv implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell = "single";
  private readonly fixture: PlacementFixture;
  private readonly demands: Demand[];
  private readonly config: PlacementConfig;
  private readonly model: BalanceModel;
  private readonly net: Network;
  private readonly catalog: PathCatalog;
  private i = 0;
  private tried: Attempt[] = [];
  private readonly history: HistoryEntry[] = [];
  private attemptsLeft: number;
  private closed = false;

  constructor(fixture: PlacementFixture, demands: Demand[], model: BalanceModel, regime: RoutingRegime, config: PlacementConfig) {
    this.task = `routing/${model}/${regime}`;
    this.seed = fixture.seed;
    this.fixture = fixture;
    this.demands = demands;
    this.config = config;
    this.model = model;
    this.net = Network.fromFixture(fixture, model);
    this.catalog = catalogOf(fixture, config);
    this.attemptsLeft = config.max_route_attempts * config.steps;
  }

  budget(): Budget { return { attempts: this.attemptsLeft, probes: 0, blocks: 0, sats: 0 }; }

  tools(): string[] { return ["attempt", "skip"]; }

  private candidates(): Candidate[] { return candidatesFor(this.net, this.catalog, this.demands[this.i]!); }

  view(): Json {
    const [source, target, sats] = this.demands[this.i]!;
    const v: RoutingView = {
      demand: { i: this.i, source, target, sats, scored: this.i >= this.config.evaluation_start },
      attempts_left: this.config.max_route_attempts - this.tried.length,
      tried: this.tried.map((t) => ({ ...t })),
      candidates: this.candidates(),
      history: this.history.map((h) => ({ ...h, attempts: h.attempts.map((a) => ({ ...a })) })),
      horizon: { demands: this.config.steps, evaluation_start: this.config.evaluation_start },
    };
    return v as unknown as Json;
  }

  done(): boolean { return this.closed; }

  private finishDemand(delivered: boolean, skipped: boolean): void {
    const [source, target, sats] = this.demands[this.i]!;
    this.history.push({ i: this.i, source, target, sats, attempts: this.tried, delivered, skipped });
    this.i += 1;
    this.tried = [];
    if (this.i >= this.config.steps) this.closed = true;
  }

  /** Spend one of the demand's attempts without routing anything; the demand fails when they run out. */
  private spend(): void {
    this.attemptsLeft -= 1;
    this.tried.push({ candidate: -1, delivered: false });
    if (this.tried.length >= this.config.max_route_attempts) this.finishDemand(false, false);
  }

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (!isObject(action) || typeof action.tool !== "string") { this.spend(); return reject("malformed"); }
    if (action.tool === "skip") { this.finishDemand(false, true); return accept({ skipped: true }); }
    if (action.tool !== "attempt") { this.spend(); return reject("unknown_tool"); }
    const raw = isObject(action.args) ? action.args.candidate : undefined;
    if (typeof raw !== "number") { this.spend(); return reject("malformed"); }
    if (!Number.isInteger(raw)) { this.spend(); return reject("not_integer"); }
    const candidates = this.candidates();
    if (raw < 0 || raw >= candidates.length) { this.spend(); return reject("out_of_grid"); }
    const path = candidates[raw]!.path;
    const sats = this.demands[this.i]![2];
    this.attemptsLeft -= 1;
    if (this.net.feasible(path, sats)) {
      this.net.apply(path, sats);
      this.tried.push({ candidate: raw, delivered: true });
      this.finishDemand(true, false);
      return accept({ delivered: true });
    }
    this.tried.push({ candidate: raw, delivered: false });
    if (this.tried.length >= this.config.max_route_attempts) this.finishDemand(false, false);
    return accept({ delivered: false });
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    this.net.assertInvariants();
    const scored = this.history.filter((h) => h.i >= this.config.evaluation_start);
    const delivered = scored.filter((h) => h.delivered).length;
    const failedAttempts = scored.reduce((n, h) => n + h.attempts.filter((a) => !a.delivered).length, 0);
    return {
      value: (100 * delivered) / scored.length,
      metrics: {
        delivered,
        demands: scored.length,
        failed_attempts: failedAttempts,
        skipped: scored.filter((h) => h.skipped).length,
        delivered_total: this.history.filter((h) => h.delivered).length,
        delivery_hash: deliveryHash(this.deliveries()),
      },
    };
  }

  /** The sequence of delivery outcomes, for the identity control. */
  deliveries(): boolean[] { return this.history.map((h) => h.delivered); }

  snapshot(): string { return canonical({ net: this.net.snapshot(), i: this.i, tried: this.tried, history: this.history }); }

  /** For the hidden-state oracles only: the hidden capacities and balances at the start of the episode. */
  privileged(): Json {
    return { capacity: [...this.fixture.capacity], balance_uv: [...this.fixture.balance_uv[this.model]] } as unknown as Json;
  }
}
