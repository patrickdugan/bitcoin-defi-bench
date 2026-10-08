// Family 2 report: nine tasks (three balance models × three regimes), the calibration gates, and
// the identity control. Not yet frozen: contrasts are declared and descriptive until an amendment.
//
// Gates, written before any family 2 run:
// - K21: `retry_wallet` − `one_shot`, pooled over the nine tasks per seed: point estimate in
//   [2.0, 8.0] and unadjusted interval above zero. Spiral measured +5.14 (3.08 to 7.20); the window
//   is that estimate plus or minus about three points, as family 1's K1 window was set.
// - K22: `hidden_state_oracle` − `retry_wallet`, pooled: unadjusted interval above zero. Spiral did
//   not measure it directly; its learner and filtering effects sum to about +1.46.
// - K23: identity. `retry_wallet` through `act` delivers, demand by demand, exactly what family 1's
//   own router (placement/router.ts, `retryWallet`) delivers run directly on the fixture, and
//   `prefix_oracle_3` delivers exactly the same: the audit's trajectory-equality check.

import type { EpisodeRow } from "../../harness/episode.ts";
import type { Manifest } from "../../harness/manifest.ts";
import type { Check, RunRecord, TaskSpec } from "../../harness/run.ts";
import { clusterInterval } from "../../harness/stats.ts";
import { checkOf, type Analysis, type ContrastSpec, type Gate, type ReportSpec } from "../../harness/table.ts";
import { BALANCE_MODELS, type BalanceModel, type PlacementConfig } from "../placement/generate.ts";
import { Network } from "../placement/network.ts";
import { retryWallet } from "../placement/router.ts";
import { placementFixture } from "../placement/task.ts";
import { catalogOf, deliveryHash } from "./env.ts";
import { ROUTING_REGIMES, type RoutingRegime } from "./generate.ts";
import { ROUTING_BAND, demandsFor, routingEpisodes } from "./task.ts";

export const K21_WINDOW: readonly [number, number] = [2.0, 8.0];

const taskOf = (model: BalanceModel, regime: RoutingRegime): string => `routing/${model}/${regime}`;

export function routingTasks(): Array<{ model: BalanceModel; regime: RoutingRegime; task: string }> {
  return BALANCE_MODELS.flatMap((model) => ROUTING_REGIMES.map((regime) => ({ model, regime, task: taskOf(model, regime) })));
}

export function routingTaskSpecs(root: string, manifest: Manifest, config: PlacementConfig): TaskSpec[] {
  return routingTasks().map(({ model, regime, task }) => ({
    task,
    unit: "success rate over the 110 evaluation demands, in percentage points",
    band: ROUTING_BAND,
    floor: "one_shot",
    ceiling: "hidden_state_oracle",
    reference: "retry_wallet",
    metrics: ["delivered", "failed_attempts", "skipped"],
    episodes: (seed: number) => routingEpisodes(root, manifest, config, model, regime, seed),
  }));
}

/** Declared, descriptive until the family is frozen. */
export function routingContrasts(): ContrastSpec[] {
  const tasks = routingTasks();
  return [
    ...tasks.map(({ task }, i) => ({ id: `R${i + 1}`, label: "`retry_wallet` − `one_shot`, predicted positive", task, a: "retry_wallet", b: "one_shot", primary: false })),
    ...tasks.map(({ task }, i) => ({ id: `R${tasks.length + i + 1}`, label: "`hidden_state_oracle` − `retry_wallet`, predicted positive", task, a: "hidden_state_oracle", b: "retry_wallet", primary: false })),
  ];
}

