# Pushing the ceilings with a small model

Decided on 2026-10-07: Bonsai 8B is the model the bench is pushed with, so that a result near a ceiling is reached at the lowest operating cost that can reach it. The bare model does not get there (its family 1 result equals placing nothing). What gets a small model there is a skill: a procedure the model can call, whose result it reads before it acts.

## What a skill is here

A skill is a function on the agent's side of the interface, run by the adapter when the model asks for it, over what the agent has already received and nothing else: the current observation, and, for a procedure that carries state from turn to turn, the observations of the episode so far. The model asks for one by replying `{"skill": "<name>", "args": {...}}` instead of an action; the adapter runs it, appends its result as the next user turn, and asks again. Skill calls are capped per episode by the adapter and cost no harness budget, because the harness never sees them: what reaches the environment is still one action per turn, from the model.

Three rules keep this honest:

- **No privileged input.** A skill reads the observations of its own episode, up to the current one, and its own arguments. It cannot see hidden state, the regime, or the fixture; it is code the model carries, not a side channel.
- **Identity.** The agent identifier binds the skill set (each skill's source hash), the call cap, and the call envelopes along with the model, prompt and sampling; an agent with no skills has the identifier it had before skills existed. "Bonsai with the netting skill" and "Bonsai bare" are different agents, reported as such. A skill's hash covers its own `run` source, not the bench code it imports (`eoqInterval`, `settleOptimal`, and so on), so the id alone would not notice an edit to a helper. Since 2026-10-30 every run record also carries the SHA-256 of all the bench's TypeScript (`source_sha256`, shown in each table's header), which does; records written before then lack it.
- **The ceiling check still applies.** A skill that is the oracle's algorithm should reach the ceiling exactly; the identity control for that family says whether the plumbing lets it. A result above the ceiling is flagged as elsewhere.

## Skills, in the order they pay

| Family | Skill | What it returns | Expected result |
|---|---|---|---|
| 6, netting | `min_cost_flow` | the exact minimum-cost plan for the observed instance | the ceiling; this is the result the family was built to check |
| 1, placement | `failed_pairs` | the warm-up failures counted per unordered pair, sorted | the failure-aware heuristic, about 0.7 normalized; the model still has to choose the split |
| 3, settlement | `probe_sweep` | a sequence of probes over the grid and their results, as a table | near the ceiling, bounded by the eight probes |
| 10, DLC design | `dlc_design` | the exact optimum on the menus, as the offer action itself | the ceiling, if the model calls it and copies an offer of a few hundred characters |
| 5, bonding | `bond_offer` | the `half_rate` baseline's bond, as the bond action itself | that baseline, 0.94 to 0.98 normalized on development seeds |
| 7, proof budget | `schedule` (also `schedule_after_proof`, a second description) | the next action, prove or wait, of an interval schedule keyed to the oldest pending claim, one call per turn | at least `fixed_interval`, 0.95 to 0.98 normalized on development seeds, if the model calls it on every turn and never stops early |
| 4, server sizing | `capacity_plan` | `buffer_rule`'s next decision, resize or hold, one call per decision | that baseline, 0.53 / 0.64 / 0.91 normalized on `balanced` / `correlated` / `drift` development seeds, if the model calls it at all 32 decisions |
| 9, `custody` | `custody_policy` | the stated policy's decision on the next pending request | the ceiling, exactly: the policy is the cell's ceiling |
| 9, `custody_hot` | `inbox_policy` | the stated policy's next action on the next pending message | the ceiling, exactly |
| 9, `publish` | `outbox_plan` | the next step of `outbox`, NIP-65 as written | that baseline, 0.83 normalized on development seeds |
| 9, `private` | `nip17_plan` | the next step of `nip17`, the cell's ceiling | the ceiling, exactly |
| 9, `counterparty` | `buyer_plan` | the next step of `reputation`, the best baseline without hidden state | that baseline, 0.95 normalized on development seeds (0.67 on the confirmatory ones) |
| 9, mesh cells | `mesh_router` | the next step of `bitchat_router`, the whitepaper's router | that baseline, 0.85 and 0.86 normalized on development seeds |

Each skill is a few lines on top of a baseline's own code, which is the point: the question is not whether the procedure exists but whether a model at this size will call it, read it, and act on it within the budget.

## How the model sees a skill

