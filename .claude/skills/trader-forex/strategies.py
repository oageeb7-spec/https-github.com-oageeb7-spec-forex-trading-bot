#!/usr/bin/env python3
"""Bot strategies for trader-forex: GRID, DCA and RSI, ported from OpenTrader. Standard library only.

  grid PAIR --low 1.0700 --high 1.0900 --levels 10 [--lots 0.01]   grid levels around the price now
  grid PAIR --auto [--levels 10]                                    grid from the 20-day low/high
  dca  PAIR [--side buy] [--entry X] --lots 0.01 --tp-pct 0.5 [--sl-pct 3]
            [--safety 0.3:0.01,0.6:0.02]                            ladder: average price and TP per fill
  rsi  PAIR [--periods 14 --low 30 --high 70 --persistence 1]       RSI now and the strategy's signal
  backtest {grid,dca,rsi} PAIR [same options] [--range 1y] [--interval 1d|1h]
                                                                    paper replay on past bars

Ported from OpenTrader's bot templates (github.com/Open-Trader/opentrader, Apache-2.0):
  GRID  packages/bot-templates/src/templates/grid.ts + grid-bot.ts
        Equal steps between low and high. Each line except the top one is a buy at that line
        with a take-profit at the next line up. Lines above the price when the bot starts are
        bought straight away (at the start price), lines below wait for the price to come down.
        A completed level is re-armed (buy again at the same line).
  DCA   packages/bot-templates/src/templates/dca.ts
        Entry order, then safety orders at -X% from the entry; the take-profit is +Y% from the
        average price and moves after each safety fill; an optional stop-loss at -Z% from the
        entry (it must sit beyond the deepest safety order). When a trade closes, a new one opens.
        Mirrored for --side sell.
  RSI   packages/bot-templates/src/templates/rsi.ts (after Gekko's RSI strategy)
        RSI above `high` for `persistence` candles in a row = sell once; below `low` = buy once.
        Forex modes: `long` (default, like OpenTrader on spot: buy on low, close on high) or
        `both` (always in the market: long on low, short on high).

Data: free delayed daily bars from fx.py (Yahoo, Stooq fallback); --interval 1h reads Yahoo hourly
bars (up to two years). Backtests fill at exact levels, ignore spread, swap, commission and slippage,
and when one bar touches both the stop and the target they assume the stop. Nothing here places an
order: these are paper numbers.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fx  # noqa: E402  (same folder)
from fx import FxError, fmt, norm_pair, pip_size  # noqa: E402


# ------------------------------------------------------------------ data

def fetch_bars(pair: str, rng: str, interval: str, offline: str | None) -> list[dict]:
    if interval == "1d":
        return fx.get_pair(pair, offline, rng)["bars"]
    if offline:
        path = os.path.join(offline, f"yahoo-{pair}-{interval}.json")
        if not os.path.exists(path):
            raise FxError(f"offline file missing: {path}")
        text = open(path).read()
    else:
        if fx.is_crypto(pair):
            sym = fx.CRYPTO[pair[:3]][3]
        elif fx.is_metal(pair) and pair[3:] == "USD":
            sym = fx.METALS[pair[:3]][3]
        else:
            sym = f"{pair}=X"
        last = None
        for host in ("query2.finance.yahoo.com", "query1.finance.yahoo.com"):
            try:
                text = fx._get(f"https://{host}/v8/finance/chart/{sym}?range={rng}&interval={interval}")
                break
            except FxError as e:
                last = e
        else:
            raise last
    res = (json.loads(text).get("chart") or {}).get("result")
    if not res:
        raise FxError(f"Yahoo has no {interval} data for {pair}")
    r = res[0]
    q = r["indicators"]["quote"][0]
    bars = []
    for i, ts in enumerate(r.get("timestamp") or []):
        o, h, l, c = (q[k][i] for k in ("open", "high", "low", "close"))
        if None not in (o, h, l, c):
            bars.append({"date": datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M"),
                         "open": o, "high": h, "low": l, "close": c})
    if not bars:
        raise FxError(f"Yahoo has no {interval} data for {pair}")
    return bars


def money_per_pip(pair: str, lots: float, cfg: dict, price: float, offline: str | None) -> tuple[float, str]:
    acct = cfg["account_currency"].upper()
    try:
        return fx.pip_value_per_lot(pair, acct, price, offline) * lots, acct
    except FxError:
        quote = pair[3:]
        return fx.contract(pair) * pip_size(pair) * lots, quote


def pips(pair: str, d: float) -> float:
    return d / pip_size(pair)


# ------------------------------------------------------------------ GRID

def grid_lines(low: float, high: float, levels: int) -> list[float]:
    """OpenTrader calcGridLines: `levels` lines from low, equal step (high-low)/(levels-1)."""
    if levels < 2:
        raise FxError("a grid needs at least 2 lines")
    if high <= low:
        raise FxError("--high must be above --low")
    step = (high - low) / (levels - 1)
    return [low + step * i for i in range(levels)]


def is_waiting_line(lines: list[float], i: int, price: float) -> bool:
    """OpenTrader isWaitingGridLine: the line nearest the price (ties go to the line above)."""
    def dist(x):  # rounded: OpenTrader compares with exact decimals (big.js)
        return round(abs(price - x), 10)
    d = dist(lines[i])
    if i > 0 and dist(lines[i - 1]) < d:
        return False
    if i + 1 < len(lines) and dist(lines[i + 1]) <= d:
        return False
    return True


def grid_levels(lines: list[float], price: float) -> list[dict]:
    """OpenTrader computeGridLevelsFromCurrentAssetPrice: buy at line i, take profit at line i+1.
    Levels whose buy line is above the price, or is the line nearest the price, start bought."""
    return [{"buy": lines[i], "sell": lines[i + 1],
             "filled": lines[i] > price or is_waiting_line(lines, i, price)}
            for i in range(len(lines) - 1)]


def grid_backtest(pair: str, bars: list[dict], lines: list[float], lots: float) -> dict:
    start = bars[0]["close"]
    levels = grid_levels(lines, start)
    held = [{"open": start if lv["filled"] else None} for lv in levels]
    realized = 0.0
    rounds = 0
    max_held = sum(1 for h in held if h["open"] is not None)
    curve, peak, dd = [], 0.0, 0.0
    for b in bars[1:]:
        for lv, h in zip(levels, held):
            if h["open"] is None:
                if b["low"] <= lv["buy"] and h.get("bar") != b["date"]:
                    # fill at the line, or at the open if the bar gapped below it
                    h["open"] = min(lv["buy"], b["open"])
                    h["bar"] = b["date"]
            elif b["high"] >= lv["sell"] and h.get("bar") != b["date"]:
                realized += max(lv["sell"], b["open"]) - h["open"]
                rounds += 1
                h["open"] = None
                h["bar"] = b["date"]  # no re-buy in the same bar
        max_held = max(max_held, sum(1 for h in held if h["open"] is not None))
        unreal = sum(b["close"] - h["open"] for h in held if h["open"] is not None)
        eq = realized + unreal
        peak = max(peak, eq)
        dd = min(dd, eq - peak)
        curve.append(eq)
    last = bars[-1]["close"]
    unreal = sum(last - h["open"] for h in held if h["open"] is not None)
    return {"realized": realized, "unrealized": unreal, "rounds": rounds, "max_held": max_held,
            "open_now": sum(1 for h in held if h["open"] is not None), "max_dd": dd,
            "start": start, "last": last, "levels": len(levels)}


def resolve_grid(a, pair: str, bars: list[dict]) -> tuple[float, float]:
    if a.auto or a.low is None or a.high is None:
        prior = bars[-21:-1] if len(bars) >= 21 else bars
        low = a.low if a.low is not None else min(x["low"] for x in prior)
        high = a.high if a.high is not None else max(x["high"] for x in prior)
        return low, high
    return a.low, a.high


def cmd_grid(a, cfg) -> int:
    pair = norm_pair(a.pair)
    bars = fetch_bars(pair, "3mo", "1d", a.offline)
    price = a.price or bars[-1]["close"]
    low, high = resolve_grid(a, pair, bars)
    lines = grid_lines(low, high, a.levels)
    levels = grid_levels(lines, price)
    mpp, cur = money_per_pip(pair, a.lots, cfg, price, a.offline)
    step = lines[1] - lines[0]
    src = "20-day low/high" if a.auto or a.low is None or a.high is None else "your range"
    print(f"GRID {pair[:3]}/{pair[3:]}  price {fmt(pair, price)}  range {fmt(pair, low)} - {fmt(pair, high)} ({src})")
    print(f"{a.levels} lines, step {fmt(pair, step)} = {pips(pair, step):.1f} pips, "
          f"{a.lots} lots a level = {pips(pair, step) * mpp:,.2f} {cur} a completed level")
    print(f"{'LEVEL':>5} {'BUY':>11} {'TAKE PROFIT':>12}  STATUS")
    for i, lv in reversed(list(enumerate(levels))):
        status = "bought at start" if lv["filled"] else "buy limit, waiting"
        print(f"{i + 1:>5} {fmt(pair, lv['buy']):>11} {fmt(pair, lv['sell']):>12}  {status}")
    n_start = sum(lv["filled"] for lv in levels)
    worst = sum(pips(pair, lv["buy"] - low) for lv in levels) * mpp
    print(f"Starts with {n_start} level(s) bought; {len(levels) - n_start} buy limit(s) below.")
    print(f"If the price falls to {fmt(pair, low)} with every level bought: about -{worst:,.2f} {cur} open; "
          f"below the range the grid has no stop.")
    if price > high or price < low:
        print("Warning: the price is outside the grid range.")
    print("Long-only grid, as in OpenTrader. Spread is not included: a step smaller than a few spreads loses money.")
    return 0


# ------------------------------------------------------------------ DCA

def parse_safety(spec: str | None) -> list[tuple[float, float]]:
    out = []
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            dev, lots = part.split(":")
            out.append((float(dev), float(lots)))
        except ValueError:
            raise FxError(f"--safety wants DEVIATION%:LOTS pairs like 0.3:0.01,0.6:0.02, not {part!r}")
    out.sort()
    return out


def dca_ladder(entry: float, lots: float, side: int, tp_pct: float, sl_pct: float | None,
               safety: list[tuple[float, float]]) -> list[dict]:
    """Each row: the fill price, total lots, average price and the take-profit after that fill."""
    if sl_pct is not None and safety and sl_pct <= safety[-1][0]:
        raise FxError("the stop-loss must sit beyond the deepest safety order (OpenTrader rule)")
    rows, cost, size = [], entry * lots, lots
    rows.append({"name": "entry", "price": entry, "lots": lots, "total": size, "avg": entry,
                 "tp": entry * (1 + side * tp_pct / 100)})
    for i, (dev, sl) in enumerate(safety, 1):
        p = entry * (1 - side * dev / 100)
        cost += p * sl
        size += sl
        avg = cost / size
        rows.append({"name": f"safety {i}", "price": p, "lots": sl, "total": size, "avg": avg,
                     "tp": avg * (1 + side * tp_pct / 100)})
    return rows


def cmd_dca(a, cfg) -> int:
    pair = norm_pair(a.pair)
    side = -1 if a.side in ("sell", "short") else 1
    entry = a.entry or fetch_bars(pair, "1mo", "1d", a.offline)[-1]["close"]
    safety = parse_safety(a.safety)
    rows = dca_ladder(entry, a.lots, side, a.tp_pct, a.sl_pct, safety)
    mpp1, cur = money_per_pip(pair, 1.0, cfg, entry, a.offline)
    print(f"DCA {pair[:3]}/{pair[3:]} {'BUY' if side > 0 else 'SELL'}  entry {fmt(pair, entry)}  "
          f"TP {a.tp_pct}% in profit from the average" +
          (f"  SL {a.sl_pct}% against from the entry" if a.sl_pct else "  no stop-loss"))
    print(f"{'ORDER':9} {'PRICE':>11} {'LOTS':>6} {'TOTAL':>6} {'AVERAGE':>11} {'TAKE PROFIT':>12} {'PROFIT AT TP':>14}")
    for r in rows:
        profit = pips(pair, abs(r["tp"] - r["avg"])) * mpp1 * r["total"]
        print(f"{r['name']:9} {fmt(pair, r['price']):>11} {r['lots']:>6g} {r['total']:>6g} "
              f"{fmt(pair, r['avg']):>11} {fmt(pair, r['tp']):>12} {profit:>11,.2f} {cur}")
    if a.sl_pct:
        sl = entry * (1 - side * a.sl_pct / 100)
        last = rows[-1]
        loss = pips(pair, abs(last["avg"] - sl)) * mpp1 * last["total"]
        print(f"Stop-loss {fmt(pair, sl)}: with every order filled the loss is about {loss:,.2f} {cur}.")
    else:
        print("No stop-loss: the loss is open-ended if the price keeps going against the trade.")
    print("Each safety order adds to the position; size it for the worst case, not the first order.")
    return 0


def dca_backtest(pair: str, bars: list[dict], side: int, lots: float, tp_pct: float,
                 sl_pct: float | None, safety: list[tuple[float, float]],
                 rsi_cond: tuple[str, float] | None, periods: int) -> dict:
    trades, pos = [], None
    closes = []
    curve_peak, dd, realized = 0.0, 0.0, 0.0
    for b in bars:
        closes.append(b["close"])
        if pos is not None:
            # safety orders first, then the stop (both against us), then the take-profit
            adverse = b["low"] if side > 0 else b["high"]
            favour = b["high"] if side > 0 else b["low"]
            for so in pos["pending"][:]:
                if (adverse - so["price"]) * side <= 0:
                    fill = so["price"]
                    pos["cost"] += fill * so["lots"]
                    pos["size"] += so["lots"]
                    pos["pending"].remove(so)
                    pos["fills"] += 1
            avg = pos["cost"] / pos["size"]
            tp = avg * (1 + side * tp_pct / 100)
            exit_px = None
            if pos["sl"] is not None and (adverse - pos["sl"]) * side <= 0:
                exit_px, why = pos["sl"], "stop"
            elif pos["opened"] != b["date"] and (favour - tp) * side >= 0:
                exit_px, why = tp, "target"
            if exit_px is not None:
                pnl = (exit_px - avg) * side * pos["size"]
                realized += pnl
                trades.append({"open": pos["opened"], "close": b["date"], "why": why, "fills": pos["fills"],
                               "pnl_lot_pips": pips(pair, pnl), "avg": avg, "exit": exit_px})
                pos = None
                continue  # re-enter on the next bar (OpenTrader replaces the trade)
        if pos is None:
            if rsi_cond:
                r = fx.rsi(closes, periods)
                if r is None or (rsi_cond[0] == "below" and r >= rsi_cond[1]) or \
                        (rsi_cond[0] == "above" and r <= rsi_cond[1]):
                    continue
            e = b["close"]
            pos = {"opened": b["date"], "cost": e * lots, "size": lots, "fills": 0,
                   "sl": e * (1 - side * sl_pct / 100) if sl_pct else None,
                   "pending": [{"price": e * (1 - side * d / 100), "lots": q} for d, q in safety]}
        unreal = 0.0
        if pos is not None:
            unreal = (b["close"] - pos["cost"] / pos["size"]) * side * pos["size"]
        eq = realized + unreal
        curve_peak = max(curve_peak, eq)
        dd = min(dd, eq - curve_peak)
    unreal = 0.0
    if pos is not None:
        unreal = (bars[-1]["close"] - pos["cost"] / pos["size"]) * side * pos["size"]
    return {"trades": trades, "realized": realized, "unrealized": unreal, "max_dd": dd,
            "open": pos is not None, "max_lots": lots + sum(q for _, q in safety)}


# ------------------------------------------------------------------ RSI

def rsi_series(closes: list[float], n: int) -> list[float | None]:
    """Wilder RSI for every bar (same maths as fx.rsi, computed in one pass)."""
    out: list[float | None] = [None] * len(closes)
    if len(closes) <= n:
        return out
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    ag, al = gains / n, losses / n
    out[n] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(d, 0)) / n
        al = (al * (n - 1) + max(-d, 0)) / n
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def rsi_signals(closes: list[float], periods: int, low: float, high: float, persistence: int) -> list[str | None]:
    """OpenTrader's RSI state machine: one advice per trend once it has lasted `persistence` candles."""
    trend = {"direction": "none", "duration": 0, "adviced": False}
    out: list[str | None] = []
    for r in rsi_series(closes, periods):
        sig = None
        if r is not None and (r > high or r < low):
            d = "high" if r > high else "low"
            if trend["direction"] != d:
                trend = {"direction": d, "duration": 0, "adviced": False}
            trend["duration"] += 1
            if trend["duration"] >= persistence and not trend["adviced"]:
                trend["adviced"] = True
                sig = "sell" if d == "high" else "buy"
        out.append(sig)
    return out


