#!/usr/bin/env python3
"""Bridge from the trader skills to MetaTrader 5 (STARTRADER or any MT5 broker).

Writes one plain text file that the JarvisSignals indicator (mql5/JarvisSignals.mq5)
reads on every chart: the FX market clock, the forex scan, the stock scanner's hits
and the current trade plan with its lot size. The indicator draws the entry, stop and
target lines on the matching chart and rings an alert when the price reaches them.

Nothing here places, changes or closes an order, and the indicator cannot trade
either (it is an indicator, not an Expert Advisor). Sending stays a manual step:
/fxsend in JARVIS (your own typed yes) or by hand in MT5.

  export                       write the file once from trader/*.json
  export --scan                run the forex scan first (fx.py scan --write)
  export --scan --every 15     keep going: rescan and rewrite every 15 minutes
  where                        print where the file goes

The file goes to MT5's shared folder, so every MT5 terminal on the PC can read it:
  Windows  %APPDATA%\\MetaQuotes\\Terminal\\Common\\Files\\jarvis_signals.txt
  other    trader/mt5/jarvis_signals.txt (copy it over, or pass --out)

Format: one record a line, fields split by "|" (no "|" ever appears inside a field).
  META |updated_utc|fx_open|sessions|next_change|ny_time
  FX   |PAIR|price|trend|rsi|atr_pips|high20|low20|signals;...|date
  STOCK|SYMBOL|price|rsi|setups;...|close_date
  PLAN |SYMBOL|side|entry|stop|target|size|size_unit|max_loss|reward_risk|source|created
Times are UTC as "YYYY.MM.DD HH:MI" (what MQL5's StringToTime reads).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fx  # noqa: E402

FILE_NAME = "jarvis_signals.txt"


def default_out() -> str:
    appdata = os.environ.get("APPDATA")
    if os.name == "nt" and appdata:
        return os.path.join(appdata, "MetaQuotes", "Terminal", "Common", "Files", FILE_NAME)
    return os.path.join("trader", "mt5", FILE_NAME)


def load(path: str):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def mt5_time(iso: str | None) -> str:
    """ISO 8601 (any offset) -> 'YYYY.MM.DD HH:MI' UTC; '' if unreadable."""
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return ""
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc).strftime("%Y.%m.%d %H:%M")


def clean(v) -> str:
    """One field: no separators or line breaks, plain ASCII."""
    if v is None:
        return ""
    if isinstance(v, float):
        v = f"{v:.6f}".rstrip("0").rstrip(".")
    s = str(v).replace("|", "/").replace("\r", " ").replace("\n", " ")
    return s.encode("ascii", "replace").decode("ascii")


def row(*fields) -> str:
    return "|".join(clean(f) for f in fields)


def build(trader_dir: str, max_stocks: int, now: datetime) -> tuple[list[str], dict]:
    lines = ["# JARVIS signals for MetaTrader 5 - written by trader-forex/mt5bridge.py",
             "# Matched rules and plans only. Not orders, not advice. Nothing is placed."]
    counts = {"fx": 0, "stocks": 0, "plans": 0}

    s = fx.market_status(now)
    lines.append(row("META", now.astimezone(timezone.utc).strftime("%Y.%m.%d %H:%M"),
                     1 if s["open"] else 0, ",".join(s["sessions"]), s["next_change"], s["ny_time"]))

    scan = load(os.path.join(trader_dir, "fx_scan.json")) or {}
    for r in scan.get("pairs") or []:
        lines.append(row("FX", r.get("pair"), r.get("price"), r.get("trend"), r.get("rsi"),
                         r.get("atr_pips"), r.get("high20"), r.get("low20"),
                         ";".join(r.get("signals") or []), r.get("date")))
        counts["fx"] += 1

    wl = load(os.path.join(trader_dir, "watchlist.json")) or {}
    for h in (wl.get("hits") or [])[:max_stocks]:
        setups = h.get("setups") or ([h["setup"]] if h.get("setup") else [])
        lines.append(row("STOCK", h.get("symbol"), h.get("price"), h.get("rsi"),
                         ";".join(setups), h.get("close_date") or wl.get("as_of")))
        counts["stocks"] += 1

    # forex plan, with lots from the proposed order when it is for the same pair
    plan = load(os.path.join(trader_dir, "fx_plan.json"))
    if plan and plan.get("pair"):
        lots, loss = "", ""
        orders = (load(os.path.join(trader_dir, "fx_orders.json")) or {}).get("orders") or []
        for o in orders:
            if o.get("pair") == plan["pair"] and o.get("side") == plan.get("side"):
                lots, loss = o.get("lots"), o.get("max_loss")
                break
        lines.append(row("PLAN", plan["pair"], plan.get("side"), plan.get("entry"), plan.get("stop"),
                         plan.get("target"), lots, "lots" if lots != "" else "", loss,
                         plan.get("reward_risk"), "forex", mt5_time(plan.get("created"))))
        counts["plans"] += 1

    # stock plan from trader-exit (for brokers that offer stock CFDs), shares from trader-budget
    splan = load(os.path.join(trader_dir, "plan.json"))
    if splan and splan.get("symbol"):
        qty, loss = "", ""
        for o in (load(os.path.join(trader_dir, "orders.json")) or {}).get("orders") or []:
            if o.get("symbol") == splan["symbol"]:
                qty = o.get("qty", "")
                loss = (o.get("plan") or {}).get("max_loss", "")
                break
        created = splan.get("created") or (f"{splan['date']}T00:00:00-05:00" if splan.get("date") else None)
        lines.append(row("PLAN", splan["symbol"], splan.get("side", "buy"), splan.get("entry"),
                         splan.get("stop"), splan.get("target"), qty, "shares" if qty != "" else "",
                         loss, splan.get("reward_risk"), "stock", mt5_time(created)))
        counts["plans"] += 1
    return lines, counts


def write_atomic(path: str, lines: list[str]) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="ascii", newline="\r\n") as f:
        f.write("\n".join(lines) + "\n")
    for attempt in range(10):  # MT5 may be reading the file for a moment
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.3)
    raise OSError(f"could not replace {path} (is it open in another program?)")


def run_scan(pairs: str | None, config: str) -> str:
    cmd = [sys.executable, os.path.join(HERE, "fx.py"), "scan", "--write", "--config", config]
    if pairs:
        cmd.insert(3, pairs)
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        return "forex scan failed: " + ((p.stderr or p.stdout).strip().splitlines() or ["no output"])[-1]
    return ""


def cmd_export(a) -> int:
    while True:
        now = datetime.now(timezone.utc)
        note = run_scan(a.pairs, a.config) if a.scan else ""
        lines, c = build(a.trader_dir, a.max_stocks, now)
        write_atomic(a.out, lines)
        stamp = now.astimezone(fx.NY).strftime("%H:%M New York")
        print(f"{stamp}: wrote {a.out} ({c['fx']} forex pairs, {c['stocks']} stocks, "
              f"{c['plans']} plan{'s' if c['plans'] != 1 else ''}).")
        if note:
            print("  " + note)
        if not c["plans"]:
            print("  No plan yet: make one with fx.py plan ... --write (and size --write for lots).")
        if not a.every:
            print("Load JarvisSignals on a chart in MT5 to see it. Nothing was placed.")
            return 0
        time.sleep(max(1, a.every) * 60)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="write the signals file for MT5")
    e.add_argument("--out", default=default_out(), help="file to write (default: MT5 Common\\Files)")
    e.add_argument("--trader-dir", default="trader")
    e.add_argument("--config", default="trader/config.json")
    e.add_argument("--scan", action="store_true", help="run the forex scan first")
    e.add_argument("--pairs", help="pairs for --scan, e.g. EURUSD,GBPUSD,XAUUSD (default: majors, crosses, gold)")
    e.add_argument("--max-stocks", type=int, default=100, help="stock scanner hits to include (default 100)")
    e.add_argument("--every", type=float, metavar="MIN", help="repeat every MIN minutes until stopped (Ctrl+C)")
    sub.add_parser("where", help="print where the file goes")
    a = p.parse_args(argv)
    if a.cmd == "where":
        print(default_out())
        return 0
    try:
        return cmd_export(a)
    except KeyboardInterrupt:
        print("Stopped.")
        return 0
    except (OSError, fx.FxError) as err:
        print(f"mt5bridge: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
