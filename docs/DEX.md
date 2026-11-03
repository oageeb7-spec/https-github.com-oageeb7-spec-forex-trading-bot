# DEX desk: Robinhood Chain meme coins

OS AI watches the meme coins on [Robinhood Chain on DexScreener](https://dexscreener.com/robinhood)
and paper-trades them. It uses DexScreener's free public API (no key).

## What it does

1. **Finds coins** every 10 minutes: DexScreener searches plus its newest and boosted token
   listings, kept to the chosen chain. The 30 most active coins are tracked (most liquid pool each).
2. **Reads prices** every minute and builds its own 5-minute candles (DexScreener's API has no candle
   history, so the desk needs about 2 hours per coin before it can trade it).
3. **Safety filter.** A coin is skipped if any of these is true (all adjustable):

   | Check | Default | Why |
   |---|---|---|
   | Liquidity below | $25,000 (`DEX_MIN_LIQUIDITY`) | thin pools move wildly and can be drained |
   | 24h volume below | $25,000 (`DEX_MIN_VOLUME`) | nobody trading it |
   | Pool younger than | 6 hours (`DEX_MIN_AGE_HOURS`) | most rug pulls happen in the first hours |
   | Sells in 24h below | 20 | if nobody sells, it may not be sellable (honeypot) |
   | Valuation over | 200× liquidity | easy to crash |
   | Moved more than | 60% in the last hour | too late to buy, or collapsing |
   | Up more than | 300% in 24 hours | a pump to sell into, not to buy |
   | Named like ETH, BTC or a stablecoin | always | not a meme coin; on a new chain usually a copy |

   **These checks cannot catch every scam.** They do not see who holds the coin, whether the
   contract can block sells or mint more, or whether the creators can pull the liquidity.
4. **Paper trades** (long only, since a swap buys the coin): buy when a safe coin closes above its
   last hour's high with at least 1.2 buyers per seller in the past hour.
   - **Stop** at 3× the coin's average 5-minute swing, between 8% and 25%; coins that would need a
     wider stop are skipped. **Target** at twice the stop. **Time exit** after 4 hours.
   - **Size** up to `DEX_PAPER_USD` ($100), smaller when the stop is wider, so every stop-out costs
     about the same (~$8).
   - **Cooldowns:** after a stop a coin rests 2 hours; after 3 losses in a row, 24 hours.
   - Each trade is charged 1% for pool fees and slippage. At most 5 open.

   *Why these rules (October 2026):* a week of paper trading with fixed 8% stops lost $219 over 135
   trades (32% won). Most stops were hit within minutes by ordinary swings, a fake "ETH" passed the
   filter, and losing coins were bought again at once. The dashboard shows results under the current
   rules separately from all-time results so the change can be judged honestly.

Settings: `DEX_CHAIN` (default `robinhood`; `off` to disable), `DEX_PAPER_USD`, `DEX_MAX_OPEN`.

## Real trading on Robinhood Chain (not built)

Real swaps would need a crypto wallet whose **private key sits on the server**, gas (ETH on
Robinhood Chain, chain ID 4663) and a swap route (Uniswap runs on the chain). Before building it:

- Let the paper desk run long enough to judge it honestly; many paper trades will lose.
- Use a **new, separate wallet** holding only what you can afford to lose completely. Anyone who
  breaks into the server can empty it.
- Accept that a coin that passes every check can still be impossible to sell, or be drained by its
  creators.