The system prompt ends with a list of the skills the agent carries, each with its description, and the cap: "Before acting you may call a skill by replying with exactly {"skill":"<name>","args":{}} and nothing else; its result comes back in the next message." The call rate falls with the length of the first turn: 8 of 8 on `bilateral_dense` in every run, and 1 to 8 of 8 on the two 48-trade cells across six runs on 2026-10-07 with nothing changed but wording. Restating the callable skills at the end of every turn was tried and removed: it cut calls to 6 of 24 and made the model settle the example plan first on the dense cell, where it had called the skill every time. The result arrives as a user turn, `Result of skill <name> (<n> skill calls left):` and the result as compact JSON, followed by the instruction to reply with one JSON object and, when the result is itself an action, the offer to send it unchanged by replying `{"tool":"send"}` (`{"send":"<name>"}` also works). The form takes no name because the one time Bonsai 8B tried to send it wrote `{"send":"settle"}`, the action's name where the skill's went. Sending is by reference: the adapter hands the harness the stored result as the model's action, and the transcript records the reply and what it sent. This exists because copying is where a 1-bit 8B model fails, not deciding: on 2026-10-07, asked to restate a 25-transfer plan of about 1,500 characters, Bonsai 8B dropped a closing brace at the end in most episodes, whether the result was shown compact (4 of 8 copies survived on `tight_links`, 2 of 3 on `multilateral_sparse`) or indented (1 of 6, and 0 of 1; it re-compacted and lost more), while six-transfer plans on `bilateral_dense` were copied exactly in 16 of 17. The strict parser rejects a reply with a brace missing and nothing repairs it, by the preregistration; the send form lets the skill carry the bytes and leaves the model the decisions to call and to commit. A reply whose `tool` names a carried skill is a skill call too: on 2026-10-07 Bonsai 8B reached for `min_cost_flow` that way in 7 of 24 development episodes and never with the `skill` field, since the only envelope the prompt's examples show is the action's. The identity records the envelopes the adapter accepts. A call past the cap, an unknown skill, or a skill that fails never reaches the harness as a skill: past the cap the reply goes to the harness as it is and is rejected as malformed, costing an attempt; an unknown or failing skill returns `{"error": ...}` to the model and counts against the cap. An agent may also carry a cap per turn (`maxSkillCallsPerTurn`, bound into the identity only when set, and stated in the system prompt): a call past it goes to the harness the same way. It exists because on 2026-10-09 Bonsai 8B called `schedule` 227 times in one family 7 turn, passing back as arguments the action it had been given, until the request outgrew a 16,384-token context. A call cut off inside its arguments is still a call: a reply that does not parse but opens with the `skill` or `tool` field naming a carried skill runs that skill with no arguments, and the conversation keeps it as the bare envelope, `{"tool":"<name>","args":{}}`, while the transcript keeps the reply as written. On 2026-11-03 Bonsai 8B opened 21 calls of `outbox_plan` in `publish`, and every call of `nip17_plan` in `private`, by writing the observation's relay and follower lists into the arguments of a skill that takes none, until the 1,024-token cap cut the reply off. Under the earlier protocol each was rejected as malformed, and in `private` each would have kept 1,024 tokens of the cut-off list in the context. Actions get no such reading: a cut-off action is malformed, as the preregistration requires. The rule is part of the skill protocol the identifier binds, so it changed the identifier of every agent carrying a skill and of no other. Rerun with the replies already logged, the family 4, `custody`, and `custody_hot` skill runs produced identical transcripts under their new identifiers, since none of their replies opens a cut-off call.

What each skill returns:

- `min_cost_flow` (no arguments): the settle action itself; its description says to reply with that action unchanged. A first version returned `{"cost_sats", "action"}`, and Bonsai 8B copied that object whole, cost and all, so the result became the action itself. Two versions of the description then showed the send form as JSON, `{"send":"min_cost_flow"}` and `{"tool":"send"}`; each cut the call rate on the dense cell from 8 of 8 to 3 and 2 of 8, the snippet competing with the call form in the model's reading, and the model never sent anyway (0 of 19 calls across the three runs that offered it). So the description holds no JSON and the send offer stays in the result turn.
- `failed_pairs` (`{"limit": n}`, 1 to 50, default 10): `{"failed_pairs": [{"pair", "failed", "has_channel"}, ...], "total_failed"}`, most-failed first, ties by pair.
- `bond_offer` (no arguments): the bond action: the smallest grid bond covering the value at risk, and the shortest grid period that meets the catch probability at half the sample's maximum-likelihood response rate, which is the `half_rate` baseline.
- `proof_step` (no arguments, the first family 7 wording): the next action of `fixed_interval`'s schedule, its interval recomputed every turn from the proofs left. Recomputing drifts as the proofs run down, so even followed exactly it reaches 0.88 of the ceiling on `few_proofs` against the reference's 0.98.
- `schedule` (no arguments, the second): the next action of an interval schedule that needs no memory of earlier turns. The interval is the economic-order one, stretched so the proofs left last the blocks left; a proof is due when the oldest pending claim has waited one interval less a block, when a full batch is pending, or at the last block. Followed exactly it scores 0.950, 0.977, and 0.978 of the ceiling on `bursty`, `few_proofs`, and `steady` on development seeds, against `fixed_interval`'s 0.945, 0.978, and 0.978, and on 64 more seeds per cell outside every seed block it is never below the reference and never forfeits. Its description says to call it on every turn, also when nothing is pending, and its name shares no stem with a tool, for the reasons in the family 7 section below.
- `capacity_plan` (no arguments, family 4): `buffer_rule`'s action for the state shown, a resize to ceil(p + 2b) or a hold. Its margin, 0.25, is written in the skill's source so the agent id binds it, and a test holds it equal to `config/server_sizing.json`'s. The description says payments keep arriving until the horizon and to call it at every decision, because the bare model committed within four decisions in every development episode.
- The family 9 skills (no arguments): `custody_policy` is the `policy` baseline's decision on the next pending request, and it needs only the current observation. The other five are a baseline's next step in a procedure that runs over many turns: a lookup whose result decides what follows, a signed event whose handle the next action passes on, a rumor, then a seal, then a wrap. The frozen observation does not carry that state, so these skills replay a fresh copy of the baseline over every observation of the episode so far and return its next action:
  - `inbox_policy` replays `policy` on `custody_hot`;
  - `outbox_plan` replays `outbox`;
  - `nip17_plan` replays `nip17`;
  - `buyer_plan` replays `reputation`;
  - `mesh_router` replays `bitchat_router`.

  Followed at every turn, each skill is its baseline, and a test runs a model that copies every result on all eight development seeds of each cell and gets the baseline's value, metrics, and rejections exactly. A turn where the model sends something else can put the replayed plan out of step with the episode, since the baseline assumed its own action was sent. Each description says to call the skill at every turn, and the result is the commit when the procedure is done.

