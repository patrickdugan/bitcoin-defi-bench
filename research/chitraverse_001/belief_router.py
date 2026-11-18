"""Exact finite-state routing under correlated hidden liquidity.

This is a new synthetic testbed motivated by arXiv:2502.02059 and the repo's
Family-2 hidden-balance routing task. A route's success is deterministic given
the hidden world; a failed attempt reveals only failure. Successful execution
is terminal. The model assumes the world stays fixed within one demand.

All probabilities, outcomes, and expected rewards use fractions. No learned
prior, on-chain market data, or source-paper empirical result is implied.
"""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction as Q
from functools import lru_cache
from itertools import product
from typing import Callable


@dataclass(frozen=True)
class Route:
    name: str
    quote: Q
    attempt_cost: Q


@dataclass(frozen=True)
class World:
    probability: Q
    succeeds: tuple[bool, ...]


@dataclass
class Plan:
    expected_utility: Q
    # keyed by (failed route indices, remaining attempts)
    choices: dict[tuple[tuple[int, ...], int], int | None]

    def choose(self, failed: tuple[int, ...], remaining: int) -> int | None:
        return self.choices.get((tuple(sorted(failed)), remaining))


@dataclass(frozen=True)
class RoutingGame:
    routes: tuple[Route, ...]
    worlds: tuple[World, ...]

    def __post_init__(self) -> None:
        if not self.routes or not self.worlds:
            raise ValueError("at least one route and hidden world required")
        if any(r.quote <= 0 or r.attempt_cost < 0 for r in self.routes):
            raise ValueError("quotes positive and attempt costs nonnegative")
        if any(w.probability < 0 or len(w.succeeds) != len(self.routes)
               for w in self.worlds):
            raise ValueError("invalid world weight or route feasibility width")
        if sum((w.probability for w in self.worlds), Q(0)) != 1:
            raise ValueError("world probability weights must sum to one")

    def mass(self, failed: tuple[int, ...]) -> Q:
        """Unnormalized posterior mass after exactly these observed failures."""
        return sum((w.probability for w in self.worlds
                    if all(not w.succeeds[i] for i in failed)), Q(0))

    def success_mass(self, failed: tuple[int, ...], i: int) -> Q:
        """Mass of the surviving hidden worlds in which route i fills."""
        return sum((w.probability for w in self.worlds
                    if w.succeeds[i] and
                    all(not w.succeeds[j] for j in failed)), Q(0))

    def posterior_fill(self, failed: tuple[int, ...], i: int) -> Q:
        base = self.mass(failed)
        if base == 0:
            raise ValueError("impossible observation history")
        return self.success_mass(failed, i) / base

    def optimal(self, max_attempts: int) -> Plan:
        """Bellman recursion with unnormalized beliefs and exact arithmetic.

        W(F,k)=max(0,max_i[-c_i*m(F)+y_i*s_i(F)+W(F+i,k-1)]).
        The success branch stops, so no expected continuation term is needed.
        No independence assumption is imposed on route feasibility.
        """
        if max_attempts < 0:
            raise ValueError("negative attempt budget")
        choices: dict[tuple[tuple[int, ...], int], int | None] = {}

        @lru_cache(maxsize=None)
        def bellman(failed: tuple[int, ...], remaining: int) -> Q:
            key = (failed, remaining)
            base = self.mass(failed)
            if remaining == 0 or base == 0 or len(failed) == len(self.routes):
                choices[key] = None
                return Q(0)
            best, pick = Q(0), None
            for i, r in enumerate(self.routes):
                if i in failed:
                    continue
                fail_next = tuple(sorted((*failed, i)))
                v = (-r.attempt_cost * base
                     + r.quote * self.success_mass(failed, i)
                     + bellman(fail_next, remaining - 1))
                if v > best:
                    best, pick = v, i
            choices[key] = pick
            return best

        result = bellman((), max_attempts)
        return Plan(result, choices)

    def myopic(self, failed: tuple[int, ...], remaining: int) -> int | None:
        """Maximize this attempt's expected quote-minus-cost; ignore option value."""
        if remaining <= 0:
            return None
        base = self.mass(failed)
        best, idx = Q(0), None
        for i, r in enumerate(self.routes):
            if i in failed:
                continue
            score = r.quote * self.success_mass(failed, i) - r.attempt_cost * base
            if score > best:
                best, idx = score, i
        return idx

    def fee_first(self, failed: tuple[int, ...], remaining: int) -> int | None:
        """Cheapest-untried attempt baseline, as a one-demand wallet analogue."""
        if remaining <= 0:
            return None
        remaining_indices = [i for i in range(len(self.routes)) if i not in failed]
        return min(remaining_indices, key=lambda i: (self.routes[i].attempt_cost, i)) if remaining_indices else None

    def realized_utility(self, world_index: int, max_attempts: int,
                         choose: Callable[[tuple[int, ...], int], int | None]) -> Q:
        w = self.worlds[world_index]
        failed: tuple[int, ...] = ()
        reward = Q(0)
        for remaining in range(max_attempts, 0, -1):
            i = choose(failed, remaining)
            if i is None:
                break
            if i in failed or not 0 <= i < len(self.routes):
                raise ValueError("illegal repeated or out-of-range attempt")
            reward -= self.routes[i].attempt_cost
            if w.succeeds[i]:
                reward += self.routes[i].quote
                break
            failed = tuple(sorted((*failed, i)))
        return reward

    def expected_utility(self, max_attempts: int,
                         choose: Callable[[tuple[int, ...], int], int | None]) -> Q:
        return sum((w.probability * self.realized_utility(j, max_attempts, choose)
                    for j, w in enumerate(self.worlds)), Q(0))

    def oracle_value(self, max_attempts: int) -> Q:
        """Privileged one-demand bound: oracle knows the hidden world exactly."""
        if max_attempts <= 0:
            return Q(0)
        return sum((w.probability * max(
                    [Q(0)] + [r.quote-r.attempt_cost
                              for r, ok in zip(self.routes, w.succeeds) if ok])
                    for w in self.worlds), Q(0))


