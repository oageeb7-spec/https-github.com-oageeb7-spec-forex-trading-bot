#!/usr/bin/env python3
"""OANDA connection for trader-forex. Standard library only.

  account                 balance, NAV, margin used, open trades (read only)
  positions               open positions (read only)
  check  [--index 1]      risk-check the proposed order in trader/fx_orders.json
  preview [--index 1]     the exact order JSON that would be sent (read only)
  send --index 1 --confirm "<the user's own words>"
                          send ONE order. Refused unless the risk check passes,
                          the confirmation is an explicit yes, and (for a live
                          account) OANDA_ALLOW_LIVE=1 is set.

Credentials come from the environment, never from chat:
  OANDA_API_TOKEN   personal access token (OANDA: Manage API Access)
  OANDA_ACCOUNT_ID  e.g. 101-001-1234567-001
  OANDA_ENV         practice (default) or live
Practice is a demo account with fake money: the default, and the place to start.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fx  # noqa: E402

HOSTS = {"practice": "https://api-fxpractice.oanda.com", "live": "https://api-fxtrade.oanda.com"}
YES = re.compile(r"^\s*(yes|y|yep|yeah|confirm|confirmed|send it|do it|go|place it)\b[\s.!]*", re.I)
NO_WORDS = re.compile(r"\b(no|not|don'?t|cancel|stop|wait|hold)\b", re.I)


class BrokerError(Exception):
    pass


def env() -> str:
    e = os.environ.get("OANDA_ENV", "practice").lower()
    if e not in HOSTS:
        raise BrokerError("OANDA_ENV must be practice or live")
    return e


def base_url() -> str:
    return os.environ.get("OANDA_BASE_URL") or HOSTS[env()]


def creds() -> tuple[str, str]:
    tok, acct = os.environ.get("OANDA_API_TOKEN"), os.environ.get("OANDA_ACCOUNT_ID")
    if not tok or not acct:
        raise BrokerError(
            "not connected: set OANDA_API_TOKEN and OANDA_ACCOUNT_ID in your shell "
            "(never paste them into a chat). Get a free practice account at oanda.com, "
            "then Manage API Access -> generate a token.")
    return tok, acct


def api(method: str, path: str, body: dict | None = None) -> dict:
    tok, _ = creds()
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base_url() + path, data=data, method=method, headers={
        "Authorization": f"Bearer {tok}", "Content-Type": "application/json",
        "Accept-Datetime-Format": "RFC3339"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get("errorMessage", "")
        except Exception:
            msg = ""
        if e.code == 401:
            raise BrokerError("OANDA rejected the token (401). Check OANDA_API_TOKEN and OANDA_ENV.")
        raise BrokerError(f"OANDA answered HTTP {e.code}: {msg}")
    except urllib.error.URLError as e:
        raise BrokerError(f"could not reach OANDA: {e.reason}")


def instrument(pair: str) -> str:
    return f"{pair[:3]}_{pair[3:]}"


# ------------------------------------------------------------------ orders

def load_orders(path: str) -> list[dict]:
    if not os.path.exists(path):
        raise BrokerError(f"no proposed orders at {path} (plan and size a trade first)")
    return json.load(open(path)).get("orders", [])


def pick(orders: list[dict], index: int) -> dict:
    if not 1 <= index <= len(orders):
        raise BrokerError(f"no order #{index} (there are {len(orders)})")
    return orders[index - 1]


def fingerprint(o: dict) -> str:
    keys = ("pair", "side", "units", "stop_loss", "take_profit")
    return hashlib.sha256(json.dumps([o.get(k) for k in keys]).encode()).hexdigest()[:16]


def order_body(o: dict) -> dict:
    p = o["pair"]
    units = int(o["units"]) * (1 if o["side"] == "buy" else -1)
    return {"order": {
        "type": "MARKET", "instrument": instrument(p), "units": str(units),
        "timeInForce": "FOK", "positionFill": "DEFAULT",
        "stopLossOnFill": {"price": fx.fmt(p, o["stop_loss"]), "timeInForce": "GTC"},
        "takeProfitOnFill": {"price": fx.fmt(p, o["take_profit"]), "timeInForce": "GTC"},
        "clientExtensions": {"comment": "jarvis", "tag": fingerprint(o)},
    }}


def risk_check(o: dict, cfg: dict, plan: dict | None, state: dict) -> list[str]:
    """Return the reasons to BLOCK (empty = PASS)."""
    problems = []
    if not o.get("stop_loss"):
        problems.append("no stop-loss")
    if not o.get("take_profit"):
        problems.append("no take-profit")
    if int(o.get("units", 0)) <= 0:
        problems.append("zero size")
    allowed = cfg["account_size"] * cfg["risk_pct"] / 100
    if cfg.get("max_loss_per_trade"):
        allowed = min(allowed, cfg["max_loss_per_trade"])
    if o.get("max_loss", 0) > allowed * 1.01:
        problems.append(f"max loss {o['max_loss']:.2f} is over your limit of {allowed:.2f}")
    if plan and plan.get("reward_risk", 99) < cfg["min_reward_risk"]:
        problems.append(f"reward:risk {plan['reward_risk']} is under your minimum {cfg['min_reward_risk']}")
    if o.get("lots", 0) > cfg["max_lots"]:
        problems.append(f"{o['lots']} lots is over max_lots {cfg['max_lots']}")
    if not fx.market_status(datetime.now(timezone.utc))["open"]:
        problems.append("the FX market is closed for the weekend")
    if fingerprint(o) in {s["fingerprint"] for s in state.get("sent", []) if s.get("status") == "sent"}:
        problems.append("this exact order was already sent")
    return problems


def load_state(path: str) -> dict:
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return {"sent": []}


def save_state(path: str, state: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    json.dump(state, open(path, "w"), indent=2)


def ticket(o: dict, index: int) -> str:
    p = o["pair"]
    acct = os.environ.get("OANDA_ENV", "practice").upper()
    unit = "oz" if fx.is_metal(p) else "units"
    return (f"ORDER {index}: {o['side'].upper()} {o['units']:,} {unit} {p[:3]}/{p[3:]} "
            f"({o['lots']} lots), market, {acct} account\n"
            f"  stop-loss {fx.fmt(p, o['stop_loss'])}   take-profit {fx.fmt(p, o['take_profit'])}\n"
            f"  max loss at the stop ~{o['max_loss']:,.2f} {o.get('account_currency', 'USD')} "
            f"(before spread and slippage)")


# ------------------------------------------------------------------ commands

def cmd_account(a) -> int:
    _, acct = creds()
    s = api("GET", f"/v3/accounts/{acct}/summary")["account"]
    print(f"OANDA {env().upper()} account {acct} ({s.get('currency')})")
    for k, label in (("balance", "Balance"), ("NAV", "NAV"), ("unrealizedPL", "Unrealized P/L"),
                     ("marginUsed", "Margin used"), ("marginAvailable", "Margin available"),
                     ("openTradeCount", "Open trades"), ("pendingOrderCount", "Pending orders")):
        print(f"  {label:17} {s.get(k)}")
    return 0


def cmd_positions(a) -> int:
    _, acct = creds()
    ps = api("GET", f"/v3/accounts/{acct}/openPositions").get("positions", [])
    if not ps:
        print("No open positions.")
    for p in ps:
        for side in ("long", "short"):
            u = p.get(side, {})
            if u.get("units") and u["units"] != "0":
                print(f"  {p['instrument']:8} {side:5} {u['units']:>10} @ {u.get('averagePrice')}  "
                      f"P/L {u.get('unrealizedPL')}")
    return 0


def cmd_check(a) -> int:
    o = pick(load_orders(a.orders), a.index)
    cfg = fx.load_config(a.config)
    plan = json.load(open(a.plan)) if os.path.exists(a.plan) else None
    problems = risk_check(o, cfg, plan, load_state(a.state))
    print(ticket(o, a.index))
    if problems:
        print("BLOCK: " + "; ".join(problems))
        return 1
    print("PASS: inside your forex rules. Sending still needs your explicit yes.")
    return 0


def cmd_preview(a) -> int:
    o = pick(load_orders(a.orders), a.index)
    print(ticket(o, a.index))
    print(f"POST {base_url()}/v3/accounts/<OANDA_ACCOUNT_ID>/orders")
    print(json.dumps(order_body(o), indent=2))
    print("Nothing was sent.")
    return 0


def cmd_send(a) -> int:
    reply = (a.confirm or "").strip()
    if not YES.match(reply) or NO_WORDS.search(reply):
        raise BrokerError(f"not sent: {reply!r} is not an explicit yes")
    if env() == "live" and os.environ.get("OANDA_ALLOW_LIVE") != "1":
        raise BrokerError("not sent: this is a LIVE (real money) account. Set OANDA_ALLOW_LIVE=1 "
                          "to allow live orders, or use OANDA_ENV=practice.")
    orders = load_orders(a.orders)
    o = pick(orders, a.index)
    cfg = fx.load_config(a.config)
    plan = json.load(open(a.plan)) if os.path.exists(a.plan) else None
    state = load_state(a.state)
    problems = risk_check(o, cfg, plan, state)
    if problems:
        raise BrokerError("not sent, risk check BLOCK: " + "; ".join(problems))
    _, acct = creds()
    entry = {"time": datetime.now(timezone.utc).isoformat(), "env": env(),
             "fingerprint": fingerprint(o), "order": o, "reply": reply}
    try:
        res = api("POST", f"/v3/accounts/{acct}/orders", order_body(o))
    except BrokerError as e:
        entry.update(status="failed", error=str(e))
        state["sent"].append(entry)
        save_state(a.state, state)
        raise
    fill = res.get("orderFillTransaction")
    cancel = res.get("orderCancelTransaction")
    if cancel and not fill:
        entry.update(status="canceled", reason=cancel.get("reason"))
        state["sent"].append(entry)
        save_state(a.state, state)
        raise BrokerError(f"OANDA canceled the order: {cancel.get('reason')}")
    entry.update(status="sent", fill_price=(fill or {}).get("price"),
                 trade_id=((fill or {}).get("tradeOpened") or {}).get("tradeID"))
    state["sent"].append(entry)
    save_state(a.state, state)
    print(f"SENT to OANDA {env().upper()}: {o['side']} {o['units']} {instrument(o['pair'])}"
          + (f", filled at {entry['fill_price']}" if entry["fill_price"] else "")
          + (f", trade {entry['trade_id']}" if entry["trade_id"] else ""))
    print(f"Stop-loss {fx.fmt(o['pair'], o['stop_loss'])} and take-profit "
          f"{fx.fmt(o['pair'], o['take_profit'])} are attached at OANDA.")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="oanda.py", description="OANDA connection for trader-forex")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("account")
    sub.add_parser("positions")
    for name in ("check", "preview", "send"):
        p = sub.add_parser(name)
        p.add_argument("--index", type=int, default=1)
        p.add_argument("--orders", default="trader/fx_orders.json")
        p.add_argument("--plan", default="trader/fx_plan.json")
        p.add_argument("--config", default="trader/config.json")
        p.add_argument("--state", default="trader/state/fx_broker.json")
        if name == "send":
            p.add_argument("--confirm", required=True, help="the user's reply, word for word")
    a = ap.parse_args(argv)
    try:
        return {"account": cmd_account, "positions": cmd_positions, "check": cmd_check,
                "preview": cmd_preview, "send": cmd_send}[a.cmd](a)
    except BrokerError as e:
        print(f"oanda.py: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
