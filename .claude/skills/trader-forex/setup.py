#!/usr/bin/env python3
"""Setup finder for trader-forex: read structure and liquidity on an intraday
chart, then return ONE decision - a trade with entry, stop, TP1, TP2 and
reward:risk plus the reasons, or No Trade. Standard library only.

  analyze EURUSD [--tf 15m|1h|4h|1d] [--min-rr 2] [--write] [--write-plan]
  track [--setup trader/fx_setup.json]      where price is versus the levels

How analyze reads the chart (all from the bars, nothing guessed):
  1. Swing highs and lows: a bar whose high (low) is beyond the --swing bars
     on each side (default 3).
  2. Structure: higher highs + higher lows = bullish, lower highs + lower
     lows = bearish, anything else = no structure.
  3. Break of structure: the last close beyond the most recent swing high
     (bullish) or swing low (bearish).
  4. Liquidity sweep: in the last 30 bars, a wick through a prior swing low
     that closed back above it (sell-side taken) - or the mirror for highs.
  5. Premium / discount: where price sits in the range between the last
     swing low and swing high. Buys want discount (<50%), sells premium.
  6. Entry zone: the most recent unfilled fair-value gap (3-bar imbalance)
     in the trade's direction, else the order block (last opposite candle
     before the move that broke structure). Entry = middle of the zone, or
     the current price if price is already inside it.
  7. Stop: beyond the zone and the protecting swing point, plus 0.1 ATR.
  8. Targets: TP1 = the first swing high (low) beyond the entry - resting
     liquidity - TP2 = the next one, else the range extreme.
  9. Decision: a trade only when the score for one side clearly wins and
     reward:risk to the final target meets --min-rr (config forex.min_setup_rr,
     default 2). Otherwise No Trade, with the reason.

Data: Yahoo's free, delayed chart JSON (EURUSD=X; gold uses the GC=F front
future, which trades a few dollars off spot). --offline FILE reads a saved
chart JSON instead. 4h bars are built from 1h bars.

This is a rules-based reading of the chart, not a prediction. Nothing here
places an order; size it with `fx.py size --plan trader/fx_plan.json` and
send through the risk-checked broker path. Not financial advice.
"""
from __future__ import annotations

import argparse
import json
import math
from decimal import ROUND_HALF_UP, Decimal
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fx import (CRYPTO, FxError, METALS, _get, decimals, fmt, is_crypto, is_metal,  # noqa: E402
                load_config, norm_pair, pip_size)

TF = {  # timeframe: (yahoo interval, yahoo range, bars to merge)
    "15m": ("15m", "5d", 1),
    "1h": ("1h", "1mo", 1),
    "4h": ("1h", "3mo", 4),
    "1d": ("1d", "1y", 1),
}
SWEEP_LOOKBACK = 30
ZONE_LOOKBACK = 60


# ------------------------------------------------------------------ data

def yahoo_symbol(pair: str) -> str:
    if is_crypto(pair):
        return CRYPTO[pair[:3]][3]
    if is_metal(pair) and pair[3:] == "USD":
        return METALS[pair[:3]][3]
    return f"{pair}=X"


def parse_chart(text: str) -> list[dict]:
    data = json.loads(text)
    res = (data.get("chart") or {}).get("result")
    if not res:
        err = (data.get("chart") or {}).get("error")
        raise FxError("Yahoo sent no bars" + (f": {err}" if err else ""))
    r = res[0]
    q = (r.get("indicators", {}).get("quote") or [{}])[0]
    bars = []
    for i, ts in enumerate(r.get("timestamp") or []):
        try:
            o, h, l, c = (q[k][i] for k in ("open", "high", "low", "close"))
        except (KeyError, IndexError):
            continue
        if None in (o, h, l, c):
            continue
        bars.append({"t": int(ts), "open": float(o), "high": float(h), "low": float(l), "close": float(c)})
    bars.sort(key=lambda b: b["t"])
    return bars


