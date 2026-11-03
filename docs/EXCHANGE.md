# Live trading on a crypto exchange

OS AI can buy and sell meme coins on your own exchange account. It uses the open-source
[ccxt](https://github.com/ccxt/ccxt) library, so it works with Binance, Kraken, Coinbase, Bybit,
OKX, KuCoin, Gate and many more. Only strategies **you** approve to Live trade, and only while
you have pressed **Arm** on the dashboard.

## How it trades

- **Spot only, buys only.** A long signal buys `TRADE_USD` worth of the coin with a market order;
  the strategy's close sells the same coins. Spot accounts cannot sell what they do not own, so
  short signals are skipped (and meme coins are backtested and paper-traded long-only to match).
- **Stops and targets** come from the strategy, applied to the real fill price, and are checked
  on the exchange's own price every 30 seconds (not just once an hour).
- **Some trades will lose.** Every buy has a stop so each loss stays small; that is what the limits
  below are for. No setting makes a strategy win every trade.

## Limits (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `TRADE_USD` | `20` | Spent on each buy, in the quote coin |
| `MAX_TRADE_USD` | `100` | Hard cap on `TRADE_USD` |
| `MAX_OPEN_TRADES` | `3` | Coins OS AI may hold at once |
| `MAX_DAILY_LOSS` | `50` | Realised plus open loss for the day; when reached, OS AI sells everything it bought and disarms |

Also: arming needs `DASHBOARD_PASSWORD`; a restart always disarms (coins already held keep their
stops watched); the **Kill switch** on *Paper & live*, or "kill switch" by voice, sells every coin
OS AI bought and disarms.

## Setup

1. **Create an API key** on your exchange with **trading permission only**. Never enable
   withdrawals. If the exchange allows it, restrict the key to your server's IP address.
2. **Add environment variables** on the server (Hostinger: hPanel → Websites →
   app.ostradingai.com → Node.js → Environment variables). Never paste keys into a chat, an email
   or the code.

   | Variable | Example |
   |---|---|
   | `EXCHANGE` | `binance`, `kraken`, `coinbase`, `bybit`, `okx`, … |
   | `EXCHANGE_API_KEY` | from the exchange |
   | `EXCHANGE_SECRET` | from the exchange |
   | `EXCHANGE_PASSPHRASE` | only OKX, KuCoin and Coinbase Exchange need it |
   | `EXCHANGE_QUOTE` | `USDT` on most exchanges, `USD` on Kraken and Coinbase |
   | `EXCHANGE_SANDBOX` | `1` = the exchange's test network with play money |
   | `DASHBOARD_PASSWORD` | required before you can arm |

3. **Test first.** With `EXCHANGE_SANDBOX=1` (supported by Binance, Bybit, OKX and others; it
   needs a test-network API key from that exchange), approve a strategy to Live, press **Arm**, and
   watch *Paper & live*: buys, sells, stops and the kill switch. Then remove `EXCHANGE_SANDBOX` to
   trade real money.
4. **Check your coins are listed.** The market traded is the coin plus `EXCHANGE_QUOTE`, e.g.
   `DOGE/USDT`. If your exchange does not list one, its orders are rejected and shown on the
   dashboard; nothing else is affected.

## Notes

- Paper trading sizes positions differently (a fixed lot per coin), so paper and live profits in
  dollars differ; compare win rates and direction, not amounts.
- If the server restarts while an order is being sent, that order shows as **unknown**: check it
  on the exchange.
- OS AI only manages coins it bought. It never touches the rest of your balance.
