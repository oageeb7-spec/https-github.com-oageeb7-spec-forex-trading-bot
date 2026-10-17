# JARVIS // Trade-Brain

An agentic forex research and trading system with a live dashboard. A team of agents finds
strategy ideas, turns them into testable recipes, backtests variants, filters them through a
robustness sieve, and paper-trades the ones **you** approve.

```bash
npm install     # only dependency: three.js for the 3D agent room
npm start       # http://localhost:3000
npm test
```

| Env var   | Default | Meaning                                                        |
|-----------|---------|----------------------------------------------------------------|
| `PORT`    | `3000`  | HTTP port                                                      |
| `TICK_MS` | `1500`  | One brain round every N ms                                     |
| `BUDGET`  | `50`    | Thinking budget in USD; research pauses when it is used up     |
| `WARMUP`  | `150`   | Rounds run at startup so the dashboard opens with history      |
| `DEMO`    | `1`     | Auto-approve the first two paper proposals during warm-up (`0` to disable) |
| `OANDA_API_KEY` | — | OANDA v20 API token; when set, real prices replace the synthetic feed |
| `OANDA_ENV` | `practice` | `practice` (fxTrade Practice / demo account) or `live` |
| `OANDA_POLL_MS` | `30000` | How often to check OANDA for newly closed candles |
| `DATA_SOURCE` | auto | `oanda` or `synthetic`; defaults to `oanda` when a key is set |

## Real prices from OANDA

1. Open a free practice account at oanda.com, then create a token under
   *Manage API Access* (My Account → Tools → API).
2. Start with the token:

   ```bash
   OANDA_API_KEY=your-token npm start                    # practice account
   OANDA_API_KEY=your-token OANDA_ENV=live npm start     # fxTrade live account
   ```

On startup the server pulls the last 8,000 hourly mid candles (~1.5 years) per pair from
`/v3/instruments/{pair}/candles`, paging past OANDA's 5,000-candle limit. Backtests use
that history and charge each pair's real median bid/ask spread. Every `OANDA_POLL_MS` it
appends newly closed candles, and paper trading acts on them, so a paper "day" is a real
trading day. Pairs your account can't trade (gold is restricted in some regions) are skipped
with a warning. If fewer than two pairs load, the server exits instead of falling back to fake
data. *Machines → Market data* shows each pair's history range, last candle, spread and feed
status. The top bar shows `OANDA practice`, `OANDA live` or `DATA synthetic`.

The integration only reads prices. It never places orders.

## How it works

```
Scout ──► Reader / Watcher ──► Summarizers (×3) ──► Recipe maker ──► Lab ──► Sieve ──► You ──► Paper ──► You ──► Live
  │                                  │                                                  ▲
  └── Terms checker ── knowledge base ┘                         Director: skill proposals, Hermes report
```

- **Agents** (`server/engine/brain.js`): Director, Scout, Reader, Watcher, three Summarizers,
  Terms checker, Recipe maker and Lab. Every action costs from the thinking budget and is logged.
- **Recipes** (`server/engine/strategies.js`): six templates — trend-follower (EMA cross),
  breakout (Donchian), range fade (Bollinger), time-series momentum, volatility squeeze and
  fair value gap — each with parameter ranges.
- **Lab** (`server/engine/backtest.js`): 10 variants per recipe on the first 70 % of the data,
  1 standard lot, spread charged per round trip, stop assumed before target on ambiguous bars.
- **The sieve**: out-of-sample Sharpe > 0.6 → settings ±20 % still work → carries over to another
  pair → survives 3× spread → at least half the months positive. Survivors are proposed to you.
- **Paper trading**: approved strategies trade bar-by-bar on the forward feed for 21 trading days;
  profitable ones are proposed for live.
- **Knowledge base** (`server/engine/patterns.js`): ICT / price-action concepts (BOS, FVG,
  displacement, CHoCH, order blocks, liquidity sweeps, …) with plain definitions, detector code
  and statistics measured on the data. You mark each one correct or wrong.

## Screens

Overview (KPIs, brain core, Hermes report, pipeline, logbook, decisions, equity fan) · Lab ·
Research galaxy · Strategies (key figures, equity + drawdown, monthly robustness, sieve) ·
Knowledge base (card-by-card check) · Agent room (3D work floor) · Paper & live · Decisions ·
Costs · Machines.

## What is simulated

- **Market data** is synthetic (regime-switching drift, clustered volatility, session effects)
  unless `OANDA_API_KEY` is set — see above.
- **Research** sources and summaries are generated; the agents do not browse the web or call an
  LLM yet. The pipeline boundaries (`scout`, `read`, `summarize`, `makeRecipes`) are where real
  search and LLM calls plug in.
- **Live** trading sends no orders: there is no broker adapter. Live strategies keep running on
  the market feed (OANDA or synthetic).

Nothing here is financial advice.