def merge(bars: list[dict], n: int) -> list[dict]:
    """Merge 1h bars into n-hour bars on UTC boundaries (4h: 0,4,8,...)."""
    if n == 1:
        return bars
    out, cur, key = [], None, None
    for b in bars:
        k = b["t"] // (3600 * n)
        if k != key:
            if cur:
                out.append(cur)
            cur, key = dict(b, t=k * 3600 * n), k
        else:
            cur["high"] = max(cur["high"], b["high"])
            cur["low"] = min(cur["low"], b["low"])
            cur["close"] = b["close"]
    if cur:
        out.append(cur)
    return out


def load_bars(pair: str, tf: str, offline: str | None) -> list[dict]:
    interval, rng, n = TF[tf]
    if offline:
        if not os.path.exists(offline):
            raise FxError(f"offline file missing: {offline}")
        with open(offline) as f:
            text = f.read()
    else:
        last = None
        for host in ("query2.finance.yahoo.com", "query1.finance.yahoo.com"):
            try:
                text = _get(f"https://{host}/v8/finance/chart/{yahoo_symbol(pair)}"
                            f"?range={rng}&interval={interval}")
                break
            except FxError as e:
                last = e
        else:
            raise last
    return merge(parse_chart(text), n)


# ------------------------------------------------------------------ reading the chart

def atr(bars: list[dict], n: int = 14) -> float:
    trs = [max(b["high"] - b["low"], abs(b["high"] - p["close"]), abs(b["low"] - p["close"]))
           for p, b in zip(bars, bars[1:])]
    trs = trs[-n:] or [bars[-1]["high"] - bars[-1]["low"]]
    return sum(trs) / len(trs)


def pivots(bars: list[dict], k: int) -> tuple[list[int], list[int]]:
    """Indexes of swing highs and lows. A pivot needs k bars on each side, so
    the last k bars can never be pivots yet (they are not confirmed)."""
    highs, lows = [], []
    for i in range(k, len(bars) - k):
        h, l = bars[i]["high"], bars[i]["low"]
        left, right = bars[i - k:i], bars[i + 1:i + k + 1]
        if all(h > b["high"] for b in left) and all(h >= b["high"] for b in right):
            highs.append(i)
        if all(l < b["low"] for b in left) and all(l <= b["low"] for b in right):
            lows.append(i)
    return highs, lows


def structure(bars, highs, lows):
    if len(highs) < 2 or len(lows) < 2:
        return None, "not enough swing points to read structure"
    h1, h2 = bars[highs[-2]]["high"], bars[highs[-1]]["high"]
    l1, l2 = bars[lows[-2]]["low"], bars[lows[-1]]["low"]
    if h2 > h1 and l2 > l1:
        return "bull", (h1, h2, l1, l2)
    if h2 < h1 and l2 < l1:
        return "bear", (h1, h2, l1, l2)
    return None, (h1, h2, l1, l2)


def last_break(bars, highs, lows):
    """The most recent close beyond a prior swing point: ('bull'|'bear', level, bar index)."""
    best = None
    for kind, idxs in (("bull", highs), ("bear", lows)):
        for pi in idxs:
            level = bars[pi]["high"] if kind == "bull" else bars[pi]["low"]
            for j in range(pi + 1, len(bars)):
                c = bars[j]["close"]
                if (kind == "bull" and c > level) or (kind == "bear" and c < level):
                    if best is None or j > best[2]:
                        best = (kind, level, j)
                    break
    return best


def sweeps(bars, highs, lows):
    """Liquidity taken in the last SWEEP_LOOKBACK bars:
    ssl = wick under a prior swing low, close back above; bsl = the mirror."""
    start = max(0, len(bars) - SWEEP_LOOKBACK)
    found = {"bull": None, "bear": None}
    for j in range(start, len(bars)):
        b = bars[j]
        for pi in lows:
            if pi < j and b["low"] < bars[pi]["low"] < b["close"]:
                found["bull"] = (bars[pi]["low"], b["low"], j)
        for pi in highs:
            if pi < j and b["high"] > bars[pi]["high"] > b["close"]:
                found["bear"] = (bars[pi]["high"], b["high"], j)
    return found


