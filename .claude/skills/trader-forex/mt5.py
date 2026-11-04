#!/usr/bin/env python3
"""MetaTrader 5 connection for trader-forex (STARTRADER or any MT5 broker).

Uses MetaQuotes' official `MetaTrader5` Python package, which talks to the
MT5 terminal running on the same Windows PC. Install the terminal from your
broker (STARTRADER: startrader.com -> Platforms -> MT5), log in once, then:

    pip install MetaTrader5

  account                 balance, equity, margin, leverage (read only)
  positions               open positions (read only)
  symbol EURUSD           the broker's symbol name and contract details (read only)
  check  [--index 1]      risk-check the proposed order in trader/fx_orders.json
                          with the broker's own contract size and tick value
  preview [--index 1]     the exact MT5 order request (read only)
  send --index 1 --confirm "<the user's own words>"
                          send ONE market order with stop-loss and take-profit.
                          Refused unless the risk check passes, the reply is an
                          explicit yes, and - for a REAL account - MT5_ALLOW_LIVE=1.

Login (optional if the terminal is already logged in), from the environment only:
  MT5_LOGIN  MT5_PASSWORD  MT5_SERVER   (e.g. the server name shown in MT5's login box)
  MT5_PATH   path to terminal64.exe if MT5 is not in the default place
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fx  # noqa: E402
from oanda import (BrokerError, YES, NO_WORDS, fingerprint, load_orders,  # noqa: E402
                   load_state, pick, save_state)

MAGIC = 26110401
mt5 = None


def connect():
    global mt5
    if mt5 is not None:
        return mt5
    try:
        import MetaTrader5 as m
    except ImportError:
        raise BrokerError(
            "the MetaTrader5 package is not installed. It runs on Windows next to the MT5 "
            "terminal: install MT5 from your broker (STARTRADER: startrader.com -> MT5), "
            "log in once, then run: pip install MetaTrader5")
    kw = {}
    if os.environ.get("MT5_PATH"):
        kw["path"] = os.environ["MT5_PATH"]
    if os.environ.get("MT5_LOGIN"):
        try:
            kw["login"] = int(os.environ["MT5_LOGIN"])
        except ValueError:
            raise BrokerError("MT5_LOGIN must be your account number")
        kw["password"] = os.environ.get("MT5_PASSWORD", "")
        kw["server"] = os.environ.get("MT5_SERVER", "")
    if not m.initialize(**kw):
        raise BrokerError(f"could not connect to the MT5 terminal: {m.last_error()}. Is MT5 "
                          "installed, open and logged in? Check MT5_LOGIN / MT5_SERVER.")
    mt5 = m
    return m


def account():
    a = connect().account_info()
    if a is None:
        raise BrokerError(f"MT5 is not logged in to an account: {mt5.last_error()}")
    return a


def mode_name(a) -> str:
    return {0: "DEMO", 1: "CONTEST", 2: "REAL"}.get(a.trade_mode, f"mode {a.trade_mode}")


def resolve_symbol(pair: str) -> str:
    """The broker's name for a pair: EURUSD, EURUSD.s, EURUSD+, GOLD..."""
    m = connect()
    if m.symbol_info(pair) is not None:
        name = pair
    else:
        aliases = [pair]
        if pair == "XAUUSD":
            aliases += ["GOLD"]
        if pair == "XAGUSD":
            aliases += ["SILVER"]
        cands = [s.name for s in (m.symbols_get() or [])
                 if any(s.name.upper().startswith(a) for a in aliases)]
        if not cands:
            raise BrokerError(f"your broker has no symbol for {pair}")
        cands.sort(key=lambda n: (len(n), n))
        name = cands[0]
    if not m.symbol_select(name, True):
        raise BrokerError(f"could not add {name} to Market Watch")
    return name


def broker_numbers(o: dict) -> dict:
    """Recompute volume and loss with the broker's own contract details."""
    m = connect()
    sym = resolve_symbol(o["pair"])
    info = m.symbol_info(sym)
    tick = m.symbol_info_tick(sym)
    if info is None or tick is None:
        raise BrokerError(f"no price for {sym} (market closed or symbol disabled)")
    step = info.volume_step or 0.01
    vol = math.floor(float(o["lots"]) / step + 1e-9) * step
    vol = round(min(vol, info.volume_max), 8)
    price = tick.ask if o["side"] == "buy" else tick.bid
    per_lot_per_unit_move = info.trade_tick_value / info.trade_tick_size
    loss = vol * abs(price - o["stop_loss"]) * per_lot_per_unit_move
    gain = vol * abs(o["take_profit"] - price) * per_lot_per_unit_move
    return {"symbol": sym, "info": info, "volume": vol, "price": price, "loss": loss,
            "gain": gain, "spread": tick.ask - tick.bid}


