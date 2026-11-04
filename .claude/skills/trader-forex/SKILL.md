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
  ATR in pips. Gold (XAUUSD) and silver (XAGUSD) too. Connects to STARTRADER
  (or any MetaTrader 5 broker) through the MT5 terminal, or to OANDA, to read
  the balance and positions and, only after a risk check and the user's own
  typed yes, send one order with stop-loss and take-profit. Use when the user says "forex", "FX",
  "EUR/USD", "cable", "how many lots", "pip value", "is forex open", "which
  session", "scan the majors", "gold", "STARTRADER", "MT5", "MetaTrader", "OANDA", "send my forex order", or names a currency pair.
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
```

Files: `trader/fx_plan.json` (plan), `trader/fx_orders.json` (proposed order),
`trader/fx_scan.json`, `trader/fx_rates.json`. Every command takes
`--offline DIR` (files named `yahoo-EURUSD.json` or `stooq-EURUSD.csv`).

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
Leverage magnifies losses as much as gains. Education and tooling, not
financial advice. This skill never places an order.
