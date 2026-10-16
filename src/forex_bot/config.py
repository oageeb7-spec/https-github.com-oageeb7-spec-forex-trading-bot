"""Runtime configuration loaded from environment variables."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

_TRUE = {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    broker_api_key: str | None
    account_id: str | None
    practice: bool
    risk_per_trade: float

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        risk = float(env.get("FOREX_RISK_PER_TRADE", "0.01"))
        if not 0 < risk <= 0.05:
            raise ValueError(f"FOREX_RISK_PER_TRADE must be in (0, 0.05], got {risk}")
        return cls(
            broker_api_key=env.get("FOREX_BROKER_API_KEY") or None,
            account_id=env.get("FOREX_ACCOUNT_ID") or None,
            practice=env.get("FOREX_PRACTICE", "true").strip().lower() in _TRUE,
            risk_per_trade=risk,
        )
