// Family 10 baselines. Each computes its design from the observation alone.

import type { Agent } from "../../harness/agent.ts";
import type { Json } from "../../harness/json.ts";
import type { Design } from "./contract.ts";
import { designJson, exactDesign, menuOf, modelFor, specDefault, twoBand, uniformTuned, type DlcView } from "./designs.ts";

const offer = (design: Design): Json => ({ tool: "offer", args: designJson(design) });
const viewOf = (observation: Json): DlcView => (observation as unknown as { view: DlcView }).view;

export class SpecDefault implements Agent {
  readonly id = "spec_default";
  private readonly ratio: number;
  constructor(defaultFloorRatio: number) { this.ratio = defaultFloorRatio; }
  act(observation: Json): Json { return offer(specDefault(viewOf(observation), this.ratio)); }
}

export class UniformTuned implements Agent {
  readonly id = "uniform_tuned";
  act(observation: Json): Json {
    const view = viewOf(observation);
    return offer(uniformTuned(modelFor(view.contract), menuOf(view)));
  }
}

export class TwoBand implements Agent {
  readonly id = "two_band";
  act(observation: Json): Json {
    const view = viewOf(observation);
    return offer(twoBand(modelFor(view.contract), menuOf(view), view));
  }
}

export class ExactDesign implements Agent {
  readonly id = "exact";
  act(observation: Json): Json {
    const view = viewOf(observation);
    return offer(exactDesign(modelFor(view.contract), menuOf(view)));
  }
}

export const dlcBaselines = (defaultFloorRatio: number): Agent[] => [new SpecDefault(defaultFloorRatio), new UniformTuned(), new TwoBand(), new ExactDesign()];
