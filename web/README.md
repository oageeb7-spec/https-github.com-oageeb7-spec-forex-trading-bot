# OS AI Trading - web app

Live: https://os-ai-trading-wg0h27.v2.appdeploy.ai/ (AppDeploy app `os-ai-trading-wg0h27`)

A web version of the trader-forex setup finder with a team of AI agents.

**Engine.** Pick a market (EUR/USD, gold, the majors, a few crosses, silver) and a
timeframe; the server pulls live delayed Yahoo bars and the rules engine reads
structure, breaks of structure, liquidity sweeps, premium/discount and fair-value gaps /
order blocks, then returns one decision: BUY or SELL with entry, stop, TP1, TP2, pips and
reward:risk plus the reasons, or NO TRADE when reward:risk is under your minimum.

**Agents** (AppDeploy `ai.run` tool loops, `backend/agents.ts`):

| agent | what it does | tools |
|---|---|---|
| Market Analyst | checks other timeframes and price action against the engine's reading | `get_setup`, `get_price_action` |
| Risk Manager | sizes the trade, checks the stop vs ATR and the session; pass, caution or veto | `size_position`, `get_volatility`, `get_session` |
| Head Trader | reads both reports, decides TAKE or SKIP with confidence and a plan | - |
| Scanner (cron, every 15 min) | reads EUR/USD, gold, GBP/USD, USD/JPY on 15m and 1h, logs new setups, sends the newest to the desk | engine |
| Tracker (same cron) | closes logged trades at target or stop and counts them in the forward test | engine |

Guardrails are code, not prompts: agents never set prices (levels come from the engine);
an engine No Trade, a risk veto or an agent that fails to report always ends in SKIP;
agent output is validated; an agent that runs out of steps gets one rescue pass with its
own tool results; reviews are cached per reading; AI runs are capped at 40 per hour.

**Page.** KPI cards, live chart with the levels, the signal card, the agent desk (each
agent's verdict, confidence, findings, concerns and the tools it called), and tabs for
the agent activity feed, the signal log (who logged it, the desk verdict, live status,
final outcome and R), the forward test (win rate and average R from closed trades) and a
position sizer. Refreshes every 60 seconds. It never places orders; sending stays in
JARVIS (`/fxsend`) behind the risk check and your typed yes.

## Layout

| path | what |
|---|---|
| `backend/analyze.ts` | the setup finder and tracker, a port of `.claude/skills/trader-forex/setup.py` |
| `backend/market.ts` | Yahoo bars, pair maths, lot sizing, market clock |
| `backend/agents.ts` | the three AI agents, their tools and the guardrails |
| `backend/store.ts` | bounded database documents (signal index, feed, stats, AI budget) with optimistic concurrency |
| `backend/index.ts` | routes (`/api/meta`, `analyze`, `desk`, `size`, `signals`, `activity`, `performance`, `scanner/run`) and the `scanMarkets` cron handler |
| `cron.json` | the 15-minute scanner schedule |
| `src/` | React + Tailwind frontend (chart is a small canvas renderer, no chart library) |
| `tests/tests.json` | the AppDeploy QA suite run on every deploy |
| `.platform-shims/` | local-only stand-ins for the AppDeploy SDK, to run and test the app here |

## Checks

```bash
cd web && npm install && npm install --no-save tsx@4.19.2

# the TypeScript analyzer must match the Python one exactly (216 cases on real bars)
python3 backend/parity_ref.py > /tmp/ref.json && npx tsx backend/parity.test.ts /tmp/ref.json

# typecheck frontend + backend, then build
npx tsc -p .platform-shims/tsconfig.check.json --noEmit
npx vite build -c .platform-shims/vite.local.config.ts

# agent guardrails (veto, No Trade, rescue, AI outage) against the stub ai.run
npx tsx --tsconfig .platform-shims/tsconfig.check.json backend/guard.test.ts

# run the whole app locally on http://localhost:5180 (Yahoo answered from the saved
# real fixtures; FEED_DOWN=1 simulates a price-feed outage, CUT=200 starts 200 bars
# in the past, GET /local/cut?n=0 moves to now, GET /local/cron fires the scheduled scan)
npx tsx --tsconfig .platform-shims/tsconfig.check.json .platform-shims/server.ts
```

## Deploying

The deployed source is the files above minus `.platform-shims/`, `backend/parity*`,
`backend/guard.test.ts` and this README. Redeploy through AppDeploy with app id `os-ai-trading-wg0h27`.

## Honest limits

Data is free, delayed and unofficial; gold and silver use COMEX futures, a few dollars
off spot. Neither the rules nor the agents are backtested; the forward test is the only
track record and a small sample says little. Yahoo's last bar is the one still forming,
so a reading (and its cached review) changes when a new bar opens. The signal log is
shared by everyone who opens the URL and shows the latest 30 saved readings. Not
financial advice.
