#!/usr/bin/env python3
"""Forex tools for trader-forex. Standard library only.

  clock                          is the FX market open, which sessions are live
  quote EURUSD GBPJPY ...        latest delayed rates, change in pips
  pips EURUSD 1.0850 1.0820      distance in pips and pip value per lot
  plan EURUSD --side buy --entry 1.0850 --stop 1.0820 [--target 2R|pips:60|price:X] --write
  size [--plan trader/fx_plan.json] [--account 10000] [--risk-pct 1] --write
  scan [EURUSD,GBPUSD,...]       daily trend, 20-day breakout, RSI, ATR in pips

Data: free delayed Yahoo chart JSON (EURUSD=X), Stooq CSV as the fallback.
Gold (XAUUSD) and silver (XAGUSD): Stooq spot first; Yahoo falls back to the
front-month futures (GC=F, SI=F), which trade a few dollars off spot.
Rates are indicative, not dealable: your broker's bid/ask is what fills.
Nothing here places an order.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

UA = "Mozilla/5.0 (compatible; jarvis-forex/1.0)"
NY = ZoneInfo("America/New_York")
CURRENCIES = {"USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK",
              "DKK", "SGD", "HKD", "MXN", "ZAR", "TRY", "PLN", "CNH", "CNY", "INR"}
MAJORS = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"]
CROSSES = ["EURGBP", "EURJPY", "GBPJPY", "AUDJPY", "EURCHF", "EURAUD", "CADJPY"]
LOT = 100_000  # units in a standard lot
METALS = {  # symbol: (contract size in oz per lot, pip size, decimals, Yahoo futures)
    "XAU": (100, 0.1, 2, "GC=F"),
    "XAG": (5000, 0.01, 3, "SI=F"),
}
# crypto, quoted in USD only. Broker convention: 1 lot = 1 coin, 1 pip = $1.
CRYPTO = {  # symbol: (coins per lot, pip size, decimals, Yahoo symbol)
    "BTC": (1, 1.0, 2, "BTC-USD"),
}


def contract(pair: str) -> int:
    if pair[:3] in CRYPTO:
        return CRYPTO[pair[:3]][0]
    return METALS[pair[:3]][0] if pair[:3] in METALS else LOT


def is_metal(pair: str) -> bool:
    return pair[:3] in METALS


def pair_coin(pair: str) -> str:
    return pair[:3]


def is_crypto(pair: str) -> bool:
    """Crypto trades 24/7: no FX sessions, no weekend close."""
    return pair[:3] in CRYPTO
DEFAULTS = {
    "account_size": 10000, "account_currency": "USD", "risk_pct": 1.0,
    "max_loss_per_trade": None, "max_leverage": 30, "min_reward_risk": 1.5,
    "min_lot_step": 0.01, "max_lots": 10,
}
SESSIONS = [  # name, zone, local open, local close
    ("Sydney", "Australia/Sydney", 7, 16),
    ("Tokyo", "Asia/Tokyo", 9, 18),
    ("London", "Europe/London", 8, 17),
    ("New York", "America/New_York", 8, 17),
]


class FxError(Exception):
    pass


# ------------------------------------------------------------------ pairs

def norm_pair(s: str) -> str:
    p = s.upper().replace("/", "").replace("_", "").replace("-", "").replace("=X", "").strip()
    p = {"GOLD": "XAUUSD", "SILVER": "XAGUSD", "XAU": "XAUUSD", "XAG": "XAGUSD",
         "BITCOIN": "BTCUSD", "BTC": "BTCUSD", "XBTUSD": "BTCUSD"}.get(p, p)
    if p[:3] in CRYPTO and p[3:] != "USD":
        raise FxError(f"{p[:3]} is only supported against USD (use {p[:3]}USD)")
    base_ok = p[:3] in CURRENCIES or p[:3] in METALS or p[:3] in CRYPTO
    if len(p) != 6 or not base_ok or p[3:] not in CURRENCIES or p[:3] == p[3:]:
        raise FxError(f"not a currency pair: {s!r} (use e.g. EURUSD, EUR/USD, XAUUSD or BTCUSD)")
    return p


def pip_size(pair: str) -> float:
    if is_crypto(pair):
        return CRYPTO[pair[:3]][1]
    if is_metal(pair):
        return METALS[pair[:3]][1]
    return 0.01 if pair[3:] == "JPY" else 0.0001


def decimals(pair: str) -> int:
    if is_crypto(pair):
        return CRYPTO[pair[:3]][2]
    if is_metal(pair):
        return METALS[pair[:3]][2]
    return 3 if pair[3:] == "JPY" else 5


def fmt(pair: str, x: float) -> str:
    return f"{x:.{decimals(pair)}f}"


# ------------------------------------------------------------------ data

_cache: dict[str, dict] = {}


def _get(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise FxError(f"{url.split('?')[0]} answered HTTP {e.code}")
    except urllib.error.URLError as e:
        raise FxError(f"could not reach {url.split('/')[2]}: {e.reason}")


def _yahoo(pair: str, rng: str, offline: str | None) -> dict:
    if offline:
        path = os.path.join(offline, f"yahoo-{pair}.json")
        if not os.path.exists(path):
            raise FxError(f"offline file missing: {path}")
        text = open(path).read()
    else:
        last = None
        for host in ("query2.finance.yahoo.com", "query1.finance.yahoo.com"):
            try:
                sym = (CRYPTO[pair[:3]][3] if is_crypto(pair)
                       else METALS[pair[:3]][3] if is_metal(pair) and pair[3:] == "USD" else f"{pair}=X")
                text = _get(f"https://{host}/v8/finance/chart/{sym}?range={rng}&interval=1d")
                break
            except FxError as e:
                last = e
        else:
            raise last
    data = json.loads(text)
    res = (data.get("chart") or {}).get("result")
    if not res:
        raise FxError(f"Yahoo has no data for {pair}")
    r = res[0]
    q = r["indicators"]["quote"][0]
    bars = []
    for i, ts in enumerate(r.get("timestamp") or []):
        o, h, l, c = (q[k][i] for k in ("open", "high", "low", "close"))
        if None not in (o, h, l, c):
            bars.append({"date": datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d"),
                         "open": o, "high": h, "low": l, "close": c})
    m = r.get("meta", {})
    price = m.get("regularMarketPrice") or (bars[-1]["close"] if bars else None)
    when = m.get("regularMarketTime")
    return {"pair": pair, "price": price, "bars": bars, "source": "yahoo",
            "prev_close": bars[-2]["close"] if len(bars) >= 2 else m.get("chartPreviousClose"),
            "time": datetime.fromtimestamp(when, timezone.utc).isoformat() if when else None}


def _stooq(pair: str, offline: str | None) -> dict:
    if offline:
        path = os.path.join(offline, f"stooq-{pair}.csv")
        if not os.path.exists(path):
            raise FxError(f"offline file missing: {path}")
        text = open(path).read()
    else:
        text = _get(f"https://stooq.com/q/d/l/?s={pair.lower()}&i=d")
    rows = list(csv.DictReader(io.StringIO(text)))
    bars = []
    for r in rows[-260:]:
        try:
            bars.append({"date": r["Date"], "open": float(r["Open"]), "high": float(r["High"]),
                         "low": float(r["Low"]), "close": float(r["Close"])})
        except (KeyError, ValueError):
            continue
    if not bars:
        raise FxError(f"Stooq has no data for {pair}")
    return {"pair": pair, "price": bars[-1]["close"], "bars": bars, "source": "stooq",
            "prev_close": bars[-2]["close"] if len(bars) >= 2 else None, "time": bars[-1]["date"]}


def get_pair(pair: str, offline: str | None = None, rng: str = "6mo", source: str = "auto") -> dict:
    key = f"{pair}:{rng}"
    if key in _cache:
        return _cache[key]
    errors = []
    if source != "auto":
        order = [source]
    else:
        order = ["stooq", "yahoo"] if is_metal(pair) else ["yahoo", "stooq"]
    for src in order:
        try:
            d = _yahoo(pair, rng, offline) if src == "yahoo" else _stooq(pair, offline)
            if d["price"]:
                _cache[key] = d
                return d
        except (FxError, ValueError, KeyError) as e:
            errors.append(f"{src}: {e}")
        time.sleep(0 if offline else 0.3)
    raise FxError(f"no rate for {pair} ({'; '.join(errors)})")


def rate(base: str, quote: str, offline: str | None) -> float:
    """How many `quote` per 1 `base`."""
    if base == quote:
        return 1.0
    try:
        return get_pair(base + quote, offline)["price"]
    except FxError:
        return 1.0 / get_pair(quote + base, offline)["price"]


# ------------------------------------------------------------------ config

def load_config(path: str) -> dict:
    cfg = dict(DEFAULTS)
    if os.path.exists(path):
        try:
            cfg.update((json.load(open(path)).get("forex") or {}))
        except (ValueError, OSError):
            pass
    return cfg


# ------------------------------------------------------------------ clock

def market_status(now: datetime) -> dict:
    ny = now.astimezone(NY)
    wd, h = ny.weekday(), ny.hour + ny.minute / 60  # Mon=0
    closed = wd == 5 or (wd == 4 and h >= 17) or (wd == 6 and h < 17)
    live = []
    for name, zone, o, c in SESSIONS:
        loc = now.astimezone(ZoneInfo(zone))
        if not closed and loc.weekday() < 5 and o <= loc.hour < c:
            live.append(name)
    if closed:
        # next open: Sunday 17:00 New York
        days = (6 - wd) % 7
        nxt = (ny + timedelta(days=days)).replace(hour=17, minute=0, second=0, microsecond=0)
        if nxt <= ny:
            nxt += timedelta(days=7)
    else:
        days = (4 - wd) % 7
        nxt = (ny + timedelta(days=days)).replace(hour=17, minute=0, second=0, microsecond=0)
    return {"open": not closed, "sessions": live, "ny_time": ny.strftime("%Y-%m-%d %H:%M %a"),
            "next_change": nxt.strftime("%a %Y-%m-%d %H:%M New York"),
            "overlap": len(live) >= 2}


def cmd_clock(a) -> int:
    now = parse_now(a.now)
    s = market_status(now)
    if a.json:
        print(json.dumps(s, indent=2))
        return 0
    if s["open"]:
        print(f"New York {s['ny_time']}: FOREX OPEN (24 hours, Sunday 17:00 to Friday 17:00 New York).")
        print("Live sessions: " + (", ".join(s["sessions"]) or "none of the big four (quiet hours)"))
        if "London" in s["sessions"] and "New York" in s["sessions"]:
            print("London / New York overlap: usually the most liquid hours, tightest spreads.")
        elif not s["sessions"]:
            print("Between sessions: thin liquidity, wider spreads.")
        print(f"Closes for the weekend: {s['next_change']}.")
    else:
        print(f"New York {s['ny_time']}: FOREX CLOSED for the weekend.")
        print(f"Opens: {s['next_change']} (Sydney session). Expect gaps and wide spreads at the open.")
    return 0


def parse_now(s: str | None) -> datetime:
    if not s:
        return datetime.now(timezone.utc)
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=NY)


# ------------------------------------------------------------------ quote

def cmd_quote(a) -> int:
    pairs = [norm_pair(p) for p in (a.pairs or MAJORS)]
    out, bad = [], 0
    for p in pairs:
        try:
            d = get_pair(p, a.offline, "5d", a.source)
        except FxError as e:
            out.append({"pair": p, "error": str(e)})
            bad += 1
            continue
        chg = None
        if d["prev_close"]:
            chg = (d["price"] - d["prev_close"]) / pip_size(p)
        out.append({"pair": p, "price": d["price"], "prev_close": d["prev_close"],
                    "note": "futures, not spot" if is_metal(p) and d["source"] == "yahoo" else None,
                    "change_pips": None if chg is None else round(chg, 1),
                    "source": d["source"], "time": d["time"]})
    if a.write:
        os.makedirs(os.path.dirname(a.write) or ".", exist_ok=True)
        json.dump({"updated": datetime.now(timezone.utc).isoformat(), "rates": out},
                  open(a.write, "w"), indent=2)
    if a.json:
        print(json.dumps(out, indent=2))
    else:
        for r in out:
            if "error" in r:
                print(f"  {r['pair'][:3]}/{r['pair'][3:]}  error: {r['error']}")
                continue
            p = r["pair"]
            ch = "" if r["change_pips"] is None else f"  {r['change_pips']:+.1f} pips vs prev close"
            note = f", {r['note']}" if r.get("note") else ""
            print(f"  {p[:3]}/{p[3:]}  {fmt(p, r['price'])}{ch}  ({r['source']}{note})")
        print("Indicative mid rates, delayed. Your broker's bid/ask is what fills.")
        if a.write:
            print(f"Wrote {a.write}")
    return 1 if bad == len(out) else 0


# ------------------------------------------------------------------ pip math

def pip_value_per_lot(pair: str, account: str, price: float | None, offline: str | None) -> float:
    """Value of one pip on one standard lot, in the account currency."""
    pv_quote = contract(pair) * pip_size(pair)  # in the quote currency
    quote = pair[3:]
    if quote == account:
        return pv_quote
    if pair[:3] == account and price:
        return pv_quote / price
    return pv_quote * rate(quote, account, offline)


def cmd_pips(a) -> int:
    p = norm_pair(a.pair)
    dist = abs(a.price2 - a.price1) / pip_size(p)
    cfg = load_config(a.config)
    acct = (a.account_currency or cfg["account_currency"]).upper()
    pv = pip_value_per_lot(p, acct, a.price1, a.offline)
    print(f"{p[:3]}/{p[3:]}: {fmt(p, a.price1)} -> {fmt(p, a.price2)} = {dist:.1f} pips "
          f"(1 pip = {pip_size(p)})")
    print(f"Pip value: {pv:.2f} {acct} per standard lot, {pv / 10:.2f} per mini, {pv / 100:.2f} per micro")
    print(f"That move is {dist * pv:,.2f} {acct} on 1 lot, {dist * pv / 100:,.2f} on 0.01 lots.")
    return 0


# ------------------------------------------------------------------ plan

def cmd_plan(a) -> int:
    p = norm_pair(a.pair)
    side = "sell" if a.side.lower() in ("sell", "short") else "buy"
    ps = pip_size(p)
    entry = a.entry
    if entry is None:
        entry = get_pair(p, a.offline, "5d")["price"]
    sgn = 1 if side == "buy" else -1
    stop = parse_level(a.stop, p, entry, -sgn, None, "stop")
    risk = abs(entry - stop)
    if risk <= 0:
        raise FxError("the stop is at the entry")
    if (stop - entry) * sgn > 0:
        raise FxError(f"a {side} stop must be {'below' if side == 'buy' else 'above'} the entry")
    target = parse_level(a.target or "2R", p, entry, sgn, risk, "target")
    if (target - entry) * sgn <= 0:
        raise FxError(f"a {side} target must be {'above' if side == 'buy' else 'below'} the entry")
    rr = abs(target - entry) / risk
    plan = {"pair": p, "side": side, "entry": round(entry, decimals(p)),
            "stop": round(stop, decimals(p)), "target": round(target, decimals(p)),
            "stop_pips": round(risk / ps, 1), "target_pips": round(abs(target - entry) / ps, 1),
            "reward_risk": round(rr, 2), "created": datetime.now(timezone.utc).isoformat()}
    cfg = load_config(a.config)
    print(f"FX plan: {side.upper()} {p[:3]}/{p[3:]}")
    print(f"  Entry    {fmt(p, plan['entry'])}")
    print(f"  Stop     {fmt(p, plan['stop'])}   {plan['stop_pips']} pips")
    print(f"  Target   {fmt(p, plan['target'])}   {plan['target_pips']} pips")
    print(f"  Reward:risk {plan['reward_risk']}")
    if rr < cfg["min_reward_risk"]:
        print(f"  WARNING: reward:risk is under your minimum of {cfg['min_reward_risk']}.")
    if plan["stop_pips"] < 5:
        print("  WARNING: a stop under 5 pips can be hit by the spread alone.")
    if a.write:
        os.makedirs(os.path.dirname(a.write) or ".", exist_ok=True)
        json.dump(plan, open(a.write, "w"), indent=2)
        print(f"Wrote {a.write}. Next: size it (fx.py size). Nothing was placed.")
    return 0


def parse_level(spec: str, pair: str, entry: float, direction: int, risk: float | None, what: str) -> float:
    s = str(spec).strip().lower()
    ps = pip_size(pair)
    try:
        if s.startswith("pips:"):
            return entry + direction * float(s[5:]) * ps
        if s.endswith("pips"):
            return entry + direction * float(s[:-4]) * ps
        if s.endswith("r"):
            if risk is None:
                raise FxError("an R multiple only works for the target")
            return entry + direction * float(s[:-1]) * risk
        if s.startswith("price:"):
            return float(s[6:])
        return float(s)
    except ValueError:
        raise FxError(f"bad {what}: {spec!r} (use a price, pips:30, or for the target 2R)")


# ------------------------------------------------------------------ size

def cmd_size(a) -> int:
    if not os.path.exists(a.plan):
        raise FxError(f"no plan at {a.plan} (run fx.py plan ... --write first)")
    plan = json.load(open(a.plan))
    cfg = load_config(a.config)
    p = plan["pair"]
    acct = cfg["account_currency"].upper()
    account = a.account or cfg["account_size"]
    risk_pct = a.risk_pct if a.risk_pct is not None else cfg["risk_pct"]
    max_loss = account * risk_pct / 100
    if cfg.get("max_loss_per_trade"):
        max_loss = min(max_loss, cfg["max_loss_per_trade"])
    pv = pip_value_per_lot(p, acct, plan["entry"], a.offline)
    step = cfg["min_lot_step"]
    raw = max_loss / (plan["stop_pips"] * pv)
    lots_risk = math.floor(raw / step + 1e-9) * step
    # leverage limit: notional in account currency / account <= max_leverage
    if p[:3] == acct:
        base_in_acct = 1.0
    elif p[3:] == acct:
        base_in_acct = plan["entry"]
    else:
        base_in_acct = rate(p[:3], acct, a.offline)
    notional_per_lot = contract(p) * base_in_acct
    lots_lev = math.floor(account * cfg["max_leverage"] / notional_per_lot / step + 1e-9) * step
    lots = min(lots_risk, lots_lev, cfg["max_lots"])
    binds = "max loss" if lots == lots_risk else ("leverage" if lots == lots_lev else "max lots")
    lots = round(lots, 2)
    loss = lots * plan["stop_pips"] * pv
    gain = lots * plan["target_pips"] * pv
    margin = lots * notional_per_lot / cfg["max_leverage"]
    print(f"{plan['side'].upper()} {p[:3]}/{p[3:]}  entry {fmt(p, plan['entry'])}  stop {fmt(p, plan['stop'])} "
          f"({plan['stop_pips']} pips)  target {fmt(p, plan['target'])} ({plan['target_pips']} pips)")
    print(f"Account {account:,.2f} {acct}, risk {risk_pct}% = {max_loss:,.2f} {acct} max loss.")
    print(f"Pip value {pv:.2f} {acct} per lot.")
    print(f"  by max loss   {max_loss:,.2f} / ({plan['stop_pips']} pips x {pv:.2f})  = {lots_risk:.2f} lots")
    print(f"  by leverage   {cfg['max_leverage']}:1 on {account:,.0f}                        = {lots_lev:.2f} lots")
    print(f"  max lots      {cfg['max_lots']}")
    if lots <= 0:
        print(f"Size: 0 lots. The stop is too wide for a {max_loss:,.2f} {acct} max loss even at "
              f"{step} lots. Tighten the stop or raise the risk.")
        return 1
    unit_name = "oz" if is_metal(p) else pair_coin(p) if is_crypto(p) else "units"
    # currencies trade in whole units; a coin splits (0.44 lots = 0.44 BTC)
    units = round(lots * contract(p), 2) if is_crypto(p) else int(round(lots * contract(p)))
    print(f"Size: {lots:.2f} lots = {units:,} {unit_name}  (limit: {binds})")
    print(f"  Loss at stop  {loss:,.2f} {acct}    Gain at target {gain:,.2f} {acct}    "
          f"Margin ~{margin:,.2f} {acct} at {cfg['max_leverage']}:1")
    order = {"pair": p, "side": plan["side"], "units": units, "lots": lots,
             "type": "market", "stop_loss": plan["stop"], "take_profit": plan["target"],
             "max_loss": round(loss, 2), "account_currency": acct}
    if a.write:
        os.makedirs(os.path.dirname(a.write) or ".", exist_ok=True)
        json.dump({"orders": [order]}, open(a.write, "w"), indent=2)
        print(f"Wrote proposed order to {a.write}. Nothing was placed.")
    print("Spreads, swaps (overnight financing) and slippage are not included. Not financial advice.")
    return 0


# ------------------------------------------------------------------ scan

def sma(xs, n):
    return sum(xs[-n:]) / n if len(xs) >= n else None


def rsi(closes, n=14):
    if len(closes) <= n:
        return None
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    ag, al = gains / n, losses / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(d, 0)) / n
        al = (al * (n - 1) + max(-d, 0)) / n
    return 100.0 if al == 0 else 100 - 100 / (1 + ag / al)


def atr(bars, n=14):
    if len(bars) <= n:
        return None
    trs = [max(b["high"] - b["low"], abs(b["high"] - p["close"]), abs(b["low"] - p["close"]))
           for p, b in zip(bars, bars[1:])]
    return sum(trs[-n:]) / n


def analyse(pair: str, bars: list[dict]) -> dict:
    closes = [b["close"] for b in bars]
    last = closes[-1]
    s20, s50 = sma(closes, 20), sma(closes, 50)
    r = rsi(closes)
    a = atr(bars)
    prior = bars[-21:-1]
    hi20 = max(b["high"] for b in prior) if len(prior) == 20 else None
    lo20 = min(b["low"] for b in prior) if len(prior) == 20 else None
    signals = []
    if hi20 and last > hi20:
        signals.append("20-day high breakout")
    if lo20 and last < lo20:
        signals.append("20-day low breakdown")
    trend = None
    if s20 and s50:
        trend = "up" if last > s20 > s50 else "down" if last < s20 < s50 else "mixed"
    if r is not None and r < 30:
        signals.append("oversold (RSI<30)")
    if r is not None and r > 70:
        signals.append("overbought (RSI>70)")
    if len(closes) >= 2 and s20:
        prev_s20 = sum(closes[-21:-1]) / 20
        if closes[-2] < prev_s20 <= s20 < last:
            signals.append("reclaimed 20-day average")
        if closes[-2] > prev_s20 >= s20 > last:
            signals.append("lost 20-day average")
    return {"pair": pair, "price": last, "trend": trend, "rsi": None if r is None else round(r, 1),
            "atr_pips": None if a is None else round(a / pip_size(pair), 1),
            "high20": hi20, "low20": lo20, "signals": signals, "date": bars[-1]["date"]}


def cmd_scan(a) -> int:
    pairs = [norm_pair(x) for x in (a.pairs.split(",") if a.pairs else MAJORS + CROSSES + ["XAUUSD"])]
    rows, errs = [], []
    for p in pairs:
        try:
            d = get_pair(p, a.offline, "6mo")
            if len(d["bars"]) < 25:
                raise FxError("not enough history")
            rows.append(analyse(p, d["bars"]))
        except FxError as e:
            errs.append(f"{p}: {e}")
    rows.sort(key=lambda r: (-len(r["signals"]), r["pair"]))
    if a.write:
        os.makedirs(os.path.dirname(a.write) or ".", exist_ok=True)
        json.dump({"updated": datetime.now(timezone.utc).isoformat(), "pairs": rows},
                  open(a.write, "w"), indent=2)
    if a.json:
        print(json.dumps({"pairs": rows, "errors": errs}, indent=2))
        return 0 if rows else 1
    print(f"{'PAIR':8} {'PRICE':>10} {'TREND':6} {'RSI':>5} {'ATR':>7}  SIGNALS")
    for r in rows:
        p = r["pair"]
        print(f"{p[:3]}/{p[3:]:4} {fmt(p, r['price']):>10} {r['trend'] or '-':6} "
              f"{r['rsi'] if r['rsi'] is not None else '-':>5} "
              f"{(str(r['atr_pips']) + 'p') if r['atr_pips'] is not None else '-':>7}  "
              f"{', '.join(r['signals']) or '-'}")
    for e in errs:
        print("  error " + e)
    print("Daily bars, delayed. ATR = average daily range in pips (14 days). A signal is not a trade.")
    if a.write:
        print(f"Wrote {a.write}")
    return 0 if rows else 1


# ------------------------------------------------------------------ main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="fx.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--offline", metavar="DIR", help="read yahoo-PAIR.json / stooq-PAIR.csv, no network")
        p.add_argument("--config", default="trader/config.json")

    p = sub.add_parser("clock", help="is the FX market open, which sessions")
    p.add_argument("--now", help="pretend it is this time (ISO; no offset = New York)")
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("quote", help="latest rates")
    p.add_argument("pairs", nargs="*")
    p.add_argument("--source", default="auto", choices=["auto", "yahoo", "stooq"])
    p.add_argument("--write", nargs="?", const="trader/fx_rates.json", metavar="PATH")
    p.add_argument("--json", action="store_true")
    common(p)

    p = sub.add_parser("pips", help="pips between two prices, pip value")
    p.add_argument("pair")
    p.add_argument("price1", type=float)
    p.add_argument("price2", type=float)
    p.add_argument("--account-currency")
    common(p)

    p = sub.add_parser("plan", help="entry, stop and target in pips")
    p.add_argument("pair")
    p.add_argument("--side", default="buy", choices=["buy", "long", "sell", "short"])
    p.add_argument("--entry", type=float, help="default: the latest rate")
    p.add_argument("--stop", required=True, help="a price, or pips:30")
    p.add_argument("--target", help="2R (default), 1.5R, pips:60, or a price")
    p.add_argument("--write", nargs="?", const="trader/fx_plan.json", metavar="PATH")
    common(p)

    p = sub.add_parser("size", help="lots from the plan and your risk")
    p.add_argument("--plan", default="trader/fx_plan.json")
    p.add_argument("--account", type=float, help="account size (default: config forex.account_size)")
    p.add_argument("--risk-pct", type=float, help="percent of the account to risk (default 1)")
    p.add_argument("--write", nargs="?", const="trader/fx_orders.json", metavar="PATH")
    common(p)

    p = sub.add_parser("scan", help="trend, breakouts, RSI, ATR across pairs")
    p.add_argument("pairs", nargs="?", help="comma-separated, default majors + main crosses")
    p.add_argument("--write", nargs="?", const="trader/fx_scan.json", metavar="PATH")
    p.add_argument("--json", action="store_true")
    common(p)

    a = ap.parse_args(argv)
    try:
        return {"clock": cmd_clock, "quote": cmd_quote, "pips": cmd_pips, "plan": cmd_plan,
                "size": cmd_size, "scan": cmd_scan}[a.cmd](a)
    except FxError as e:
        print(f"fx.py: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
