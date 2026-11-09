import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode } from "../harness/episode.ts";
import { readManifest } from "../harness/manifest.ts";
import { PlacementEnv } from "../tasks/placement/env.ts";
import { placementPrompt } from "../tasks/placement/prompt.ts";
import { loadPlacementConfig, placementFixture } from "../tasks/placement/task.ts";
import type { Json } from "../harness/json.ts";
import { ChatAgent } from "./chat.ts";
import { PERSONA_CARD, withPersona } from "./persona.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = readManifest(root);
const config = loadPlacementConfig(root);
const fixture = placementFixture(root, manifest, 0);

test("the persona card is prepended to the system prompt, turns are untouched, and the hash differs from the bare prompt", () => {
  const bare = placementPrompt(256);
  const persona = withPersona(bare);
  assert.notEqual(persona.sha256, bare.sha256);
  assert.notEqual(withPersona(bare, `${PERSONA_CARD} x`).sha256, persona.sha256);
  const env = new PlacementEnv(fixture, "uniform", "stationary", config);
  const observation = { budget: env.budget(), view: env.view(), last: null } as unknown as Json;
  assert.equal(persona.system(observation), `${PERSONA_CARD}\n\n${bare.system(observation)}`);
  assert.equal(persona.turn(observation), bare.turn(observation));
});

test("a persona agent and a bare agent get the same environment and different ids and requests", async () => {
  const systems: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      systems.push((JSON.parse(raw) as { messages: Array<{ role: string; content: string }> }).messages[0]!.content);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"tool":"commit"}', reasoning_content: "" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const mk = (prompt: ReturnType<typeof placementPrompt>) => new ChatAgent({
      name: "mock", baseUrl, model: "mock-model",
      sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, max_tokens: 256, seed: 1 },
      thinking: false, identity: { model_sha256: "0".repeat(64), runtime: "mock" }, prompt,
    });
    const bare = mk(placementPrompt(256));
    const persona = mk(withPersona(placementPrompt(256)));
    assert.notEqual(bare.id, persona.id);
    const a = await runEpisode(new PlacementEnv(fixture, "uniform", "stationary", config), bare);
    const b = await runEpisode(new PlacementEnv(fixture, "uniform", "stationary", config), persona);
    assert.equal(a.value, b.value, "the same committed-nothing action scores the same");
    assert.equal(systems.length, 2);
    assert.ok(!systems[0]!.includes("agorist") && systems[1]!.includes("agorist"));
  } finally { server.close(); }
});