The mesh cells have their own `send` tool, which collides with the reply that sends a stored result. In an environment with a tool of that name, a `send` with arguments goes to the harness as the model wrote it, and only `{"tool":"send"}` with no arguments, or `{"send":"<name>"}`, sends a stored result. No other family has a `send` tool, so nothing about the earlier agents changes.

## Development results, family 6 (seeds 0 to 7)

Six variants of the skill-carrying agent were run on the development block on 2026-10-07, each a different identifier, and the bare agent once. Skill calls are per cell out of 8 episodes; the normalized gain is the table's, floor `gross`, ceiling `min_cost_flow`.

| Variant | Change | Calls dense / sparse / tight | Gain dense / sparse / tight |
|---|---|---|---|
| bare (`e6519a39e3ee`) | no skill | — | −0.44 / −1.00 / −0.53 |
| 1 (`a7af0154b11e`) | calls by tool envelope accepted; result `{cost_sats, action}` | 8 / 3 / 8 | 1.00 / −1.00 / 0.33 |
| 2 (`20a12795e8fe`) | result is the action, shown indented | 8 / 1 / 6 | 1.00 / −1.00 / −0.53 |
| 3 (`aad11630edbf`) | compact again; send by reference offered | 8 / 1 / 2 | 1.00 / −1.00 / −0.53 |
| 4 (`c5f75212c95a`) | skills restated every turn; description shows `{"send":…}` | 3 / 2 / 1 | 0.07 / −1.00 / −0.53 |
| 5 (`de56095a2d61`) | restatement removed; description shows `{"tool":"send"}` | 2 / 0 / 0 | −0.10 / −1.00 / −0.53 |
| 6 (`2e6ce1150a4a`) | description without JSON; the confirmatory agent | 8 / 1 / 4 | 1.00 / −1.00 / −0.53 |

What held across variants. On `bilateral_dense` (6 traders, about 5 transfers) the model calls the skill and copies its 350-character result exactly whenever the description carries no JSON, and scores the ceiling in every episode. On the two 48-trade cells it calls the skill in 1 to 8 episodes of 8 depending on wording alone, and when it does, its copy of the 1,500-character plan survives the strict parser about half the time at best (variant 1: 2 of 3 and 4 of 8; variant 6: 0 of 1 and 0 of 4). It never sent a result by reference (0 of 19 calls where that was offered). A gain of −1.00 on `multilateral_sparse` is the clipped penalty for episodes with no accepted plan. The one number that moved with the change meant to move it, and stayed, is the dense cell; the rest is noise around a low rate, and the confirmatory block is the estimate of that rate. A variant was never run on confirmatory seeds before variant 6.

## Confirmatory results, family 6 (seeds 1000 to 1031)

Variant 6 with `min_cost_flow`, `bonsai-8b-nothink@2e6ce1150a4a`, in [results/v0-netting-bonsai-8b-nothink-min_cost_flow-confirmatory.md](../results/v0-netting-bonsai-8b-nothink-min_cost_flow-confirmatory.md):

| Cell | Skill called | Copy accepted at once | Normalized gain | Agent − `bilateral_net`, adjusted |
|---|---:|---:|---|---|
| `bilateral_dense` | 24 of 32 | 24 of 24 | 0.59 (0.34 to 0.84) | +0.16 (−0.25 to +0.58), inconclusive |
| `multilateral_sparse` | 5 of 32 | 0 of 5 | −1.00, clipped | −0.93 (−1.04 to −0.83), negative |
| `tight_links` | 8 of 32 | 0 of 8 | −0.48 (−0.60 to −0.36) | −1.06 (−1.27 to −0.85), negative |

Every dense episode in which the model called the skill scored the ceiling, and the eight in which it did not score the no-plan penalty; 0.59 is the mean of the two. On the 48-trade cells the call rate is 16 and 25 percent and no copy of the long plan was accepted, so the agent sits at or below the floor there. No result was sent by reference in 96 episodes. The expectation Amendment 3 recorded for a skill-carrying agent, a normalized gain of 0.9 or more, is not met on any cell: it assumed the skill's result would reach the harness, and what bounds the result is the model's decision to call and its copy of the plan, not the skill. Gates K11 to K13 pass, so the plumbing is not the cause. The development call rate on the dense cell, 8 of 8 in four variants, overstated the confirmatory 24 of 32. The bare agent, `bonsai-8b-nothink@e6519a39e3ee`, in [results/v0-netting-bonsai-8b-nothink-confirmatory.md](../results/v0-netting-bonsai-8b-nothink-confirmatory.md): no accepted plan in any of 96 episodes, normalized −0.49 (−0.52 to −0.45), −1.00 clipped, and −0.56 (−0.63 to −0.49) on the three cells, every primary contrast negative; its rejections are 137 malformed, 95 unbalanced, 93 over budget and 19 without a link, which is the prediction tasks §7.6 recorded for an agent without the skill. So on the dense cell the skill is the difference between the floor and the ceiling, and the model's reading of it is the difference between the ceiling and 0.59.

## Development results, family 1 (seeds 0 to 7)

