// IronClaw backend (docs/ironclaw.md): the chat adapter's transport replaced by NEAR AI's IronClaw
// agent (github.com/nearai/ironclaw), reached through its OpenAI-Responses-style API on loopback,
// POST /api/v1/responses with a bearer token. IronClaw runs its own agent loop, safety layers and
// LLM provider between the bench and the model, so an IronClaw agent is IronClaw and its model
// together, and its id binds both.
//
// - The bench's system prompt and the first turn go as one input with previous_response_id null.
//   Each later request carries only the user messages added since the last reply, chained by
//   previous_response_id, so IronClaw holds the episode as one thread. Every episode starts a new one.
// - The cache and the reply log key on the whole conversation the adapter holds, as for the chat
//   endpoint. Each reply keeps IronClaw's response id (Reply.thread). A cached or replayed reply
//   restores its id, so a rerun continues the chain where the log ends.
// - Requests are paced at minIntervalMs, because IronClaw limits chat sends to 30 per 60 s per user.
//   An HTTP 429 waits retryMs and is sent again, at most five times. Any other transport failure throws.
// - A response whose status is not "completed" is a turn IronClaw failed or refused. It becomes an
//   empty reply, which the harness rejects as malformed, and its status and error are kept as reasoning.
// - Sampling is IronClaw's provider configuration. The adapter's sampling and thinking fields are
//   not sent, and the id says so.
// - The token is read from the environment variable named by tokenEnv when a request is sent. It is
//   never stored in the id, the reply log, or the transcript.

import { request } from "node:http";
import { canonical, sha256, type Json } from "../harness/json.ts";
import type { Backend, Message, Reply } from "./chat.ts";

export const IRONCLAW_BACKEND_VERSION = "ironclaw-backend/v0";

export interface IronClawOptions {
  /** IronClaw's web address on this machine, for example http://127.0.0.1:3000. */
  baseUrl: string;
  /** The model field of each request: IronClaw's name for its configured provider model. */
  model: string;
  /** `ironclaw --version`, bound into the id. */
  version: string;
  /** SHA-256 of the IronClaw configuration the run used (config.toml and providers.json), bound into the id. */
  configSha256?: string;
  /** Environment variable holding the web UI token. Default IRONCLAW_REBORN_WEBUI_TOKEN. */
  tokenEnv?: string;
  /** Least time between two requests sent. Default 2,100 ms. */
  minIntervalMs?: number;
  /** Wait after an HTTP 429. Default 30,000 ms. */
  retryMs?: number;
  timeoutMs?: number;
  /** For tests; the process environment otherwise. */
  env?: { [name: string]: string | undefined };
}

interface OutputItem { type?: string; role?: string; content?: Array<{ type?: string; text?: string }>; [key: string]: unknown }
interface ResponseBody { id?: string; status?: string; output?: OutputItem[]; error?: unknown }

const conversationKey = (messages: readonly Message[]): string => sha256(canonical(messages.map((m) => ({ role: m.role, content: m.content }))));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The assistant text of a Responses API reply, and everything else it carried, as the reply's reasoning. */
export function readResponse(data: ResponseBody): Reply {
  if (typeof data.id !== "string" || data.id === "") throw new Error("IronClaw returned a response without an id");
  const output = Array.isArray(data.output) ? data.output : [];
  const text = output
    .filter((item) => item.type === "message")
    .flatMap((item) => (item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? ""))
    .join("\n");
  const other = output.filter((item) => item.type !== "message");
  if (data.status !== "completed") {
    return { content: "", reasoning: `ironclaw status ${String(data.status)}: ${JSON.stringify(data.error ?? null)}${other.length ? ` ${JSON.stringify(other)}` : ""}`, thread: data.id };
  }
  return { content: text, reasoning: other.length ? JSON.stringify(other) : "", thread: data.id };
}

export class IronClawBackend implements Backend {
  private readonly options: IronClawOptions;
  private readonly endpoint: string;
  /** IronClaw's response id for each conversation the adapter sent, keyed by the messages it answered. */
  private readonly threads = new Map<string, string>();
  private lastSent = 0;

  constructor(options: IronClawOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error(`IronClaw backend accepts http loopback addresses only, got ${url.protocol}//${url.hostname}`);
    }
    this.options = options;
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/api/v1/responses`;
  }

  describe(): Json {
    return {
      kind: "ironclaw",
      backend: IRONCLAW_BACKEND_VERSION,
      ironclaw_version: this.options.version,
      model: this.options.model,
      config_sha256: this.options.configSha256 ?? null,
      api: "POST /api/v1/responses; first input is the system prompt and the first turn; later inputs are the new user messages, chained by previous_response_id; one thread per episode",
      sampling: "IronClaw's provider configuration; the adapter's sampling and thinking fields are not sent",
    };
  }

  body(messages: readonly Message[]): object {
    return { backend: IRONCLAW_BACKEND_VERSION, model: this.options.model, messages: messages.map((m) => ({ role: m.role, content: m.content })) };
  }

  observe(messages: readonly Message[], reply: Reply): void {
    if (reply.thread !== undefined) this.threads.set(conversationKey(messages), reply.thread);
  }

  /** The request IronClaw gets for a conversation: the messages after the last reply, and that reply's id. */
  wire(messages: readonly Message[]): { model: string; input: string; previous_response_id: string | null; stream: false } {
    let last = -1;
    messages.forEach((m, i) => { if (m.role === "assistant") last = i; });
    // Keyed by what the reply answered, not by its text: the adapter may keep a cut-off skill call as its bare envelope.
    const previous = last < 0 ? null : this.threads.get(conversationKey(messages.slice(0, last)));
    if (previous === undefined) throw new Error("IronClaw backend has no response id for this conversation; a reply log without response ids cannot continue an IronClaw thread");
    const input = messages.slice(last + 1).map((m) => m.content).join("\n\n");
    return { model: this.options.model, input, previous_response_id: previous, stream: false };
  }

  async post(_body: object, messages: readonly Message[]): Promise<Reply> {
    const wire = this.wire(messages);
    const min = this.options.minIntervalMs ?? 2_100;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastSent + min - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastSent = Date.now();
      const { status, text } = await this.send(JSON.stringify(wire));
      if (status === 429 && attempt < 5) { await sleep(this.options.retryMs ?? 30_000); continue; }
      if (status !== 200) throw new Error(`IronClaw returned HTTP ${status}: ${text.slice(0, 300)}`);
      return readResponse(JSON.parse(text) as ResponseBody);
    }
  }

  /** One POST over node:http, for the same reason as the chat adapter's: fetch gives up on slow headers. */
  private send(payload: string): Promise<{ status: number; text: string }> {
    const tokenEnv = this.options.tokenEnv ?? "IRONCLAW_REBORN_WEBUI_TOKEN";
    const token = (this.options.env ?? process.env)[tokenEnv];
    const headers: { [name: string]: string | number } = { "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
    if (token) headers.authorization = `Bearer ${token}`;
    const timeoutMs = this.options.timeoutMs ?? 3_600_000;
    return new Promise((resolve, reject) => {
      const req = request(this.endpoint, { method: "POST", headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`IronClaw did not answer within ${timeoutMs} ms`)));
      req.on("error", reject);
      req.end(payload);
    });
  }
}
