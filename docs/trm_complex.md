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

## Confirmatory runs (seeds 1000 to 1031)

Amendment 10 fixed the eight complexes by identifier. It predicted that the seven with a constant gate would equal their skill's baseline on every episode, and treated any difference as a harness defect to audit. They were run on 2026-11-03 and 04 (`results/v0-*-bonsai-8b-nothink-trm-complex-confirmatory.md`). The prediction held on all 288 episodes, with no mismatch, and no report flags anything for audit. The columns are those of the development table. **Agent − reference** is Amendment 5's agent contrast for family 9 and Amendment 10's for family 4, in the family's unit.

| Cell | Turns | Agree | Gate | Repair | Proposal sent | Normalized | Agent − reference | Equal to |
|---|---:|---:|---:|---:|---:|---|---|---|
| family 4, three cells | 3,072 | 86 | 2,529 | 457 | 0 | 0.54 / 0.35 / 0.92 | exactly 0 in each, equivalent | `buffer_rule` |
| `custody` | 512 | 122 | 65 | 325 | 0 | 1.00 | +155,427 (+120,710 to +190,144), positive | `policy`, the ceiling |
| `custody_hot` | 591 | 35 | 343 | 213 | 89 | 0.80 (0.69 to 0.91) | +53,875 (+49,977 to +57,773), positive | none |
| `publish` | 413 | 3 | 365 | 45 | 0 | 0.86 | exactly 0, equivalent | `outbox` |
| `private` | 901 | 12 | 750 | 139 | 0 | 1.00 | +5,635 (+4,848 to +6,423), positive | `nip17`, the ceiling |
| `counterparty` | 854 | 203 | 469 | 182 | 0 | 0.67 (0.46 to 0.87) | +25,007 (+12,134 to +37,879), positive | `reputation` |
| `mesh_outage` | 456 | 29 | 389 | 38 | 0 | 0.79 | exactly 0, equivalent | `bitchat_router` |
| `mesh_partial` | 445 | 21 | 382 | 42 | 0 | 0.79 | exactly 0, equivalent | `bitchat_router` |

- **The construction holds, and it carries the result.** Where the gate is constant, each complex's score is its skill's baseline's score. The four positive contrasts come from the skill, not the model; in `custody_hot`, from the skill less what the gate gave up. In `custody` and `custody_hot` the reference is below doing nothing. In `private` and `counterparty` the skill's baseline is a better policy than the reference.
- **What the model contributes.** The proposer's own action was the skill's on 0.7% (`publish`) to 24% (`custody`, `counterparty`) of turns.
- **The network gate replicates its development cost.** In `custody_hot` it sent 89 of the 343 legal proposals that differed from the skill's action: 43 invoices, 31 ignores, and 15 signatures. The complex fell below the policy on 14 of 32 episodes and never rose above it, 813 sats an episode on average. It scored 0.80 of the ceiling, as in development.
- **Infrastructure.** The family 4 run lost its server seven times, at least five of them to a CUDA error while a second server shared the GPU. It was restarted once more to change the server's flags. The runner replayed 1,636 logged replies, and the record says so (prereg §9.1). From 00:32 on 2026-11-04, every server ran with llama-server's host prompt cache off (`--cache-ram 0`), because the crash had twice followed the saving of an entry to it. Server flags are not part of an agent's identifier.

## The combo: a proposer that carries the skill

The combo is the complex with one change: its proposer is the cell's skill agent (docs/saturation.md) instead of the bare one. The model may call the skill through the chat adapter before it proposes, and may send the result by reference as its proposal. Everything after the proposal is unchanged: the same package, the same repair, and a gate. Built with the bare proposer and the combo's proposer, the four arms make a 2×2 of skill as a tool × complex. `scripts/factorial_table.ts` puts them side by side (`results/v0-skill-trm-factorial-<block>.md`). Prereg Amendment 12 fixes the combos and the bare agents for the confirmatory seeds.

