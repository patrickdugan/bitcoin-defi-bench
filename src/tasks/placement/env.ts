// Family 1: directional placement (docs/tasks.md §2). One episode: the harness routes the warm-up
// demands, the agent sees the public graph and the demand history and commits capital to directed
// pairs, and the evaluation demands are then routed over the result. The agent never sees
// capacity, balance, the failing edge of a failed path, the hotspot pairs, the regime, or future
// demand.
//
// The capital budget is held in Spiral's SettlementLedger: funded to class U, and each accepted
// placement is a U→C event. An over-budget placement is refused before any hold is placed, and
// cross-class conservation (Proposition S1) is checked at the end of every episode.

import { SettlementLedger, conservationGap } from "../../../vendor/spiral/model/ledger.ts";
import { accept, reject, type Budget, type Environment, type Outcome, type RejectReason, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, type Json } from "../../harness/json.ts";
import { cmp } from "../../harness/order.ts";
import type { BalanceModel, Demand, PlacementConfig, PlacementFixture, Regime } from "./generate.ts";
import { Network } from "./network.ts";
import { PathCatalog } from "./paths.ts";
import { retryWallet } from "./router.ts";

export interface Placement { from: string; to: string; sats: number; }

interface HistoryEntry { i: number; source: string; target: string; sats: number; delivered: boolean; failed_attempts: number; }

interface WarmUp { net: Network; history: HistoryEntry[]; }

const OPERATOR = "operator";
const baseCatalogs = new WeakMap<PlacementFixture, PathCatalog>();
const warmUps = new WeakMap<PlacementFixture, Map<BalanceModel, WarmUp>>();

function baseCatalog(fixture: PlacementFixture, config: PlacementConfig): PathCatalog {
  let catalog = baseCatalogs.get(fixture);
  if (!catalog) {
    // The public graph is the same under every balance model, so one catalog serves the fixture.
    catalog = new PathCatalog(Network.fromFixture(fixture, "uniform").adjacency(), config.candidate_path_limit);
    baseCatalogs.set(fixture, catalog);
  }
  return catalog;
}

/** Route the warm-up demands. Identical under both regimes, which differ only after the boundary. */
function warmUp(fixture: PlacementFixture, model: BalanceModel, config: PlacementConfig): WarmUp {
  if (!warmUps.has(fixture)) warmUps.set(fixture, new Map());
  const cache = warmUps.get(fixture)!;
  let warm = cache.get(model);
  if (!warm) {
    const net = Network.fromFixture(fixture, model);
    const catalog = baseCatalog(fixture, config);
    const history: HistoryEntry[] = [];
    for (let i = 0; i < config.evaluation_start; i++) {
      const demand = fixture.demand.stationary[i]!;
      const r = retryWallet(net, catalog, demand, config.max_route_attempts);
      history.push({ i, source: demand[0], target: demand[1], sats: demand[2], delivered: r.delivered, failed_attempts: r.failedAttempts });
    }
    warm = { net, history };
    cache.set(model, warm);
  }
  return warm;
}

/** The warm-up record an agent is shown as demand history. */
export function warmUpHistory(fixture: PlacementFixture, model: BalanceModel, config: PlacementConfig): ReadonlyArray<Readonly<HistoryEntry>> {
  return warmUp(fixture, model, config).history;
}

/**
 * The simulator without the agent interface: apply placements to the post-warm-up state and route
 * the evaluation demands. PlacementEnv.finish calls this with what the agent committed; the K5
 * identity check calls it directly with the same placements and requires the same outcome.
 */
export function evaluatePlacements(fixture: PlacementFixture, model: BalanceModel, regime: Regime, config: PlacementConfig, placements: readonly Placement[]): Outcome {
  const warm = warmUp(fixture, model, config);
  const net = warm.net.clone();
  // Aggregate per directed pair and apply in canonical order, so the order of entries in an action cannot matter.
  const byDirection = new Map<string, Placement>();
  for (const p of placements) {
    const key = `${p.from}>${p.to}`;
    const existing = byDirection.get(key);
    if (existing) existing.sats += p.sats; else byDirection.set(key, { ...p });
  }
  const before = net.totalCapacity();
  let placed = 0;
  for (const key of [...byDirection.keys()].sort(cmp)) {
    const p = byDirection.get(key)!;
    net.addCapacity(p.from, p.to, p.sats, config.new_channel_policy);
    placed += p.sats;
  }
  if (net.totalCapacity() !== before + placed) throw new Error("placement changed capacity by more than the committed capital");
  const catalog = placed === 0 ? baseCatalog(fixture, config) : new PathCatalog(net.adjacency(), config.candidate_path_limit);
  const demands: Demand[] = fixture.demand[regime].slice(config.evaluation_start, config.steps);
  let delivered = 0;
  let deliveredSats = 0;
  let attemptedSats = 0;
  let failedAttempts = 0;
  for (const demand of demands) {
    const r = retryWallet(net, catalog, demand, config.max_route_attempts);
    attemptedSats += demand[2];
    failedAttempts += r.failedAttempts;
    if (r.delivered) { delivered += 1; deliveredSats += demand[2]; }
  }
  net.assertInvariants();
  if (net.totalCapacity() !== before + placed) throw new Error("payment rewrite changed channel capacity");
  return {
    value: (100 * delivered) / demands.length,
    metrics: {
      delivered, demands: demands.length, placed_sats: placed, failed_attempts: failedAttempts,
      volume_share: (100 * deliveredSats) / attemptedSats,
    },
  };
}