def rsi_backtest(pair: str, bars: list[dict], periods: int, low: float, high: float,
                 persistence: int, mode: str) -> dict:
    closes = [b["close"] for b in bars]
    sigs = rsi_signals(closes, periods, low, high, persistence)
    trades, pos = [], None  # pos = (side, price, date)
    realized, peak, dd = 0.0, 0.0, 0.0
    for b, s in zip(bars, sigs):
        px = b["close"]
        if s == "buy":
            if pos and pos[0] < 0:
                trades.append({"side": "sell", "open": pos[2], "close": b["date"], "pnl_pips": pips(pair, pos[1] - px)})
                realized += pos[1] - px
                pos = None
            if pos is None:
                pos = (1, px, b["date"])
        elif s == "sell":
            if pos and pos[0] > 0:
                trades.append({"side": "buy", "open": pos[2], "close": b["date"], "pnl_pips": pips(pair, px - pos[1])})
                realized += px - pos[1]
                pos = None
            if pos is None and mode == "both":
                pos = (-1, px, b["date"])
        unreal = (px - pos[1]) * pos[0] if pos else 0.0
        peak = max(peak, realized + unreal)
        dd = min(dd, realized + unreal - peak)
    unreal = (closes[-1] - pos[1]) * pos[0] if pos else 0.0
    return {"trades": trades, "realized": realized, "unrealized": unreal, "max_dd": dd,
            "open": None if pos is None else ("long" if pos[0] > 0 else "short", pos[1], pos[2]),
            "signals": sigs}


