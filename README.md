# JARVIS — trading assistant

JARVIS is a terminal assistant that answers trading questions in plain English by running the
trader skills in `.claude/skills/` (scanner, news, entry, exit, time machine, budget, risk,
broker tickets, alerts, earnings, Congress trades) **and forex**. Claude picks the skill, runs it and
summarises the output.

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...     # or: ant auth login
python jarvis.py                         # chat
python jarvis.py "is the market open?"  # one question
```

Examples: "is the market open?", "scan TSLA, NVDA and AMD for setups", "any news on my
watchlist?", "how did Apple's last quarter look?", "what has Pelosi filed lately?".

## Voice

```bash
pip install -r requirements-voice.txt   # macOS: brew install portaudio first; Linux: apt install portaudio19-dev espeak-ng
python jarvis.py --voice
```

Press Enter on an empty line to talk; JARVIS speaks a short version of each answer.
`/voice on` / `/voice off` toggle it. Speech recognition uses Google's free web recognizer.
Orders are never confirmed by voice: `/fxsend` always needs a typed yes.

## Forex

JARVIS trades currency pairs too, through the `trader-forex` skill
(`.claude/skills/trader-forex/fx.py`, also usable as `/trader-forex` in Claude Code):

- **Clock:** is FX open (Sunday 17:00 to Friday 17:00 New York), which of Sydney, Tokyo,
  London and New York are live, and the London/New York overlap.
- **Quotes:** any pair (EURUSD, GBP/JPY, "cable", "the yen"…), change in pips. Yahoo, Stooq fallback.
- **Pip math:** pips between two prices and pip value per standard/mini/micro lot in your
  account currency (JPY pairs and crosses handled).
- **Plans:** long *or short*, stop and target as prices, pips or R; warns on tight stops and low reward:risk.
- **Lot sizing:** from your account size and risk %, capped by leverage (default 30:1) and max lots.
- **Scanner:** majors and crosses for trend, 20-day breakouts, RSI and ATR in pips.
- **Setup finder:** "analyze gold", "give me a signal on EURUSD", "analyze cable on 4h".
  Reads market structure, breaks of structure, liquidity sweeps, premium/discount and
  fair-value gaps / order blocks, then gives one decision: buy or sell with entry, stop,
  TP1, TP2, reward:risk and the reasons, or **No Trade** when reward:risk is under 2.
  "Track my setup" follows it (pending, open, TP1 hit, target hit, stopped). Rules-based
  and not backtested, so there is no known win rate.

- **Gold and silver:** XAUUSD / XAGUSD ("price of gold", "buy gold at 2650 stop 2635").
- **STARTRADER (MetaTrader 5):** read your account and positions ("my STARTRADER account"),
  and send a planned order with `/fxsend`: risk-checked against your real balance and the
  broker's live price, then sent only after you type yes, with stop-loss and take-profit
  attached. Needs **Windows** with the STARTRADER MT5 terminal installed and logged in
  (`pip install -r requirements.txt` installs the `MetaTrader5` package there). Real-money
  accounts are blocked unless `MT5_ALLOW_LIVE=1`; start on a demo account.
  Works with any MT5 broker. Use OANDA instead with `JARVIS_FX_BROKER=oanda`
  (`OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID`).

Try: "is forex open?", "price of EURUSD and cable", "scan the forex majors",
"plan EURUSD buy at 1.0850 stop 1.0820 target 2R", "short GBPJPY stop 40 pips target 80 pips",
"how many lots, 1% risk", "set forex account to 25000", "set leverage to 50".
Forex rules live in the `forex` section of `trader/config.json`. Spread, swap and slippage are
not included in the numbers, and nothing is ever placed.

## Charts

`charts.py` draws a candlestick chart with your own trade plan on it. It fetches the
same free Yahoo bars the other tools use and overlays whatever the bot already worked
out: entry / stop / target and the opening range from `trader/plan.json`, plus the
scanner's setup label from `trader/watchlist.json`. It also draws a moving average
(MA20 by default), a volume panel and the last price.

The output is one self-contained `.html` file — open it in any browser. The chart is
drawn by a small inline renderer with no external library, so it works fully offline.
Standard library only, no pip install, no API key.

```bash
python3 charts.py TSLA                      # 5 days of 15-minute bars
python3 charts.py EURUSD=X --range 1mo --interval 1h
python3 charts.py NVDA --interval 5m --ma 50 --out trader/nvda.html
python3 charts.py --plan                    # chart the symbol in trader/plan.json
python3 charts.py --setup                   # chart the forex setup: entry, SL, TP1, TP2, zone
python3 charts.py TSLA --offline TSLA.json  # read a saved Yahoo chart JSON
```

The levels are your plan drawn on the price — a view, not a signal. The bars are free,
delayed and unofficial, so don't trade off this chart alone.

**No API key? It still works.** Without a key JARVIS uses a built-in rule-based brain that
understands the common requests: market clock, quotes, news, scans, opening-range
breakouts, entries, trade plans ("plan TSLA entry 364.20 stop 358 target 380"), the time
machine, position sizing, risk checks, tickets, alerts, earnings and Congress trades. With a key
(`ANTHROPIC_API_KEY`) Claude handles free-form conversation instead. Switch with `/local` or
`/claude`. `/run <tool> <args>` runs any skill script directly. Type `/help` for examples.

On first run JARVIS creates `trader/config.json` with starter rules ($5,000 budget, $50 max
loss a trade, paper trading). Say "show my rules", or "set budget to 10000" / "set max loss to 100".
Set `sec_user_agent` in that file to your name and email for the SEC (news, earnings).

**Safety:** for **stocks**, JARVIS never places, approves or records orders — it only
*shows* tickets; sending stays a manual step through `/trader-broker` in Claude Code.
The one exception is **forex `/fxsend`**: it risk-checks the order against your real
balance and the broker's live price, then sends it to MT5/OANDA after you type `yes`.
Real-money forex is blocked unless `MT5_ALLOW_LIVE=1`, so you stay on a demo account
until you deliberately turn that off. Data is free, delayed and unofficial. This is not
financial advice.

Settings (env vars): `JARVIS_OFFLINE=1` forces the built-in brain; `JARVIS_MODEL` (default `claude-opus-5-5`), `JARVIS_EFFORT`
(default `medium`), `JARVIS_TOOL_TIMEOUT` seconds (default 300).
Working files go in `trader/` (git-ignored).
