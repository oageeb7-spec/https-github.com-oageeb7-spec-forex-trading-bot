# OS Trading AI

An agentic forex research and trading system with a live dashboard. A team of agents finds
strategy ideas, turns them into testable recipes, backtests variants, filters them through a
robustness sieve, and paper-trades the ones **you** approve.

```bash
npm install
cp .env.example .env   # then put your OANDA (and optionally Anthropic) keys in .env
npm start              # http://localhost:3000
npm run demo    # fully simulated: generated prices and research, no keys needed
npm test
```

By default everything is real: prices come from OANDA and the agents research real sources.
The server refuses to start without `OANDA_API_KEY` rather than inventing prices.

| Env var   | Default | Meaning                                                        |
|-----------|---------|----------------------------------------------------------------|
| `OANDA_API_KEY` | — | OANDA v20 API token (required unless `DATA_SOURCE=synthetic`) |
| `OANDA_ENV` | `practice` | `practice` (demo account) or `live` |
| `OANDA_POLL_MS` | `30000` | How often to check OANDA for newly closed candles |
| `ANTHROPIC_API_KEY` | — | Lets Claude analyze sources; without it a free keyword classifier is used |
| `ANALYST_MODEL` | `claude-opus-5-5` | Claude model for the summarizer agents |
| `ANALYST_EFFORT` | `low` | Claude effort level (`low` … `max`) |
| `GITHUB_TOKEN` | — | Optional; raises GitHub's search rate limit |
| `YOUTUBE_API_KEY` | — | Optional; adds YouTube (video titles and descriptions) as a source |
| `RESEARCH_SCOUT_MS` | `45000` | Pause between the scout's searches |
| `DATA_SOURCE` | `oanda` | `synthetic` for generated prices |
| `RESEARCH` | `live` | `simulated` for generated research |
| `BUDGET`  | `50`    | Thinking budget in USD (real Claude spend in live mode); research pauses at the limit |
| `PORT`    | `3000`  | HTTP port |
| `TICK_MS` | `1500`  | One brain round every N ms |
| `WARMUP`, `DEMO` | on in `npm run demo` only | Pre-run rounds and auto-approval of the first two paper proposals |

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

## What is still not real

- **Live** trading sends no orders: there is no broker adapter. "Live" strategies keep running
  on the OANDA price feed.
- **Video research** reads titles and descriptions only; the YouTube Data API does not provide
  transcripts.

Nothing here is financial advice.

## License

Personal use only — see [LICENSE](LICENSE). No redistribution or resale.
