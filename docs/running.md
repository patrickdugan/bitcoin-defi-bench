# Running the bench

## Requirements

- Node 22.6 or later. Nothing else at run time: no packages are installed and `node_modules` does not exist.
- The Spiral checkout at the pinned commit in `vendor/spiral` (see the README). The harness refuses to run if the commit or any imported model file differs from the manifest.
- The topology snapshot only if you rebuild fixtures. A run reads the committed, hash-bound fixtures.

## Commands

```
node --experimental-strip-types --test "src/**/*.test.ts"
node --experimental-strip-types scripts/run_placement.ts --block development
node --experimental-strip-types scripts/run_placement.ts --block confirmatory
```

The first runs the tests, which assert on development fixtures only and take a few minutes, most of it the family 3 simulations on two development seeds. The second writes `results/v0-placement-baselines-development.md`. The third is the preregistered baseline run; it is refused unless `prereg/v0.md` lists the family on its "Frozen families" line.

Family 3 (settlement-object selection):

```
node --experimental-strip-types scripts/run_settlement_object.ts --block development
node --experimental-strip-types scripts/run_settlement_object.ts --block confirmatory
```

Three of its four cells simulate 200-agent populations, and each fixture needs nine runs of the pinned server, so the development block takes about ten minutes and the confirmatory block the better part of an hour.

Family 6 (position netting):

```
node --experimental-strip-types scripts/run_netting.ts --block development
node --experimental-strip-types scripts/run_netting.ts --block confirmatory
```

Its instances are small; both blocks run in seconds.

Every run verifies the manifest first and recomputes the baselines in the same process.

## Rebuilding fixtures

```
python vendor/spiral/scripts/fetch_ln_snapshot.py --member 20230716.gml.geo --output-dir data/topology
node --experimental-strip-types scripts/build_fixtures.ts
```

The fetch extracts one 33 MB member from the Harvard Dataverse archive by byte range (3.8 MB transferred). The build checks the member's SHA-256 and the graph statistics Spiral recorded before it writes anything, builds the fixtures of both families, and rewrites `fixtures/manifest.json`. It writes only files whose bytes changed, and rebuilding on an unchanged tree changes nothing; tests check that committed fixtures regenerate byte for byte.

## Running an LLM agent

The adapter in `src/agents/chat.ts` talks to an OpenAI-compatible chat endpoint on the loopback interface. It accepts no other host.

Start a server, then run the agent with the baselines:

```
llama-server -m <model.gguf> --alias <model> --host 127.0.0.1 --port 8094 -ngl 99 -c 16384 -np 1 --jinja

node --experimental-strip-types scripts/run_placement_agent.ts --block development \
  --name <agent-name> --base-url http://127.0.0.1:8094/v1 --model <model> \
  --model-sha256 <sha256 of the GGUF> --runtime "<output of llama-server --version>"
```

Add `--seeds 0,1` to run a subset of the development block. The confirmatory block cannot be subset. `--skills failed_pairs` gives the agent that skill (see the family 6 section below for how skills work and are named).

The run writes three files under `results/`: the table, the run record, and a transcript with every prompt turn, reply, and parsed action. The agent identifier printed in the table is the name followed by a hash of the model file hash, the runtime, the sampling parameters, and the prompt hash, so two runs with the same identifier used the same everything.

The adapter posts over plain `node:http` with a one-hour timeout per request, and logs each reply to `results/<name>.replies.jsonl` as it arrives. If a run dies of an infrastructure failure, running the same command again replays the logged replies for identical requests and asks the server only for the rest; the harness still executes every episode and every baseline, and the table says how many replies were replayed. The log is removed when a run completes.

What the adapter will not do, per `prereg/v0.md` §9.1: retry or repair a reply that does not parse (it is rejected as malformed and costs an attempt), tell the model which regime it is in, or summarize the demand history for it.

### Bonsai 8B

`Bonsai-8B-Q1_0.gguf` (SHA-256 `284a335a…134bd54`) is a 1-bit file and needs PrismML's llama.cpp fork. Sampling defaults in the run script are the non-thinking settings BitAgent-LatentBench uses for it: temperature 0.7, top-p 0.8, top-k 20, thinking off. The largest confirmatory prompt is about 10,000 characters, so a 16,384-token context is enough.

### Family 6, and skills

```
node --experimental-strip-types scripts/run_netting_agent.ts --block development   --name <agent-name> --base-url http://127.0.0.1:8094/v1 --model <model>   --model-sha256 <sha256 of the GGUF> --runtime "<output of llama-server --version>"   --skills min_cost_flow
```

The same flags as the placement script, with a reply limit of 2,048 tokens by default (`--max-tokens`), since a settlement plan is long. Start the server with a 32,768-token context for this family: an episode can run to eleven exchanges, each adding a reply of up to 2,048 tokens to the conversation, and a 16,384-token window overflowed on a development seed (the server answers HTTP 400, which the adapter treats as an infrastructure failure, and the run is rerun whole with its reply log). `--skills` names the skills the agent carries, comma-separated, from `src/agents/skills.ts`, and `--max-skill-calls` caps calls per episode (default 4). The output name carries the skill set, `v0-netting-<name>-<skills>-<block>`, and the agent identifier binds each skill's name and source hash, so an agent with a skill never shares an identifier with one without. What a skill is and what it may read is in [saturation.md](saturation.md).

A skill call appears in the transcript as an exchange with a `skill` field holding the call and its result; the model's next request carries the result as a user turn with the remaining call count. A reply `{"tool": "send"}` sends the latest skill result that is an action (`{"send": "<skill>"}` names one), and the exchange records the skill it sent in a `sent` field. The harness sees none of it: a skill call costs no attempt or probe, and only the action the model finally sends reaches the environment.
