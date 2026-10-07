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
//
// Skills (docs/saturation.md): a skill is a function on the agent's side, run by this adapter
// when the model asks for one by replying {"skill": name, "args": {...}} instead of an action.
// It reads the observation and its arguments and nothing else; its result is appended as the
// next user turn and the model is asked again. Calls are capped per episode. A reply {"send": name}
// sends that skill's result, unchanged, as the action, so the model decides and the skill carries
// the bytes. The agent id binds every skill's name and source hash and this protocol, so an agent
// with a skill is a different agent.

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

/** A procedure the model may call before it acts. Pure in the observation and its arguments. */
export interface Skill {
  name: string;
  /** One or two sentences the model sees, saying what the skill returns and what to do with it. */
  description: string;
  /** SHA-256 binding the skill's source into the agent id. */
  sha256: string;
  run(observation: Json, args: Json): Json;
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
  skills?: Skill[];
  /** Skill calls allowed per episode; a request beyond the cap is passed to the harness as it is. Default 4. */
  maxSkillCalls?: number;
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
  /** Present when the reply was a skill call: what was called and what it returned. */
  skill?: { name: string; args: Json; result: Json };
  /** Present when the reply sent a skill's stored result as the action; `action` is that result. */
  sent?: string;
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
  private skillCalls = 0;
  /** The latest result of each skill called in this episode, for a reply that sends one. */
  private results = new Map<string, Json>();

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
    const skills = (this.options.skills ?? []).map((s) => ({ name: s.name, sha256: s.sha256, description_sha256: sha256(s.description) }));
    const base = { adapter: ADAPTER_VERSION, model, model_sha256: identity.model_sha256, runtime: identity.runtime, sampling: { ...sampling }, thinking, prompt_sha256: prompt.sha256 };
    // Skills enter the identity only when carried, so a bare agent's identifier is unchanged by the skill loop.
    return skills.length ? { ...base, skills, max_skill_calls: this.options.maxSkillCalls ?? 4, skill_protocol: "call by a skill field or a tool field naming a carried skill; result as compact json; {tool: send} or {send: name} sends a stored result that is an action" } : base;
  }

  reset(episode: EpisodeInfo): void {
    this.episode = episode;
    this.messages = [];
    this.skillCalls = 0;
    this.results.clear();
  }

  private requestSeed(turn: number, call: number): number {
    const digest = sha256(`${this.options.sampling.seed}|${this.episode.seed}|${this.episode.cell}|${turn}|${call}`);
    return parseInt(digest.slice(0, 8), 16) >>> 1;
  }

  /** What the system prompt says about skills, when there are any. */
  private skillsText(): string {
    const skills = this.options.skills ?? [];
    if (skills.length === 0) return "";
    const cap = this.options.maxSkillCalls ?? 4;
    return `\n\nSkills. Before acting you may call a skill by replying with exactly {"skill":"<name>","args":{}} and nothing else; its result comes back in the next message. When a result is itself an action you may send it unchanged by replying {"tool":"send"}. You may call skills at most ${cap} times in this episode; a call beyond that is treated as an invalid action. The skills:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
  }

  /**
   * The skill a reply calls, or null when the reply is an action: the skill field, or a tool field
   * naming a carried skill, which is the envelope a model copying the action examples reaches for.
   * The harness never sees a carried skill's name as a tool; without the skill it is an unknown tool.
   */
  private skillCalled(parsed: Json): string | null {
    const skills = this.options.skills ?? [];
    if (skills.length === 0 || !isObject(parsed)) return null;
    if (typeof parsed.skill === "string") return parsed.skill;
    if (typeof parsed.tool === "string" && skills.some((s) => s.name === parsed.tool)) return parsed.tool;
    return null;
  }

  /**
   * The skill whose stored result a reply sends as its action: {"tool": "send"} or {"send": name}. A
   * name that matches a stored result is used; otherwise the latest stored result that is an action.
   * The form takes no name because a small model wrote the action's name where the skill's went.
   */
  private sentResult(parsed: Json): string | null {
    if (!isObject(parsed) || !("send" in parsed || parsed.tool === "send")) return null;
    if (typeof parsed.send === "string" && this.results.has(parsed.send)) return parsed.send;
    for (const [name, result] of [...this.results].reverse()) if (isObject(result) && typeof result.tool === "string") return name;
    return null;
  }

  /** Run a requested skill over the observation. Errors are returned to the model, never thrown. */
  private runSkill(name: string, args: Json, observation: Json): Json {
    const skill = (this.options.skills ?? []).find((s) => s.name === name);
    if (!skill) return { error: `unknown skill ${name}` };
    try { return skill.run(observation, args); } catch (e) { return { error: String((e as Error).message ?? e) }; }
  }

  async act(observation: Json): Promise<Json> {
    const turn = (observation as { episode: { turn: number } }).episode.turn;
    if (turn === 0) this.messages = [{ role: "system", content: this.options.prompt.system(observation) + this.skillsText() }];
    let user = this.options.prompt.turn(observation);
    const cap = this.options.maxSkillCalls ?? 4;
    for (let call = 0; ; call++) {
      this.messages.push({ role: "user", content: user });
      const { reply, key, cached, replayed } = await this.complete(turn, call);
      this.messages.push({ role: "assistant", content: reply.content });
      const parsed = extractAction(reply.content);
      const name = this.skillCalled(parsed);
      if (name === null || this.skillCalls >= cap) {
        // An action, a sent result, or a skill call past the cap, which the harness rejects as malformed.
        const sent = this.sentResult(parsed);
        const action = sent === null ? parsed : this.results.get(sent)!;
        this.options.onExchange?.({ episode: this.episode, turn, request_sha256: key, cached, replayed, user, reply: reply.content, reasoning: reply.reasoning, action, ...(sent === null ? {} : { sent }) });
        return action;
      }
      this.skillCalls += 1;
      const args = ((parsed as { args?: Json }).args ?? {}) as Json;
      const result = this.runSkill(name, args, observation);
      this.results.set(name, result);
      this.options.onExchange?.({ episode: this.episode, turn, request_sha256: key, cached, replayed, user, reply: reply.content, reasoning: reply.reasoning, action: parsed, skill: { name, args, result } });
      // Compact: an indented result was re-compacted by a small model and lost more braces, not fewer.
      const offer = isObject(result) && typeof result.tool === "string" ? `, or {"tool":"send"} to send this result unchanged as your action` : "";
      user = `Result of skill ${name} (${cap - this.skillCalls} skill calls left):\n${JSON.stringify(result)}\n\nReply with one JSON object${offer}.`;
    }
  }

  /** One completion over the conversation so far, from the cache, the replay log, or the server. */
  private async complete(turn: number, call: number): Promise<{ reply: Reply; key: string; cached: boolean; replayed: boolean }> {
    const { sampling } = this.options;
    const body = {
      model: this.options.model,
      messages: this.messages.map((m) => ({ ...m })),
      temperature: sampling.temperature, top_p: sampling.top_p, top_k: sampling.top_k,
      max_tokens: sampling.max_tokens, seed: this.requestSeed(turn, call),
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
    return { reply, key, cached, replayed };
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
