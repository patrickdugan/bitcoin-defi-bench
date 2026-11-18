# Chitraverse x YaRN 001: mechanism geometry and adversarial state

**Status:** small applied-math exploration. Python standard library only. Seven tests passed locally on 2026-11-07. The examples are synthetic; this is neither a deployed-protocol audit nor an empirical DeFi claim. This folder is separate from the repository's existing Lightning payment-routing tasks.

## Reproducible source draw

Input: [Chitraverse arXiv catalog](https://github.com/patrickdugan/Chitraverse/blob/main/catalog/papers.jsonl). Selection: xorshift32 with seed 20261107, Fisher-Yates shuffle of the twelve verified-paper rows, first three records. The Chitraverse repository holds provenance and metadata; original full-text copies are not committed. The papers were read independently through their public arXiv HTML pages.

1. Chitra, Erins, Kulkarni, [*Attacks on Dynamic DeFi Interest Rate Curves*](https://arxiv.org/html/2307.13139v1), 2023, section 2.
2. Angeris, Chitra, [*Improved Price Oracles: Constant Function Market Makers*](https://arxiv.org/html/2003.10001v4), 2020, sections 2.2-2.4.
3. Chitra, Kulkarni, Srinivasan, [*Optimal Routing in the Presence of Hooks*](https://arxiv.org/html/2502.02059v1), 2025, section 5.

### A. Dynamic interest controller: a checkable equation mismatch

The paper's displayed supply expression before equation (3) is

$$
S_{s+i}=2S_s+\frac{i+1}{n}\left(\frac{D_{s-1}}{U^*}-2S_s\right).
$$

Summing this expression from i=1 to n as indicated in the next displayed revenue calculation gives

$$
\sum_{i=1}^{n}S_{s+i}=(n-3)S_s+\frac{n+3}{2}\frac{D_{s-1}}{U^*}.
$$

The printed next-step revenue expression instead contains

$$
(n-3)\left(S_s+\frac{D_{s-1}}{2U^*}\right).
$$

These differ by **3 D_(s-1) / U***. With synthetic S_s=100, D_(s-1)=30, U*=2/5, n=10, the schedule sum is 1187.5 while the printed expression gives 962.5. The exact difference is 225. The test checks rational arithmetic across different time horizons and latent demand.

This flags an *internal algebra and indexing audit*, with the displayed formulas taken literally. The economic attack, settlement timeline and profitability conclusion need an independent replication. The signed demand-elasticity Markov inequality in section 2.1 also needs checking: its expected demand derivative is nonpositive, making the printed negative RHS unsuitable as an upper bound on a probability. A repair candidate is a nonnegative variable for the magnitude of negative demand elasticity.

**Destination:** [Control-Harness](https://github.com/MoralityLabAI/Control-Harness). Define the intervention game over rate-controller state, with matched capital budgets, P/PI/static baselines, explicit timing, defender observation limits and exogenous elasticities. Source-error audits must be resolved before claims enter a risk scoring harness.

### B. CFMMs: exact reserve-value certificate

The 2020 paper analyzes convex feasible reserve sets and supporting-price geometry. For any positive x,y,k,p with xy >= k, define reserve value V=px+y. The exact algebraic identity

$$
V^2-4pk=(px-y)^2+4p(xy-k)\ge 0
$$

implies **V >= 2 sqrt(pk)**, with equality only when xy=k and px=y. The corresponding tight reserves are x=sqrt(k/p), y=sqrt(kp). For a synthetic x=120,y=90,k=10000,p=3/2, V=270 and the exact squared-value slack is 12900; the floor is approximately 244.9489743.

A fee-retaining one-way constant-product swap of dx >= 0 with multiplier 0 < gamma <= 1 receives

$$
dy=\frac{y\gamma dx}{x+\gamma dx},
\qquad
(x+dx)(y-dy)=xy\frac{x+dx}{x+\gamma dx}\ge xy.
$$

The actual reserve-product floor therefore persists by induction for sequences of such swaps, and the value certificate can be checked after every state update. The code uses exact Python fractions.

**Destination:** [OntologicalProofs](https://github.com/patrickdugan/OntologicalProofs). Formalize the polynomial identity, the positivity conditions, the equality case and the repeated-swap invariant in Lean. A proof of the conditional reserve floor is distinct from proof that any particular exchange is an accurate price oracle.

### C. Noncomposable hook routing: a unique optimizer and a quotient

The 2025 paper models a deterministic constant-product pool and a hook whose quote has curvature and stochastic fill risk. Take the alpha=1 quadratic hook, and a quadratic mean-variance penalty. For trade size D, amount z sent through the hook, pool reserves Rx,Ry, curvature b>0 and variance coefficient beta>=0,

$$
J(z)=\frac{R_y(D-z)}{R_x+D-z}+2z-(b+\lambda\beta)z^2,\qquad 0\le z\le D.
$$

We derive

$$
J'(z)=2-2(b+\lambda\beta)z-\frac{R_xR_y}{(R_x+D-z)^2}
$$

and

$$
J''(z)=-2(b+\lambda\beta)-\frac{2R_xR_y}{(R_x+D-z)^3}<0.
$$

Therefore the constrained maximum is unique. A boundary sign or a single bisection root of J'=0 solves it. The interior sensitivity to risk aversion is

$$
\frac{dz^*}{d\lambda}=
-\frac{2\beta z^*}{2(b+\lambda\beta)+2R_xR_y/(R_x+D-z^*)^3}\le0.
$$

For a synthetic D=25, Rx=Ry=100, b=0.035, beta=0.04, the computed solutions are:

| Lambda | Hook amount | Mean-variance utility | All-pool utility |
| ---: | ---: | ---: | ---: |
| 0 | 16.447981 | 31.305467 | 20.000000 |
| 1 | 8.427461 | 25.744768 | 20.000000 |
| 4 | 3.394291 | 22.308964 | 20.000000 |
| 16 | 0.999732 | 20.679839 | 20.000000 |

These are optimizer outputs for the stated surrogate model, not observed fill rates.

Let u=z/D, d=D/Rx, q=Ry/Rx, B=bD, and L=lambda*beta*D. Dividing by D yields the dimensionless representation

$$
\bar J(u)=q\frac{1-u}{1+d(1-u)}+2u-(B+L)u^2.
$$

The original six numeric inputs reduce to four named dimensionless parameters (d,q,B,L), with the optimum using B and L only through their sum. Scaling D,Rx,Ry by c>0 and b,beta by 1/c preserves the optimum fraction u*, while scaling optimal value by c. The test checks five reserve scales from 0.1 to 1000.

**Destinations:** [Compactification-Theory](https://github.com/MoralityLabAI/Compactification-Theory) for the exact scale-quotient transfer conjecture, and this repository for a new, clearly separated CFMM/hook-routing benchmark with execution-risk observations.

## Run

From the repository root:

    cd research/chitraverse_001
    python -m unittest discover -s . -p "test_*.py" -v
    python probe.py > results.json

Seven standard-library tests cover the controller summation discrepancy, CFMM identity and fee-retaining invariant, hook optimizer KKT/grid checks, monotonic risk response, scale equivariance, and invalid-parameter guards.

## Next falsification gates

- For the controller: independently define accrual order, settlement costs, passive-yield reference and adversary capital. Build matched attacker/defender evaluations with fixed seeds.
- For the CFMM: prove the certificate with explicit hypotheses, then test it against randomized valid swap trajectories and arbitrage/price perturbations.
- For the hook: add actual nonfill outcomes, retry limits, clairvoyant and oblivious baselines, out-of-scale holdouts, utility regret and time budget. Freeze the normalized representation before introducing learned routing policies.

Keep finite synthetic evidence, exact algebraic identities, formal proofs and on-chain observations in separate result fields.
