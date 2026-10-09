# Pushing the ceilings with a small model

Decided on 2026-10-07: Bonsai 8B is the model the bench is pushed with, so that a result near a ceiling is reached at the lowest operating cost that can reach it. The bare model does not get there (its family 1 result equals placing nothing). What gets a small model there is a skill: a procedure the model can call, whose result it reads before it acts.

## What a skill is here

A skill is a function on the agent's side of the interface, run by the adapter when the model asks for it, over the observation the model already has and nothing else. The model asks for one by replying `{"skill": "<name>", "args": {...}}` instead of an action; the adapter runs it, appends its result as the next user turn, and asks again. Skill calls are capped per episode by the adapter and cost no harness budget, because the harness never sees them: what reaches the environment is still one action per turn, from the model.

Three rules keep this honest:

- **No privileged input.** A skill reads the observation and its own arguments. It cannot see hidden state, the regime, or the fixture; it is code the model carries, not a side channel.
- **Identity.** The agent identifier binds the skill set (each skill's source hash), the call cap, and the call envelopes along with the model, prompt and sampling; an agent with no skills has the identifier it had before skills existed. "Bonsai with the netting skill" and "Bonsai bare" are different agents, reported as such.
- **The ceiling check still applies.** A skill that is the oracle's algorithm should reach the ceiling exactly; the identity control for that family says whether the plumbing lets it. A result above the ceiling is flagged as elsewhere.

## Skills, in the order they pay

| Family | Skill | What it returns | Expected result |
|---|---|---|---|
| 6, netting | `min_cost_flow` | the exact minimum-cost plan for the observed instance | the ceiling; this is the result the family was built to check |
| 1, placement | `failed_pairs` | the warm-up failures counted per unordered pair, sorted | the failure-aware heuristic, about 0.7 normalized; the model still has to choose the split |
| 3, settlement | `probe_sweep` | a sequence of probes over the grid and their results, as a table | near the ceiling, bounded by the eight probes |
| 10, DLC design | `dlc_design` | the exact optimum on the menus, as the offer action itself | the ceiling, if the model calls it and copies an offer of a few hundred characters |
| 5, bonding | `bond_offer` | the `half_rate` baseline's bond, as the bond action itself | that baseline, 0.94 to 0.98 normalized on development seeds |
| 7, proof budget | `schedule` | the next action, prove or wait, of an interval schedule keyed to the oldest pending claim, one call per turn | at least `fixed_interval`, 0.95 to 0.98 normalized on development seeds, if the model calls it on every turn and never stops early |

Each skill is a few lines on top of a baseline's own code, which is the point: the question is not whether the procedure exists but whether a model at this size will call it, read it, and act on it within the budget.

## How the model sees a skill

The system prompt ends with a list of the skills the agent carries, each with its description, and the cap: "Before acting you may call a skill by replying with exactly {"skill":"<name>","args":{}} and nothing else; its result comes back in the next message." The call rate falls with the length of the first turn: 8 of 8 on `bilateral_dense` in every run, and 1 to 8 of 8 on the two 48-trade cells across six runs on 2026-10-07 with nothing changed but wording. Restating the callable skills at the end of every turn was tried and removed: it cut calls to 6 of 24 and made the model settle the example plan first on the dense cell, where it had called the skill every time. The result arrives as a user turn, `Result of skill <name> (<n> skill calls left):` and the result as compact JSON, followed by the instruction to reply with one JSON object and, when the result is itself an action, the offer to send it unchanged by replying `{"tool":"send"}` (`{"send":"<name>"}` also works). The form takes no name because the one time Bonsai 8B tried to send it wrote `{"send":"settle"}`, the action's name where the skill's went. Sending is by reference: the adapter hands the harness the stored result as the model's action, and the transcript records the reply and what it sent. This exists because copying is where a 1-bit 8B model fails, not deciding: on 2026-10-07, asked to restate a 25-transfer plan of about 1,500 characters, Bonsai 8B dropped a closing brace at the end in most episodes, whether the result was shown compact (4 of 8 copies survived on `tight_links`, 2 of 3 on `multilateral_sparse`) or indented (1 of 6, and 0 of 1; it re-compacted and lost more), while six-transfer plans on `bilateral_dense` were copied exactly in 16 of 17. The strict parser rejects a reply with a brace missing and nothing repairs it, by the preregistration; the send form lets the skill carry the bytes and leaves the model the decisions to call and to commit. A reply whose `tool` names a carried skill is a skill call too: on 2026-10-07 Bonsai 8B reached for `min_cost_flow` that way in 7 of 24 development episodes and never with the `skill` field, since the only envelope the prompt's examples show is the action's. The identity records the envelopes the adapter accepts. A call past the cap, an unknown skill, or a skill that fails never reaches the harness as a skill: past the cap the reply goes to the harness as it is and is rejected as malformed, costing an attempt; an unknown or failing skill returns `{"error": ...}` to the model and counts against the cap. An agent may also carry a cap per turn (`maxSkillCallsPerTurn`, bound into the identity only when set, and stated in the system prompt): a call past it goes to the harness the same way. It exists because on 2026-10-09 Bonsai 8B called `schedule` 227 times in one family 7 turn, passing back as arguments the action it had been given, until the request outgrew a 16,384-token context.

What each skill returns:

- `min_cost_flow` (no arguments): the settle action itself; its description says to reply with that action unchanged. A first version returned `{"cost_sats", "action"}`, and Bonsai 8B copied that object whole, cost and all, so the result became the action itself. Two versions of the description then showed the send form as JSON, `{"send":"min_cost_flow"}` and `{"tool":"send"}`; each cut the call rate on the dense cell from 8 of 8 to 3 and 2 of 8, the snippet competing with the call form in the model's reading, and the model never sent anyway (0 of 19 calls across the three runs that offered it). So the description holds no JSON and the send offer stays in the result turn.
- `failed_pairs` (`{"limit": n}`, 1 to 50, default 10): `{"failed_pairs": [{"pair", "failed", "has_channel"}, ...], "total_failed"}`, most-failed first, ties by pair.
- `bond_offer` (no arguments): the bond action: the smallest grid bond covering the value at risk, and the shortest grid period that meets the catch probability at half the sample's maximum-likelihood response rate, which is the `half_rate` baseline.
- `proof_step` (no arguments, the first family 7 wording): the next action of `fixed_interval`'s schedule, its interval recomputed every turn from the proofs left. Recomputing drifts as the proofs run down, so even followed exactly it reaches 0.88 of the ceiling on `few_proofs` against the reference's 0.98.
- `schedule` (no arguments, the second): the next action of an interval schedule that needs no memory of earlier turns. The interval is the economic-order one, stretched so the proofs left last the blocks left; a proof is due when the oldest pending claim has waited one interval less a block, when a full batch is pending, or at the last block. Followed exactly it scores 0.950, 0.977, and 0.978 of the ceiling on `bursty`, `few_proofs`, and `steady` on development seeds, against `fixed_interval`'s 0.945, 0.978, and 0.978, and on 64 more seeds per cell outside every seed block it is never below the reference and never forfeits. Its description says to call it on every turn, also when nothing is pending, and its name shares no stem with a tool, for the reasons in the family 7 section below.

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

- **Family 2, routing** (seeds 0 and 1 only). It delivered within −2.3 to +1.4 points of the retry wallet in each task, trying candidate 0, the prompt's example index and the shortest path, first on 97% of payments, then other candidates, never skipping (docs/tasks.md §3.3). Here copying the example is close to a sound policy, because trying alternatives is most of what routing gains.

In families 5 and 7, as in families 1, 6, and 10, the model either copies what the prompt shows or ends early. The two sections below are what skills did about it.

## Development results, family 5 with `bond_offer` (seeds 0 to 7)

`bonsai-8b-nothink@6efb099f3322`, in [results/v0-bonding-bonsai-8b-nothink-bond_offer-development.md](../results/v0-bonding-bonsai-8b-nothink-bond_offer-development.md). The model called the skill on its first turn in all 24 episodes and offered the result in all 24: 22 sent by reference, where no family 6 or 10 run had sent one, and 2 copied exactly. Every episode scored what `half_rate` scores: normalized 0.98, 0.94, and 0.96 on `fast`, `slow`, and `strict`. The first turn is about 1,700 characters before the skill list, with one example action: shorter than family 6's dense cell (1,900), where the skill was also called every time. The skill's own level is the bound now; what remains above it is the margin `half_rate` pays against a sample of eight response times.

## Development results, family 7 with skills (seeds 0 to 7)

A family 7 episode is up to 144 blocks, decided one turn at a time, and an agent that stops early forfeits every claim still to arrive. That makes it the bench's longest decision chain for a small model. Six runs on 2026-10-09; gains are the table's, floor `every_arrival`, ceiling `optimal_batching`. `schedule` followed exactly scores 0.950, 0.977, and 0.978.

| Run | Agent | Gain bursty / few_proofs / steady | Claims forfeited | Ended with `commit` |
|---|---|---|---:|---:|
| bare (2026-10-08) | `3748879242c9` | −0.19 / −0.01 / −0.06 | 98% | 18 of 24 |
| bare, stop line reworded | `910e2b21cafc` | −0.11 / −0.01 / −0.06 | 86% | 9 of 24 |
| `proof_step` | `d40dfa62749a` | −0.18 / 0.03 / 0.01 | 75% | 22 of 24 |
| `schedule`, first try | — | crashed: 227 skill calls in one turn | — | — |
| `schedule`, one call per turn | `bbd834c1c687` | 0.44 / 0.03 / 0.04 | 54% | 20 of 24 |
| `schedule`, one call per turn, greedy | `56c0300c61db` | **0.95** / 0.06 / 0.64 | 29% | 13 of 24, 2 at the last block |

What each step found:

- **The name.** With `proof_step` the model wrote `prove_step` 70 times, a blend of the skill and the `prove` tool. Each one was rejected as an unknown tool and spent a proof. `schedule` shares no stem with a tool, and the blend did not recur.
- **The stop line.** The prompt said stopping loses "every claim not yet proven". The model read that as the pending claims, and committed as soon as a proof emptied the queue. The line now adds "including every claim still to arrive" (tasks §8.6). Bare, that halved the early stops, and the model then proved one claim at a time instead (243 of 399 proofs), the prompt's example count, until its proofs ran out. Its result stayed at the floor.
- **A loop.** In its first try with `schedule` the model called the skill 227 times in one turn, passing the given action back as arguments, until the request outgrew the context. A cap of one call per turn ends that: a second call goes to the harness and is rejected. It did not happen again in 48 episodes.
- **Sampling.** At temperature 0.7 the model called the skill on 371 of 375 ordinary turns. On the turn right after a proof empties the queue it called it only 110 times in 215, waited 84 times, and committed 20 times. That 9% recurs 10 to 25 times an episode, and it ended 20 of 24 episodes early. Greedy decoding removes the sampled tail: the skill was called on all 512 ordinary turns, and commits after a proof fell to 13 in 335. On `bursty` no episode stopped early, nothing was forfeited, and the gain equals the skill's, 0.95, with agent − `fixed_interval` +0.03 (−0.02 to +0.09). What is left is the argmax itself in one state: right after a proof, with few proofs left. Every `few_proofs` episode committed there, after 2 to 9 proofs. On `steady`, three episodes stopped before the last block.

So in family 7 the skill reaches its own level only where the model never stops early. Greedy decoding is part of the agent's identity, like any sampling setting, and is reported as a separate agent.

## Order of work

1. Done (2026-10-07): the skill loop in `src/agents/chat.ts`, the skills in `src/agents/skills.ts`, a netting prompt in `src/tasks/netting/prompt.ts`, and `scripts/run_netting_agent.ts` with `--skills`. Tests cover the loop, the cap, the identity binding, error returns, and that a model which echoes `min_cost_flow` scores the ceiling.
2. `min_cost_flow` for family 6, run on development seeds (the six variants above), then one confirmatory run of variant 6 and of the bare agent (results in the README's results list).
3. `failed_pairs` for family 1, the same way. Done on development seeds: never called (section above). The number this was meant to produce, the gap between the skill's result and the heuristic, needs a model that calls it.
4. Thinking mode, as a separate agent identifier, only where the non-thinking result falls short of the skill's expected result.
