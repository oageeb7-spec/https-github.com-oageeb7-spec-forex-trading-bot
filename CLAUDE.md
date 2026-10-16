# forex-trading-bot

Python 3.11+, src layout (`src/forex_bot`), tests in `tests/`.

- Install: `pip install -e ".[dev]"`
- Test: `pytest`
- Lint/format: `ruff check . && ruff format --check .`
- Typecheck: `mypy src`

Notes:
- Config comes from `FOREX_*` env vars (see `.env.example`); never commit secrets or `.env`.
- Practice mode is the default; don't change defaults toward live trading.
