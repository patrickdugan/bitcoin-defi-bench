# IronClaw as the agent under test

[IronClaw](https://github.com/nearai/ironclaw) is NEAR AI's agent runtime: a Rust implementation of an OpenClaw-style assistant, licensed MIT OR Apache-2.0, with tools sandboxed in WebAssembly. Between the user and the model it runs a leak detector over secrets, an input sanitizer, a policy engine, and tool-output wrapping. The latest release at the time of writing is `ironclaw-v1.4.1` (2026-09-29).

The bench runs IronClaw the way it runs a bare model: every agent runner takes `--backend ironclaw`. The agent under test is then IronClaw with the model behind its provider, not the model alone. Its score on a family is that system's competence at the operator's problem. Its rejections and failed turns are that system's errors.

## What the bench measures

IronClaw gets the same rows as any agent: one row per task, the same seeds, fixtures, budgets, baselines, and gates.

- **Its safety layers meet a real cost.** In family 9's custody cells (docs/tasks.md §10.2), hostile requests ask the agent to sign events or paste its key, and the cell scores what is lost. IronClaw's leak detector and injection defenses act on those requests. A defense that also refuses legitimate requests costs their value, so over-refusal is scored too.
- **It meets every operator problem the bench poses.** That includes the newest families: the BitVM3 claim graph (§15), the SatsHedgeZero venue (§16), and the Cashu desk backed by Ark (§17).
- **Skills work through the text channel.** Skills (docs/saturation.md) run on the adapter's side through the chat adapter's skill protocol: the model replies `{"skill": ...}`, and the adapter answers with the result as the next message. IronClaw's MCP extensions are installed from its registry over HTTP and do not take stdio servers, so the bench does not offer its skills as MCP tools. A skill-carrying IronClaw agent carries the same skill text, bound into its id, as a skill-carrying bare model.
- **IronClaw against its own model is a contrast in the same table.** The same model through the chat endpoint is another agent on the same seeds. Agent − agent contrasts are descriptive, as for the arms of docs/trm_complex.md.

## The protocol

`src/agents/ironclaw.ts` is a backend for the chat adapter (`src/agents/chat.ts`). It replaces the transport and nothing else. The skill loop, the cache, the reply log, and the transcript are the adapter's own.

- **API.** It posts to IronClaw's Responses API on loopback, `POST /api/v1/responses`, with `Authorization: Bearer <token>`. It reads the token from the environment variable named by `--ironclaw-token-env` (default `IRONCLAW_REBORN_WEBUI_TOKEN`) when it sends. The token is in neither the id, the reply log, nor the transcript.
- **One thread per episode.** The first request carries the bench's system prompt and the first turn as one input, with `previous_response_id` null. Each later request carries only the user messages added since the last reply, chained on that reply's response id.
- **Cache and reply log.** Both key on the whole conversation the adapter holds, as for a chat endpoint. Each logged reply keeps IronClaw's response id, so a rerun after an infrastructure failure replays the log and continues the thread from the last logged id.
- **Failures.**
  - A response whose status is not `completed` is a turn IronClaw failed or refused, such as an approval its policy engine required. It becomes an empty reply, which the harness rejects as malformed, and the transcript keeps its status and error.
  - An HTTP error is an infrastructure failure: the run stops and is rerun with its reply log.
- **Pacing.** IronClaw limits chat sends to 30 per 60 s per user, so requests are paced at 2,100 ms (`--ironclaw-min-interval-ms`), and an HTTP 429 is waited out and sent again.
- **No context window.** IronClaw holds the conversation, so the adapter's `contextTurns` window does not apply. The runners drop it under this backend.
- **Sampling.** Sampling is IronClaw's provider configuration. The adapter's sampling and thinking fields are not sent, and the id says so.
- **Loopback only.** Only `http://127.0.0.1`, `localhost`, and `[::1]` are accepted.

**The id.** It binds:
- the chat adapter's fields;
- `ironclaw_version`, from `--ironclaw-version`, the output of `ironclaw --version`;
- the `model` field IronClaw is asked for;
- `config_sha256`, from `--ironclaw-config-sha256`, the SHA-256 of the configuration the run used;
- the protocol string.

`--model-sha256` and `--runtime` name the model file and the server behind IronClaw's provider. An agent run without `--backend` has no backend field and keeps the id it always had. The family 11 Bonsai 8B agents `eba1c86695cb` and `9159079e0210` recompute to their committed ids under this code.

## Running it

1. **Start the model server on loopback**, as for any agent (docs/running.md), for example llama-server on port 8094.
2. **Start IronClaw on loopback** with a fresh home for the run, so nothing it remembers carries over from an earlier run:
   - set `IRONCLAW_REBORN_HOME=<empty directory>`;
   - onboard non-interactively with `ironclaw onboard --no-service`;
   - point its provider at the model server. IronClaw's README gives the variables `LLM_BACKEND=openai_compatible`, `LLM_BASE_URL=http://127.0.0.1:8094/v1`, and `LLM_MODEL=<alias>`;
   - start `ironclaw serve`. Its token is in `$IRONCLAW_REBORN_HOME/webui-token`. Its API documentation gives `127.0.0.1:3000` as the address, and its configuration documentation gives `listen_port = 3100`, so use the address `serve` prints.
3. **Run any agent script with the backend flags:**

```
node --experimental-strip-types scripts/run_nostr_agent.ts --cell custody --block development \
  --backend ironclaw --base-url http://127.0.0.1:3000 --model default \
  --ironclaw-version "<ironclaw --version>" --ironclaw-config-sha256 <sha256 of config.toml and providers.json> \
  --name ironclaw-bonsai-8b --model-sha256 <sha256 of the GGUF> --runtime "<llama-server --version>"
```

Episodes within a run share one IronClaw home. Anything IronClaw writes to its own memory during one episode is visible to the next. Cross-episode dependence of this kind shows in the per-seed rows, and a fresh home per run bounds it to one run.

## What is tested

`src/agents/ironclaw.test.ts` runs the backend against a mock of the documented Responses API. It covers:
- the wire format and thread chaining;
- the token's absence from the id;
- a family 4 episode through the skill loop that plays `buffer_rule` exactly;
- a rerun that replays its reply log and continues the thread from the last logged response id;
- a failed turn, which becomes a malformed action;
- HTTP 429 and 500;
- the runner flags.

No run record from a live IronClaw is committed.