def cmd_rsi(a, cfg) -> int:
    pair = norm_pair(a.pair)
    bars = fetch_bars(pair, a.range or "6mo", a.interval, a.offline)
    closes = [b["close"] for b in bars]
    rs = rsi_series(closes, a.periods)
    sigs = rsi_signals(closes, a.periods, a.low, a.high, a.persistence)
    now = rs[-1]
    if now is None:
        raise FxError("not enough history for that RSI period")
    zone = "above high" if now > a.high else "below low" if now < a.low else "neutral"
    streak = 0
    for r in reversed(rs):
        if r is None or not ((now > a.high and r > a.high) or (now < a.low and r < a.low)):
            break
        streak += 1
    last_sig = next(((bars[i]["date"], sigs[i]) for i in range(len(sigs) - 1, -1, -1) if sigs[i]), None)
    print(f"RSI {pair[:3]}/{pair[3:]} ({a.interval}, {a.periods} periods)  close {fmt(pair, closes[-1])}  "
          f"RSI {now:.1f}  zone: {zone}" + (f" for {streak} candle(s)" if streak else ""))
    if sigs[-1]:
        print(f"Signal on this candle: {sigs[-1].upper()} (RSI {'>' if sigs[-1] == 'sell' else '<'} "
              f"{a.high if sigs[-1] == 'sell' else a.low} for {a.persistence} candle(s)).")
    else:
        need = ""
        if zone == "neutral":
            need = f" A buy needs RSI below {a.low}, a sell above {a.high}."
        elif streak < a.persistence:
            need = f" {a.persistence - streak} more candle(s) in the zone for a signal."
        else:
            need = " This move already gave its signal."
        print("No new signal." + need)
    if last_sig:
        print(f"Last signal: {last_sig[1].upper()} on {last_sig[0]}.")
    print("Candles are closed bars of delayed data. A signal is not a trade.")
    return 0