Each combo has its own gate, `<package>.skill-proposer.json`, trained by the rules above on the skill agent's development transcripts (`scripts/train_complex_gate.ts --curriculum skill`). `private`'s skill agent outgrew the context on the development seeds, so its curriculum is empty and its gate is the constant rule.

| Package | Turns | Illegal | Agreeing | Rows | `commit` rows | Mean margin | Validation, networks / constant | Gate |
|---|---:|---:|---:|---:|---:|---:|---|---|
| `server_sizing` | 366 | 125 | 116 | 125 | 20 | −0.38 ln | 0.84 / 0.92 | constant `reference` |
| `nostr_custody` | 197 | 43 | 65 | 89 | 0 | 0 | — | constant `reference` |
| `nostr_custody_hot` | 96 | 54 | 1 | 41 | 0 | −683 sats | — | constant `reference` |
| `nostr_publish` | 139 | 122 | 10 | 7 | 1 | −1,386 sats | — | constant `reference` |
| `nostr_private` | 0 | | | 0 | | | — | constant `reference` |
| `nostr_counterparty` | 117 | 37 | 33 | 47 | 7 | −2,515 sats | 0.60 / 0.50 | five networks |
| `nostr_mesh` | 322 | 43 | 50 | 229 | 11 | −874 sats | 0.946 / 0.946 | constant `reference` |

`custody_hot`'s gate is now constant: all 41 of its rows are labelled `reference`. `counterparty`'s networks beat the constant on 10 validation rows, 6 right against 5.

On the development seeds, on 2026-11-04 (`results/v0-*-bonsai-8b-nothink-<skill>-trm-complex-development.md`):

| Cell | Turns | Skill calls | Agree | Gate | Repair | Proposal sent | Equal to |
|---|---:|---:|---:|---:|---:|---:|---|
| family 4, three cells | 768 | 243 | 243 | 274 | 251 | 0 | `buffer_rule`, 24 of 24 episodes |
| `custody` | 128 | 1 | 1 | 60 | 67 | 0 | `policy`, 8 of 8 |
| `custody_hot` | 133 | 1 | 2 | 62 | 69 | 0 | `policy`, 8 of 8 |
| `publish` | 106 | 17 | 10 | 54 | 42 | 0 | `outbox`, 8 of 8 |
| `private` | 229 | 8 | 11 | 191 | 27 | 0 | `nip17`, 8 of 8 |
| `counterparty` | 162 | 11 | 51 | 84 | 27 | 3 | `reputation` on 6 of 8, `oracle` on seeds 2 and 7 |
| `mesh_outage` | 103 | 20 | 20 | 76 | 7 | 0 | `bitchat_router`, 8 of 8 |
| `mesh_partial` | 96 | 15 | 25 | 66 | 5 | 0 | `bitchat_router`, 8 of 8 |

- **The skill call is the agreement.** In family 4, every one of the 243 agreeing turns followed a skill call whose result the model sent by reference, and no other turn agreed. The model's own proposal was sent on 31.6% of turns, against 2.7% (21 of 768) with the bare proposer. The action is the skill's either way; what changed is that the model chose it. In the family 9 cells, agreement and skill calls overlap only in part: in `mesh_partial`, 9 of the 25 agreeing turns followed a skill call.
- **`private` completed.** The skill agent on its own outgrew the context on seed 1. As the combo's proposer, on the same 40,960-token context, it completed all 8 episodes, every action of which was the skill's.
- **`counterparty` is the one cell where the gate changed the result.** It sent the model's proposal 3 times, each a `request` on turn 1 where the skill would have fetched another provider's record. On seeds 2 and 7 the complex then reached the ceiling where `reputation` did not. On seed 0 `reputation` was already at the ceiling. On average the complex was 1,762 sats above `reputation` (−965 to +4,488). These are the seeds the gate was trained and validated on, against the skill agent's trajectories.

### The 2×2 on the confirmatory seeds

Amendment 12 fixed the eight combos and the eight bare agents. They were run on 2026-11-04 (`results/v0-*-bonsai-8b-nothink-<skill>-trm-complex-confirmatory.md`, `results/v0-*-bonsai-8b-nothink-confirmatory.md`). Every calibration gate passed, and no report flags anything for audit.