Bonsai 8B with `failed_pairs`, `bonsai-8b-nothink@6126b58af965`, in [results/v0-placement-bonsai-8b-nothink-failed_pairs-development.md](../results/v0-placement-bonsai-8b-nothink-failed_pairs-development.md), 48 episodes: the model never called the skill, and its result is indistinguishable from the random floor on both regimes (normalized −0.01, intervals covering zero), as the bare agent's was; 154 of its replies were malformed. The first turn of a family 1 episode is about 4,300 characters of graph and payment history on these seeds, and up to about 10,000 on confirmatory seeds, against 1,900 for the dense netting cell where the skill was called every time on these seeds: the same length effect as in family 6, further along. Nothing of the skill reached the model, so this was not run on confirmatory seeds; what remains to try here is thinking mode, step 4 below.

## Development results, family 10 (seeds 0 to 7)

Bonsai 8B with `dlc_design`, `bonsai-8b-nothink@a63ee64a14a3`, in [results/v0-dlc-bonsai-8b-nothink-dlc_design-development.md](../results/v0-dlc-bonsai-8b-nothink-dlc_design-development.md), and bare, `bonsai-8b-nothink@1a17091c09d8`, in [results/v0-dlc-bonsai-8b-nothink-development.md](../results/v0-dlc-bonsai-8b-nothink-development.md). The skill was called in none of 24 episodes. The bare model offered the prompt's example design verbatim in all 24; with the skill in its prompt it probed in every episode and still offered the example in 15. Both land near the floor, about 3 to 4 ln units below `uniform_tuned` on the two 30-day cells (docs/tasks.md §13.8). The first turn is about 3,300 characters, between family 6's dense cell (1,900, skill called 8 of 8) and family 1 (4,300 on development seeds, never called), and it carries three JSON examples. The example design was chosen to be valid and expensive, so copying it is scored as what it is rather than rewarded.

## Confirmatory results, family 10 (seeds 1000 to 1031)

With `dlc_design` the model called the skill in 18 of 96 episodes, and all 18 offered its result and scored the ceiling: an offer of a few hundred characters is copied without a slip. Its gains are 0.28, 0.25, and 0.23 on `mobile_signer`, `stable_30d`, and `stable_90d`, against 0.07, 0.08, and −0.04 bare. Both remain below `uniform_tuned` in every cell (docs/tasks.md §13.9). On this family the call rate is the whole gap: about one call in five, where development showed none in 24.

## Development results, families 2, 5, and 7

Bare Bonsai 8B, no skills, thinking off.

- **Family 5, service bonding.** It offered the prompt's example, the largest bond with the longest period, in 24 of 24 episodes. That offer is always admitted, so it costs a lot but is never penalized. Agent − `plug_in` is −0.24 to −0.52 in ln cost, with every interval crossing zero at eight seeds (docs/tasks.md §6.1).
- **Family 7, proving within a budget.** It forfeited 98% of the claims and sits at the floor, about 7.8 ln units below `fixed_interval`. Eighteen of 24 episodes ended with `commit` after a few proofs of one to four claims (docs/tasks.md §8.6).

- **Family 2, routing** (seeds 0 and 1 only). It delivered within −2.3 to +1.4 points of the retry wallet in each task. It tried candidate 0 first on 97% of payments: the prompt's example index and the shortest path. After a failure it mostly tried that same candidate again, and it never skipped (docs/tasks.md §3.3). Two seeds could not separate that from the retry wallet; the confirmatory run below does.

In families 5 and 7, as in families 1, 6, and 10, the model either copies what the prompt shows or ends early. The two sections below are what skills did about it.

## Development results, family 5 with `bond_offer` (seeds 0 to 7)

`bonsai-8b-nothink@6efb099f3322`, in [results/v0-bonding-bonsai-8b-nothink-bond_offer-development.md](../results/v0-bonding-bonsai-8b-nothink-bond_offer-development.md). The model called the skill on its first turn in all 24 episodes and offered the result in all 24: 22 sent by reference, where no family 6 or 10 run had sent one, and 2 copied exactly. Every episode scored what `half_rate` scores: normalized 0.98, 0.94, and 0.96 on `fast`, `slow`, and `strict`. The first turn is about 1,700 characters before the skill list, with one example action: shorter than family 6's dense cell (1,900), where the skill was also called every time. The skill's own level is the bound now; what remains above it is the margin `half_rate` pays against a sample of eight response times.

## Development results, family 7 with skills (seeds 0 to 7)

A family 7 episode is up to 144 blocks, decided one turn at a time, and an agent that stops early forfeits every claim still to arrive. That makes it the bench's longest decision chain for a small model. Seven runs on 2026-10-08 and 2026-10-09; gains are the table's, floor `every_arrival`, ceiling `optimal_batching`. `schedule` followed exactly scores 0.950, 0.977, and 0.978.

| Run | Agent | Gain bursty / few_proofs / steady | Claims forfeited | Ended with `commit` |
|---|---|---|---:|---:|
| bare (2026-10-08) | `3748879242c9` | −0.19 / −0.01 / −0.06 | 98% | 18 of 24 |
| bare, stop line reworded | `910e2b21cafc` | −0.11 / −0.01 / −0.06 | 86% | 9 of 24 |
| `proof_step` | `d40dfa62749a` | −0.18 / 0.03 / 0.01 | 75% | 22 of 24 |
| `schedule`, first try | — | crashed: 227 skill calls in one turn | — | — |
| `schedule`, one call per turn | `bbd834c1c687` | 0.44 / 0.03 / 0.04 | 54% | 20 of 24 |
| `schedule`, one call per turn, greedy | `56c0300c61db` | **0.95** / 0.06 / 0.64 | 29% | 13 of 24, 2 at the last block |
| the same, description naming the turn after a proof (`schedule_after_proof`) | `4defdd7582fd` | **0.95** / 0.18 / 0.74 | 12% | 10 of 24 |

