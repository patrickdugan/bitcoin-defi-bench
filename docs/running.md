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

The first runs the tests, which assert on development fixtures only and take a few minutes, most of it the family 3 simulations. The second writes `results/v0-placement-baselines-development.md`. The third is the preregistered baseline run; it is refused unless `prereg/v0.md` lists the family on its "Frozen families" line.

Family 3 (settlement-object selection, pin-supported variant):

```
node --experimental-strip-types scripts/run_settlement_object.ts --block development
node --experimental-strip-types scripts/run_settlement_object.ts --block exploratory
```

Its preregistration sections are not frozen, so its 32-seed block (2000 through 2031) is exploratory and a confirmatory block is refused. The exploratory run simulates 200-agent populations and takes ten minutes or more.

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

Add `--seeds 0,1` to run a subset of the development block. The confirmatory block cannot be subset.

The run writes three files under `results/`: the table, the run record, and a transcript with every prompt turn, reply, and parsed action. The agent identifier printed in the table is the name followed by a hash of the model file hash, the runtime, the sampling parameters, and the prompt hash, so two runs with the same identifier used the same everything.

What the adapter will not do, per `prereg/v0.md` §9.1: retry or repair a reply that does not parse (it is rejected as malformed and costs an attempt), tell the model which regime it is in, or summarize the demand history for it.

### Bonsai 8B

`Bonsai-8B-Q1_0.gguf` (SHA-256 `284a335a…134bd54`) is a 1-bit file and needs PrismML's llama.cpp fork. Sampling defaults in the run script are the non-thinking settings BitAgent-LatentBench uses for it: temperature 0.7, top-p 0.8, top-k 20, thinking off. The largest confirmatory prompt is about 10,000 characters, so a 16,384-token context is enough.