**The predictions held.**

- The seven combos with a constant gate each equalled their skill's baseline on every episode, 288 of 288. In `custody_hot` that baseline is `policy`, the exact ceiling.
- Combo − complex is exactly 0 on every episode in family 4, `custody`, `publish`, `private`, and the two mesh cells, 256 episodes.
- In `custody_hot` it is 0 on 18 episodes and positive on 14, and never negative. The combo's constant gate recovers the 813 sats an episode that the complex's network gate gave up.

The columns are those of the development tables. **Proposal sent** counts the gate's `commit` choices.

| Cell | Turns | Skill calls | Agree | Gate | Repair | Proposal sent | Normalized | Agent − reference | Equal to |
|---|---:|---:|---:|---:|---:|---:|---|---|---|
| family 4, three cells | 3,072 | 889 | 890 | 1,232 | 950 | 0 | 0.54 / 0.35 / 0.92 | exactly 0 in each, equivalent | `buffer_rule`, 96 of 96 |
| `custody` | 512 | 0 | 25 | 174 | 313 | 0 | 1.00 | +155,427 (+120,710 to +190,144), positive | `policy`, 32 of 32 |
| `custody_hot` | 527 | 1 | 2 | 266 | 259 | 0 | 1.00 | +54,688 (+50,858 to +58,517), positive | `policy`, 32 of 32 |
| `publish` | 413 | 88 | 39 | 233 | 141 | 0 | 0.86 | exactly 0, equivalent | `outbox`, 32 of 32 |
| `private` | 901 | 38 | 33 | 676 | 192 | 0 | 1.00 | +5,635 (+4,848 to +6,423), positive | `nip17`, 32 of 32 |
| `counterparty` | 876 | 44 | 244 | 468 | 164 | 184 | 0.51 (0.28 to 0.74) | +19,187 (+7,236 to +31,138), positive | `reputation` on 18 of 32 |
| `mesh_outage` | 456 | 70 | 53 | 351 | 52 | 0 | 0.79 | exactly 0, equivalent | `bitchat_router`, 32 of 32 |
| `mesh_partial` | 445 | 93 | 80 | 320 | 45 | 0 | 0.79 | exactly 0, equivalent | `bitchat_router`, 32 of 32 |

The four arms side by side, as normalized gain ([results/v0-skill-trm-factorial-confirmatory.md](../results/v0-skill-trm-factorial-confirmatory.md) has the intervals and the contrasts, all descriptive and paired by seed):

| Cell | Bare | Skill as tool | TRM complex | Combo |
|---|---|---|---|---|
| family 4, three cells | −1.00 / −1.00 / −1.00, clipped | −1.00 / −0.83 / −0.65 | 0.54 / 0.35 / 0.92 | 0.54 / 0.35 / 0.92 |
| `custody` | −1.00, clipped | −1.00, clipped | 1.00 | 1.00 |
| `custody_hot` | −1.00, clipped | −1.00, clipped | 0.80 | 1.00 |
| `publish` | −0.01 | 0.03 | 0.86 | 0.86 |
| `private` | 0.00 | not completed | 1.00 | 1.00 |
| `counterparty` | 0.07 | 0.12 | 0.67 | 0.51 |
| `mesh_outage` | −0.14 | 0.13 | 0.79 | 0.79 |
| `mesh_partial` | −0.15 | 0.28 | 0.79 | 0.79 |

- **The complex is the large factor, and its source is the skill.**
  - Complex − bare is positive in all ten rows.
  - Combo − skill as tool is positive in eight of the nine rows where both arms completed. In `custody_hot` it is inconclusive: +16,597 (−1,104 to +34,298).
  - Where the gate is constant, both complexes score the skill's baseline. This factor is the skill's action, sent by construction.
- **The tool is a small factor, and it vanishes inside the complex.**
  - Skill as tool − bare is positive in family 4's three cells and the two mesh cells, and inconclusive in `custody`, `custody_hot`, `publish`, and `counterparty`. In `private` there is no contrast, because the skill agent did not complete.
  - Combo − complex is exactly 0 in eight rows. It is positive in `custody_hot`, +813 (+352 to +1,273), where the two gates differ, and inconclusive in `counterparty`, −5,820 (−12,782 to +1,142).