def filling(info) -> int:
    fm = getattr(info, "filling_mode", 0)
    if fm & 1:
        return mt5.ORDER_FILLING_FOK
    if fm & 2:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN


def request(o: dict, n: dict) -> dict:
    d = n["info"].digits
    return {
        "action": mt5.TRADE_ACTION_DEAL, "symbol": n["symbol"], "volume": n["volume"],
        "type": mt5.ORDER_TYPE_BUY if o["side"] == "buy" else mt5.ORDER_TYPE_SELL,
        "price": n["price"], "sl": round(o["stop_loss"], d), "tp": round(o["take_profit"], d),
        "deviation": 20, "magic": MAGIC, "comment": "jarvis " + fingerprint(o)[:8],
        "type_time": mt5.ORDER_TIME_GTC, "type_filling": filling(n["info"]),
    }


def check_order(o: dict, n: dict, cfg: dict, plan: dict | None, state: dict, acct) -> list[str]:
    problems = []
    if not o.get("stop_loss") or not o.get("take_profit"):
        problems.append("stop-loss and take-profit are both required")
    info = n["info"]
    if n["volume"] < info.volume_min:
        problems.append(f"{o['lots']} lots is under the broker's minimum {info.volume_min}")
    sgn = 1 if o["side"] == "buy" else -1
    if (o["stop_loss"] - n["price"]) * sgn >= 0:
        problems.append(f"the price ({n['price']}) is already past the stop - re-plan")
    if (o["take_profit"] - n["price"]) * sgn <= 0:
        problems.append(f"the price ({n['price']}) is already past the target - re-plan")
    balance = acct.balance
    allowed = balance * cfg["risk_pct"] / 100
    if cfg.get("max_loss_per_trade"):
        allowed = min(allowed, cfg["max_loss_per_trade"])
    if n["loss"] > allowed * 1.02:
        problems.append(f"loss at the stop {n['loss']:,.2f} {acct.currency} is over your limit "
                        f"{allowed:,.2f} ({cfg['risk_pct']}% of the real balance {balance:,.2f})")
    if plan and plan.get("reward_risk", 99) < cfg["min_reward_risk"]:
        problems.append(f"reward:risk {plan['reward_risk']} is under your minimum {cfg['min_reward_risk']}")
    if n["volume"] > cfg["max_lots"]:
        problems.append(f"{n['volume']} lots is over max_lots {cfg['max_lots']}")
    if fingerprint(o) in {s["fingerprint"] for s in state.get("sent", []) if s.get("status") == "sent"}:
        problems.append("this exact order was already sent")
    chk = mt5.order_check(request(o, n))
    if chk is None:
        problems.append(f"MT5 order check failed: {mt5.last_error()}")
    elif chk.retcode not in (0, getattr(mt5, "TRADE_RETCODE_DONE", 10009)):
        problems.append(f"MT5 says: {chk.comment} (code {chk.retcode})")
    return problems


def ticket(o: dict, n: dict, acct, index: int) -> str:
    p = o["pair"]
    d = n["info"].digits
    return (f"ORDER {index}: {o['side'].upper()} {n['volume']} lots {n['symbol']} at market "
            f"(~{n['price']:.{d}f}, spread {n['spread']:.{d}f}), {acct.company} {mode_name(acct)} "
            f"account {acct.login}\n"
            f"  stop-loss {o['stop_loss']:.{d}f}   take-profit {o['take_profit']:.{d}f}\n"
            f"  loss at the stop ~{n['loss']:,.2f} {acct.currency}, gain at target ~{n['gain']:,.2f} "
            f"(broker's contract size {n['info'].trade_contract_size:g} for {p})")


# ------------------------------------------------------------------ commands

def _load(a):
    o = pick(load_orders(a.orders), a.index)
    cfg = fx.load_config(a.config)
    plan = json.load(open(a.plan)) if os.path.exists(a.plan) else None
    return o, cfg, plan


def cmd_account(a) -> int:
    x = account()
    print(f"{x.company} - {mode_name(x)} account {x.login} on {x.server} ({x.currency})")
    for label, v in (("Balance", x.balance), ("Equity", x.equity), ("Margin used", x.margin),
                     ("Free margin", x.margin_free), ("Leverage", f"1:{x.leverage}"),
                     ("Profit", x.profit)):
        print(f"  {label:12} {v:,.2f}" if isinstance(v, float) else f"  {label:12} {v}")
    if x.trade_mode == 2:
        print("  This is a REAL money account. Sending needs MT5_ALLOW_LIVE=1.")
    return 0


