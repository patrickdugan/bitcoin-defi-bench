# Routing follow-up: posterior-state planning and hook execution risk

This track extends [Chitraverse x YaRN 001](README.md), seeded by Chitra, Kulkarni and Srinivasan, [*Optimal Routing in the Presence of Hooks: Three Case Studies*](https://arxiv.org/html/2502.02059v1). The paper studies standing limit-order liquidity, time-dependent liquidation and non-composable liquidity with uncertain fills. The following finite-world Bellman model extends these themes to the hidden-balance routing family. It is an original synthetic model, not a reported experiment from the paper.

## Where the paper meets this repository

Family 2 (src/tasks/routing) currently scores terminal payment delivery on 220 demands, with 110 evaluated, three attempts per demand, public path fees and node sequences, and hidden capacity and balance. The confirmed reference is retry_wallet: first three candidates in fee order. Its privileged ceiling knows the hidden balances. The source's confirmed gap from the full oracle to retry_wallet, pooled across nine task cells, is +1.34 percentage points (95% interval +0.55 to +2.12): see results/v0-routing-baselines-confirmatory.md.

This score rewards reliability. A new execution-quality family should measure the tradeoff between **quote value, execution certainty, attempt fee/latency, and fallback opportunities**. It needs an independent preregistration, new held-out fixtures, and separately labeled output units. Existing v0 scores, fixtures and baselines remain unchanged.

## Exact one-demand latent-state problem

Let routes i=1,...,m have successful value y_i, paid attempt cost c_i and deterministic feasibility f_i(omega) in hidden state omega. Prior masses pi(omega) sum to 1. A failure is terminal feedback on the attempted route; a success ends the current demand. The hidden state remains fixed during one demand. The router has K attempts and may stop early.

Define F as the failed-route set and Omega_F as the hidden worlds in which every route in F fails. Let

- M(F)=sum of pi(omega) over Omega_F;
- S_i(F)=sum of pi(omega) over surviving worlds in which route i succeeds.

The **unnormalized** Bellman recurrence is

$$
W(F,k) = \max\left\{0,\;\max_{i\notin F}
\left[-c_i M(F)+y_i S_i(F)+W(F\cup\{i\},k-1)\right]\right\}.
$$

Boundary W(F,0)=0. The prior expected utility is W(empty,K). For M(F)>0, conditional fill probability is p_i(F)=S_i(F)/M(F). The recursion incorporates the option to try an alternative after failure and accepts correlations induced by shared hidden channel balances.

### Executable eight-world example

Synthetic edge bits e0,e1,e2 are independent fair Bernoulli variables. Feasibility is a conjunction of required edges.

| Route | Hidden requirement | Quote y | Attempt cost c | Prior fill chance |
|---|---|---:|---:|---:|
| deep_A | e0 & e1 | 120 | 1 | 1/4 |
| deep_B | e0 & e2 | 118 | 1 | 1/4 |
| direct_C | e0 | 100 | 1/2 | 1/2 |

With eight equally weighted worlds and two attempts, exact output is:

| Router | Expected net utility |
|---|---:|
| Fee-first | 49 |
| Myopic one-step greedy | 99/2 = 49.5 |
| Exact belief-state Bellman | 429/8 = 53.625 |
| Privileged hidden-world oracle | 909/16 = 56.8125 |

Bellman chooses A, then C after failure. When A fails, C's posterior fill probability falls from 1/2 to 1/3. If C fails first, both remaining candidates become impossible because each requires e0. The gain of 4.125 utility units over myopic choice comes from retaining the inexpensive, more reliable fallback.

For a *single* demand with terminal success and only success/failure observations, the sole continuing branch is failure. An optimal policy therefore corresponds to an ordered list of attempted routes with optional early stopping. Exhaustive ordered-subset enumeration certifies the Bellman optimum. More complex belief dynamics emerge with partial fills, external signals, across-demand state updates, and trade inventory carried through time.

### Compactification connection

For m public candidate routes, the history relevant to the posterior under this fixed-world model compresses into a failed-route bitmask plus remaining attempts. This gives at most (K+1) 2^m finite decision states, with many unreachable. For eight candidates and three attempts the coarse bound is 1024 states.

A complete network can contain thousands of hidden edge balances. Whether a smaller vector of conditional path fill probabilities is a sufficient state statistic when successful routes update those balances is an *open experiment*. Test approximations against policy regret on held-out networks and rescaled capacities, then attempt a proof of any proposed transfer invariant.

## Next research gates

1. Create an independent output-routing family with limit orders and non-composable hooks, using a pinned CFMM curve, price/volume caps and execution-risk regimes. Retain Family 2 unchanged.
2. Score fee-first, myopic greedy, exact finite-world Bayes, and privileged full-state oracle. Report utility regret, delivery rate, failed attempts, tail losses and runtime on identical seeds.
3. On Family 2, test a factorized posterior over public path intersections and hidden directional balances. Keep retrial budget and observations matched to the published retry wallet.
4. Give small TRM/HRM/Bonsai policies the same compact feature vector of candidate fees, calibrated conditional fills and quote advantage. Score out-of-scale transfer against exact optimization.

## Reproduction

From research/chitraverse_001:

    python belief_router.py
    python -m unittest discover -s . -p 'test_*.py' -v

The six additional tests include exact arithmetic, posterior updates, oracle bounds and exhaustive comparison across 48 seeded random small games. The Bellman-vs-brute-force identity was also independently checked for all 49 synthetic games in a local Python arithmetic probe.

No empirical return, learned-model performance or production routing claim is implied.