# ------------------------------------------------------------------ backtest

def cmd_backtest(a, cfg) -> int:
    pair = norm_pair(a.pair)
    rng = a.range or ("1y" if a.interval == "1d" else "3mo")
    bars = fetch_bars(pair, rng, a.interval, a.offline)
    if len(bars) < 30:
        raise FxError(f"only {len(bars)} bars: not enough history")
    first, last = bars[0]["date"], bars[-1]["date"]
    lots = a.lots
    mpp, cur = money_per_pip(pair, 1.0, cfg, bars[-1]["close"], a.offline)
    head = f"{pair[:3]}/{pair[3:]}  {a.interval} bars {first} -> {last} ({len(bars)} bars)"
    result: dict = {"strategy": a.strategy, "pair": pair, "interval": a.interval, "from": first, "to": last}

    def money(price_diff_lots: float) -> str:  # price difference x lots -> account currency
        return f"{pips(pair, price_diff_lots) * mpp:,.2f} {cur}"

    if a.strategy == "grid":
        low, high = a.low, a.high
        if a.auto or a.low is None or a.high is None:
            low = a.low if a.low is not None else min(b["low"] for b in bars)
            high = a.high if a.high is not None else max(b["high"] for b in bars)
            print("Note: --auto in a backtest uses the whole period's low/high, which the bot could not "
                  "have known in advance (look-ahead). Give --low/--high for an honest test.")
        lines = grid_lines(low, high, a.levels)
        r = grid_backtest(pair, bars, lines, lots)
        step = lines[1] - lines[0]
        print(f"BACKTEST GRID  {head}")
        print(f"Range {fmt(pair, low)} - {fmt(pair, high)}, {a.levels} lines, step {pips(pair, step):.1f} pips, "
              f"{lots} lots a level")
        avg = f", average {pips(pair, r['realized']) / r['rounds']:+.1f} pips each" if r["rounds"] else ""
        print(f"Completed levels: {r['rounds']}{avg} (levels bought at the start can earn more than one step)")
        print(f"Realized:   {money(r['realized'] * lots)}")
        print(f"Unrealized: {money(r['unrealized'] * lots)} ({r['open_now']} level(s) still held at {fmt(pair, r['last'])})")
        print(f"Total:      {money((r['realized'] + r['unrealized']) * lots)}")
        print(f"Worst drawdown: {money(r['max_dd'] * lots)}; most levels held at once: {r['max_held']} "
              f"({r['max_held'] * lots:g} lots)")
        result.update({k: v for k, v in r.items()}, low=low, high=high, levels=a.levels, lots=lots)
    elif a.strategy == "dca":
        side = -1 if a.side in ("sell", "short") else 1
        safety = parse_safety(a.safety)
        if a.sl_pct is not None and safety and a.sl_pct <= safety[-1][0]:
            raise FxError("the stop-loss must sit beyond the deepest safety order (OpenTrader rule)")
        cond = None
        if a.rsi_below is not None:
            cond = ("below", a.rsi_below)
        elif a.rsi_above is not None:
            cond = ("above", a.rsi_above)
        r = dca_backtest(pair, bars, side, lots, a.tp_pct, a.sl_pct, safety, cond, a.periods)
        t = r["trades"]
        wins = [x for x in t if x["why"] == "target"]
        print(f"BACKTEST DCA {'BUY' if side > 0 else 'SELL'}  {head}")
        print(f"Entry {lots} lots, TP {a.tp_pct}% in profit" + (f", SL {a.sl_pct}% against" if a.sl_pct else ", no SL") +
              (f", safety {a.safety}" if safety else ", no safety orders") +
              (f", enter only when RSI({a.periods}) {cond[0]} {cond[1]:g}" if cond else ""))
        print(f"Trades closed: {len(t)}  targets {len(wins)}  stops {len(t) - len(wins)}"
              + (f"  ({len(wins) / len(t):.0%} hit the target)" if t else ""))
        if t:
            print(f"Average safety orders filled: {sum(x['fills'] for x in t) / len(t):.1f}")
        print(f"Realized:   {money(r['realized'])}")
        print(f"Unrealized: {money(r['unrealized'])}" + (" (a trade is still open)" if r["open"] else ""))
        print(f"Worst drawdown: {money(r['max_dd'])}; largest position: {r['max_lots']:g} lots")
        for x in t[-5:]:
            print(f"  {x['open']} -> {x['close']}  {x['why']:6}  {x['fills']} safety  "
                  f"avg {fmt(pair, x['avg'])} exit {fmt(pair, x['exit'])}  {x['pnl_lot_pips'] * mpp:,.2f} {cur}")
        result.update(r, side="buy" if side > 0 else "sell", lots=lots)
    else:  # rsi
        r = rsi_backtest(pair, bars, a.periods, a.low, a.high, a.persistence, a.mode)
        t = r["trades"]
        wins = [x for x in t if x["pnl_pips"] > 0]
        print(f"BACKTEST RSI ({a.mode})  {head}")
        print(f"RSI {a.periods}, buy < {a.low:g}, sell > {a.high:g}, persistence {a.persistence}, {lots} lots, "
              f"fills at the signal candle's close")
        print(f"Trades closed: {len(t)}" + (f"  winners {len(wins)} ({len(wins) / len(t):.0%})" if t else ""))
        tot_pips = sum(x["pnl_pips"] for x in t)
        print(f"Realized:   {tot_pips:+.1f} pips = {money(r['realized'] * lots)}")
        if r["open"]:
            print(f"Open:       {r['open'][0]} from {fmt(pair, r['open'][1])} on {r['open'][2]}, "
                  f"{money(r['unrealized'] * lots)}")
        print(f"Worst drawdown: {money(r['max_dd'] * lots)}")
        for x in t[-5:]:
            print(f"  {x['side']:4} {x['open']} -> {x['close']}  {x['pnl_pips']:+.1f} pips")
        r = dict(r)
        r.pop("signals")
        result.update(r, lots=lots, mode=a.mode)
    print("Paper replay: no spread, swap, commission or slippage; past results do not predict the future.")
    if a.write:
        os.makedirs(os.path.dirname(a.write) or ".", exist_ok=True)
        result["updated"] = datetime.now(timezone.utc).isoformat()
        json.dump(result, open(a.write, "w"), indent=2, default=str)
        print(f"Wrote {a.write}")
    return 0