def cmd_positions(a) -> int:
    account()
    ps = mt5.positions_get() or ()
    if not ps:
        print("No open positions.")
    for p in ps:
        side = "buy" if p.type == 0 else "sell"
        print(f"  {p.symbol:10} {side:4} {p.volume:>6} lots @ {p.price_open}  sl {p.sl}  tp {p.tp}  "
              f"P/L {p.profit:,.2f}  #{p.ticket}")
    return 0


def cmd_symbol(a) -> int:
    account()
    sym = resolve_symbol(fx.norm_pair(a.pair))
    i = mt5.symbol_info(sym)
    t = mt5.symbol_info_tick(sym)
    print(f"{a.pair.upper()} -> {sym}: bid {t.bid} ask {t.ask}, contract {i.trade_contract_size:g}, "
          f"lots {i.volume_min}-{i.volume_max} step {i.volume_step}, digits {i.digits}")
    return 0


def cmd_check(a) -> int:
    acct = account()
    o, cfg, plan = _load(a)
    n = broker_numbers(o)
    problems = check_order(o, n, cfg, plan, load_state(a.state), acct)
    print(ticket(o, n, acct, a.index))
    if problems:
        print("BLOCK: " + "; ".join(problems))
        return 1
    print("PASS: inside your forex rules and accepted by MT5's order check. "
          "Sending still needs your explicit yes.")
    return 0


def cmd_preview(a) -> int:
    acct = account()
    o, _, _ = _load(a)
    n = broker_numbers(o)
    print(ticket(o, n, acct, a.index))
    print(json.dumps(request(o, n), indent=2, default=str))
    print("Nothing was sent.")
    return 0


def cmd_send(a) -> int:
    reply = (a.confirm or "").strip()
    if not YES.match(reply) or NO_WORDS.search(reply):
        raise BrokerError(f"not sent: {reply!r} is not an explicit yes")
    acct = account()
    if acct.trade_mode == 2 and os.environ.get("MT5_ALLOW_LIVE") != "1":
        raise BrokerError(f"not sent: account {acct.login} is a REAL money account. Set "
                          "MT5_ALLOW_LIVE=1 to allow live orders, or log MT5 in to a demo account.")
    o, cfg, plan = _load(a)
    n = broker_numbers(o)
    state = load_state(a.state)
    problems = check_order(o, n, cfg, plan, state, acct)
    if problems:
        raise BrokerError("not sent, risk check BLOCK: " + "; ".join(problems))
    req = request(o, n)
    entry = {"time": datetime.now(timezone.utc).isoformat(), "broker": "mt5",
             "account": acct.login, "mode": mode_name(acct), "fingerprint": fingerprint(o),
             "order": o, "request": {k: str(v) for k, v in req.items()}, "reply": reply}
    res = mt5.order_send(req)
    if res is None or res.retcode != mt5.TRADE_RETCODE_DONE:
        why = mt5.last_error() if res is None else f"{res.comment} (code {res.retcode})"
        entry.update(status="failed", error=str(why))
        state["sent"].append(entry)
        save_state(a.state, state)
        raise BrokerError(f"MT5 did not fill the order: {why}")
    entry.update(status="sent", fill_price=res.price, deal=res.deal, order_ticket=res.order)
    state["sent"].append(entry)
    save_state(a.state, state)
    print(f"SENT to {acct.company} ({mode_name(acct)} {acct.login}): {o['side']} {n['volume']} lots "
          f"{n['symbol']}, filled at {res.price}, order #{res.order}")
    print(f"Stop-loss {req['sl']} and take-profit {req['tp']} are attached in MT5.")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mt5.py", description="MetaTrader 5 connection for trader-forex")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("account")
    sub.add_parser("positions")
    p = sub.add_parser("symbol")
    p.add_argument("pair")
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
        return {"account": cmd_account, "positions": cmd_positions, "symbol": cmd_symbol,
                "check": cmd_check, "preview": cmd_preview, "send": cmd_send}[a.cmd](a)
    except (BrokerError, fx.FxError) as e:
        print(f"mt5.py: {e}", file=sys.stderr)
        return 2
    finally:
        if mt5 is not None:
            mt5.shutdown()


if __name__ == "__main__":
    sys.exit(main())
