---
name: trader-forex
description: >-
  Forex desk. Tells you whether the FX market is open and which sessions are
  live (Sydney, Tokyo, London, New York, and the London/New York overlap),
  fetches free delayed rates for any currency pair (Yahoo EURUSD=X, Stooq
  fallback) with the change in pips, does the pip math (JPY pairs included,
  pip value per standard/mini/micro lot in your account currency, crosses
  converted), plans a long or short trade with the stop and target in pips
  or R, sizes it in lots from your account and risk percent with a leverage
  cap, and scans the majors and crosses for trend, 20-day breakouts, RSI and
  ATR in pips. Finds intraday setups (setup.py): reads market structure,
  breaks of structure, liquidity sweeps, premium/discount and fair-value
  gaps / order blocks on 15m/1h/4h/1d, and returns one decision - buy or sell
  with entry, stop, TP1, TP2, reward:risk and the reasons - or No Trade, then
  tracks it. Gold (XAUUSD), silver (XAGUSD) and Bitcoin (BTCUSD) too. Connects to STARTRADER
  (or any MetaTrader 5 broker) through the MT5 terminal, or to OANDA, to read
  the balance and positions and, only after a risk check and the user's own
  typed yes, send one order with stop-loss and take-profit. Use when the user says "forex", "FX",
  "EUR/USD", "cable", "how many lots", "pip value", "is forex open", "which
  session", "scan the majors", "gold", "analyze gold", "give me a signal on
  EURUSD", "is there a setup", "smart money", "liquidity", "track my setup",
  "bitcoin", "BTC", "STARTRADER", "MT5", "MetaTrader", "OANDA", "send my forex order", or names a currency pair.
argument-hint: "[pair] [price]"
---

# trader-forex

`${CLAUDE_SKILL_DIR}` is this skill's folder. Run from the repo root.

```bash
python3 "${CLAUDE_SKILL_DIR}/fx.py" clock                         # open? which sessions?
python3 "${CLAUDE_SKILL_DIR}/fx.py" quote EURUSD GBP/JPY USDJPY     # rates, change in pips
python3 "${CLAUDE_SKILL_DIR}/fx.py" pips EURUSD 1.0850 1.0820       # pips + pip value per lot
python3 "${CLAUDE_SKILL_DIR}/fx.py" plan EURUSD --side buy --entry 1.0850 --stop 1.0820 --target 2R --write
python3 "${CLAUDE_SKILL_DIR}/fx.py" plan GBPJPY --side sell --stop pips:40 --target pips:80 --write
python3 "${CLAUDE_SKILL_DIR}/fx.py" size --account 10000 --risk-pct 1 --write
python3 "${CLAUDE_SKILL_DIR}/fx.py" scan                            # majors + main crosses
python3 "${CLAUDE_SKILL_DIR}/fx.py" scan EURUSD,GBPUSD,AUDUSD
python3 "${CLAUDE_SKILL_DIR}/setup.py" analyze EURUSD --write --write-plan     # 15m setup or No Trade
python3 "${CLAUDE_SKILL_DIR}/setup.py" analyze gold --tf 1h --write --write-plan
python3 "${CLAUDE_SKILL_DIR}/setup.py" track                                   # pending/open/TP1/target/stopped
python3 charts.py --setup                                                      # chart it: entry, SL, TP1, TP2, zone
```

Files: `trader/fx_plan.json` (plan), `trader/fx_orders.json` (proposed order),
`trader/fx_scan.json`, `trader/fx_rates.json`, `trader/fx_setup.json` (setup).
`fx.py` commands take `--offline DIR` (files named `yahoo-EURUSD.json` or
`stooq-EURUSD.csv`); `setup.py` takes `--offline FILE` (one saved Yahoo chart JSON).

## Bitcoin (BTCUSD)

`BTCUSD` (or `bitcoin`, `BTC`), USD-quoted only, from Yahoo `BTC-USD`. Broker
convention: 1 lot = 1 BTC and 1 pip = $1, so pip value is $1 a lot and sizes
come out in fractions of a coin (0.44 lots = 0.44 BTC). Crypto trades 24/7: there
is no weekend close and the FX session clock does not apply. The setup finder's
minimum stop on BTC is 0.1% of the price, since a fixed pip count means nothing at
$80,000. Check your broker's contract size and leverage for crypto; many cap it far
below forex.

## Setup finder (setup.py)

One decision per run, from the bars alone - nothing is guessed:

1. **Swings** - a bar whose high (low) beats `--swing` bars each side (default 3).
2. **Structure** - higher highs + higher lows is bullish, lower highs + lower lows bearish.
3. **Break of structure** - the latest close beyond a prior swing high or low.
4. **Liquidity sweep** - in the last 30 bars, a wick through a swing low (high) that closed back inside.
5. **Premium / discount** - where price sits in the last swing range; buys want under 50%, sells over.
6. **Entry zone** - the latest unfilled fair-value gap in the trade's direction, else the
   order block before the break. Entry is the middle of the zone (a limit), or the
   current price if price is already inside it (market). A zone price has already
   run through is a failed zone: No Trade.
7. **Stop** - beyond the zone and the protecting swing, plus 0.1 ATR; at least 5 pips
   (20 on gold, i.e. $2).
8. **Targets** - TP1 is the first swing beyond the entry (resting liquidity), TP2 the next,
   else the range extreme.
9. **Decision** - each signal scores (structure 2, break 2, sweep 1, premium/discount 1). A
   side needs 4+ and a lead of 2, and reward:risk to the final target must reach
   `--min-rr` (config `min_setup_rr`, default 2). Otherwise **No Trade**, with the reason.

