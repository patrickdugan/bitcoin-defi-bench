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

Each skill is a few lines on top of a baseline's own code, which is the point: the question is not whether the procedure exists but whether a model at this size will call it, read it, and act on it within the budget.

## How the model sees a skill

The system prompt ends with a list of the skills the agent carries, each with its description, and the cap: "Before acting you may call a skill by replying with exactly {"skill":"<name>","args":{}} and nothing else; its result comes back in the next message." The result arrives as a user turn, `Result of skill <name> (<n> skill calls left): <json>`, followed by the instruction to reply with one JSON object. A reply whose `tool` names a carried skill is a skill call too: on 2026-10-07 Bonsai 8B reached for `min_cost_flow` that way in 7 of 24 development episodes and never with the `skill` field, since the only envelope the prompt's examples show is the action's. The identity records the envelopes the adapter accepts. A call past the cap, an unknown skill, or a skill that fails never reaches the harness as a skill: past the cap the reply goes to the harness as it is and is rejected as malformed, costing an attempt; an unknown or failing skill returns `{"error": ...}` to the model and counts against the cap.

What each skill returns:

- `min_cost_flow` (no arguments): `{"cost_sats", "action"}`, where `action` is the settle action to send unchanged.
- `failed_pairs` (`{"limit": n}`, 1 to 50, default 10): `{"failed_pairs": [{"pair", "failed", "has_channel"}, ...], "total_failed"}`, most-failed first, ties by pair.

## Order of work

1. Done (2026-10-07): the skill loop in `src/agents/chat.ts`, the skills in `src/agents/skills.ts`, a netting prompt in `src/tasks/netting/prompt.ts`, and `scripts/run_netting_agent.ts` with `--skills`. Tests cover the loop, the cap, the identity binding, error returns, and that a model which echoes `min_cost_flow` scores the ceiling.
2. `min_cost_flow` for family 6, run on development seeds, then one confirmatory run.
3. `failed_pairs` for family 1, the same way. The interesting number is the gap between the skill's result and the heuristic: what the model loses in choosing the split and committing.
4. Thinking mode, as a separate agent identifier, only where the non-thinking result falls short of the skill's expected result.
