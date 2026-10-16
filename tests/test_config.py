import pytest

from forex_bot.config import Settings


def test_defaults_to_practice_mode() -> None:
    s = Settings.from_env({})
    assert s.practice is True
    assert s.risk_per_trade == 0.01
    assert s.broker_api_key is None


def test_reads_env() -> None:
    s = Settings.from_env(
        {"FOREX_BROKER_API_KEY": "k", "FOREX_PRACTICE": "false", "FOREX_RISK_PER_TRADE": "0.02"}
    )
    assert s.broker_api_key == "k"
    assert s.practice is False
    assert s.risk_per_trade == 0.02


@pytest.mark.parametrize("risk", ["0", "-0.01", "0.5"])
def test_rejects_unsafe_risk(risk: str) -> None:
    with pytest.raises(ValueError):
        Settings.from_env({"FOREX_RISK_PER_TRADE": risk})
