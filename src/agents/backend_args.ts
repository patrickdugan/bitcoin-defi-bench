// The backend flags every agent runner accepts (docs/ironclaw.md). Without --backend, a runner posts
// to an OpenAI-compatible chat endpoint as before, and its agents keep their ids.
//
//   --backend ironclaw --base-url http://127.0.0.1:3000 --model default \
//     --ironclaw-version "<ironclaw --version>" [--ironclaw-config-sha256 <hex>] \
//     [--ironclaw-token-env IRONCLAW_REBORN_WEBUI_TOKEN] [--ironclaw-min-interval-ms 2100]
//
// --model-sha256 and --runtime still name the model and the server behind IronClaw's provider.

import type { ChatOptions, Reply } from "./chat.ts";
import { IronClawBackend } from "./ironclaw.ts";

export type Arg = (name: string, fallback?: string) => string;

/** What a runner merges into its ChatOptions: nothing for the chat endpoint; the backend, and no context window, for IronClaw. */
export function backendOptions(arg: Arg, options: Pick<ChatOptions, "baseUrl" | "model">): Partial<ChatOptions> {
  const backend = arg("backend", "chat");
  if (backend === "chat") return {};
  if (backend !== "ironclaw") throw new Error(`--backend must be chat or ironclaw, got ${backend}`);
  const configSha256 = arg("ironclaw-config-sha256", "");
  return {
    backend: new IronClawBackend({
      baseUrl: options.baseUrl,
      model: options.model,
      version: arg("ironclaw-version"),
      ...(configSha256 === "" ? {} : { configSha256 }),
      tokenEnv: arg("ironclaw-token-env", "IRONCLAW_REBORN_WEBUI_TOKEN"),
      minIntervalMs: Number(arg("ironclaw-min-interval-ms", "2100")),
    }),
    contextTurns: undefined,
  };
}

/** A reply-log entry back into a Reply, keeping a backend's response id. */
export function loggedReply(entry: Reply): Reply {
  return { content: entry.content, reasoning: entry.reasoning, ...(entry.thread === undefined ? {} : { thread: entry.thread }) };
}
