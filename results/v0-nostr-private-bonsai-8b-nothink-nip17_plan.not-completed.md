# `nostr/private`, `bonsai-8b-nothink@bf72a2ef7045` with `nip17_plan`: not completed

Both runs of this agent stopped at a request longer than the model server's 40,960-token context. Amendment 10 of `prereg/v0.md` gives the rule, and Amendment 11 applies it to this agent: the run stops and is reported as not completed, naming the episode and the turn. No table was produced for either run.

| Block | Date | Episodes run | Stopped at | Request |
|---|---|---|---|---|
| development | 2026-11-03 | seed 0, 24 turns; seed 1, turns 0 to 15 | seed 1, the request for turn 16 | 41,025 tokens |
| confirmatory | 2026-11-04 | seeds 1000 and 1001, 24 turns each; seed 1002, turns 0 to 19 | seed 1002, the request for turn 20 | 42,486 tokens |

Turns count from 0. The server's answer to the last request was HTTP 400 with `exceed_context_size_error`, for example `request (42486 tokens) exceeds the available context size (40960 tokens)`.

The model's replies up to the stop are in the partial reply logs beside this note:

- `v0-nostr-private-bonsai-8b-nothink-nip17_plan-development.partial-replies.jsonl`, SHA-256 `32b100324948cd936bb2ea160090d122734851da3005a2f8b30252bde23ff6c3`;
- `v0-nostr-private-bonsai-8b-nothink-nip17_plan-confirmatory.partial-replies.jsonl`, SHA-256 `e4028951710b25e50905d5fdb6137ab9a0db1ff1699203bedce2085e68010c98`.

The first line of each names the agent, and each later line holds one request's SHA-256 and the reply. Copied to the runner's reply-log path (`.replies.jsonl`), a log replays without the model up to the request that did not fit.

What the model did, from the logs:

- **Development.** Each episode opened with a skill call cut off at the 1,024-token reply cap. On seed 1, turns 1 to 15 were complete `fetch` requests of 481 tokens each, listing authors' keys.
- **Confirmatory.** Seed 1000 sent a `send` whose argument was a `fetch` request, on all 24 turns. Seed 1001 sent a `send` whose argument was an unfinished skill call, on all 24 turns. Seed 1002 opened with a skill call followed by `commit` in the same reply. It then answered `{"tool":"send","args":{"handle":"h3"}}` on every turn, which the adapter reads as sending the stored skill result.

Each request carries the whole episode. The TRM complex for this cell, whose proposer is the bare agent, completed all 32 confirmatory episodes on the same context (`v0-nostr-private-bonsai-8b-nothink-trm-complex-confirmatory.md`).
