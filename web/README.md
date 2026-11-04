# OS AI Trading - web app

Live: https://os-ai-trading-wg0h27.v2.appdeploy.ai/ (AppDeploy app `os-ai-trading-wg0h27`)

A web version of the trader-forex setup finder. Pick a market (EUR/USD, gold, the
majors, a few crosses, silver) and a timeframe; the server pulls live delayed Yahoo
bars, reads structure, breaks of structure, liquidity sweeps, premium/discount and
fair-value gaps / order blocks, and returns one decision: BUY or SELL with entry,
stop, TP1, TP2, pips and reward:risk plus the reasons, or NO TRADE when reward:risk is
under your minimum. The page also has a candlestick chart with the levels, a position
sizer (USD account), the FX market clock, and a signal log saved in the app database
whose trades are re-checked against live prices (pending, open, TP1, target, stopped).
It refreshes every 60 seconds. It never places orders; sending stays in JARVIS
(`/fxsend`) behind the risk check and your typed yes.

## Layout

| path | what |
|---|---|
| `backend/analyze.ts` | the setup finder and tracker, a port of `.claude/skills/trader-forex/setup.py` |
| `backend/market.ts` | Yahoo bars, pair maths, lot sizing, market clock |
| `backend/index.ts` | routes: `GET /api/meta`, `GET /api/analyze`, `POST /api/size`, `GET/POST /api/signals`, `DELETE /api/signals/:id` |
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

# run the whole app locally on http://localhost:5180 (Yahoo answered from the saved
# real fixtures; FEED_DOWN=1 simulates a price-feed outage)
npx tsx --tsconfig .platform-shims/tsconfig.check.json .platform-shims/server.ts
```

## Deploying

The deployed source is the files above minus `.platform-shims/`, `backend/parity*`
and this README. Redeploy through AppDeploy with app id `os-ai-trading-wg0h27`.

## Honest limits

Data is free, delayed and unofficial; gold and silver use COMEX futures, a few dollars
off spot. The rules are not backtested, so there is no known win rate. The signal log is
shared by everyone who opens the URL and shows the latest 30 saved readings. Not
financial advice.