def shared_edge_example() -> RoutingGame:
    """Synthetic 3-edge directed network, 8 equally likely hidden worlds.

    A requires e0 & e1, B requires e0 & e2, C requires e0 only.
    C is the cheapest and most likely route but pays a smaller quote.
    All feasibility sets are actual AND-of-edges (no magical OR path).
    """
    routes = (
        Route("deep_A", Q(120), Q(1)),
        Route("deep_B", Q(118), Q(1)),
        Route("direct_C", Q(100), Q(1, 2)),
    )
    worlds = tuple(
        World(Q(1, 8), (e0 and e1, e0 and e2, e0))
        for e0, e1, e2 in product((False, True), repeat=3)
    )
    return RoutingGame(routes, worlds)


def report() -> dict[str, object]:
    game = shared_edge_example()
    budget = 2
    plan = game.optimal(budget)
    result = {
        "model": "finite-world-correlated-routing-v1",
        "source": "arxiv:2502.02059; bitcoin-defi-bench Family 2",
        "synthetic": True,
        "hidden_edges": 3,
        "worlds": len(game.worlds),
        "candidate_routes": len(game.routes),
        "max_attempts": budget,
        "exact_bayes": str(plan.expected_utility),
        "greedy_one_step": str(game.expected_utility(budget, game.myopic)),
        "fee_first": str(game.expected_utility(budget, game.fee_first)),
        "privileged_oracle": str(game.oracle_value(budget)),
        "first_attempts": {
            "bayes": game.routes[plan.choose((), budget)].name if plan.choose((), budget) is not None else None,
            "myopic": game.routes[game.myopic((), budget)].name if game.myopic((), budget) is not None else None,
            "fee_first": game.routes[game.fee_first((), budget)].name if game.fee_first((), budget) is not None else None,
        },
        "prior_fill_probabilities": {
            r.name: str(game.posterior_fill((), i))
            for i, r in enumerate(game.routes)
        },
        "post_A_failure_fill_probabilities": {
            r.name: str(game.posterior_fill((0,), i))
            for i, r in enumerate(game.routes) if i != 0
        },
    }
    return result


if __name__ == "__main__":
    import json
    print(json.dumps(report(), indent=2))
