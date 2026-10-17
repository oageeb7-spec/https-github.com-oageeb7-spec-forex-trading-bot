# OS Trading AI

An agentic forex research and trading system with a live dashboard. A team of agents finds
strategy ideas, turns them into testable recipes, backtests variants, filters them through a
robustness sieve, and paper-trades the ones **you** approve.

![OS AI overview](docs/screenshots/overview.png)

| | |
|---|---|
| ![Lab](docs/screenshots/lab.png) **Lab** — 10 variants per recipe, re-based at the in/out-of-sample split | ![Strategies](docs/screenshots/strategies.png) **Strategies** — key figures, equity, drawdown, the five-check sieve |
| ![Research](docs/screenshots/research.png) **Research** — one cluster per topic, one star per source | ![Knowledge base](docs/screenshots/knowledge.png) **Knowledge base** — check each concept card by card |
| ![Agent room](docs/screenshots/room.png) **Agent room** — 3D work floor, every movement is a real task | ![Decisions](docs/screenshots/decisions.png) **Decisions** — nothing goes to paper or live without you |

*Screenshots from `npm run demo` (generated prices and research).*

```bash
npm install
cp .env.example .env   # optional: Anthropic key for Claude research, dashboard password
npm start              # http://localhost:3000
npm run demo    # fully simulated: generated prices and research, no keys needed
npm test
```

By default everything is real: prices come from **OS AI data** (real hourly FX, gold and bitcoin prices
from Yahoo Finance's public feed, no key needed) and the agents research real sources. With an
`OANDA_API_KEY` the feed switches to OANDA, which adds real bid/ask spreads. If no feed can
load, the server stops rather than inventing prices.

| Env var   | Default | Meaning                                                        |
|-----------|---------|----------------------------------------------------------------|
| `OANDA_API_KEY` | — | Optional OANDA v20 token; switches the price feed to OANDA |
| `OANDA_ENV` | `practice` | `practice` (demo account) or `live` |
| `POLL_MS` | `30000` | How often to check the feed for newly closed candles |
| `ANTHROPIC_API_KEY` | — | Lets Claude analyze sources; without it a free keyword classifier is used |
| `ANALYST_MODEL` | `claude-opus-5-5` | Claude model for the summarizer agents |
| `ANALYST_EFFORT` | `low` | Claude effort level (`low` … `max`) |
| `GITHUB_TOKEN` | — | Optional; raises GitHub's search rate limit |
| `YOUTUBE_API_KEY` | — | Optional; adds YouTube (video titles and descriptions) as a source |
| `RESEARCH_SCOUT_MS` | `45000` | Pause between the scout's searches |
| `DATA_SOURCE` | `osai` (`oanda` with a token) | `synthetic` for generated prices |
| `RESEARCH` | `live` | `simulated` for generated research |
| `BUDGET`  | `50`    | Thinking budget in USD (real Claude spend in live mode); research pauses at the limit |
| `DASHBOARD_PASSWORD` | — | Password for the dashboard when hosted publicly |
| `FRAME_ANCESTORS` | your Shopify domains | Sites allowed to embed the dashboard |
| `STATE_FILE` | `~/.os-ai/state.json` | Where strategies, paper trades, decisions and research are saved so restarts and redeploys keep them (not used by `npm run demo`) |
| `PORT`    | `3000`  | HTTP port |
| `TICK_MS` | `1500`  | One brain round every N ms |
| `WARMUP`, `DEMO` | on in `npm run demo` only | Pre-run rounds and auto-approval of the first two paper proposals |

## Host it and show it in your Shopify store

Shopify cannot run OS AI itself (it needs a server that stays on), so OS AI runs on a small
host and your store shows it on a page.

**Hostinger VPS at ostradingai.com:** follow [docs/HOSTINGER.md](docs/HOSTINGER.md); one script
installs OS AI with HTTPS. Render (below) is the alternative.

1. **Host:** on render.com choose *New → Blueprint* and pick this repository. `render.yaml`
   sets everything up; Render then asks for `OANDA_API_KEY`, `ANTHROPIC_API_KEY` and
   `DASHBOARD_PASSWORD`. Any Node 18+ host works the same way with `npm ci && npm start`.
2. **Store page:** in Shopify admin, *Online Store → Pages → Add page*, switch the editor to
   HTML and paste `docs/shopify-page.html` with your host's address filled in. Keep the page
   hidden from the store menu.
3. The dashboard is set up for **app.ostradingai.com**: in your domain's DNS, add a CNAME record
   `app` pointing at the Render address (Render shows it under *Settings → Custom Domains*).
   The store page then lives at `https://ostradingai.com/pages/os-ai`.

With `DASHBOARD_PASSWORD` set, every page and API call needs that password (any username).
`/healthz` stays open for the host's health check.

## Live research

- **Scout** searches arXiv, GitHub, Hacker News (web articles) and, with a key, YouTube, rotating
  through ten FX strategy topics. Already-seen URLs are skipped.
- **Reader / Watcher** fetch the full text: arXiv abstracts, repository READMEs, article bodies
  (HTML stripped) and video descriptions. Text beyond 40,000 characters is cut and marked.
  Sources that promise unrealistic returns ("never lose", "100% win rate") are rejected.
- **Summarizers** send each document to Claude (`claude-opus-5-5`, structured JSON output,
  server-side refusal fallback enabled). Claude decides whether the document describes a rule
  one of the six recipe templates can test, which pairs and timeframe it targets, and which
  settings it uses. The document is treated as untrusted data. Real token usage is priced and
  charged to the thinking budget, per agent, on the Costs page.
- **Recipe maker** tests the source's own settings on the pairs it names (or two others).
  Every recipe links back to its source.
- Failures (rate limits, unreachable sites) mark the agent *stuck* in red and appear in the log.

## OS AI data

Hourly candles for EUR/USD, GBP/USD, AUD/USD, USD/JPY, USD/CAD, gold (COMEX front-month
future) and bitcoin (BTC/USD, 1 lot = 1 BTC, traded 24/7 so weekends count in its backtests)
from Yahoo Finance's public chart endpoint: about two years of history (the last 8,000
bars are used) and new candles polled every `POLL_MS`. The feed has no bid/ask, so backtests
charge typical retail spreads. It is unofficial and free, so Yahoo can change or rate-limit it;
for a contractual feed use OANDA below.

## Optional: prices from OANDA

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

## What is still not real

- **Live** trading sends no orders: there is no broker adapter. "Live" strategies keep running
  on the OANDA price feed.
- **Video research** reads titles and descriptions only; the YouTube Data API does not provide
  transcripts.

Nothing here is financial advice.

## License

Personal use only — see [LICENSE](LICENSE). No redistribution or resale.
