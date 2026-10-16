# forex-trading-bot

Python forex trading bot. Runs in practice mode by default.

## Setup

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env   # fill in broker credentials; never commit .env
```

## Run

```bash
forex-bot
```

## Develop

```bash
pytest
ruff check . && ruff format --check .
mypy src
```
