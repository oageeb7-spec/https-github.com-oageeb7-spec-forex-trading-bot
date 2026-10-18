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

   **These checks cannot catch every scam.** They do not see who holds the coin, whether the
   contract can block sells or mint more, or whether the creators can pull the liquidity.
4. **Paper trades** (long only, since a swap buys the coin): buy $100 when a safe coin closes above
   its last hour's high with more buyers than sellers in the past hour; sell at -8% (stop), +16%
   (target) or after 4 hours. Each trade is charged 1% for pool fees and slippage. At most 5 open.

Settings: `DEX_CHAIN` (default `robinhood`; `off` to disable), `DEX_PAPER_USD`, `DEX_MAX_OPEN`.

## Real trading on Robinhood Chain (not built)

Real swaps would need a crypto wallet whose **private key sits on the server**, gas (ETH on
Robinhood Chain, chain ID 4663) and a swap route (Uniswap runs on the chain). Before building it:

- Let the paper desk run long enough to judge it honestly; many paper trades will lose.
- Use a **new, separate wallet** holding only what you can afford to lose completely. Anyone who
  breaks into the server can empty it.
- Accept that a coin that passes every check can still be impossible to sell, or be drained by its
  creators.
