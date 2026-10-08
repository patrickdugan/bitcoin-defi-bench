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

Each skill is a few lines on top of a baseline's own code, which is the point: the question is not whether the procedure exists but whether a model at this size will call it, read it, and act on it within the budget.

## How the model sees a skill

The system prompt ends with a list of the skills the agent carries, each with its description, and the cap: "Before acting you may call a skill by replying with exactly {"skill":"<name>","args":{}} and nothing else; its result comes back in the next message." The call rate falls with the length of the first turn: 8 of 8 on `bilateral_dense` in every run, and 1 to 8 of 8 on the two 48-trade cells across six runs on 2026-10-07 with nothing changed but wording. Restating the callable skills at the end of every turn was tried and removed: it cut calls to 6 of 24 and made the model settle the example plan first on the dense cell, where it had called the skill every time. The result arrives as a user turn, `Result of skill <name> (<n> skill calls left):` and the result as compact JSON, followed by the instruction to reply with one JSON object and, when the result is itself an action, the offer to send it unchanged by replying `{"tool":"send"}` (`{"send":"<name>"}` also works). The form takes no name because the one time Bonsai 8B tried to send it wrote `{"send":"settle"}`, the action's name where the skill's went. Sending is by reference: the adapter hands the harness the stored result as the model's action, and the transcript records the reply and what it sent. This exists because copying is where a 1-bit 8B model fails, not deciding: on 2026-10-07, asked to restate a 25-transfer plan of about 1,500 characters, Bonsai 8B dropped a closing brace at the end in most episodes, whether the result was shown compact (4 of 8 copies survived on `tight_links`, 2 of 3 on `multilateral_sparse`) or indented (1 of 6, and 0 of 1; it re-compacted and lost more), while six-transfer plans on `bilateral_dense` were copied exactly in 16 of 17. The strict parser rejects a reply with a brace missing and nothing repairs it, by the preregistration; the send form lets the skill carry the bytes and leaves the model the decisions to call and to commit. A reply whose `tool` names a carried skill is a skill call too: on 2026-10-07 Bonsai 8B reached for `min_cost_flow` that way in 7 of 24 development episodes and never with the `skill` field, since the only envelope the prompt's examples show is the action's. The identity records the envelopes the adapter accepts. A call past the cap, an unknown skill, or a skill that fails never reaches the harness as a skill: past the cap the reply goes to the harness as it is and is rejected as malformed, costing an attempt; an unknown or failing skill returns `{"error": ...}` to the model and counts against the cap.

What each skill returns:

- `min_cost_flow` (no arguments): the settle action itself; its description says to reply with that action unchanged. A first version returned `{"cost_sats", "action"}`, and Bonsai 8B copied that object whole, cost and all, so the result became the action itself. Two versions of the description then showed the send form as JSON, `{"send":"min_cost_flow"}` and `{"tool":"send"}`; each cut the call rate on the dense cell from 8 of 8 to 3 and 2 of 8, the snippet competing with the call form in the model's reading, and the model never sent anyway (0 of 19 calls across the three runs that offered it). So the description holds no JSON and the send offer stays in the result turn.
- `failed_pairs` (`{"limit": n}`, 1 to 50, default 10): `{"failed_pairs": [{"pair", "failed", "has_channel"}, ...], "total_failed"}`, most-failed first, ties by pair.

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

## Order of work

1. Done (2026-10-07): the skill loop in `src/agents/chat.ts`, the skills in `src/agents/skills.ts`, a netting prompt in `src/tasks/netting/prompt.ts`, and `scripts/run_netting_agent.ts` with `--skills`. Tests cover the loop, the cap, the identity binding, error returns, and that a model which echoes `min_cost_flow` scores the ceiling.
2. `min_cost_flow` for family 6, run on development seeds (the six variants above), then one confirmatory run of variant 6 and of the bare agent (results in the README's results list).
3. `failed_pairs` for family 1, the same way. Done on development seeds: never called (section above). The number this was meant to produce, the gap between the skill's result and the heuristic, needs a model that calls it.
4. Thinking mode, as a separate agent identifier, only where the non-thinking result falls short of the skill's expected result.
