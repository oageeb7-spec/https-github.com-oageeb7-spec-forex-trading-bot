# Live trading on MT4 / MT5

OS AI places real orders through a small Expert Advisor (EA) that runs in your MetaTrader
terminal. Every few seconds the EA asks OS AI for new orders, executes them on your account, and
reports fills, open positions, balance and equity back to the dashboard.

> **Real money.** Run this on a **demo account** for at least a few weeks first. Past and paper
> results do not guarantee future results. Nothing here is financial advice.

## What gets traded

Only strategies that went the whole way: lab → sieve → you approved paper → 21 paper days →
you approved **Live**. When such a strategy opens or closes on the live price feed, OS AI sends the
same open or close to MetaTrader, with the strategy's stop-loss and take-profit.

## Safety limits

| Limit | Default | Setting |
|---|---|---|
| Live trading is off until you press **Arm** on the dashboard | off | — |
| Arming needs a dashboard password | required | `DASHBOARD_PASSWORD` |
| Lot size per trade | 0.01 | `LIVE_LOTS` (capped by `MAX_LOTS`, default 0.1) |
| Open OS AI trades at once | 3 | `MAX_OPEN_TRADES` |
| Daily loss that disarms and closes everything | 100 (account currency) | `MAX_DAILY_LOSS` |
| Lot cap inside the EA, whatever the server sends | 0.10 | EA input `MaxLotsPerTrade` |
| Orders the EA doesn't collect within 2 minutes expire | — | — |
| A server restart always disarms | — | — |
| Voice can't arm or approve live strategies | — | — |

The **Kill switch** (dashboard, or say "kill switch" and confirm) disarms and closes every OS AI
position. Closing orders still go through when disarmed, so nothing is left open by accident.

## Setup

1. **Server settings** (hPanel → app.ostradingai.com → Node.js → Environment variables, or `.env`):
   - `DASHBOARD_PASSWORD`: a strong password.
   - `BRIDGE_TOKEN`: a long random string (40+ characters). The EA uses it to log in.
   - Optionally `LIVE_LOTS`, `MAX_LOTS`, `MAX_OPEN_TRADES`, `MAX_DAILY_LOSS`.
2. **Allow the EA to reach OS AI:** in MetaTrader, *Tools → Options → Expert Advisors* → tick
   *Allow WebRequest for listed URL* → add `https://app.ostradingai.com`.
3. **Install the EA:** *File → Open Data Folder* → `MQL5/Experts` (MT5) or `MQL4/Experts` (MT4) →
   copy `mt/OSAI_Bridge.mq5` or `mt/OSAI_Bridge.mq4` there → open it in MetaEditor → **Compile**.
4. **Attach it** to any one chart (one chart only). Inputs:
   - `Token`: the same value as `BRIDGE_TOKEN`.
   - `SymbolSuffix`: if your broker names pairs like `EURUSD.m`, enter `.m`.
   - `GoldSymbol` / `BitcoinSymbol`: your broker's names for gold and bitcoin.
   Turn on **Algo Trading** (MT5) / **AutoTrading** (MT4).
5. On the dashboard, open **Paper & live**: it should say **EA connected** and show your account.
   Press **Arm live trading** when you are ready.

Use a **hedging** account on MT5 (each OS AI trade stays a separate position). Your terminal has to
stay open, so run it on a computer or Windows VPS that stays on.

The EAs have not yet been compiled or run against a broker by the author; compile them in
MetaEditor and watch the first trades on a demo account.
