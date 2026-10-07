// Netting baselines. All three compute their plan from the observation alone; the ceiling needs
// no privileged information because nothing in this family is hidden.

import type { Agent } from "../../harness/agent.ts";
import type { Json } from "../../harness/json.ts";
import { settleBilateral, settleGross, settleOptimal, type Instance, type Transfer } from "./plans.ts";

const settle = (plan: Transfer[]): Json => ({ tool: "settle", args: { plan: { transfers: plan.map((t) => ({ ...t })) } } });

const instanceOf = (observation: Json): Instance => (observation as { view: Instance }).view;

export class GrossSettlement implements Agent {
  readonly id = "gross";
  act(observation: Json): Json { return settle(settleGross(instanceOf(observation))); }
}

export class BilateralNetting implements Agent {
  readonly id = "bilateral_net";
  act(observation: Json): Json { return settle(settleBilateral(instanceOf(observation))); }
}

export class MinCostFlowSettlement implements Agent {
  readonly id = "min_cost_flow";
  act(observation: Json): Json { return settle(settleOptimal(instanceOf(observation))); }
}

export const nettingBaselines = (): Agent[] => [new GrossSettlement(), new BilateralNetting(), new MinCostFlowSettlement()];
