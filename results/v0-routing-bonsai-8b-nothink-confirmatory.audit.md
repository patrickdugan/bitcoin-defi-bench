# Audit: family 2, `bonsai-8b-nothink@e6b9a351f65d`, confirmatory seeds

The audit note prereg/v0.md §9 requires before the nine rows of [v0-routing-bonsai-8b-nothink-confirmatory.md](v0-routing-bonsai-8b-nothink-confirmatory.md) are reported. They were flagged `outside_calibration` because no adjusted agent − `retry_wallet` interval lies inside ±1.0 point. Written 2026-11-03.

## The run

| | |
|---|---|
| Agent | `bonsai-8b-nothink@e6b9a351f65d`, fixed by Amendment 9 before the run (prompt `903a6b76…`, context window at the current turn, no skill) |
| Run record SHA-256 (as the table prints it) | `00ef3cd12a6c6c6d620eff7cde8b0403c90d18780d6cd7727b60b3c2690de984` |
| Source SHA-256 | `75674790917c…`, the bench's TypeScript at commit `f2a7d51`, recomputed after the run |
| Transcript | `v0-routing-bonsai-8b-nothink-confirmatory.transcript.jsonl.gz`: 83,167 exchanges, 389,010,015 bytes uncompressed (SHA-256 `00b3dc25a337…`), stored with `gzip -9 -n` because GitHub refuses files over 100 MB |
| Replies | 61,074 from the server in the final invocation, 6,471 replayed from the reply log, 15,622 identical requests answered from the adapter's cache |

The final invocation was the fourth. The first two ended when the model server aborted (Windows Application Error 1000, `ucrtbase.dll`, exception 0xc0000409, at 13:54 and 14:44 on 2026-11-03). The third was stopped by hand 2 minutes in, to raise the supervisor's restart cap. Each later invocation replayed the reply log, and the last one executed every episode and every baseline again. §9.1 permits that rerun as an infrastructure failure, and the record's run notes log the replay.

## Checks, in the order §9 lists them

`node --experimental-strip-types scripts/audit_routing_agent.ts --record results/v0-routing-bonsai-8b-nothink-confirmatory.json --transcript results/v0-routing-bonsai-8b-nothink-confirmatory.transcript.jsonl.gz` printed:

```
1a identity: prefix_oracle_3 = retry_wallet in 288 episodes
1b identity: the scripted retry wallet through the chat adapter = retry_wallet in 288 episodes
2 observation: 83167 of 83167 turns re-rendered byte for byte from public fields; 2052 turns compared across balance models with the same history
3 attempts: 288 episodes replayed to the recorded row; 1593 rejections each spent an attempt
4 order: candidates in catalog order on every replayed turn
audit: every check passes
```

1. **Identity controls.**
   - `prefix_oracle_3` delivers what `retry_wallet` delivers in all 288 episodes (gate K23 also passes).
   - A retry wallet scripted from the request text alone matches the built-in `retry_wallet` in all 288 episodes, by delivery hash, value, and failed attempts. It answers from a loopback server through the same adapter, prompt, and parser as the model.
2. **Observation leak.**
   - Every turn in the transcript equals the prompt renderer's output for a fresh environment replayed to that turn.
   - That environment's view has only the public fields (demand, candidates with hop count and public fee, tried, history, horizon).
   - The three balance models of a seed and regime differ only in hidden balances. At every turn whose earlier actions and outcomes agreed (2,052 turns), they showed the same text.
3. **Attempts charged.**
   - Replaying the logged actions through fresh environments reproduces each of the agent's 288 rows exactly: value, every metric, the rejection list, and the turn count.
   - Each of the 1,593 rejections (all `out_of_grid`) spent one attempt and moved nothing.
   - No payment received more than three attempts.
4. **Candidate order.** On every turn the candidates are numbered 0 to n − 1 in (hop count, node sequence) order. That order is a function of the public graph alone.

Negative control: the same command on a copy of the record with one agent metric and one `prefix_oracle_3` delivery hash altered reports both and exits 1.

No harness defect was found. The nine rows are reported as results: bare Bonsai 8B is practically equivalent to the retry wallet on no task, below it on five, and inconclusive on four, all four with negative point estimates.

## Why it falls short

The counts come from the transcript's turns, over the 31,680 scored payments. Delivery outcomes come from the history that an episode's last turn shows, which covers payments 110 to 218.

- **First try.**
  - Candidate 0 is the first try on 93.0% of all payments. It is the first in catalog order, the path with the fewest hops, and the index in the prompt's format example. It is the cheapest path 66.7% of the time.
  - That first try delivered 82.6% of payments 110 to 218 (71.4% to 96.2% by task). In eight of nine tasks that is above `one_shot`'s whole score, which tries the cheapest path once.
- **After a failure.**
  - The model mostly tries the same candidate again. Balances do not move between attempts at one payment, so a repeat cannot succeed.
  - 12,273 of the scored payments (39%) have a single candidate. There, a failed first try cannot be rescued by any policy.
  - Of the 3,530 scored payments with more than one candidate that took a second attempt, 2,527 (72%) never tried another candidate; 1,003 did.
  - 396 of payments 110 to 218 were delivered by a retry.
  - `retry_wallet` has the same first try as `one_shot`. Its whole lead over `one_shot`, 2.75 to 10.44 more payments delivered per episode, comes from trying other candidates in fee order.
- **Out of range.** 1,582 of the 1,593 indices past the end of the list were on payments with a single candidate, where there is no other path to try.
- **Skips.** The model skipped 4 times in 83,167 turns.

The development run shows the same pattern. Of the 289 payments (110 to 218, seeds 0 and 1) whose first try failed, 222 never had another candidate tried, and 25 were delivered by a retry. docs/tasks.md §3.3 had said the model moved to other candidates after a failure. That was wrong, and it is corrected there.