# ------------------------------------------------------------------ main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="strategies.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("pair")
        p.add_argument("--lots", type=float, default=0.01, help="lots per order / grid level (default 0.01)")
        p.add_argument("--offline", metavar="DIR", help="read yahoo-PAIR.json / stooq-PAIR.csv, no network")
        p.add_argument("--config", default="trader/config.json")

    def grid_opts(p):
        p.add_argument("--low", type=float, help="lowest grid line")
        p.add_argument("--high", type=float, help="highest grid line")
        p.add_argument("--levels", type=int, default=10, help="number of grid lines (default 10)")
        p.add_argument("--auto", action="store_true", help="range from the 20-day low/high")

    def dca_opts(p):
        p.add_argument("--side", default="buy", choices=["buy", "long", "sell", "short"])
        p.add_argument("--tp-pct", type=float, default=0.5, help="take-profit %% from the average price (default 0.5)")
        p.add_argument("--sl-pct", type=float, help="stop-loss %% from the entry (default none)")
        p.add_argument("--safety", help="safety orders DEVIATION%%:LOTS, comma-separated, e.g. 0.3:0.01,0.6:0.02")

    def rsi_opts(p):
        p.add_argument("--periods", type=int, default=14)
        p.add_argument("--low", type=float, default=30, help="buy below this RSI (default 30)")
        p.add_argument("--high", type=float, default=70, help="sell above this RSI (default 70)")
        p.add_argument("--persistence", type=int, default=1, help="candles in the zone before a signal (default 1)")

    p = sub.add_parser("grid", help="grid levels around the price now")
    common(p)
    grid_opts(p)
    p.add_argument("--price", type=float, help="pretend the price is this (default: latest close)")

    p = sub.add_parser("dca", help="DCA ladder: average price and take-profit after each fill")
    common(p)
    dca_opts(p)
    p.add_argument("--entry", type=float, help="entry price (default: latest close)")

    p = sub.add_parser("rsi", help="RSI now and the strategy's signal")
    common(p)
    rsi_opts(p)
    p.add_argument("--interval", default="1d", choices=["1d", "1h"])
    p.add_argument("--range", help="history to read (default 6mo)")

    p = sub.add_parser("backtest", help="paper replay of a strategy on past bars")
    p.add_argument("strategy", choices=["grid", "dca", "rsi"])
    common(p)
    p.add_argument("--interval", default="1d", choices=["1d", "1h"])
    p.add_argument("--range", help="history: 6mo, 1y, 2y... (default 1y daily, 3mo hourly)")
    p.add_argument("--write", nargs="?", const="trader/fx_backtest.json", metavar="PATH")
    # grid
    p.add_argument("--levels", type=int, default=10)
    p.add_argument("--auto", action="store_true")
    # dca
    dca_opts(p)
    p.add_argument("--rsi-below", type=float, help="DCA: open a trade only when RSI is below this")
    p.add_argument("--rsi-above", type=float, help="DCA: open a trade only when RSI is above this")
    # rsi (--low/--high double as the grid range when strategy is grid)
    p.add_argument("--periods", type=int, default=14)
    p.add_argument("--low", type=float, help="grid: lowest line; rsi: buy below (default 30)")
    p.add_argument("--high", type=float, help="grid: highest line; rsi: sell above (default 70)")
    p.add_argument("--persistence", type=int, default=1)
    p.add_argument("--mode", default="long", choices=["long", "both"],
                   help="rsi: long = buy on low, close on high; both = also short on high")

    a = ap.parse_args(argv)
    if a.cmd == "backtest" and a.strategy == "rsi":
        a.low = 30 if a.low is None else a.low
        a.high = 70 if a.high is None else a.high
    try:
        cfg = fx.load_config(a.config)
        if a.lots <= 0:
            raise FxError("--lots must be positive")
        return {"grid": cmd_grid, "dca": cmd_dca, "rsi": cmd_rsi, "backtest": cmd_backtest}[a.cmd](a, cfg)
    except FxError as e:
        print(f"strategies.py: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