def fvg(bars, side):
    """Most recent unfilled fair-value gap for `side`: (low, high, index of the middle bar)."""
    start = max(2, len(bars) - ZONE_LOOKBACK)
    for i in range(len(bars) - 1, start - 1, -1):
        a, c = bars[i - 2], bars[i]
        if side == "bull" and c["low"] > a["high"]:
            lo, hi = a["high"], c["low"]
            if all(b["low"] > lo for b in bars[i + 1:]):
                return lo, hi, i - 1
        if side == "bear" and c["high"] < a["low"]:
            lo, hi = c["high"], a["low"]
            if all(b["high"] < hi for b in bars[i + 1:]):
                return lo, hi, i - 1
    return None


def order_block(bars, side, break_idx):
    """Last opposite-colour candle before the move that broke structure."""
    for i in range(break_idx - 1, max(-1, break_idx - 20), -1):
        b = bars[i]
        if side == "bull" and b["close"] < b["open"]:
            return b["low"], b["high"], i
        if side == "bear" and b["close"] > b["open"]:
            return b["low"], b["high"], i
    return None


# ------------------------------------------------------------------ decision

def rnd(x: float, n: int) -> float:
    """Round exact halves away from zero, like JavaScript's toFixed. Python's round()
    sends exact halves to the even digit (295.25 -> 295.2), which only shows up on
    prices that are exact in binary, such as BTC's 2-decimal prices; the web app must
    give the same numbers, so both use this rule."""
    return float(Decimal(x).quantize(Decimal(1).scaleb(-n), rounding=ROUND_HALF_UP))


def min_stop_distance(pair: str, entry: float) -> float:
    """Smallest stop the spread and noise allow: 5 pips on FX, 20 ($2) on gold and
    silver, 0.1% of the price on crypto (a fixed pip count means nothing at $80,000)."""
    ps = pip_size(pair)
    if is_crypto(pair):
        return math.ceil(entry * 0.001 / ps) * ps
    return 20 * ps if is_metal(pair) else 5 * ps