/** Per-seed mean over the family's tasks of a − b, as Spiral pooled its cells within a topology cluster. */
function pooled(record: RunRecord, a: string, b: string): number[] {
  const tasks = record.tasks.map((t) => t.task).filter((t) => t.startsWith("routing/"));
  return record.seeds.map((seed) => {
    let sum = 0;
    for (const task of tasks) {
      const va = record.rows.find((r) => r.task === task && r.seed === seed && r.agent === a)!.value;
      const vb = record.rows.find((r) => r.task === task && r.seed === seed && r.agent === b)!.value;
      sum += va - vb;
    }
    return sum / tasks.length;
  });
}

export function routingGates(_analysis: Analysis, record: RunRecord): Gate[] {
  const retry = clusterInterval(pooled(record, "retry_wallet", "one_shot"));
  const oracle = clusterInterval(pooled(record, "hidden_state_oracle", "retry_wallet"));
  const fmt = (i: { mean: number; lo: number; hi: number }): string => `${i.mean >= 0 ? "+" : ""}${i.mean.toFixed(2)} (${i.lo.toFixed(2)} to ${i.hi.toFixed(2)})`;
  const identity = checkOf(record, "K23");
  return [
    { id: "K21", description: `\`retry_wallet\` − \`one_shot\`, pooled over the nine tasks: point estimate in [${K21_WINDOW[0]}, ${K21_WINDOW[1]}] and interval above zero (Spiral: +5.14, 3.08 to 7.20)`, pass: retry.mean >= K21_WINDOW[0] && retry.mean <= K21_WINDOW[1] && retry.lo > 0, detail: fmt(retry) },
    { id: "K22", description: "`hidden_state_oracle` − `retry_wallet`, pooled over the nine tasks: interval above zero", pass: oracle.lo > 0, detail: fmt(oracle) },
    { id: "K23", description: "identity: `retry_wallet` through `act` and `prefix_oracle_3` deliver, demand by demand, what family 1's router delivers run directly on the fixture", pass: identity?.pass === true, detail: identity?.detail ?? "not run" },
  ];
}

/** Family 1's router, run directly on the fixture with no observation or action interface. */
export function directRetry(root: string, manifest: Manifest, config: PlacementConfig, model: BalanceModel, regime: RoutingRegime, seed: number): { deliveries: boolean[]; value: number } {
  const fixture = placementFixture(root, manifest, seed);
  const net = Network.fromFixture(fixture, model);
  const catalog = catalogOf(fixture, config);
  const deliveries = demandsFor(root, manifest, seed, regime).slice(0, config.steps).map((d) => retryWallet(net, catalog, d, config.max_route_attempts).delivered);
  const scored = deliveries.slice(config.evaluation_start);
  return { deliveries, value: (100 * scored.filter(Boolean).length) / scored.length };
}

export function routingIdentityCheck(root: string, manifest: Manifest, config: PlacementConfig): (rows: EpisodeRow[]) => Check[] {
  return (rows) => {
    let compared = 0;
    const mismatches: string[] = [];
    for (const row of rows) {
      if (!row.task.startsWith("routing/") || row.agent !== "retry_wallet") continue;
      const [, model, regime] = row.task.split("/") as [string, BalanceModel, RoutingRegime];
      const direct = directRetry(root, manifest, config, model, regime, row.seed);
      const prefix = rows.find((r) => r.task === row.task && r.seed === row.seed && r.agent === "prefix_oracle_3");
      compared += 1;
      const hash = deliveryHash(direct.deliveries);
      if (row.value !== direct.value || row.metrics.delivery_hash !== hash || !prefix || prefix.metrics.delivery_hash !== hash) mismatches.push(`${row.task} seed ${row.seed}`);
    }
    return [{ id: "K23", pass: compared > 0 && mismatches.length === 0, detail: mismatches.length === 0 ? `${compared} episodes compared demand by demand, 0 mismatches` : `${mismatches.length} of ${compared} mismatched, first: ${mismatches[0]}` }];
  };
}

export const routingReport: ReportSpec = {
  title: "Bitcoin DeFi Bench v0: family 2 (routing under hidden state), baselines",
  contrasts: routingContrasts(),
  gates: routingGates,
};
