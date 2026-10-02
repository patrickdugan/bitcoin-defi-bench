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

import { request } from "node:http";
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
  /** Replies logged by an earlier attempt of the same run that ended in an infrastructure failure, keyed by request hash. */
  replay?: Map<string, Reply>;
  /** Called once for each reply that came from the server, so it can be logged as it arrives. */
  onReply?: (requestSha256: string, reply: Reply) => void;
}

export interface Reply { content: string; reasoning: string; }

export interface Exchange {
  episode: EpisodeInfo;
  turn: number;
  request_sha256: string;
  cached: boolean;
  /** True when the reply came from the log of an earlier attempt rather than from the server in this process. */
  replayed: boolean;
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
  private readonly cache = new Map<string, Reply>();
  private readonly fromReplay = new Set<string>();
  /** Requests answered from the replay log, and requests sent to the server, in this process. */
  readonly counts = { replayed: 0, served: 0 };
  private episode: EpisodeInfo = { task: "", seed: -1, cell: "" };
  private messages: Message[] = [];

  constructor(options: ChatOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error(`chat adapter accepts http loopback endpoints only, got ${url.protocol}//${url.hostname}`);
    }
    this.options = options;
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.id = `${options.name}@${sha256(canonical(this.describe())).slice(0, 12)}`;
    for (const [key, reply] of options.replay ?? []) { this.cache.set(key, reply); this.fromReplay.add(key); }
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
    const replayed = this.fromReplay.has(key);
    if (!reply) {
      reply = await this.post(body);
      this.cache.set(key, reply);
      this.counts.served += 1;
      this.options.onReply?.(key, reply);
    } else if (replayed) {
      // Count a replayed request once; later uses of it are ordinary cache hits.
      this.fromReplay.delete(key);
      this.counts.replayed += 1;
    }
    this.messages.push({ role: "assistant", content: reply.content });
    const action = extractAction(reply.content);
    this.options.onExchange?.({ episode: this.episode, turn, request_sha256: key, cached, replayed, user, reply: reply.content, reasoning: reply.reasoning, action });
    return action;
  }

  /**
   * One POST over node:http. Not fetch: Node's fetch abandons a request whose response headers have
   * not arrived within five minutes, whatever timeout it is given, and a non-streaming completion
   * sends its headers only when generation ends. On a GPU shared with other jobs a reply can take
   * longer than that, and a slow server is not a failed one.
   */
  private post(body: object): Promise<Reply> {
    const payload = JSON.stringify(body);
    const timeoutMs = this.options.timeoutMs ?? 3_600_000;
    return new Promise<Reply>((resolve, reject) => {
      const req = request(this.endpoint, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) { reject(new Error(`chat endpoint returned HTTP ${res.statusCode}: ${text.slice(0, 300)}`)); return; }
          try {
            const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }> };
            const message = data.choices?.[0]?.message;
            if (!message) { reject(new Error("chat endpoint returned no message")); return; }
            resolve({ content: message.content ?? "", reasoning: message.reasoning_content ?? "" });
          } catch (error) { reject(error as Error); }
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`chat endpoint did not answer within ${timeoutMs} ms`)));
      req.on("error", reject);
      req.end(payload);
    });
  }
}
