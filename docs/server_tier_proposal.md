# The server-tier term: a definition for review

Status: proposal. None of this is coded into a task. The numbers are from development seeds 0 through 7 and are arithmetic on the pin-supported run, not results.

## The decision

The brief says family 3 always charges a server-tier term and lets the agent choose server capital B_S. The pinned model does neither: it charges W_S, the value the server has fronted and not yet swept, and nothing else (docs/tasks.md §4.6).

The definition is not a detail. On the paper's own bursty corner it decides whether Ark is favored at all:

| Charge on the server | 𝒟_C / 𝒟_V, `many_bursty_long` | `many_bursty_correlated` | `few_steady_recycling` |
|---|---:|---:|---:|
| Pin: W_S only | 24.8 | 24.6 | 0.0054 |
| A. Provisioned capital: peak W_S held for the horizon | 12.7 | 8.6 | 0.0047 |
| B. The server's Lightning channels, receipts over Lightning | 0.97 | 0.96 | 0.0053 |
| B. The server's Lightning channels, receipts by boarding | 1.44 | 1.53 | 0.0006 |

Channel side: margin 0.25. VTXO side: refresh lead 288. Geometric means over eight seeds.

The steady corner favors the channel under every definition. The bursty corner favors Ark by 25 to 1 with no server-tier term, by about 1.4 to 1 when the server's channels are charged and receipts arrive by boarding, and not at all when receipts arrive over Lightning.

## Why B erases the bursty result

The pinned bursty corner is not only bursty. Each agent receives 100 sat per step on average and spends 40, so every agent accumulates. A channel operator must pre-fund inbound for that accumulation, agent by agent: about 81 million sat across 200 agents.

If the agents hold VTXOs instead and their receipts arrive over Lightning, the same inflow lands on the server's own channels. The server's net Lightning position rises by the population's net inflow, about 65 million sat over the horizon, and its channels need that much inbound. Net drift is not diversifiable: pooling 200 agents who all accumulate gives the sum of their accumulations. The server-tier term comes out at roughly what the channel operator locked, and the ratio goes to one.

Pooling does help with the part of demand that cancels across agents. The pinned corner has little of it relative to its drift. This is presumably why the brief's observation lists per-agent drift and its population correlation, and whether value arrives over Lightning or by boarding.

## The candidate definitions

### A. Provisioned server capital

Locked_V(t) = B_S for the whole horizon, so 𝒟_V = B_S · H / Vol. The server's capital is treated as the channel's pre-funded stock is: committed before demand is known and held whether or not it is used. B_S becomes a real choice, since lower capital is cheaper and fails more.

- What it prices: pooling of lock-up across holders. Correlation matters (12.7 falls to 8.6), because correlated bursts raise the peak.
- What it ignores: the direction problem. A VTXO has no direction, but the server's Lightning channels do, and A does not charge them.
- What it needs: `ArkServer.advance` discards the result of a refresh the server cannot front. With finite capital, refreshes would be starved without any failure being counted. Either Spiral's model reports those (a counter is enough), or B_S is not an agent choice and the charge is the peak W_S of an unbounded run, which is what the table's row A uses.

### B. The server's Lightning channel set

Locked_V(t) = W_S(t) + C_S, where C_S is the capital on the server's own channels. With P(t) the server's cumulative net Lightning position (holders' Lightning receipts minus holders' Lightning spends), the channels need outbound for the lowest point of P and inbound for the highest, so C_S = (1 + margin) × (max P − min P), with the same margin rule the channel model uses. Under boarding, receipts do not touch the server's channels and P only falls, so C_S is the whole spend volume.

- What it prices: the paper's §3.4 claim, that the cut deficits move to the server's channel set and the ghost solver's job moves one tier up. This is the single-cut version of that.
- What it ignores: any replenishment of the server's channels during the horizon (rebalancing, splicing, swaps), which is what a real server would do and what family 4 is about. Without it the boarding case is harsh: the server must pre-fund every spend.
- What it needs: nothing from `ArkServer`. P(t) is a function of the demand stream alone, which is what an `aggregateSteps` interface would expose.

### A and B together

The paper defines B_S as the server's on-chain and channel capital together (§3.2). A charges the first, B the second. Charging both is consistent with the paper and is the most conservative for Ark.

## What I recommend

1. Adopt B as the server-tier term, with the server's rebalancing made explicit: a fixed rule in family 3, and the agent's decision in family 4. B is the term the paper's §3.4 describes, it needs no change to `ArkServer`, and it is the definition under which the family's observation fields (drift, correlation, arrival mode) all matter.
2. Add A only after Spiral's model reports starved refreshes, and make B_S a choice then.
3. Restate H3 before freezing. "The ratio exceeds one on the bursty corner" is true at the pin and is not true under B for this corner. The cell that tests pooling is a bursty population with no net drift; the pinned parameters are not that cell.

## What I need from you

- Is B, A, or both the term the brief means? If a revised paper defines it, that definition replaces all of this.
- Under B, should the server's channels be static over the horizon in family 3, or rebalanced by a fixed rule?
- Should the bursty corner keep the pinned parameters, with their net inflow, or be re-specified as zero-drift?