What each step found:

- **The name.** With `proof_step` the model wrote `prove_step` 70 times, a blend of the skill and the `prove` tool. Each one was rejected as an unknown tool and spent a proof. `schedule` shares no stem with a tool, and the blend did not recur.
- **The stop line.** The prompt said stopping loses "every claim not yet proven". The model read that as the pending claims, and committed as soon as a proof emptied the queue. The line now adds "including every claim still to arrive" (tasks §8.6). Bare, that halved the early stops, and the model then proved one claim at a time instead (243 of 399 proofs), the prompt's example count, until its proofs ran out. Its result stayed at the floor.
- **A loop.** In its first try with `schedule` the model called the skill 227 times in one turn, passing the given action back as arguments, until the request outgrew the context. A cap of one call per turn ends that: a second call goes to the harness and is rejected. It did not happen again in 48 episodes.
- **Sampling.** At temperature 0.7 the model called the skill on 371 of 375 ordinary turns. On the turn right after a proof empties the queue it called it only 110 times in 215, waited 84 times, and committed 20 times. That 9% recurs 10 to 25 times an episode, and it ended 20 of 24 episodes early. Greedy decoding removes the sampled tail: the skill was called on all 512 ordinary turns, and commits after a proof fell to 13 in 335. On `bursty` no episode stopped early, nothing was forfeited, and the gain equals the skill's, 0.95, with agent − `fixed_interval` +0.03 (−0.02 to +0.09). What is left is the argmax itself in one state: right after a proof, with few proofs left. Every `few_proofs` episode committed there, after 2 to 9 proofs. On `steady`, three episodes stopped before the last block.
- **The turn after a proof, named.** A second description for the same code and name says to call it "also right after a proof when nothing is pending: stopping early loses every claim still to arrive". Greedy, the model then called the skill on that turn 373 times in 383 and never waited without it. The 10 commits left follow one rule: right after a proof with 2 or 3 proofs left, it stops (8 of 11 such turns, every `few_proofs` episode, at block 108 or 120); with 4 or more left it called the skill every time. Two `steady` episodes stopped at block 73 and 74 with 36 proofs left, the only exceptions. The wording was not tuned further: a description aimed at that trigger would be fitted to eight development seeds.

So in family 7 the skill reaches its own level only where the model never stops early: on `bursty`, in both greedy runs. Elsewhere what is left is the model's rule that scarce proofs mean stop. Greedy decoding is part of the agent's identity, like any sampling setting, and is reported as a separate agent.

## Confirmatory results, families 5 and 7 (seeds 1000 to 1031)

Amendments 7 and 8 fixed four agents before these runs, all with thinking off: each family bare, family 5 with `bond_offer`, and family 7 with `schedule_after_proof`, greedy, with one call per turn. All four ran on 2026-10-30 against the same source (`source_sha256` `75674790917c…`), and every calibration gate passed. The agent − reference contrasts are adjusted for three comparisons. Details and intervals are in docs/tasks.md §6.1 and §8.6.

| Agent | Skill called | Result reaching the harness | Normalized gain | Agent − reference, adjusted |
|---|---|---|---|---|
| family 5 bare (`2293827142dd`) | — | the prompt's example in 95 of 96 | −0.13 / 0.33 / 0.01 | one negative (`fast`), two inconclusive |
| family 5 `bond_offer` (`6efb099f3322`) | 96 of 96, first turn | 77 sent by reference, 17 copied, 2 malformed then the example | 0.96 / 0.96 / 0.95 | positive on `slow` and `strict`, inconclusive on `fast` |
| family 7 bare (`910e2b21cafc`) | — | 83% of claims forfeited; 45 early `commit`s, 24 waits to the horizon | −0.04 / −0.01 / −0.05 | all three negative |
| family 7 `schedule_after_proof`, greedy (`4defdd7582fd`) | all 2,058 ordinary turns; 1,573 of 1,607 after a proof | 34 early `commit`s, each on a turn without a call | 0.95 / 0.18 / 0.92 | positive on `bursty`, negative on `few_proofs`, inconclusive on `steady` |

Gains are for `fast` / `slow` / `strict` in family 5 and for `bursty` / `few_proofs` / `steady` in family 7. In family 5 the reference is `plug_in`; in family 7 it is `fixed_interval`.

What the confirmatory block says:

- **Development predicted it.** Every number the eight development seeds showed held on the 32 confirmatory seeds, unlike family 6, where development's 8 of 8 call rate fell to 24 of 32.
- **Family 5 with the skill: the skill is the bound.** On `fast` the skill's own level is not separable from `plug_in` after adjustment: `half_rate` − `plug_in` is +0.25 (+0.03 to +0.47) before it. So the inconclusive `fast` contrast is the skill's margin, not the model's.
- **Family 5 bare: a sound but expensive copy.** It offers the safe, expensive end of the grid. That offer is never rejected, so on `slow` the bare agent comes within 0.07 of the reference.
- **Family 7 with the skill: one remaining failure.** The model's own stop rule. Right after a proof, with two or three proofs left, it ends the episode instead of calling the skill: in every `few_proofs` episode, at block 84 to 120, as on development seeds.
- **Family 7 with the skill: where it does not stop, it beats the reference.** On `bursty` nothing stopped, and the agent beats `fixed_interval`, +0.03 (+0.01 to +0.05). With family 5's `slow` and `strict`, these are the first agent − reference contrasts the bench has found positive for an LLM, and in all three what beats the reference is the skill's procedure, carried through by the model.
- **Family 7 bare: no strategy.** It has none that survives the horizon. It ends early, waits to the end, or proves one claim at a time until its proofs run out.

