// LLM adapter: an Agent backed by an OpenAI-compatible chat endpoint on this machine. It renders
// each observation with a family's prompt renderer, sends the conversation so far, and returns the
// first JSON object in the reply as the action. It follows prereg/v0.md §9.1:
//
// - The agent id binds the model file hash, the runtime build, the sampling parameters, and the
//   prompt hash.
// - Output that does not parse is returned to the harness as it is, where it is rejected as
//   malformed and costs an attempt. There is no retry, repair, or default action.
// - The request seed comes from the episode seed, the cell, and the turn, never from the task.
//   Identical requests are answered from a cache, so episodes that present the same observations
//   (the two placement regimes) get the same decisions whether or not the server is deterministic.
//
// Only loopback endpoints are accepted. A transport failure throws: it is an infrastructure
// failure, the run aborts, and it is rerun whole.

import type { Agent, EpisodeInfo } from "../harness/agent.ts";
import { canonical, isObject, sha256, type Json } from "../harness/json.ts";

export const ADAPTER_VERSION = "chat-adapter/v0";

export interface PromptRenderer {
  /** SHA-256 of the prompt template text. */
  readonly sha256: string;
  system(observation: Json): string;
  turn(observation: Json): string;
}

export interface Sampling {
  temperature: number;
  top_p: number;
  top_k: number;
  max_tokens: number;
  seed: number;
}

export interface ChatOptions {
  name: string;
  baseUrl: string;
  model: string;
  sampling: Sampling;
  thinking: boolean;
  identity: { model_sha256: string; runtime: string };
  prompt: PromptRenderer;
  timeoutMs?: number;
  onExchange?: (exchange: Exchange) => void;
}

export interface Exchange {
  episode: EpisodeInfo;
  turn: number;
  request_sha256: string;
  cached: boolean;
  user: string;
  reply: string;
  reasoning: string;
  action: Json;
}

interface Message { role: "system" | "user" | "assistant"; content: string; }

/** The first JSON object in a reply, or the reply itself when there is none. */
export function extractAction(reply: string): Json {
  const text = reply.trim();
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (ch === "\\") i += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1)) as Json;
            if (isObject(parsed)) return parsed;
          } catch { /* not JSON from this brace; try the next one */ }
          break;
        }
      }
    }
  }
  return reply;
}

export class ChatAgent implements Agent {
  readonly id: string;
  private readonly options: ChatOptions;
  private readonly endpoint: string;
  private readonly cache = new Map<string, { content: string; reasoning: string }>();
  private episode: EpisodeInfo = { task: "", seed: -1, cell: "" };
  private messages: Message[] = [];

  constructor(options: ChatOptions) {
    const url = new URL(options.baseUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error(`chat adapter accepts loopback endpoints only, got ${url.hostname}`);
    }
    this.options = options;
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.id = `${options.name}@${sha256(canonical(this.describe())).slice(0, 12)}`;
  }

  /** Everything the agent id binds. Stored in the run record. */
  describe(): Json {
    const { identity, sampling, thinking, prompt, model } = this.options;
    return { adapter: ADAPTER_VERSION, model, model_sha256: identity.model_sha256, runtime: identity.runtime, sampling: { ...sampling }, thinking, prompt_sha256: prompt.sha256 };
  }

  reset(episode: EpisodeInfo): void {
    this.episode = episode;
    this.messages = [];
  }

  private requestSeed(turn: number): number {
    const digest = sha256(`${this.options.sampling.seed}|${this.episode.seed}|${this.episode.cell}|${turn}`);
    return parseInt(digest.slice(0, 8), 16) >>> 1;
  }

  async act(observation: Json): Promise<Json> {
    const turn = (observation as { episode: { turn: number } }).episode.turn;
    if (turn === 0) this.messages = [{ role: "system", content: this.options.prompt.system(observation) }];
    const user = this.options.prompt.turn(observation);
    this.messages.push({ role: "user", content: user });
    const { sampling } = this.options;
    const body = {
      model: this.options.model,
      messages: this.messages.map((m) => ({ ...m })),
      temperature: sampling.temperature, top_p: sampling.top_p, top_k: sampling.top_k,
      max_tokens: sampling.max_tokens, seed: this.requestSeed(turn),
      chat_template_kwargs: { enable_thinking: this.options.thinking },
      cache_prompt: true,
    };
    const key = sha256(canonical(body));
    let reply = this.cache.get(key);
    const cached = reply !== undefined;
    if (!reply) {
      reply = await this.post(body);
      this.cache.set(key, reply);
    }
    this.messages.push({ role: "assistant", content: reply.content });
    const action = extractAction(reply.content);
    this.options.onExchange?.({ episode: this.episode, turn, request_sha256: key, cached, user, reply: reply.content, reasoning: reply.reasoning, action });
    return action;
  }

  private async post(body: object): Promise<{ content: string; reasoning: string }> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 3_600_000),
    });
    if (!response.ok) throw new Error(`chat endpoint returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }> };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("chat endpoint returned no message");
    return { content: message.content ?? "", reasoning: message.reasoning_content ?? "" };
  }
}