- **Inside the complex, the tool changes who chose the action, not the action.**
  - In family 4 the combo's proposal was the skill's action on 25% to 33% of turns, against 1% to 4% for the bare proposer. 889 of its 890 agreeing turns followed a skill call whose result the model sent by reference. The other was a `hold` that the skill also chose (seed 1016, `balanced`, turn 22).
  - In the custody cells the combo's proposer agreed less often than the bare proposer: 4.9% of turns against 23.8% in `custody`, and 0.4% against 5.9% in `custody_hot`.
- **`counterparty`: the one learned gate cost the combo 5,820 sats an episode.** Its networks had beaten the constant on 10 validation rows, 6 right against 5. On these seeds the gate sent 184 proposals that differed from the skill's action, against 3 on the development seeds.
  - **15 `request`s on turn 1**, where the skill would have fetched another provider's record, as on the development seeds. In the 11 episodes where this was the only commit, the combo was above `reputation` in 3, below it in 1 by 705 sats, and equal in 7: +24,433 sats in all.
  - **169 `wait`s where the skill would have paid an offer**, in 10 episodes. In each, from turn 22 or 23 the model proposed `wait` on every turn and the gate sent it, until the episode ended. In one episode, seed 1016, a repair sent the payment on turn 39. No result arrived in any of the 10.
    - In 7 of them `reputation` got a result, and the combo finished 31,894 to 50,000 sats below it.
    - In the other 3, `reputation` paid a third time and still got no result. The combo, which had paid once, finished 16,015 to 25,707 sats above it.
    - Net, −210,671 sats.
  - Against the constant rule, which would have played `reputation` as the complex did, the gate's choices lost 5,820 sats an episode (inconclusive). The normalized gain fell from 0.67 to 0.51.
- **Infrastructure.**
  - The family 4 combo lost its server twice to CUDA errors while the second server shared the GPU: a failed matrix multiply at 11:39 and an out-of-memory error at 11:53. The runner replayed 502 logged replies, and the record says so (prereg §9.1).
  - No other run was restarted.
  - Every server ran with `--cache-ram 0`.
  - The bare `private` agent completed all 32 episodes on the 40,960-token context.

## Limits

- **The curriculum's states are the bare model's.** The complex sends the skill's action most of the time, so the states it meets are mostly the skill's trajectory, not the bare model's, which commits or copies the prompt's example early. The paper's gate saw its proposer's answers to the same puzzles. These rows come from a different trajectory than the one the gate will judge.
- **The labels follow the skill after one deviation.** A replayed skill can fall out of step after the proposer's own earlier actions. All 8 `commit` labels in `custody_hot` are of that kind: the policy, replayed over a trajectory where the model had made invoices of its own, attaches one of them, and a fresh invoice scores higher. The labels record what the rollout scored, not what an exact policy would have.
- **The gate meets states its curriculum never reached.** The `turn` atom is one of the gate's inputs. The curriculum comes from the proposer's development episodes, and confirmatory episodes can run longer. No episode of the `counterparty` skill agent on the development seeds went past turn 18. The combo's episodes on the confirmatory seeds ran to turn 41, and every one of its gate's 169 `wait` commits came on turn 22 or later.
- **Repair is the skill, not a learned repair.** Stage 5, a network that writes the repair where the operators stop, is not built: in these cells the skill is a complete repair.
- **The complex's floor is near the skill by construction.** When the gate always chooses the skill's action, the complex sends the skill's action on every turn where the proposal differs, so its result is the skill's apart from the turns where the proposal agrees. Where the skill is the cell's exact ceiling (`custody`, `custody_hot`, `private`), it is that ceiling. What a run measures is how often the proposer's own action is what is sent, and whether the gate's choices add anything beyond the skill. The paper's reading on Campsite was the same: the model's share of the best arm was a constant.
