"""Command-line entry point."""

from __future__ import annotations

from forex_bot import __version__
from forex_bot.config import Settings


def main() -> None:
    settings = Settings.from_env()
    mode = "practice" if settings.practice else "LIVE"
    print(f"forex-bot {__version__} ({mode}, risk {settings.risk_per_trade:.2%} per trade)")


if __name__ == "__main__":
    main()
