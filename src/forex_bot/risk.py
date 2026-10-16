"""Position sizing."""

from __future__ import annotations


def position_size(balance: float, risk_fraction: float, stop_pips: float, pip_value: float) -> int:
    """Units to trade so that hitting the stop loses ``balance * risk_fraction``.

    ``pip_value`` is the account-currency value of one pip for one unit
    (e.g. 0.0001 for EUR/USD on a USD account).
    """
    if balance <= 0 or risk_fraction <= 0 or stop_pips <= 0 or pip_value <= 0:
        raise ValueError("balance, risk_fraction, stop_pips and pip_value must be positive")
    return int(balance * risk_fraction / (stop_pips * pip_value))