def analyze(pair: str, bars: list[dict], swing: int, min_rr: float, tf: str) -> dict:
    p = pair
    ps = pip_size(p)
    dec = decimals(p)
    r = lambda x: rnd(x, dec)  # noqa: E731
    out = {"pair": p, "timeframe": tf, "decision": "no_trade", "side": None, "reasons": [],
           "price": r(bars[-1]["close"]) if bars else None,
           "last_bar_time": bars[-1]["t"] if bars else None,
           "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if len(bars) < 4 * swing + 20:
        out["reasons"].append(f"only {len(bars)} bars - not enough history on {tf}")
        return out
    price = bars[-1]["close"]
    a = atr(bars)
    highs, lows = pivots(bars, swing)
    trend, info = structure(bars, highs, lows)
    brk = last_break(bars, highs, lows)
    swp = sweeps(bars, highs, lows)

    score = {"bull": 0, "bear": 0}
    why = {"bull": [], "bear": []}
    if trend and isinstance(info, tuple):
        h1, h2, l1, l2 = info
        word = "higher highs and higher lows" if trend == "bull" else "lower highs and lower lows"
        score[trend] += 2
        why[trend].append(f"{'Bullish' if trend == 'bull' else 'Bearish'} structure: {word} "
                          f"(highs {fmt(p, h1)} -> {fmt(p, h2)}, lows {fmt(p, l1)} -> {fmt(p, l2)})")
    if brk:
        kind, level, j = brk
        score[kind] += 2
        why[kind].append(f"Break of structure: closed {'above' if kind == 'bull' else 'below'} "
                         f"the swing {'high' if kind == 'bull' else 'low'} {fmt(p, level)} "
                         f"{len(bars) - 1 - j} bar(s) ago")
    if swp["bull"]:
        lvl, wick, j = swp["bull"]
        score["bull"] += 1
        why["bull"].append(f"Sell-side liquidity taken: wick to {fmt(p, wick)} under the swing low "
                           f"{fmt(p, lvl)}, closed back above")
    if swp["bear"]:
        lvl, wick, j = swp["bear"]
        score["bear"] += 1
        why["bear"].append(f"Buy-side liquidity taken: wick to {fmt(p, wick)} over the swing high "
                           f"{fmt(p, lvl)}, closed back below")
    if highs and lows:
        rng_hi, rng_lo = bars[highs[-1]]["high"], bars[lows[-1]]["low"]
        if rng_hi > rng_lo:
            pos = (price - rng_lo) / (rng_hi - rng_lo)
            if pos < 0.5:
                score["bull"] += 1
                why["bull"].append(f"Price in discount: {pos:.0%} of the range {fmt(p, rng_lo)}-{fmt(p, rng_hi)}")
            elif pos > 0.5:
                score["bear"] += 1
                why["bear"].append(f"Price in premium: {pos:.0%} of the range {fmt(p, rng_lo)}-{fmt(p, rng_hi)}")
    out["score"] = score

    side = None
    if score["bull"] >= 4 and score["bull"] >= score["bear"] + 2:
        side = "bull"
    elif score["bear"] >= 4 and score["bear"] >= score["bull"] + 2:
        side = "bear"
    if side is None:
        out["reasons"] = (why["bull"] + why["bear"]) or ["no swing structure on this timeframe"]
        out["reasons"].append(f"No clear edge: bullish score {score['bull']}, bearish {score['bear']} "
                              f"(a trade needs 4+ and a lead of 2)")
        return out
    sgn = 1 if side == "bull" else -1
    reasons = list(why[side])

    zone = fvg(bars, side)
    kind = "fair-value gap"
    if zone is None and brk and brk[0] == side:
        zone = order_block(bars, side, brk[2])
        kind = "order block"
    if zone is None:
        reasons.append(f"No unfilled {'bullish' if side == 'bull' else 'bearish'} fair-value gap "
                       f"or order block to enter from")
        out["reasons"] = reasons
        return out
    z_lo, z_hi, zi = zone
    if z_lo <= price <= z_hi:
        entry, entry_type = price, "market"
        reasons.append(f"Entry: price is inside the {kind} {fmt(p, z_lo)}-{fmt(p, z_hi)}")
    else:
        entry, entry_type = (z_lo + z_hi) / 2, "limit"
        if (price - entry) * sgn < 0:
            reasons.append(f"Price {fmt(p, price)} has already gone {'below' if side == 'bull' else 'above'} "
                           f"the {kind} {fmt(p, z_lo)}-{fmt(p, z_hi)}, so that "
                           f"{'buy' if side == 'bull' else 'sell'} zone has failed - nothing to enter from")
            out["reasons"] = reasons
            return out
        reasons.append(f"Entry: middle of the {kind} {fmt(p, z_lo)}-{fmt(p, z_hi)} (limit, wait for the pullback)")

    buf = 0.1 * a
    if side == "bull":
        prot = [bars[i]["low"] for i in lows if bars[i]["low"] < entry]
        base = min([z_lo] + prot[-1:])
        stop = base - buf
        where = "the zone and the last swing low" if prot else "the zone"
    else:
        prot = [bars[i]["high"] for i in highs if bars[i]["high"] > entry]
        base = max([z_hi] + prot[-1:])
        stop = base + buf
        where = "the zone and the last swing high" if prot else "the zone"
    risk = abs(entry - stop)
    min_stop = min_stop_distance(p, entry)
    if risk < min_stop:
        stop = entry - sgn * min_stop
        risk = min_stop
        where += f", widened to the {min_stop / ps:.0f}-pip minimum"
    reasons.append(f"Stop {'below' if side == 'bull' else 'above'} {where}, plus a 0.1 ATR buffer")

    pool = sorted({bars[i]["high"] for i in highs} if side == "bull" else {bars[i]["low"] for i in lows},
                  reverse=(side == "bear"))
    beyond = [x for x in pool if (x - entry) * sgn > 0.5 * risk]
    if not beyond:
        extreme = max(b["high"] for b in bars) if side == "bull" else min(b["low"] for b in bars)
        if (extreme - entry) * sgn > 0.5 * risk:
            beyond = [extreme]
    if not beyond:
        reasons.append("No resting liquidity beyond the entry to target")
        out["reasons"] = reasons
        return out
    tp1 = beyond[0]
    tp2 = next((x for x in beyond[1:] if (x - tp1) * sgn > 0.3 * risk), None)
    if tp2 is None:
        extreme = max(b["high"] for b in bars) if side == "bull" else min(b["low"] for b in bars)
        if (extreme - tp1) * sgn > 0.3 * risk:
            tp2 = extreme
    # from here on, measure everything from the rounded prices the user sees
    entry, stop, tp1 = r(entry), r(stop), r(tp1)
    tp2 = r(tp2) if tp2 is not None else None
    risk = abs(entry - stop)
    final = tp2 if tp2 is not None else tp1
    rr = abs(final - entry) / risk
    reasons.append(f"TP1: first {'buy' if side == 'bull' else 'sell'}-side liquidity at {fmt(p, tp1)}")
    if tp2 is not None:
        reasons.append(f"TP2: next liquidity at {fmt(p, tp2)}")

    out.update({
        "side": "buy" if side == "bull" else "sell", "entry_type": entry_type,
        "entry": r(entry), "stop": r(stop), "tp1": r(tp1), "tp2": r(tp2) if tp2 is not None else None,
        "zone": {"kind": kind, "low": r(z_lo), "high": r(z_hi)},
        "stop_pips": rnd(risk / ps, 1), "tp1_pips": rnd(abs(tp1 - entry) / ps, 1),
        "tp2_pips": rnd(abs(tp2 - entry) / ps, 1) if tp2 is not None else None,
        "rr_tp1": rnd(abs(tp1 - entry) / risk, 2), "rr": rnd(rr, 2), "atr_pips": rnd(a / ps, 1),
    })
    if rr < min_rr:
        reasons.append(f"No Trade: reward:risk {rr:.2f} is under the {min_rr:g} minimum")
        out["reasons"] = reasons
        out["decision"] = "no_trade"
        out["rejected"] = True
        return out
    out["decision"] = "trade"
    out["reasons"] = reasons
    return out


# ------------------------------------------------------------------ output

def card(s: dict) -> str:
    p = s["pair"]
    name = f"{p[:3]}/{p[3:]}"
    lines = []
    if s["decision"] != "trade":
        lines.append(f"{name} {s['timeframe']}: NO TRADE   (price {fmt(p, s['price'])})" if s.get("price")
                     else f"{name} {s['timeframe']}: NO TRADE")
    else:
        lines.append(f"{name} {s['timeframe']}: {s['side'].upper()}   ({s['entry_type']} entry, "
                     f"price now {fmt(p, s['price'])})")
        lines.append(f"  Entry   {fmt(p, s['entry'])}")
        lines.append(f"  Stop    {fmt(p, s['stop'])}   -{s['stop_pips']} pips")
        lines.append(f"  TP1     {fmt(p, s['tp1'])}   +{s['tp1_pips']} pips   ({s['rr_tp1']}R)")
        if s.get("tp2") is not None:
            lines.append(f"  TP2     {fmt(p, s['tp2'])}   +{s['tp2_pips']} pips   ({s['rr']}R)")
        lines.append(f"  Reward:risk 1 : {s['rr']}")
    lines.append("Why:")
    lines += [f"  - {x}" for x in s["reasons"]]
    if s.get("rejected"):
        lines.append(f"  (levels it would have used: entry {fmt(p, s['entry'])}, stop {fmt(p, s['stop'])}, "
                     f"TP1 {fmt(p, s['tp1'])})")
    lines.append("A rules-based reading of delayed data, not a prediction or advice. Nothing was placed.")
    return "\n".join(lines)


def to_plan(s: dict) -> dict:
    """The shape fx.py size / mt5.py / oanda.py read (target = the final TP)."""
    target = s["tp2"] if s.get("tp2") is not None else s["tp1"]
    return {"pair": s["pair"], "side": s["side"], "entry": s["entry"], "stop": s["stop"],
            "target": target, "tp1": s["tp1"], "stop_pips": s["stop_pips"],
            "target_pips": s["tp2_pips"] if s.get("tp2") is not None else s["tp1_pips"],
            "reward_risk": s["rr"], "entry_type": s["entry_type"], "source": "setup.py",
            "timeframe": s["timeframe"], "created": s["created"]}


def track(s: dict, bars: list[dict]) -> dict:
    """Walk the bars after the analysis: did it fill, hit TP1/TP2, or stop out?"""
    p = s["pair"]
    ps = pip_size(p)
    sgn = 1 if s["side"] == "buy" else -1
    after = [b for b in bars if b["t"] > s["last_bar_time"]]
    filled = s["entry_type"] == "market"
    status, tp1_hit, events = ("open" if filled else "pending"), False, []
    for b in after:
        t = datetime.fromtimestamp(b["t"], timezone.utc).strftime("%m-%d %H:%M")
        adverse = b["low"] if sgn > 0 else b["high"]
        favour = b["high"] if sgn > 0 else b["low"]
        if not filled:
            if (favour - s["tp1"]) * sgn >= 0 and (adverse - s["entry"]) * sgn > 0:
                status = "missed"
                events.append(f"{t} price reached TP1 without filling the entry - setup void")
                break
            if (adverse - s["entry"]) * sgn <= 0:
                filled, status = True, "open"
                events.append(f"{t} entry filled at {fmt(p, s['entry'])}")
            else:
                continue
        if (adverse - s["stop"]) * sgn <= 0:  # stop checked first: worst case in a bar that hits both
            status = "stopped" if not tp1_hit else "stopped after TP1"
            events.append(f"{t} stop hit at {fmt(p, s['stop'])}")
            break
        final = s["tp2"] if s.get("tp2") is not None else s["tp1"]
        if (favour - final) * sgn >= 0:
            status = "target hit"
            events.append(f"{t} {'TP2' if s.get('tp2') is not None else 'TP1'} hit at {fmt(p, final)}")
            break
        if not tp1_hit and (favour - s["tp1"]) * sgn >= 0:
            tp1_hit, status = True, "TP1 hit"
            events.append(f"{t} TP1 hit at {fmt(p, s['tp1'])}")
    price = rnd(bars[-1]["close"], decimals(p))
    pips = lambda x: rnd(x / ps, 1) + 0.0  # noqa: E731  (+0.0 turns -0.0 into 0.0)
    res = {"status": status, "price": price, "events": events, "bars_since": len(after),
           "to_stop_pips": pips((price - s["stop"]) * sgn),
           "to_tp1_pips": pips((s["tp1"] - price) * sgn)}
    if s.get("tp2") is not None:
        res["to_tp2_pips"] = pips((s["tp2"] - price) * sgn)
    if filled:
        res["open_pips"] = pips((price - s["entry"]) * sgn)
    return res


# ------------------------------------------------------------------ commands

def cmd_analyze(a) -> int:
    p = norm_pair(a.pair)
    if a.tf not in TF:
        raise FxError(f"timeframe must be one of {', '.join(TF)}")
    cfg = load_config(a.config)
    min_rr = a.min_rr if a.min_rr is not None else float(cfg.get("min_setup_rr", 2.0))
    bars = load_bars(p, a.tf, a.offline)
    s = analyze(p, bars, a.swing, min_rr, a.tf)
    s["source"] = "offline file" if a.offline else "yahoo " + yahoo_symbol(p)
    if a.json:
        print(json.dumps(s, indent=2))
    else:
        print(card(s))
        if is_metal(p) and not a.offline:
            print("Gold/silver bars are the front future (GC=F/SI=F) and run a few dollars off spot - "
                  "check the levels against your broker's chart.")
    if a.write:
        os.makedirs(os.path.dirname(a.write) or ".", exist_ok=True)
        with open(a.write, "w") as f:
            json.dump(s, f, indent=2)
        if not a.json:
            print(f"Wrote {a.write}.")
    if a.write_plan and s["decision"] == "trade":
        os.makedirs(os.path.dirname(a.write_plan) or ".", exist_ok=True)
        with open(a.write_plan, "w") as f:
            json.dump(to_plan(s), f, indent=2)
        if not a.json:
            print(f"Wrote {a.write_plan}. Next: fx.py size --write, then the risk-checked send.")
    return 0


def cmd_track(a) -> int:
    if not os.path.exists(a.setup):
        raise FxError(f"no setup at {a.setup} (run setup.py analyze PAIR --write first)")
    with open(a.setup) as f:
        s = json.load(f)
    if s.get("decision") != "trade":
        print(f"The saved setup for {s.get('pair')} is No Trade - nothing to track.")
        return 0
    p = s["pair"]
    bars = load_bars(p, s["timeframe"], a.offline)
    t = track(s, bars)
    if a.json:
        print(json.dumps(t, indent=2))
        return 0
    print(f"{p[:3]}/{p[3:]} {s['timeframe']} {s['side'].upper()}: {t['status'].upper()}   "
          f"price {fmt(p, t['price'])}, {t['bars_since']} bar(s) since the setup")
    if "open_pips" in t:
        print(f"  Open P/L     {t['open_pips']:+} pips from entry {fmt(p, s['entry'])}")
    print(f"  To stop      {t['to_stop_pips']} pips   ({fmt(p, s['stop'])})")
    print(f"  To TP1       {t['to_tp1_pips']} pips   ({fmt(p, s['tp1'])})")
    if "to_tp2_pips" in t:
        print(f"  To TP2       {t['to_tp2_pips']} pips   ({fmt(p, s['tp2'])})")
    for e in t["events"]:
        print(f"  {e}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="setup.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("analyze", help="read the chart and return a trade or No Trade")
    p.add_argument("pair", help="EURUSD, XAUUSD (gold), GBPUSD ...")
    p.add_argument("--tf", default="15m", help="15m (default), 1h, 4h, 1d")
    p.add_argument("--swing", type=int, default=3, help="bars each side for a swing point (default 3)")
    p.add_argument("--min-rr", type=float, help="minimum reward:risk (default config forex.min_setup_rr or 2)")
    p.add_argument("--write", nargs="?", const="trader/fx_setup.json", metavar="PATH")
    p.add_argument("--write-plan", nargs="?", const="trader/fx_plan.json", metavar="PATH",
                   help="also write the plan fx.py size reads (only when it is a trade)")
    p.add_argument("--json", action="store_true")
    p.add_argument("--offline", metavar="FILE", help="read a saved Yahoo chart JSON")
    p.add_argument("--config", default="trader/config.json")
    p = sub.add_parser("track", help="where price is versus the saved setup")
    p.add_argument("--setup", default="trader/fx_setup.json")
    p.add_argument("--json", action="store_true")
    p.add_argument("--offline", metavar="FILE", help="read a saved Yahoo chart JSON")
    a = ap.parse_args(argv)
    try:
        return {"analyze": cmd_analyze, "track": cmd_track}[a.cmd](a)
    except FxError as e:
        print(f"setup.py: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
