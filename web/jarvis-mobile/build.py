#!/usr/bin/env python3
"""Build JARVIS Mobile (a phone page) from the latest scan.

Reads what the trader skills wrote in trader/ and fills template.html:
  trader/fx_scan.json     forex, metals and crypto   (fx.py scan --write)
  trader/watchlist.json   stock scanner hits          (scan.py daily)

  python web/jarvis-mobile/build.py              # -> web/jarvis-mobile/dist/jarvis.html
  python web/jarvis-mobile/build.py --scan       # run the forex scan first (adds ETHUSD)
  python web/jarvis-mobile/build.py --out PATH

Publish dist/jarvis.html as a claude.ai Artifact with these capabilities, so the
Live buttons and the chat work (ask Claude to "republish JARVIS Mobile"):
  mcp:    CoinGecko [get-coin-market-chart],
          Alpha Vantage MCP Server [FX_DAILY, TIME_SERIES_DAILY]
  sample: {}
Opened as a plain file, the page still shows the snapshot and the calculator.
The page never places orders.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.dirname(os.path.abspath(__file__))
FX = os.path.join(ROOT, ".claude", "skills", "trader-forex", "fx.py")
SETUP_ORDER = ["breakout_20d", "bull_flag", "reclaim_ma20", "oversold_bounce", "oversold"]
PER_SETUP = {"oversold": 15}  # others: 12


def sig(x, n=7):
    return None if x is None else float(f"{x:.{n}g}")


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def scan(trader: str) -> None:
    out = os.path.join(trader, "fx_scan.json")
    pairs = ("EURUSD,GBPUSD,USDJPY,USDCHF,AUDUSD,USDCAD,NZDUSD,EURGBP,EURJPY,GBPJPY,"
             "AUDJPY,EURCHF,EURAUD,CADJPY,XAUUSD,BTCUSD,ETHUSD")
    p = subprocess.run([sys.executable, FX, "scan", pairs, "--write", out], cwd=ROOT,
                       capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        sys.exit("forex scan failed: " + (p.stderr or p.stdout).strip()[-300:])


def snapshot(trader: str) -> dict:
    fx = load(os.path.join(trader, "fx_scan.json"))
    if not fx or not fx.get("pairs"):
        sys.exit("No trader/fx_scan.json. Run with --scan, or: fx.py scan --write")
    rows = [{"s": p["pair"], "p": sig(p["price"]), "t": p.get("trend"), "rsi": p.get("rsi"),
             "atr": p.get("atr_pips"), "hi": sig(p.get("high20")), "lo": sig(p.get("low20")),
             "sig": p.get("signals") or []} for p in fx["pairs"]]

    wl = load(os.path.join(trader, "watchlist.json")) or {}
    hits = wl.get("hits") or []
    stocks, seen = [], set()
    for s in SETUP_ORDER:
        n = 0
        for h in hits:
            if s in (h.get("setups") or []) and h["symbol"] not in seen and n < PER_SETUP.get(s, 12):
                stocks.append({"s": h["symbol"], "p": round(h.get("price") or 0, 2), "rsi": h.get("rsi"),
                               "set": h["setups"]})
                seen.add(h["symbol"])
                n += 1
    counts = {"universe": wl.get("universe") if isinstance(wl.get("universe"), int) else None,
              "liquid": wl.get("scanned"), "hits": len(hits)}
    for s in SETUP_ORDER:
        counts[s] = sum(1 for h in hits if s in (h.get("setups") or []))
    if counts["universe"] is None:
        counts["universe"] = counts["liquid"] or len(hits)
    if counts["liquid"] is None:
        counts["liquid"] = counts["universe"]

    when = fx.get("updated") or datetime.now(timezone.utc).isoformat()
    d = datetime.fromisoformat(when.replace("Z", "+00:00")).astimezone(ZoneInfo("America/New_York"))
    label = d.strftime("%a %-d %b %Y, %-I:%M %p New York")
    return {"asof": when, "asofLabel": label, "fx": rows, "stocks": stocks, "counts": counts}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--trader-dir", default=os.path.join(ROOT, "trader"))
    ap.add_argument("--scan", action="store_true", help="run the forex scan first")
    ap.add_argument("--out", default=os.path.join(HERE, "dist", "jarvis.html"))
    a = ap.parse_args(argv)
    if a.scan:
        scan(a.trader_dir)
    snap = snapshot(a.trader_dir)
    tpl = open(os.path.join(HERE, "template.html")).read()
    if "__SNAPSHOT__" not in tpl:
        sys.exit("template.html has no __SNAPSHOT__ placeholder")
    html = tpl.replace("__SNAPSHOT__", json.dumps(snap, separators=(",", ":")).replace("</", "<\\/"), 1)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as f:
        f.write(html)
    print(f"Wrote {a.out}: {len(snap['fx'])} forex/metal/crypto rows, {len(snap['stocks'])} stocks, "
          f"scan {snap['asofLabel']}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
