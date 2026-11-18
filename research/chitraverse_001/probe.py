"""Chitraverse × YaRN 001: deterministic applied-math probes.

Source papers:
  https://arxiv.org/html/2307.13139v1
  https://arxiv.org/html/2003.10001v4
  https://arxiv.org/html/2502.02059v1

All numeric examples are synthetic; the source-paper equations are quoted by
number in README.md. Standard-library-only to support exact arithmetic tests.
"""
from __future__ import annotations

from fractions import Fraction
from math import sqrt
import json

Q = Fraction


def pid_sum_audit(S: Q, d: Q, target: Q, n: int) -> dict[str, Q]:
    """Compare the formulas printed in arXiv:2307.13139, §2 (display before eq. 3).

    This is an internal *algebra* audit of the printed S_{s+i} expression. It is
    not an attack profitability replication or a claim about a deployed pool.
    """
    if not (n >= 4 and S > 0 and 0 < target <= Q(1, 2)
            and 0 <= d < S * target):
        raise ValueError("require n>=4, S>0, 0<target<=1/2, 0<=d<S*target")
    term = d / target - 2 * S
    displayed_schedule_sum = sum((2 * S + Q(i + 1, n) * term
                                  for i in range(1, n + 1)), Q(0))
    direct_closed_form = (n - 3) * S + Q(n + 3, 2) * d / target
    printed_revenue_sum = (n - 3) * (S + d / (2 * target))
    gap = displayed_schedule_sum - printed_revenue_sum
    return {
        "displayed_schedule_sum": displayed_schedule_sum,
        "derived_closed_form": direct_closed_form,
        "printed_revenue_sum": printed_revenue_sum,
        "difference": gap,
        "predicted_difference": 3 * d / target,
    }


def cfmm_value_certificate(x: Q, y: Q, k: Q, p: Q) -> dict[str, Q]:
    """Exact algebraic certificate: (px+y)^2 - 4pk = (px-y)^2 + 4p(xy-k)."""
    if not (x > 0 and y > 0 and k > 0 and p > 0 and x * y >= k):
        raise ValueError("positive x,y,k,p and reachable xy>=k required")
    lhs = (p * x + y) ** 2 - 4 * p * k
    rhs = (p * x - y) ** 2 + 4 * p * (x * y - k)
    if lhs != rhs or rhs < 0:
        raise AssertionError("exact certificate failed")
    return {"lhs": lhs, "sum_of_nonnegative_terms": rhs,
            "value": p * x + y, "reserve_product": x * y}


def cfmm_fee_posttrade(x: Q, y: Q, dx: Q, gamma: Q) -> tuple[Q, Q]:
    """Fee-adjusted constant-product trade; actual reserves retain the fee."""
    if not (x > 0 and y > 0 and dx >= 0 and 0 < gamma <= 1):
        raise ValueError("invalid reserves/trade/fee")
    dy = y * gamma * dx / (x + gamma * dx)
    xx, yy = x + dx, y - dy
    if xx * yy < x * y:
        raise AssertionError("invariant should be nondecreasing")
    return xx, yy


def hook_value(z: float, D: float, Rx: float, Ry: float,
               b: float, beta: float, risk_lambda: float) -> float:
    """Mean-variance utility: G1(D-z)+2z-b*z^2-lambda*beta*z^2."""
    return Ry * (D - z) / (Rx + D - z) + 2*z - (b + risk_lambda*beta)*z*z


def hook_derivative(z: float, D: float, Rx: float, Ry: float,
                    b: float, beta: float, risk_lambda: float) -> float:
    return 2 - 2*(b + risk_lambda*beta)*z - Rx*Ry/(Rx + D - z)**2


def hook_second_derivative(z: float, D: float, Rx: float, Ry: float,
                           b: float, beta: float, risk_lambda: float) -> float:
    return -2*(b + risk_lambda*beta) - 2*Rx*Ry/(Rx + D - z)**3


def solve_hook_route(D: float, Rx: float, Ry: float, b: float,
                     beta: float, risk_lambda: float) -> dict[str, float | str]:
    """Certified 1D concave maximum by derivative bisection and KKT signs."""
    if not (D > 0 and Rx > 0 and Ry > 0 and b > 0 and beta >= 0
            and risk_lambda >= 0):
        raise ValueError("positive reserves/size/curvature; nonnegative risk")
    kw = (D, Rx, Ry, b, beta, risk_lambda)
    if hook_derivative(0, *kw) <= 0:
        z, status = 0., "lower_boundary"
    elif hook_derivative(D, *kw) >= 0:
        z, status = D, "upper_boundary"
    else:
        lo, hi = 0., D
        for _ in range(90):
            mid = (lo + hi)/2
            if hook_derivative(mid, *kw) > 0:
                lo = mid
            else:
                hi = mid
        z, status = (lo+hi)/2, "interior"
    if hook_second_derivative(z, *kw) >= 0:
        raise AssertionError("failed strict concavity check")
    if status == "interior" and abs(hook_derivative(z, *kw)) > 1e-11:
        raise AssertionError("KKT residual")
    return {
        "risk_lambda": risk_lambda, "hook_allocation": z,
        "pool_allocation": D-z, "utility": hook_value(z, *kw),
        "all_pool_utility": hook_value(0, *kw),
        "kkt_derivative": hook_derivative(z, *kw), "status": status,
    }


def normalized_hook_value(u: float, d: float, q: float, B: float, L: float) -> float:
    """The dimensionless three-parameter family after z=D*u.

    d=D/Rx, q=Ry/Rx, B=bD, L=lambda*beta*D. The optimizer
    needs B+L, while keeping them distinct supports intervention analysis.
    """
    if not (0 <= u <= 1 and d > 0 and q > 0 and B > 0 and L >= 0):
        raise ValueError("dimensionless parameter domain violation")
    return q*(1-u)/(1+d*(1-u)) + 2*u - (B+L)*u*u


def main() -> None:
    pid = pid_sum_audit(Q(100), Q(30), Q(2, 5), 10)
    cert = cfmm_value_certificate(Q(120), Q(90), Q(10000), Q(3, 2))
    x2, y2 = cfmm_fee_posttrade(Q(100), Q(100), Q(20), Q(997, 1000))
    routing = [solve_hook_route(25., 100., 100., .035, .04, l)
               for l in (0., 1., 4., 16.)]
    out = {
        "protocol": "chitraverse-yarn-001-v1",
        "source_ids": ["2307.13139v1", "2003.10001v4", "2502.02059v1"],
        "synthetic": True,
        "pid_display_sum": {key: str(val) for key, val in pid.items()},
        "cfmm": {
            "exact_certificate": {key: str(val) for key, val in cert.items()},
            "value_bound": 2*sqrt(1.5*10000),
            "post_fee_trade": {"x": str(x2), "y": str(y2),
                               "product": str(x2*y2), "old_product": "10000"},
        },
        "hook_routing": routing,
        "dimensionless_example": {
            "d": .25, "q": 1., "B": .035*25, "L_at_lambda_1": .04*25,
            "optimal_u_at_lambda_1": routing[1]["hook_allocation"]/25.,
        },
    }
    print(json.dumps(out, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
