# The TRM complex

An agent built the way Dugan, "MeTTa-Scaffolded Repair Curricula for TRM-Infused Hermes Skills" (Morality Lab, revised October 2026, [moralitylab.xyz](https://moralitylab.xyz/papers/MeTTa_Scaffolded_Repair_Curricula_for_TRM_Infused_Hermes_Skills__1_.pdf)) says a skill should be built. Its §12 lays out six stages, each owned by a different executor:

1. declare the state;
2. narrow the action space by rule;
3. repair, then verify, with the commit decision owned by the verifier;
4. train tiny recursive gates only where a decision is uncertain;
5. train a repair network where the operators stop;
6. let the language model propose.

The complex applies that to families 4 and 9, whose skills (docs/saturation.md) a bare 1-bit model rarely calls. The skill stops being something the model may call and becomes the complex's verifier-backed repair.

Code: `src/agents/complex.ts` (compiler, gate, pipeline), `src/agents/trm.ts` (the network), `src/agents/complex/` (the packages and their gates), `scripts/train_complex_gate.ts`, `scripts/run_complex_agent.ts`.

## One turn

```
observe → propose → validate → repair → validate → commit or veto → record
```

- **Propose.** The proposer is the bare agent of the family's own agent script, built from the same flags, so its identifier is that agent's. It sees the cell's ordinary prompt and nothing about the complex.
- **Declare.** Each family 4 run, and each family 9 cell, has a package (`src/agents/complex/*.metta`), one top-level atom per line. A package declares:
  - its skill;
  - the typed atoms of the turn's verifier-visible state, 14 or 15 of them: nine common to every package (does the proposal parse, is its tool known, does it match the skill's tool, does it or the skill commit, the turn, the attempts and blocks left, was the last action rejected), and five or six for the cell;
  - the verifier's rules;
  - the repair operators in order;
  - the gate's menu.

  The compiler checks that the code implements exactly what the package declares: an atom declared and not computed, or computed and not declared, is an error. As in the paper, the package is a declaration that code implements, and no MeTTa interpreter runs.
- **Validate.** The rules are the cell's public rules as its prompt states them, read from the observations the agent has received:
  - family 4: a resize target is a whole number between the position held and `max_inbound_sats`;
  - `custody`: approve only what the stated policy allows, and only a pending request;
  - `custody_hot`: answer only what the stated policy answers; never send any 12 characters of the key; never sign a profile, contact list, or relay list; attach only a handle a result returned;
  - `publish`, `private`: name only listed relays and returned handles, and in `private` never sign a message's text into a public event;
  - `counterparty`: pay only an open offer; request once; wait inside the horizon;
  - the mesh: send only an undelivered message; Nostr only to a mutual favorite while online; courier copies within the stated range.

  A test holds every rule to the skill's own action on every turn of every development episode.
- **Repair, then verify.** A proposal that breaks a rule is replaced by the first operator whose action passes the rules. Every package has one operator, the skill's action. If nothing passes, the skill's action is sent anyway, as a veto. A legal proposal equal to the skill's action is sent.
- **Gate.** What is left goes to the gate: a legal proposal that differs from the skill's action. The rules cannot judge it, because whether it is good depends on hidden state. The gate's menu is `commit` (send the proposal) or `reference` (send the skill's action).
- **Record.** Every turn emits its atoms, verdict, stage, gate choice, proposal, skill action, and what was sent (`<run>.records.jsonl`).

The complex's identifier binds the proposer's identifier and description, the package text's SHA-256, the skill's source hash, and the gate file's SHA-256.

## The gate

The network is the paper's: hermes-lite's `TinyRecursivePolicy` shape. It has:

- an input projection;
- one recurrent update on the projection and a 64-unit state, applied four times;
- an action head.

On 16 atoms with four actions that is 9,604 parameters, the paper's count. With 14 or 15 atoms and two actions it is about 9,500. Training is full-batch AdamW at 5 × 10⁻³, with the checkpoint chosen at 50, 100, 200, or 400 steps by validation accuracy. Five network seeds are trained, and play uses their per-turn majority, with a tie going to the skill's action. Everything is plain TypeScript, and the weights are a function of the data and the seed alone.

**The curriculum is the proposer's own failures.** The paper found that a gate trained on synthetic defects does not stand in for real failures. The rows come from bare Bonsai 8B's development transcripts of 2026-11-03, the same agent the complex uses as its proposer.

1. Each episode is replayed in a fresh environment from the logged actions, and the replay must reach the recorded row.
2. A row is a turn whose proposal passes the rules and differs from the skill's action.
3. Its label comes from two rollouts on the same seed that follow the skill afterwards, one sending the proposal and one the skill's action. The label is `commit` when the proposal's rollout scores strictly higher, and `reference` otherwise.
4. Development seeds 0 to 5 train and 6 and 7 validate.

The confirmatory block is never read.

**A network has to earn its place.** The constant rule takes over in two cases:

- when there are fewer than 20 rows, only one label in training, or no validation rows;
- when the networks' majority does not beat that constant rule on the validation seeds.

Both rules were fixed before any complex was run, on development data only.

**The gates trained on 2026-11-03** (`src/agents/complex/gates/`). In the table:

- **Turns** are every turn of bare Bonsai's eight development episodes per cell, or 24 for family 4 and 16 for the two mesh cells together.
- **Illegal** and **agreeing** count proposals that broke a rule, or matched the skill's action.
- **Rows** are the rest. Of those, `commit` rows are the ones where sending the proposal scored strictly higher in its rollout.
- **Mean margin** is the proposal's rollout less the skill's, over all rows.
- **Validation** gives the networks' majority accuracy on seeds 6 and 7, then the accuracy of the constant `reference` rule.

| Package | Turns | Illegal | Agreeing | Rows | `commit` rows | Mean margin | Validation, networks / constant | Gate |
|---|---:|---:|---:|---:|---:|---:|---|---|
| `server_sizing` | 44 | 0 | 1 | 43 | 2 | −1.96 ln | 1.00 / 1.00 | constant `reference` |
| `nostr_custody` | 164 | 45 | 83 | 36 | 0 | 0 | — | constant `reference` |
| `nostr_custody_hot` | 103 | 33 | 5 | 65 | 8 | −492 sats | 0.92 / 0.75 | five networks |
| `nostr_publish` | 141 | 32 | 0 | 109 | 0 | −674 sats | — | constant `reference` |
| `nostr_private` | 302 | 25 | 7 | 270 | 1 | −825 sats | 0.94 / 1.00 | constant `reference` |
| `nostr_counterparty` | 86 | 30 | 12 | 44 | 7 | −4,358 sats | 0.57 / 0.71 | constant `reference` |
| `nostr_mesh` | 289 | 55 | 1 | 233 | 20 | −952 sats | 0.88 / 0.91 | constant `reference` |

Family 4 has only 44 turns because bare Bonsai committed within four decisions in every episode. On almost every row where the model's legal action differed from the skill's, the skill's action scored as well or better. Only in `custody_hot` did a network beat the constant rule on validation, and its `commit` rows are the artifact described under the limits below. So the complex sends the proposal on six packages only when the proposal is the skill's own action. That is the paper's Campsite finding in this bench: once the skill owns validation, repair, and commit, little is left for the model to decide.

## Development runs (seeds 0 to 7)

Each complex was run on the development seeds on 2026-11-03, after its gate was trained, with Bonsai 8B as the proposer (`results/v0-*-bonsai-8b-nothink-trm-complex-development.md`, each with its `.records.jsonl`). In the table:

- **Turns** are every turn the complex sent an action.
- **Agree**, **gate**, and **repair** say which stage decided it: the proposal was the skill's action; the proposal was legal and differed from the skill's action; the proposal broke a rule and the skill's action was sent. No turn was vetoed.
- **Proposal sent** counts the gate's `commit` choices.
- **Normalized** is the complex's normalized gain. **Equal to** names the baseline it matched on every episode.

| Cell | Turns | Agree | Gate | Repair | Proposal sent | Normalized | Equal to |
|---|---:|---:|---:|---:|---:|---:|---|
| family 4, three cells | 768 | 21 | 622 | 125 | 0 | 0.53 / 0.64 / 0.91 | `buffer_rule` |
| `custody` | 128 | 17 | 11 | 100 | 0 | 1.00 | `policy`, the ceiling |
| `custody_hot` | 185 | 6 | 129 | 50 | 46 | 0.80 (0.62 to 0.98) | none |
| `publish` | 106 | 2 | 92 | 12 | 0 | 0.83 | `outbox` |
| `private` | 229 | 4 | 166 | 59 | 0 | 1.00 | `nip17`, the ceiling |
| `counterparty` | 187 | 52 | 110 | 25 | 0 | 0.95 | `reputation` |
| `mesh_outage` | 103 | 7 | 89 | 7 | 0 | 0.85 | `bitchat_router` |
| `mesh_partial` | 96 | 8 | 80 | 8 | 0 | 0.86 | `bitchat_router` |

Where the gate is the constant rule, the complex plays the skill's baseline exactly, as its construction requires. Bare Bonsai 8B on the same seeds was clipped at −1.00 in family 4 and in `custody`. As the complex's proposer, its proposal was the skill's own action on 2% to 28% of turns.

The one network gate, `custody_hot`'s, sent 46 proposals that differed from the skill's action:

- 29 were invoices (`make_invoice`) where the policy would reply, ignore, or sign;
- 16 were reactions (kind 7) signed where the policy would reply, ignore, or invoice;
- 1 was an ignore where the policy would invoice.

Each spent the episode's turns or sats, and the complex lost 0.20 of the ceiling that the skill alone reaches. This is what the limits below anticipate: those `commit` labels came from rollouts in which the replayed policy had fallen out of step with the proposer's own earlier invoices. The gate is left as trained. Its training rules were fixed before any complex ran, and this run is what they produce.

## Limits

- **The curriculum's states are the bare model's.** The complex sends the skill's action most of the time, so the states it meets are mostly the skill's trajectory, not the bare model's, which commits or copies the prompt's example early. The paper's gate saw its proposer's answers to the same puzzles. These rows come from a different trajectory than the one the gate will judge.
- **The labels follow the skill after one deviation.** A replayed skill can fall out of step after the proposer's own earlier actions. All 8 `commit` labels in `custody_hot` are of that kind: the policy, replayed over a trajectory where the model had made invoices of its own, attaches one of them, and a fresh invoice scores higher. The labels record what the rollout scored, not what an exact policy would have.
- **Repair is the skill, not a learned repair.** Stage 5, a network that writes the repair where the operators stop, is not built: in these cells the skill is a complete repair.
- **The complex's floor is near the skill by construction.** When the gate always chooses the skill's action, the complex sends the skill's action on every turn where the proposal differs, so its result is the skill's apart from the turns where the proposal agrees. Where the skill is the cell's exact ceiling (`custody`, `custody_hot`, `private`), it is that ceiling. What a run measures is how often the proposer's own action is what is sent, and whether the gate's choices add anything beyond the skill. The paper's reading on Campsite was the same: the model's share of the best arm was a constant.
