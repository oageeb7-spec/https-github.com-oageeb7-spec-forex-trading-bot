import pytest

from forex_bot.risk import position_size


def test_position_size() -> None:
    # Risk $100 with a 20-pip stop on EUR/USD: 100 / (20 * 0.0001) = 50,000 units.
    assert position_size(10_000, 0.01, 20, 0.0001) == 50_000


def test_rejects_non_positive_inputs() -> None:
    with pytest.raises(ValueError):
        position_size(10_000, 0.01, 0, 0.0001)
