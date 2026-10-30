Family 4: server inbound resizing, the operator problem identified in docs/tasks.md section 5.1.

Reuses family 3's committed pilot and evaluation streams for `drift` (`many_bursty_long`),
`balanced` (`many_bursty_balanced`), and `correlated` (`many_bursty_balanced_correlated`); no
fixture of this family exists. The environment charges inbound capital, delayed resizes, and failed
receipts, in the order family 3's `serverEnvelope` processes a step. Outbound is not modelled.

The capacity is never below the position the server holds in its channels. A resize whose target is
below the position at the decision is rejected (`below_position`); when a resize takes effect, one
step after the decision, the capacity in force is the larger of the target and the position then,
and the lease is charged on the increase actually put in force.

The privileged oracle is an exact dynamic program over never-failing schedules. A level must cover
the highest no-failure position right after a receipt while it is in force, and for every decision
after the first the position at the decision and at the step it takes effect. The ceiling is exact,
not only among never-failing schedules, because of that floor: with the capacity at or above the
failing path's position always, the no-failure path satisfies p_nf(t) <= p_fail(t) + the sats failed
so far, so raising every later level by the cumulative failed sats gives a never-failing schedule.
Its extra cost is at most capital_rate_per_block x horizon_blocks + lease_rate_ppm / 1e6 per failed
sat, which `failure_value_share` covers, plus at most one resize fee per interval with a failure,
which `failure_fixed_sats` covers. Without the floor the claim is false (a sparse stream with a large
standing balance makes cutting below the position and failing a receipt cheaper). `server_sizing.test.ts`
checks it by enumeration on small streams with the two inequalities exactly tight, failing schedules
included. The cap on a target is sixteen times the pilot peak, set so that neither the oracle nor the raised
schedule meets it: on the development seeds the oracle's highest level is at most 0.22 of it
(correlated, seed 5, whose evaluation stream peaks at 3.4 times its pilot's). If a seed ever needed
more, the oracle would throw rather than play a failing schedule.

Run development baselines with `node --experimental-strip-types scripts/run_server_sizing.ts --block development`.
The agent runner is `scripts/run_server_sizing_agent.ts`. Family 4 is not frozen: all contrasts
are descriptive and both runners refuse confirmatory seeds until preregistration freezes it.