## Confirmatory result, family 2 (seeds 1000 to 1031)

Amendment 9 fixed bare Bonsai 8B (`e6b9a351f65d`, thinking off, the development prompt) before this run. The run ended on 2026-11-03. The calibration gates passed. No adjusted agent − `retry_wallet` interval fell inside the ±1.0 band, so all nine rows were audited as prereg §9 requires. The audit found no harness defect ([audit note](../results/v0-routing-bonsai-8b-nothink-confirmatory.audit.md)).

- **Result.** Agent − `retry_wallet` is negative on five tasks and inconclusive on four, between −0.82 and −5.20 points. The normalized gain is 0.10 to 0.66. On the family the bench calibrates its harness against, the bare model is equivalent to the reference on no task and below it on five.
- **First try.** It copies the example. Candidate 0 is its first try on 93% of payments. That is the shortest path, and in eight of nine tasks it delivers more often than `one_shot`'s cheapest path.
- **Retries.** It does not retry with a different candidate. Of 3,530 scored payments with more than one candidate that took a second attempt, 2,527 never had another candidate tried. A repeated attempt cannot succeed, and trying other candidates is the whole of the retry wallet's lead.

The skill that matches this failure is the retry wallet's next candidate. It would read the observation, take the public-fee order, skip what was already tried, and return the attempt as an action the model sends by reference. Followed exactly, it is `retry_wallet`. The test is whether the model calls it after a failure.

## Development results, families 4 and 9 (seeds 0 to 7)

On 2026-11-03 bare Bonsai 8B was run for the first time on family 4 (inbound resizing) and on family 9's seven cells. Both show the patterns of the other families, at their worst.

- **Copying the example.** In family 4 the model resized to the prompt's 100,000-sat format example in 9 of 24 episodes. In family 9's `publish` cell it filtered on the placeholders `"<hex pubkey>"` and `"..."`.
- **Stopping early.** Every family 4 episode ended with `commit` within four of 32 decisions. That fixes the capacity to the horizon, so failed receipts dominate the cost, and the agent is clipped at −1.00 in all three cells. As in family 7, the model reads `commit` as "done".
- **A signer that signs everything.** In `custody` it approved 5.6 of 6 hostile requests an episode, and the key was compromised in 6 of 8 episodes. In `custody_hot` it answered nothing at all.
- **Long JSON.** In `private`, a rumor reply missing its final closing brace accounts for most of 71 malformed rejections. That is the same slip family 6's long plans showed.

Details are in docs/tasks.md §5.2 and §10.9. The skills written for these failures are in the table above. Each returns a short action the model can send by reference, as in family 5 and family 7's `bursty` cell, where that carried a skill's level through.

