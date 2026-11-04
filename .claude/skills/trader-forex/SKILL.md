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
  ATR in pips. Nothing is placed. Use when the user says "forex", "FX",
  "EUR/USD", "cable", "how many lots", "pip value", "is forex open", "which
  session", "scan the majors", or names a currency pair.
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