export class PlacementEnv implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell: string;
  private readonly fixture: PlacementFixture;
  private readonly model: BalanceModel;
  private readonly regime: Regime;
  private readonly config: PlacementConfig;
  private readonly warm: WarmUp;
  private readonly nodes: Set<string>;
  private readonly ledger = new SettlementLedger();
  private readonly placements: Placement[] = [];
  private attempts: number;
  private closed = false;

  constructor(fixture: PlacementFixture, model: BalanceModel, regime: Regime, config: PlacementConfig) {
    this.task = `placement/${regime}`;
    this.seed = fixture.seed;
    this.cell = model;
    this.fixture = fixture;
    this.model = model;
    this.regime = regime;
    this.config = config;
    this.warm = warmUp(fixture, model, config);
    this.nodes = new Set(fixture.nodes);
    this.attempts = config.attempts;
    this.ledger.fund("U", OPERATOR, config.budget_sats);
  }

  budget(): Budget {
    return { attempts: this.attempts, probes: 0, blocks: 0, sats: this.ledger.available("U", OPERATOR) };
  }

  tools(): string[] {
    return ["place", "commit"];
  }

  view(): Json {
    return {
      nodes: this.fixture.nodes,
      edges: this.fixture.edges.map((e) => ({ ...e })),
      history: this.warm.history.map((h) => ({ ...h })),
      horizon: { warmup: this.config.evaluation_start, evaluation: this.config.steps - this.config.evaluation_start },
      rules: {
        min_pair_sats: this.config.min_pair_sats,
        existing_edges_allowed: true,
        new_channel_policy: { ...this.config.new_channel_policy },
      },
    };
  }

  done(): boolean {
    return this.closed;
  }

  /** First reason a place action is invalid, or the parsed entries. No state is touched here. */
  private validate(args: unknown): RejectReason | Placement[] {
    if (!isObject(args) || !Array.isArray(args.placements) || args.placements.length === 0) return "malformed";
    const entries: Placement[] = [];
    for (const raw of args.placements as unknown[]) {
      if (!isObject(raw) || typeof raw.from !== "string" || typeof raw.to !== "string" || typeof raw.sats !== "number") return "malformed";
      entries.push({ from: raw.from, to: raw.to, sats: raw.sats });
    }
    for (const p of entries) {
      if (!this.nodes.has(p.from) || !this.nodes.has(p.to)) return "unknown_node";
      if (p.from === p.to) return "self_pair";
      if (!Number.isInteger(p.sats) || p.sats <= 0) return "not_integer";
    }
    const total = entries.reduce((a, p) => a + p.sats, 0);
    if (total > this.ledger.available("U", OPERATOR)) return "over_budget";
    // A pair with no existing channel must end up with at least the minimum channel size.
    const perPair = new Map<string, number>();
    for (const p of [...this.placements, ...entries]) {
      const key = p.from < p.to ? `${p.from}|${p.to}` : `${p.to}|${p.from}`;
      perPair.set(key, (perPair.get(key) ?? 0) + p.sats);
    }
    for (const p of entries) {
      if (this.warm.net.has(p.from, p.to)) continue;
      const key = p.from < p.to ? `${p.from}|${p.to}` : `${p.to}|${p.from}`;
      if (perPair.get(key)! < this.config.min_pair_sats) return "below_minimum";
    }
    return entries;
  }

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (isObject(action) && action.tool === "commit") {
      this.closed = true;
      return accept();
    }
    // Every other submission costs one attempt, whether or not it is accepted.
    this.attempts -= 1;
    if (this.attempts === 0) this.closed = true;
    if (!isObject(action) || typeof action.tool !== "string") return reject("malformed");
    if (action.tool !== "place") return reject("unknown_tool");
    const checked = this.validate(action.args);
    if (typeof checked === "string") return reject(checked);
    // All checks have passed; the ledger's own guard is a second line, not the first.
    for (const p of checked) {
      this.ledger.initiate({
        id: `p${this.placements.length}`,
        from: { cls: "U", holder: OPERATOR }, to: { cls: "C", holder: OPERATOR },
        amount: p.sats, fee: 0, clock: { kind: "confirmations", required: 0 },
      });
      this.placements.push(p);
    }
    return accept({ placed_sats: checked.reduce((a, p) => a + p.sats, 0), remaining_sats: this.ledger.available("U", OPERATOR) });
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    for (const ev of this.ledger.pending()) this.ledger.settle(ev.id);
    const placed = this.placements.reduce((a, p) => a + p.sats, 0);
    if (conservationGap(this.ledger.snapshot()) !== 0 || this.ledger.balance("C", OPERATOR) !== placed) {
      throw new Error("capital ledger does not conserve");
    }
    return evaluatePlacements(this.fixture, this.model, this.regime, this.config, this.placements);
  }

  snapshot(): string {
    return canonical({ net: this.warm.net.snapshot(), ledger: this.ledger, placements: this.placements });
  }

  privileged(): Json {
    const pair = this.regime === "shift" ? this.fixture.hotspots.second : this.fixture.hotspots.first;
    return { evaluation_hotspot: [...pair], forward_probability: this.config.hotspot_forward_probability };
  }
}
