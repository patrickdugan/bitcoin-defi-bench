// The three families with a teacher skill (5 bonding, 6 netting, 10 dlc) as the SFT data and its scorer build them:
// the bare agent's prompt renderer at the 27B runs' reply-token limits, the teacher, and an in-memory episode.

import type { Environment } from "../src/harness/agent.ts";
import type { PromptRenderer, Skill } from "../src/agents/chat.ts";
import { bondOfferSkill, dlcDesignSkill, minCostFlowSkill } from "../src/agents/skills.ts";
import { BondingEnv } from "../src/tasks/bonding/env.ts";
import { generateFixture as generateBonding } from "../src/tasks/bonding/generate.ts";
import { bondingPrompt } from "../src/tasks/bonding/prompt.ts";
import { loadBondingConfig } from "../src/tasks/bonding/task.ts";
import { DlcEnv } from "../src/tasks/dlc/env.ts";
import { generateFixture as generateDlc } from "../src/tasks/dlc/generate.ts";
import { dlcPrompt } from "../src/tasks/dlc/prompt.ts";
import { loadDlcConfig } from "../src/tasks/dlc/task.ts";
import { NettingEnv } from "../src/tasks/netting/env.ts";
import { generateFixture as generateNetting } from "../src/tasks/netting/generate.ts";
import { nettingPrompt } from "../src/tasks/netting/prompt.ts";
import { loadNettingConfig } from "../src/tasks/netting/task.ts";

export interface SftFamily {
  id: string;
  cells: string[];
  prompt: PromptRenderer;
  teacher: Skill;
  env(seed: number, cell: string): Environment;
}

export function sftFamilies(root: string): SftFamily[] {
  const bonding = loadBondingConfig(root);
  const dlc = loadDlcConfig(root);
  const netting = loadNettingConfig(root);
  return [
    { id: "bonding", cells: Object.keys(bonding.cells).sort(), prompt: bondingPrompt(768), teacher: bondOfferSkill,
      env: (seed, cell) => new BondingEnv(generateBonding(seed, cell, bonding.cells[cell]!, bonding), bonding) },
    { id: "dlc", cells: Object.keys(dlc.cells).sort(), prompt: dlcPrompt(768), teacher: dlcDesignSkill,
      env: (seed, cell) => new DlcEnv(generateDlc(seed, cell, dlc.cells[cell]!, dlc), dlc) },
    { id: "netting", cells: Object.keys(netting.cells).sort(), prompt: nettingPrompt(1024), teacher: minCostFlowSkill,
      env: (seed, cell) => new NettingEnv(generateNetting(seed, cell, netting.cells[cell]!, netting.market), netting) },
  ];
}