`--write-plan` writes `trader/fx_plan.json` (target = TP2, `tp1` kept) so `fx.py size`
and the MT5/OANDA check read it unchanged. `track` walks the bars after the setup:
a limit entry is `pending` until touched, `missed` if price reaches TP1 first; once
filled it is `open`, `TP1 hit`, `target hit` or `stopped` (a bar that touches both the
stop and a target counts as stopped). Gold uses Yahoo's GC=F future, a few dollars
off spot - check levels against your broker's chart. Tests:
`python3 -m unittest discover -s .claude/skills/trader-forex/tests` (real EURUSD and gold fixtures).

## Gold and silver

`XAUUSD` (or `gold`) and `XAGUSD` (`silver`). A lot is 100 oz of gold (pip
0.1, so $10 a pip a lot) or 5,000 oz of silver (pip 0.01, $50 a pip a lot).
Prices come from Stooq spot; if Stooq fails, Yahoo's front-month futures
(GC=F, SI=F) are used and marked "futures, not spot". Many regulators cap
gold leverage at 20:1, lower than currencies; set `max_leverage` to match.

## STARTRADER / MetaTrader 5 (sending orders)

STARTRADER (startrader.com, regulated by CMA, FSCA, FSA and FSC) trades through
MetaTrader 5. Not to be confused with straderfx.com ("Strader Markets Group"), an
unrelated company. `mt5.py` uses MetaQuotes' official `MetaTrader5` package, which
only runs on **Windows** next to an installed, logged-in MT5 terminal.

```bash
pip install MetaTrader5
# optional - otherwise the account the MT5 terminal is logged in to is used:
set MT5_LOGIN=88001234 & set MT5_PASSWORD=... & set MT5_SERVER=<server name from MT5's login box>
python3 "${CLAUDE_SKILL_DIR}/mt5.py" account          # balance, equity, margin, leverage
python3 "${CLAUDE_SKILL_DIR}/mt5.py" positions
python3 "${CLAUDE_SKILL_DIR}/mt5.py" symbol EURUSD    # broker's name (EURUSD+, GOLD, ...) and contract
python3 "${CLAUDE_SKILL_DIR}/mt5.py" check            # risk check with live price + broker contract size
python3 "${CLAUDE_SKILL_DIR}/mt5.py" preview          # the exact MT5 order request, nothing sent
python3 "${CLAUDE_SKILL_DIR}/mt5.py" send --index 1 --confirm "yes"   # only on the user's own yes
```

`check` and `send` recompute the loss at the stop with the broker's own tick
value and the live bid/ask, test it against `risk_pct` of the **real account
balance**, block a price already past the stop or target, and run MT5's own
`order_check`. A REAL account (not demo) also needs `MT5_ALLOW_LIVE=1`. Start on a
STARTRADER demo account. Every attempt is logged in `trader/state/fx_broker.json`.

## OANDA (alternative)

```bash
export OANDA_API_TOKEN=...          # oanda.com -> Manage API Access (never paste into chat)
export OANDA_ACCOUNT_ID=101-001-1234567-001
export OANDA_ENV=practice           # default; demo money
python3 "${CLAUDE_SKILL_DIR}/oanda.py" account        # balance, margin (read only)
python3 "${CLAUDE_SKILL_DIR}/oanda.py" positions      # read only
python3 "${CLAUDE_SKILL_DIR}/oanda.py" check          # risk check trader/fx_orders.json #1
python3 "${CLAUDE_SKILL_DIR}/oanda.py" preview        # exact order JSON, nothing sent
python3 "${CLAUDE_SKILL_DIR}/oanda.py" send --index 1 --confirm "yes"   # only on the user's own yes
```

`send` refuses unless: the confirmation is an explicit yes (not "no", "wait",
"maybe"); the risk check passes (stop and target attached, loss at the stop
within `risk_pct` of `account_size` and `max_loss_per_trade`, reward:risk at
least `min_reward_risk`, lots within `max_lots`, market open, not a
duplicate); and, for `OANDA_ENV=live`, `OANDA_ALLOW_LIVE=1` is also set. Every
attempt is logged in `trader/state/fx_broker.json`. As Claude, never run `send`
without the user typing yes for that exact order in this conversation.

## Rules (the `forex` section of trader/config.json)

| key | default | meaning |
|---|---|---|
| `account_size` | 10000 | account balance |
| `account_currency` | USD | pip values and losses are shown in this |
| `risk_pct` | 1.0 | percent of the account lost if the stop hits |
| `max_loss_per_trade` | null | optional hard cap in account currency |
| `max_leverage` | 30 | notional / account cap (30:1 is the EU/UK retail limit on majors; US is 50:1) |
| `min_reward_risk` | 1.5 | plan warns under this |
| `min_setup_rr` | 2.0 | setup.py returns No Trade under this |
| `min_lot_step` | 0.01 | micro lots |
| `max_lots` | 10 | hard cap |

## Pip math

- A pip is 0.0001, or 0.01 when JPY is the quote currency.
- Pip value per standard lot (100,000 units) = 100,000 × pip, in the quote
  currency, converted to the account currency (USD quote: $10; USD base:
  $10 / rate; crosses use the live quote→account rate).
- Lots = max loss / (stop in pips × pip value per lot), rounded down to 0.01,
  then capped by leverage and `max_lots`.

## Honest limits

Rates are indicative delayed mids, not dealable quotes. Spread, swap
(overnight financing) and slippage are not in the numbers. Weekends gap.
Leverage magnifies losses as much as gains. A setup is a rules-based reading
of past bars, not a prediction. These rules have not been backtested, so there
is no known win rate - treat setups as a starting point for your own judgement.
No Trade is a normal answer. Education and tooling, not financial advice. fx.py and
setup.py never place an order; mt5.py/oanda.py send one only after the risk
check and your own typed yes.
