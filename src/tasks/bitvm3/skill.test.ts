// The family 12 skill. It imports the skill registry, which imports every family's baselines and
// with them the vendored Spiral model, so it needs the vendor/spiral checkout; the rest of the
// family's tests do not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatAgent } from "../../agents/chat.ts";
import { echoSkillServer } from "../../agents/echo_mock.test_helper.ts";
import { SKILLS, bitvm3WatchSkill } from "../../agents/skills.ts";
import { runEpisode } from "../../harness/episode.ts";
import { SEED_BLOCKS } from "../../harness/seeds.ts";
import { LARGEST_FIRST, Watcher } from "./baselines.ts";
import { Bitvm3Env } from "./env.ts";
import { generateFixture, type Bitvm3Config } from "./generate.ts";
import { bitvm3Prompt } from "./prompt.ts";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const config = JSON.parse(readFileSync(join(root, "config/bitvm3.json"), "utf8")) as Bitvm3Config;

test("bitvm3_watch: a model that calls it at every turn and copies its result plays largest_first exactly", async () => {
  assert.equal(SKILLS.bitvm3_watch, bitvm3WatchSkill);
  const m = await echoSkillServer("bitvm3_watch");
  try {
    const agent = new ChatAgent({
      name: "echo", baseUrl: m.url, model: "mock", sampling: { temperature: 0, top_p: 1, top_k: 1, max_tokens: 256, seed: 0 }, thinking: false,
      identity: { model_sha256: "0".repeat(64), runtime: "mock" }, prompt: bitvm3Prompt(256), skills: [bitvm3WatchSkill], maxSkillCalls: 1000, maxSkillCallsPerTurn: 1, contextTurns: 0,
    });
    const reference = new Watcher("largest_first", LARGEST_FIRST);
    for (const cell of Object.keys(config.cells).sort()) {
      for (const seed of SEED_BLOCKS.development) {
        const f = generateFixture(seed, cell, config.cells[cell]!, config);
        const a = await runEpisode(new Bitvm3Env(f, config), agent);
        const b = await runEpisode(new Bitvm3Env(f, config), reference);
        assert.equal(a.value, b.value, `${cell} seed ${seed}`);
        assert.deepEqual(a.metrics, b.metrics, `${cell} seed ${seed}`);
        assert.deepEqual(a.rejections, b.rejections);
        assert.equal(a.rejections.length, 0);
      }
    }
    assert.ok(m.calls() > 0);
  } finally { m.server.close(); }
});