**With the skills, family 4 and the custody cells** (the same day, at the bare agent's sampling, temperature 0.7, and again at temperature 0). Every reply was replayed under the skill protocol that recognizes a cut-off call (above), which changed nothing in these three runs. In the table:

- **Calls** are the turns with a skill call, out of all turns.
- **Followed** are the calls whose result was sent as the action.
- **Agent − reference** is per cell, in the family's unit.

| Run | Agent | Calls | Followed | Agent − reference | Bare agent − reference |
|---|---|---:|---:|---|---|
| family 4, `capacity_plan`, 0.7 | `5bf77bc1d7db` | 111 of 366 | 111 | −1.99 / −1.62 / −2.36 | −4.23 / −3.52 / −2.80 |
| family 4, `capacity_plan`, 0 | `bonsai-8b-nothink-t0@5992af5d3411` | 69 of 849 | 69 | −2.66 / −1.29 / −1.67 | |
| `custody`, `custody_policy`, 0.7 | `284eb3883ea5` | 0 of 197 | — | −48,288 sats | −27,333 |
| `custody`, `custody_policy`, 0 | `bonsai-8b-nothink-t0@72f92f5748e9` | 0 of 136 | — | −48,488 | |
| `custody_hot`, `inbox_policy`, 0.7 | `22e2200e3886` | 1 of 96 | 1 | +44,700 | +44,663 |
| `custody_hot`, `inbox_policy`, 0 | `bonsai-8b-nothink-t0@cbeca978bb80` | 0 of 98 | — | +19,700 | |

The family 4 cells are listed as `balanced` / `correlated` / `drift`. The custody cells' references are `kinds_only` and `no_key_paste`, both below doing nothing. So `custody_hot`'s positive contrast means the model answered almost nothing, about what `idle` earns.

- **Family 4.** The skill helps when it is called. The model called it on 30% of decisions and copied every result. On decisions without a call it resized to the format example, 100,000 sats, 136 times in 255, and that was most of what it did otherwise. The run halved the bare agent's shortfall against `buffer_rule` in two cells, but the agent was still clipped at −1.00 normalized in two of three.
- **The custody cells.** The skill was never called in `custody`, and once in `custody_hot`. The first turn is long there, about 8,800 characters, and family 6 showed the call rate falling with the first turn's length.
- **Temperature 0.** It called the skill no more often in any of the three, and less often in family 4: 8% of decisions against 30%. Its family 4 episodes ran longer, 849 decisions against 366, mostly at the format example. So the agents the preregistration fixes sample at 0.7. These temperature-0 runs predate the cut-off rule and keep their earlier identifiers.

**With the skills, the other five family 9 cells** (2026-11-03 to 04, at 0.7, under the cut-off protocol from the start):

| Cell | Agent | Calls | Followed | Agent − reference, sats | Bare agent − reference |
|---|---|---:|---:|---|---|
| `publish`, `outbox_plan` | `9a50b6012cdd` | 18 of 139 | 10 | −11,788 | −12,988 |
| `private`, `nip17_plan` | `bf72a2ef7045` | not completed | | | −26,033 |
| `counterparty`, `buyer_plan` | `7022487f091f` | 24 of 117 | 24 | +11,933, inconclusive | +9,679, inconclusive |
| `mesh_outage`, `mesh_router` | `e94ca1ac779a` | 31 of 159 | 16 | −15,852 | −16,172 |
| `mesh_partial`, `mesh_router` | `71bc752498cf` | 54 of 163 | 24 | −14,883 | −18,024 |

- **Long arguments.** In `publish`, 120 of 139 actions were `fetch` requests that listed authors' keys until the reply reached the 1,024-token cap, and were rejected as malformed. In `private` the `fetch` requests were complete, 481 tokens each, but every request carries the whole episode. On seed 1, after 15 of them in a row, the request for turn 16 was 41,025 tokens. The run stopped there under Amendment 10's rule. The bare agent's `private` run had finished within the context.
- **The format example again.** In `counterparty`, on turns without a call, the model bid the prompt's example, 25,000 sats, 27 times, and paid the offer `"<offer id>"` 8 times.
- **Flooding.** In the mesh cells the model followed the router on about half its calls. Otherwise it sent over the mesh again and again: 229 and 198 transmissions an episode, against the oracle's 24 and 22.
- **No clear change.** In each completed cell the skill agent's interval overlaps the bare agent's. The largest shift is `mesh_partial`'s, about 3,100 sats toward the reference. The agent stays below the reference in `publish` and both mesh cells, and is inconclusive in `counterparty`, as the bare agent was.

Amendment 11 fixes these five agents for the confirmatory seeds.

The TRM complex (docs/trm_complex.md) uses the same skills a different way. The model proposes, the cell's rules check the proposal, and the skill repairs it. On the development seeds it played each skill's baseline exactly in every cell but `custody_hot`.

## Confirmatory results, skill agents (seeds 1000 to 1031)

All eight skill agents were run on 2026-11-04: the three Amendment 10 fixed, then the five Amendment 11 fixed. Nothing is flagged for audit.

**Family 4 and the custody cells** (Amendment 10). Family 4's contrast is agent − `buffer_rule` in ln cost, adjusted over the three cells. The custody cells' contrast is agent − the cell's reference, in sats.

| Run | Agent | Calls | Copied | Agent − reference | Normalized |
|---|---|---:|---:|---|---|
| family 4, `balanced` | `5bf77bc1d7db` | 416 of 1,311, three cells | 416 | −2.49 (−3.10 to −1.87), negative | −1.00, clipped |
| family 4, `correlated` | | | | −1.44 (−1.97 to −0.91), negative | −0.83 |
| family 4, `drift` | | | | −1.25 (−1.65 to −0.85), negative | −0.65 |
| `custody` | `284eb3883ea5` | 0 of 743 | — | −72,428 (−112,662 to −32,193), negative | −1.00, clipped |
| `custody_hot` | `22e2200e3886` | 1 of 385 | 1 | +38,091 (+20,009 to +56,172), positive | −1.00 (−1.00 to 1.32), clipped |

- **Family 4: the development pattern, at the same size.** The model called `capacity_plan` on 32% of decisions and copied every result. On the decisions without a call it resized to the format example, 100,000 sats, 488 times in 895, and committed 93 times. Failed receipts are most of its cost in every cell. The development estimates were −1.99, −1.62, and −2.36. As the TRM complex, the same skill played `buffer_rule` exactly (docs/trm_complex.md).
- **`custody`: no call, and the key lost.** The model never called `custody_policy`. It approved 5.5 hostile requests an episode, and the key was compromised in 30 of 32 episodes. That is worse than the reference, `kinds_only`, which is itself below doing nothing.
- **`custody_hot`: one call, and mostly silence.** The model earned exactly 0 in 26 of 32 episodes. Of the other 6, it leaked the key in 2, at −200,000 sats each, and answered 5 legitimate messages across the remaining 4. The positive contrast reflects only how far the reference, `no_key_paste`, falls below doing nothing.

**The other five family 9 cells** (Amendment 11). In the table, **calls** are turns with a skill call and **copied** are calls whose result was sent as the action. The contrast is again agent − the cell's reference, in sats.

| Cell | Agent | Calls | Copied | Agent − reference | Normalized | TRM complex, same skill |
|---|---|---:|---:|---|---|---|
| `publish` | `9a50b6012cdd` | 64 of 563 | 27 | −13,559 (−14,549 to −12,570), negative | 0.03 (−0.03 to 0.08) | 0.86 |
| `private` | `bf72a2ef7045` | not completed | | | | 1.00 |
| `counterparty` | `7022487f091f` | 54 of 530 | 54 | +4,503 (−5,551 to +14,556), inconclusive | 0.12 (−0.02 to 0.27) | 0.67 |
| `mesh_outage` | `e94ca1ac779a` | 153 of 662 | 72 | −11,343 (−13,705 to −8,982), negative | 0.13 (0.00 to 0.26) | 0.79 |
| `mesh_partial` | `71bc752498cf` | 231 of 641 | 125 | −8,512 (−11,003 to −6,020), negative | 0.28 (0.13 to 0.43) | 0.79 |

- **`private` did not complete.** On seed 1002 the request for turn 20 was 42,486 tokens, past the 40,960-token context, and the run stopped under Amendment 10's rule. Seeds 1000 and 1001 had run 24 turns each ([note and partial logs](../results/v0-nostr-private-bonsai-8b-nothink-nip17_plan.not-completed.md)).
- **The development failures repeat.** In `publish`, 380 of 563 actions were `fetch` requests cut off at the 1,024-token reply cap. In `counterparty`, on turns without a call the model waited (102), bid the prompt's example of 25,000 sats (60), and paid the offer `"<offer id>"` (30). In the mesh cells it copied about half of its calls. It transmitted more than `bitchat_router` (197 and 233 an episode, against 166 and 159) and delivered fewer messages (2.1 and 3.3, against 5.8 and 5.7).
- **The same skill, two ways.** Given the skill as a tool, the model reached 0.03 to 0.28 of the ceiling. In the TRM complex, where the skill repairs the model's proposal and a constant gate prefers it, the same skill reached 0.67 to 1.00 (docs/trm_complex.md). As a tool, the skill was called on 10% to 36% of turns, and 42% to 100% of the calls were copied. In the complex, the skill's action is sent whenever the proposal differs from it, so the score is the skill's.

## Confirmatory results, bare agents of families 4 and 9 (seeds 1000 to 1031)

Amendment 12 fixed the eight bare agents, and they were run on 2026-11-04 alongside the combo complexes (docs/trm_complex.md). Every gate passed, nothing is flagged, and all eight completed. `private` ran on the 40,960-token context. The contrast is Amendment 10's: in family 4 agent − `buffer_rule` in ln cost, adjusted over the three cells, and in family 9 agent − the cell's reference in sats.

| Cell | Agent | Agent − reference | Normalized | Skill as tool, normalized |
|---|---|---|---|---|
| family 4, `balanced` | `b7e945ef3ef0` | −4.75 (−5.01 to −4.49), negative | −1.00, clipped | −1.00, clipped |
| family 4, `correlated` | | −2.82 (−3.61 to −2.03), negative | −1.00, clipped | −0.83 |
| family 4, `drift` | | −2.93 (−3.50 to −2.37), negative | −1.00, clipped | −0.65 |
| `custody` | `d8325f53f685` | −83,649 (−121,276 to −46,023), negative | −1.00, clipped | −1.00, clipped |
| `custody_hot` | `fd6b50014da9` | +31,844 (+10,139 to +53,548), positive | −1.00 (−1.00 to 0.77), clipped | −1.00, clipped |
| `publish` | `22aa09bf32c9` | −14,083 (−14,802 to −13,365), negative | −0.01 | 0.03 |
| `private` | `e06836fa3df2` | −26,035 (−28,205 to −23,864), negative | 0.00 | not completed |
| `counterparty` | `6332fdb1e664` | +2,520 (−7,930 to +12,969), inconclusive | 0.07 | 0.12 |
| `mesh_outage` | `8d6935055857` | −15,990 (−17,954 to −14,027), negative | −0.14 | 0.13 |
| `mesh_partial` | `24f957258215` | −15,693 (−17,306 to −14,080), negative | −0.15 | 0.28 |

- **The development failures repeat.**
  - **Family 4**: 201 decisions in 96 episodes; there was no resize in 35 episodes and failed payments in 87.
  - **`custody`**: the key was compromised in all 32 episodes.
  - **`custody_hot`**: it earned exactly 0 in 27 of 32 episodes and leaked the key in 3.
  - **`publish`**: it reached no follower and no mention in any episode. 150 of its actions named unknown handles, and 106 were over budget.
  - **`private`**: one NIP-17 message was delivered in 32 episodes. 232 actions were over budget and 136 malformed.
  - **`counterparty`**: it got a result in 6 of 32 episodes and paid an impostor in 6.
  - **The mesh cells**: it delivered 28 and 22 of 192 messages, with 246 and 221 transmissions an episode.
- **The tool helps where it is called.** Skill as tool − bare, paired by seed, is positive in family 4's three cells (+2.26, +1.38, +1.68 ln) and in both mesh cells (+4,647 and +7,181 sats). It is inconclusive in `custody`, `custody_hot`, `publish`, and `counterparty`, where the skill was called on 0% to 11% of turns.
- **The complex helps everywhere.** In the TRM complex the same skill is sent whenever the proposal differs from it. Complex − bare is positive in all ten rows, and the complex reaches 0.35 to 1.00 of the ceiling. The full 2×2 is in [results/v0-skill-trm-factorial-confirmatory.md](../results/v0-skill-trm-factorial-confirmatory.md) and docs/trm_complex.md.

## Order of work

1. Done (2026-10-07): the skill loop in `src/agents/chat.ts`, the skills in `src/agents/skills.ts`, a netting prompt in `src/tasks/netting/prompt.ts`, and `scripts/run_netting_agent.ts` with `--skills`. Tests cover the loop, the cap, the identity binding, error returns, and that a model which echoes `min_cost_flow` scores the ceiling.
2. `min_cost_flow` for family 6, run on development seeds (the six variants above), then one confirmatory run of variant 6 and of the bare agent (results in the README's results list).
3. `failed_pairs` for family 1, the same way. Done on development seeds: never called (section above). The number this was meant to produce, the gap between the skill's result and the heuristic, needs a model that calls it.
4. Thinking mode, as a separate agent identifier, only where the non-thinking result falls short of the skill's expected result.
