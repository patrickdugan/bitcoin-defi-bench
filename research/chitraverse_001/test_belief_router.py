"""Exact oracle and randomized brute-force tests for the correlated routing toy."""
from fractions import Fraction as Q
from itertools import permutations
from random import Random
import unittest

from belief_router import Route, World, RoutingGame, shared_edge_example, report


def brute_force_value(game: RoutingGame, max_attempts: int) -> Q:
    """Any single-demand policy with terminal success has one failure branch.
    Enumerating routes in order, with optional early stop, is exhaustive.
    """
    def reward(order: tuple[int, ...]) -> Q:
        total = Q(0)
        for w in game.worlds:
            value = Q(0)
            for i in order:
                value -= game.routes[i].attempt_cost
                if w.succeeds[i]:
                    value += game.routes[i].quote
                    break
            total += w.probability * value
        return total
    return max((reward(order)
                for k in range(min(max_attempts, len(game.routes))+1)
                for order in permutations(range(len(game.routes)), k)), default=Q(0))


class CorrelatedBeliefRouterTests(unittest.TestCase):
    def test_shared_edge_optimality_against_enumeration(self):
        game = shared_edge_example()
        plan = game.optimal(2)
        self.assertEqual(plan.expected_utility, Q(429, 8))
        self.assertEqual(game.expected_utility(2, plan.choose), Q(429, 8))
        self.assertEqual(brute_force_value(game, 2), Q(429, 8))
        self.assertEqual(game.routes[plan.choose((), 2)].name, "deep_A")
        self.assertEqual(game.routes[plan.choose((0,), 1)].name, "direct_C")

    def test_shared_edge_baselines_and_privileged_bound(self):
        game = shared_edge_example()
        self.assertEqual(game.expected_utility(2, game.myopic), Q(99, 2))
        self.assertEqual(game.expected_utility(2, game.fee_first), Q(49))
        self.assertEqual(game.oracle_value(2), Q(909, 16))
        self.assertLess(game.expected_utility(2, game.myopic),
                        game.optimal(2).expected_utility)
        self.assertLessEqual(game.optimal(2).expected_utility,
                             game.oracle_value(2))

    def test_failure_reveals_shared_channel_bottleneck(self):
        game = shared_edge_example()
        self.assertEqual(game.posterior_fill((), 0), Q(1, 4))
        self.assertEqual(game.posterior_fill((), 1), Q(1, 4))
        self.assertEqual(game.posterior_fill((), 2), Q(1, 2))
        self.assertEqual(game.posterior_fill((0,), 1), Q(1, 6))
        self.assertEqual(game.posterior_fill((0,), 2), Q(1, 3))
        self.assertEqual(game.posterior_fill((2,), 0), Q(0))
        self.assertEqual(game.posterior_fill((2,), 1), Q(0))

    def test_exhaustive_small_random_games(self):
        rnd = Random(20261107)
        for _ in range(48):
            n, m, budget = 4, 8, rnd.randrange(1, 4)
            routes = tuple(Route(f"r{i}", Q(rnd.randrange(2, 15)),
                                 Q(rnd.randrange(0, 4), 2)) for i in range(n))
            worlds = tuple(World(Q(1, m), tuple(rnd.random() < .6
                                for _ in range(n))) for _ in range(m))
            game = RoutingGame(routes, worlds)
            plan = game.optimal(budget)
            self.assertEqual(plan.expected_utility,
                             brute_force_value(game, budget))
            self.assertEqual(plan.expected_utility,
                             game.expected_utility(budget, plan.choose))
            self.assertLessEqual(plan.expected_utility,
                                 game.oracle_value(budget))

    def test_repeated_action_and_invalid_priors_rejected(self):
        game = shared_edge_example()
        with self.assertRaises(ValueError):
            game.realized_utility(0, 2, lambda _f, _k: 0)
        # Above world 0 has every route infeasible, so repeated 0 is illegal.
        bad = RoutingGame(game.routes, (World(Q(1), (False, True, True)),))
        with self.assertRaises(ValueError):
            bad.posterior_fill((1,), 0)
        with self.assertRaises(ValueError):
            RoutingGame(game.routes, (World(Q(1, 2), (True,)*3),))
        with self.assertRaises(ValueError):
            game.optimal(-1)

    def test_source_provenance_and_realized_output_are_synthetic(self):
        obj = report()
        self.assertEqual(obj["synthetic"], True)
        self.assertEqual(obj["exact_bayes"], "429/8")
        self.assertEqual(obj["greedy_one_step"], "99/2")
        self.assertEqual(obj["fee_first"], "49")
        self.assertEqual(obj["privileged_oracle"], "909/16")


if __name__ == "__main__":
    unittest.main()
