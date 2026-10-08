// Family 10: designing a numeric DLC (docs/tasks.md §11). The agent sees the contract, the forecast,
// and the menus; it may probe designs for their CET count and expected costs, and offers one design,
// scored by its expected cost in sats. An invalid design is rejected whole and offers nothing.

import { accept, reject, type Budget, type Environment, type Outcome, type StepResult } from "../../harness/agent.ts";
import { canonical, isObject, type Json } from "../../harness/json.ts";
import { evaluateDesign, type Costs, type Design, type Menu } from "./contract.ts";
import { designJson, menuOf, modelFor, parseDesign, specDefault, type DlcView } from "./designs.ts";
import type { DlcConfig, DlcFixture } from "./generate.ts";

/** Native value: −ln of the expected cost in sats, with a floor of one sat. */
export const valueOf = (cost: number): number => 0 - Math.log(Math.max(cost, 1));

export function viewOf(fixture: DlcFixture): DlcView {
  const model = modelFor(fixture.contract);
  return {
    contract: JSON.parse(JSON.stringify(fixture.contract)) as DlcFixture["contract"],
    oracle: { base: 2, max_outcome: model.maxOutcome, unit: "USD per BTC" },
    offerer_collateral_sats: model.offererCollateral,
    breakpoints: fixture.breakpoints.map((b) => ({ begin_interval: b, below_probability: model.cdf(b - 1) })),
    rounding_mods: [...fixture.rounding_mods],
    collateral_options: fixture.collateral_options.map((c) => ({ collateral_sats: c.collateral_sats, floor_price_usd: c.floor_price_usd, below_probability: model.cdf(c.floor_price_usd - 1) })),
  };
}

export class DlcEnv implements Environment {
  readonly task: string;
  readonly seed: number;
  readonly cell = "single";
  private readonly fixture: DlcFixture;
  private readonly config: DlcConfig;
  private readonly menu: Menu;
  private attempts: number;
  private probes: number;
  private closed = false;
  private design: Design | null = null;
  private readonly probed: string[] = [];

  constructor(fixture: DlcFixture, config: DlcConfig) {
    this.task = `dlc/${fixture.cell}`;
    this.seed = fixture.seed;
    this.fixture = fixture;
    this.config = config;
    this.menu = { breakpoints: [...fixture.breakpoints], rounding_mods: [...fixture.rounding_mods], collateral_options: fixture.collateral_options.map((c) => c.collateral_sats) };
    this.attempts = config.budget.attempts;
    this.probes = config.budget.probes;
  }

  budget(): Budget { return { attempts: this.attempts, probes: this.probes, blocks: 0, sats: 0 }; }

  tools(): string[] { return ["probe", "offer", "commit"]; }

  view(): Json { return viewOf(this.fixture) as unknown as Json; }

  done(): boolean { return this.closed; }

  private spendAttempt(): void {
    this.attempts -= 1;
    if (this.attempts === 0) this.closed = true;
  }

  private evaluate(design: Design): Costs { return evaluateDesign(modelFor(this.fixture.contract), design); }

  private report(costs: Costs): Json { return { ...costs } as unknown as Json; }

  step(action: unknown): StepResult {
    if (this.closed) return reject("phase_closed");
    if (isObject(action) && action.tool === "commit") { this.closed = true; return accept(); }
    if (!isObject(action) || typeof action.tool !== "string") { this.spendAttempt(); return reject("malformed"); }
    if (action.tool !== "probe" && action.tool !== "offer") { this.spendAttempt(); return reject("unknown_tool"); }
    if (action.tool === "probe") {
      if (this.probes === 0) { this.spendAttempt(); return reject("over_budget"); }
      this.probes -= 1;
    } else {
      this.spendAttempt();
    }
    const parsed = parseDesign(action.args, this.menu);
    if ("reason" in parsed) return reject(parsed.reason, { detail: parsed.detail });
    const costs = this.evaluate(parsed.design);
    if (!Number.isFinite(costs.cets)) return reject("out_of_grid", { detail: "the payout is constant over the whole domain, which is not a DLC" });
    if (action.tool === "probe") {
      this.probed.push(canonical(designJson(parsed.design)));
      return accept(this.report(costs));
    }
    this.design = parsed.design;
    this.closed = true;
    return accept(this.report(costs));
  }

  /** The floor policy's cost, which also prices an episode that ends with no design offered. */
  floorCost(): number {
    return this.evaluate(specDefault(viewOf(this.fixture), this.config.default_floor_ratio)).total_sats;
  }

  finish(): Outcome {
    if (!this.closed) throw new Error("finish called before the decision phase ended");
    const costs = this.design ? this.evaluate(this.design) : null;
    const cost = costs ? costs.total_sats : this.config.infeasible_penalty_factor * this.floorCost();
    return {
      value: valueOf(cost),
      metrics: {
        cost_sats: cost,
        offered: costs ? 1 : 0,
        cets: costs ? costs.cets : 0,
        collateral_sats: this.design ? this.design.collateral_sats : 0,
        capital_sats: costs ? costs.capital_sats : 0,
        shortfall_sats: costs ? costs.shortfall_sats : 0,
        tracking_sats: costs ? costs.tracking_sats : 0,
        signing_sats: costs ? costs.signing_sats : 0,
        probes_used: this.config.budget.probes - this.probes,
      },
    };
  }

  snapshot(): string { return canonical({ design: this.design ? designJson(this.design) : null, probed: this.probed }); }

  privileged(): Json { return {}; }
}
