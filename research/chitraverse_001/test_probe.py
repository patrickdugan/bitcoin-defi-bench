"""Pure-stdlib falsification and identity tests for Chitraverse × YaRN 001."""
from fractions import Fraction as Q
import unittest

from probe import (pid_sum_audit, cfmm_value_certificate, cfmm_fee_posttrade,
                   solve_hook_route, hook_value, hook_derivative, normalized_hook_value)


class Chitraverse001Tests(unittest.TestCase):
    def test_pid_schedule_sum_identity(self):
        for n in (4, 7, 10, 23):
            for d in (0, 10, 30):
                r = pid_sum_audit(Q(100), Q(d), Q(2, 5), n)
                self.assertEqual(r["displayed_schedule_sum"], r["derived_closed_form"])
                self.assertEqual(r["difference"], r["predicted_difference"])
        r = pid_sum_audit(Q(100), Q(30), Q(2, 5), 10)
        self.assertEqual(r["displayed_schedule_sum"], Q(2375, 2))
        self.assertEqual(r["printed_revenue_sum"], Q(1925, 2))
        self.assertEqual(r["difference"], Q(225))

    def test_cfmm_value_certificate_exact(self):
        for x, y, k, p in [
            (Q(120), Q(90), Q(10000), Q(3, 2)),
            (Q(10), Q(10), Q(100), Q(1)),
            (Q(4), Q(9), Q(36), Q(9, 4)),
        ]:
            c = cfmm_value_certificate(x, y, k, p)
            self.assertEqual(c["lhs"], c["sum_of_nonnegative_terms"])
            self.assertGreaterEqual(c["lhs"], 0)

    def test_fee_increases_product_except_zero_or_no_fee(self):
        x, y = Q(100), Q(100)
        for fee in (Q(1), Q(997, 1000), Q(9, 10)):
            xx, yy = cfmm_fee_posttrade(x, y, Q(20), fee)
            self.assertGreaterEqual(xx*yy, x*y)
            if fee < 1:
                self.assertGreater(xx*yy, x*y)
            else:
                self.assertEqual(xx*yy, x*y)

    def test_hook_analytic_optimum_vs_dense_grid(self):
        cfg = (25., 100., 100., .035, .04)
        for lam in (0., .05, 1., 4., 16., 1000.):
            row = solve_hook_route(*cfg, lam)
            z, best = row["hook_allocation"], row["utility"]
            self.assertGreaterEqual(z, 0.)
            self.assertLessEqual(z, cfg[0])
            self.assertGreaterEqual(best+1e-10, row["all_pool_utility"])
            for i in range(501):
                self.assertGreaterEqual(best+1e-9,
                    hook_value(cfg[0]*i/500, *cfg, lam))
            if row["status"] == "interior":
                self.assertAlmostEqual(hook_derivative(z, *cfg, lam), 0., places=10)

    def test_hook_risk_aversion_decreases_hook_allocation(self):
        cfg = (25., 100., 100., .035, .04)
        zs = [solve_hook_route(*cfg, lam)["hook_allocation"]
              for lam in (0., .1, .5, 1., 4., 16., 1000.)]
        self.assertTrue(all(a >= b for a,b in zip(zs, zs[1:])))

    def test_compactification_scale_equivariance(self):
        D,Rx,Ry,b,beta,lam=25.,100.,100.,.035,.04,1.
        base=solve_hook_route(D,Rx,Ry,b,beta,lam)
        for c in (.1, .5, 2., 10., 1000.):
            scaled=solve_hook_route(c*D,c*Rx,c*Ry,b/c,beta/c,lam)
            self.assertAlmostEqual(scaled["hook_allocation"]/c,
                                   base["hook_allocation"],places=9)
            self.assertAlmostEqual(scaled["utility"]/c,
                                   base["utility"],places=9)
        u=base["hook_allocation"]/D
        v=normalized_hook_value(u,D/Rx,Ry/Rx,b*D,lam*beta*D)
        self.assertAlmostEqual(D*v,base["utility"],places=10)

    def test_reject_invalid_parameters(self):
        with self.assertRaises(ValueError):
            pid_sum_audit(Q(100), Q(30), Q(3, 5), 10)
        with self.assertRaises(ValueError):
            cfmm_value_certificate(Q(1), Q(1), Q(2), Q(1))
        with self.assertRaises(ValueError):
            solve_hook_route(0, 100, 100, .035, .04, 1)


if __name__ == "__main__":
    unittest.main()
