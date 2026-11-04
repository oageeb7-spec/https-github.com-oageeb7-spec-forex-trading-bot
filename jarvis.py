#!/usr/bin/env python3
"""JARVIS - a trading assistant for this repo.

Talk to it in plain English ("is the market open?", "scan for breakouts",
"any news on TSLA?", "plan a trade on NVDA at 182.40 with the stop at the
range low"). Claude decides which trader skill to run, runs the script in
.claude/skills/, reads the output and answers.

Safety: JARVIS never places, approves or records an order. The broker skill
is limited to `show` (rendering tickets). Sending an order stays a manual
step through trader-broker's three gates.

Without an API key it uses a built-in rule-based brain, so plain English
still works for the common requests; /run <tool> <args...> runs any skill.

Usage:
    pip install -r requirements.txt
    export ANTHROPIC_API_KEY=sk-ant-...      # or: ant auth login
    python jarvis.py                          # interactive
    python jarvis.py "is the market open?"    # one question, then exit
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SKILLS = ROOT / ".claude" / "skills"
MODEL = os.environ.get("JARVIS_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("JARVIS_EFFORT", "medium")
TOOL_TIMEOUT = int(os.environ.get("JARVIS_TOOL_TIMEOUT", "300"))
MAX_OUTPUT_CHARS = 30_000

# tool name -> (script, allowed subcommands or None for scripts without
# subcommands, description for Claude)
TOOLS: dict[str, tuple[str, set[str] | None, str]] = {
    "alerts": (
        "trader-alerts/alerts.py",
        {"clock", "quote", "check", "add", "list", "reset"},
        "NYSE clock and delayed quotes, and price alerts. "
        "`clock` = is the market open; `quote TSLA AAPL` = latest delayed quotes; "
        "`add --symbol TSLA --above 400` / `add --from-plan` = add alert rules; "
        "`check` = ring alerts that hit.",
    ),
    "analyst": (
        "trader-analyst/facts.py",
        None,
        "Earnings from SEC EDGAR: revenue, margins, EPS, quarter vs a year earlier. "
        "Args: tickers, e.g. `AAPL KO --quarters 6`.",
    ),
    "broker": (
        "trader-broker/ticket.py",
        {"show"},
        "Render the order tickets in trader/orders.json (READ ONLY - `show` only). "
        "JARVIS cannot approve or place orders.",
    ),
    "budget": (
        "trader-budget/size.py",
        None,
        "Position sizing from trader/plan.json against the user's limits. "
        "`--budget 5000` overrides the budget; `--write` writes trader/orders.json.",
    ),
    "entry": (
        "trader-entry/entry.py",
        {"check", "watchlist"},
        "Entry timer. `check TSLA` = opening-range breakout status now "
        "(`--setup level --level 182.5` for a level break; `--write` saves trader/entry.json); "
        "`watchlist` = check every hit in trader/watchlist.json.",
    ),
    "exit": (
        "trader-exit/exit.py",
        {"plan", "show"},
        "Stop and target. `plan --symbol TSLA --entry 364.2 --or-high 365 --or-low 358 "
        "[--stop or-mid|or-low|price:X|pct:X|atr:K] [--target 2R|1R|price:X] --write`; "
        "`plan` with no symbol plans from trader/entry.json; `show` = current plan.",
    ),
    "news": (
        "trader-news/news.py",
        None,
        "Breaking news, 8-K filings and moves. `--tickers TSLA NVDA` (default: watchlist, "
        "plan and portfolio); `--hours 24`; `--all` shows seen items too.",
    ),
    "pelosi": (
        "trader-pelosi/ptr.py",
        {"index", "new", "fetch"},
        "Congress stock trades (House PTRs). `index --member Pelosi --limit 20`; "
        "`new --read` = new filings since last check, parsed; `fetch DOC_ID`.",
    ),
    "risk": (
        "trader-risk/check.py",
        None,
        "Pre-trade risk check of trader/orders.json: PASS or BLOCK with reasons. No args needed.",
    ),
    "scanner": (
        "trader-scanner/scan.py",
        {"universe", "daily", "orb"},
        "Chart scanner. `daily --symbols TSLA,NVDA,AMD` or `daily --limit 300` = "
        "pre-market setups (breakouts, bull flags, oversold); `orb --symbols ...` = "
        "opening-range breakouts today; `universe` = rebuild the symbol list. "
        "Full-universe scans are slow - prefer --symbols or --limit.",
    ),
    "timemachine": (
        "trader-timemachine/timemachine.py",
        {"run", "chart"},
        "Monte Carlo replay of trader/plan.json: odds of target vs stop. "
        "`run` (optionally `--replays 2000`), `chart`.",
    ),
    "forex": (
        "trader-forex/fx.py",
        {"clock", "quote", "pips", "plan", "size", "scan"},
        "Forex (currency pairs like EURUSD, GBPJPY). `clock` = is FX open, live sessions; "
        "`quote EURUSD GBPJPY` = rates and change in pips; `pips EURUSD 1.0850 1.0820` = pip "
        "distance and pip value per lot; `plan EURUSD --side buy|sell --entry 1.0850 --stop "
        "1.0820|pips:30 [--target 2R|pips:60|PRICE] --write` = trade plan (entry defaults to the "
        "latest rate); `size [--account 10000] [--risk-pct 1] --write` = lots from "
        "trader/fx_plan.json; `scan [EURUSD,GBPUSD]` = trend, 20-day breakouts, RSI, ATR in pips "
        "(default: majors and crosses).",
    ),
}

SYSTEM_PROMPT = """You are JARVIS, a calm, concise trading assistant for one user.
You work through tools that run the trader skill scripts in this repository
(standard-library Python that reads free delayed data: Yahoo, Stooq, SEC EDGAR,
Nasdaq Trader, the House Clerk). Each tool takes `args`: the command-line
arguments for that script, as a list of strings.

How to work:
- Use the tools to get real data. Never invent prices, news or numbers.
- The pipeline for a day trade is: scanner -> news -> entry -> exit -> timemachine
  -> budget -> risk -> broker. Files pass between steps under trader/.
- Forex is separate: forex clock -> forex scan -> forex quote -> forex plan ->
  forex size. Stock tools (scanner, entry, budget, risk, broker) do not handle
  currency pairs. Forex can be bought or sold short; stocks here are long only.
- Keep scans small (--symbols or --limit) unless the user asks for a full scan.
- If a script errors, read the message, fix the arguments and try again once;
  otherwise explain what went wrong.
- Answer briefly: lead with the answer, then the key numbers.

Hard limits:
- You cannot place, approve or record orders. If the user wants to trade, show the
  ticket (broker show) and tell them to send it themselves through /trader-broker
  in Claude Code, which asks for their explicit yes.
- Present data neutrally. You are not a financial adviser; do not tell the user
  to buy or sell. Data is delayed and may be incomplete.
"""


def tool_definitions() -> list[dict]:
    defs = []
    for name, (_, subs, desc) in TOOLS.items():
        if subs:
            desc += " First arg must be one of: " + ", ".join(sorted(subs)) + "."
        defs.append({
            "name": name,
            "description": desc + " Append `--help` to see all options.",
            "strict": True,
            "input_schema": {
                "type": "object",
                "properties": {
                    "args": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Command-line arguments for the script.",
                    }
                },
                "required": ["args"],
                "additionalProperties": False,
            },
        })
    return defs


CONFIG = ROOT / "trader" / "config.json"


def ensure_config() -> bool:
    """Create trader/config.json from the example on first run. True if created."""
    if CONFIG.exists():
        return False
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    example = SKILLS / "trader-budget" / "config.example.json"
    CONFIG.write_text(example.read_text())
    return True


FOREX_DEFAULTS = {"account_size": 10000, "account_currency": "USD", "risk_pct": 1.0,
                  "max_loss_per_trade": None, "max_leverage": 30, "min_reward_risk": 1.5,
                  "min_lot_step": 0.01, "max_lots": 10}


def ensure_forex_config() -> None:
    cfg = json.loads(CONFIG.read_text())
    if "forex" not in cfg:
        cfg["forex"] = dict(FOREX_DEFAULTS)
        CONFIG.write_text(json.dumps(cfg, indent=2) + "\n")


SETTINGS = {  # phrase -> config key ("forex.x" = inside the forex section)
    "forex account": "forex.account_size", "account size": "forex.account_size",
    "fx account": "forex.account_size", "risk percent": "forex.risk_pct",
    "risk %": "forex.risk_pct", "risk per trade": "forex.risk_pct",
    "leverage": "forex.max_leverage", "max lots": "forex.max_lots",
    "budget": "budget", "max loss": "max_loss_per_trade_usd",
    "daily loss": "max_daily_loss_usd", "max order": "max_order_usd",
    "trades per day": "max_trades_per_day", "cash buffer": "cash_buffer_pct",
    "position cap": "max_position_pct", "reward": "min_reward_risk",
}


def update_setting(text: str) -> str | None:
    t = text.lower()
    ensure_config()
    ensure_forex_config()
    if not re.search(r"\b(set|change|make|update)\b", t):
        return None
    for phrase, key in SETTINGS.items():
        m = re.search(re.escape(phrase) + r"[^\d]{0,20}\$?([\d,]+(?:\.\d+)?)\s*(k\b)?", t)
        if m:
            val = float(m.group(1).replace(",", "")) * (1000 if m.group(2) else 1)
            cfg = json.loads(CONFIG.read_text())
            val = int(val) if val.is_integer() else val
            if key.startswith("forex."):
                cfg.setdefault("forex", dict(FOREX_DEFAULTS))[key[6:]] = val
            else:
                cfg[key] = val
            CONFIG.write_text(json.dumps(cfg, indent=2) + "\n")
            return f"Done: {key} = {val} (saved in trader/config.json)."
    return None


def show_settings() -> str:
    ensure_config()
    ensure_forex_config()
    cfg = json.loads(CONFIG.read_text())
    keys = ["budget", "max_loss_per_trade_usd", "max_daily_loss_usd", "max_trades_per_day",
            "max_order_usd", "max_position_pct", "cash_buffer_pct", "min_reward_risk",
            "no_entries_before", "no_entries_after", "flat_by", "paper"]
    fx = cfg.get("forex", {})
    extra = (f"\nForex: account {fx.get('account_size')} {fx.get('account_currency')}, risk "
             f"{fx.get('risk_pct')}% a trade, leverage cap {fx.get('max_leverage')}:1, "
             f"max {fx.get('max_lots')} lots, min reward:risk {fx.get('min_reward_risk')}")
    lines = [f"  {k:24} {cfg.get(k)}" for k in keys]
    return ("Your trading rules (trader/config.json):\n" + "\n".join(lines) +
            extra + "\nChange one by saying e.g. \"set budget to 10000\", \"set max loss to 100\" or "
            "\"set forex account to 25000\".")


def run_tool(name: str, args: list[str]) -> tuple[str, bool]:
    """Run one skill script. Returns (output, is_error)."""
    if name not in TOOLS:
        return f"Unknown tool {name!r}. Tools: {', '.join(TOOLS)}", True
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        return "args must be a list of strings", True
    script, subs, _ = TOOLS[name]
    is_help = args[:1] in (["--help"], ["-h"])
    if subs is not None and not is_help:
        if not args or args[0] not in subs:
            return f"{name}: first arg must be one of {sorted(subs)}", True
    path = SKILLS / script
    if not path.exists():
        return f"Script missing: {path}", True
    (ROOT / "trader" / "state").mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            [sys.executable, str(path), *args],
            cwd=ROOT, capture_output=True, text=True, timeout=TOOL_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return f"Timed out after {TOOL_TIMEOUT}s. Try a smaller scan.", True
    out = (proc.stdout or "") + (("\n[stderr]\n" + proc.stderr) if proc.stderr.strip() else "")
    out = out.strip() or "(no output)"
    if len(out) > MAX_OUTPUT_CHARS:
        out = out[:MAX_OUTPUT_CHARS] + f"\n... [truncated, {len(out)} chars total]"
    return out, proc.returncode != 0


# ---------------------------------------------------------------- Claude mode

class Brain:
    def __init__(self) -> None:
        import anthropic  # imported here so command mode works without it
        self.anthropic = anthropic
        self.client = anthropic.Anthropic()
        self.tools = tool_definitions()
        self.messages: list = []

    def _create(self):
        return self.client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            tools=self.tools,
            messages=self.messages,
            thinking={"type": "adaptive"},
            output_config={"effort": EFFORT},
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
        )

    def ask(self, text: str) -> str:
        self.messages.append({"role": "user", "content": text})
        for _ in range(25):  # cap tool rounds per question
            resp = self._create()
            self.messages.append({"role": "assistant", "content": resp.content})
            if resp.stop_reason == "refusal":
                return "I can't help with that one."
            if resp.stop_reason == "pause_turn":
                continue
            calls = [b for b in resp.content if b.type == "tool_use"]
            if resp.stop_reason != "tool_use" or not calls:
                text_out = "\n".join(b.text for b in resp.content if b.type == "text").strip()
                if resp.stop_reason == "max_tokens":
                    text_out += "\n[answer cut off]"
                return text_out or "(no answer)"
            results = []
            for call in calls:
                args = call.input.get("args", []) if isinstance(call.input, dict) else []
                print(f"  > {call.name} {shlex.join(args)}", flush=True)
                out, err = run_tool(call.name, args)
                results.append({"type": "tool_result", "tool_use_id": call.id,
                                "content": out, "is_error": err})
            self.messages.append({"role": "user", "content": results})
        return "Stopped after too many steps. Ask me again more specifically."


# ---------------------------------------------------------------- local mode
# Works with no API key: matches what you typed to a skill with simple rules.

import re

NAMES = {
    "apple": "AAPL", "tesla": "TSLA", "nvidia": "NVDA", "microsoft": "MSFT",
    "amazon": "AMZN", "google": "GOOGL", "alphabet": "GOOGL", "meta": "META",
    "facebook": "META", "netflix": "NFLX", "amd": "AMD", "intel": "INTC",
    "palantir": "PLTR", "coca-cola": "KO", "coke": "KO", "disney": "DIS",
    "boeing": "BA", "walmart": "WMT", "jpmorgan": "JPM", "berkshire": "BRK-B",
    "spy": "SPY", "qqq": "QQQ", "s&p": "SPY", "nasdaq": "QQQ", "bitcoin": "BTC-USD",
    "coinbase": "COIN", "uber": "UBER", "broadcom": "AVGO", "oracle": "ORCL",
}
NOT_TICKERS = {
    "I", "A", "AN", "AND", "OR", "THE", "IS", "IT", "ME", "MY", "ON", "IN", "OF",
    "TO", "FOR", "AT", "BY", "UP", "DO", "GO", "NO", "OK", "SO", "US", "WE", "AM",
    "PM", "NYSE", "ORB", "ATR", "EPS", "CEO", "SEC", "ETF", "USD", "RSI", "IPO",
    "PTR", "JSON", "API", "AI", "WHAT", "HOW", "WHY", "WHEN", "ANY", "NEWS",
}
COMMON = {"aapl", "tsla", "nvda", "msft", "amzn", "googl", "goog", "meta", "nflx",
          "amd", "intc", "pltr", "spy", "qqq", "coin", "avgo", "orcl", "smci", "mstr",
          "ko", "dis", "ba", "wmt", "jpm", "uber", "shop", "sofi", "hood", "arm"}


def find_tickers(text: str) -> list[str]:
    hits: list[tuple[int, str]] = []
    for m in re.finditer(r"\$([A-Za-z]{1,5}(?:[.-][A-Za-z])?)", text):
        hits.append((m.start(), m.group(1).upper()))
    low = text.lower()
    for name, t in NAMES.items():
        for m in re.finditer(r"(?<![a-z$])" + re.escape(name) + r"(?![a-z])", low):
            hits.append((m.start(), t))
    for m in re.finditer(r"(?<![$\w])[A-Za-z][A-Za-z.-]{0,5}", text):
        w = m.group(0).rstrip(".-")
        if (w.isupper() and 1 <= len(w) <= 5 and w not in NOT_TICKERS) or w.lower() in COMMON:
            hits.append((m.start(), w.upper()))
    out: list[str] = []
    for _, t in sorted(hits):
        if t not in out:
            out.append(t)
    return out


def first_price(text: str) -> float | None:
    m = re.search(r"(?<![\w.])\$?(\d+(?:\.\d+)?)(?![\w%])", text)
    return float(m.group(1)) if m else None


def entry_time_now() -> str:
    """Current New York time on a 5-minute bar close, kept inside the session."""
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("America/New_York"))
    mins = now.hour * 60 + now.minute
    mins = min(max(mins - mins % 5, 9 * 60 + 45), 15 * 60 + 25)
    h, m = divmod(mins, 60)
    return f"{(h - 1) % 12 + 1}:{m:02d} {'AM' if h < 12 else 'PM'}"


def exit_plan(text: str, ticker: str) -> list[tuple[str, list[str]]]:
    t = text.lower()
    entry = re.search(r"(?:entry|enter|in at|at|@)\s*\$?(\d+(?:\.\d+)?)", t)
    price = float(entry.group(1)) if entry else first_price(text)
    args = ["plan", "--symbol", ticker, "--entry", str(price)]
    stop = re.search(r"stop(?:\s*(?:at|loss|of))?\s*\$?(\d+(?:\.\d+)?)(\s*%)?", t)
    target = re.search(r"target(?:\s*(?:at|of))?\s*\$?(\d+(?:\.\d+)?)(\s*r\b)?", t)
    say = []
    if stop:
        args += ["--stop", ("pct:" if stop.group(2) else "price:") + stop.group(1)]
    else:
        args += ["--stop", "pct:1"]
        say = [("_say", ["(No stop given, so I used 1% below the entry. Say e.g. \"stop 358\" to set it.)"])]
    tm = re.search(r"\b(\d{1,2}:\d{2})\s*(am|pm)?", t)
    if tm:
        args += ["--time", tm.group(1) + (" " + tm.group(2).upper() if tm.group(2) else "")]
    else:
        args += ["--time", entry_time_now()]
    if target:
        args += ["--target", (target.group(1) + "R") if target.group(2) else "price:" + target.group(1)]
    return [("exit", args + ["--write"]), *say]


def has(text: str, *words: str) -> bool:
    return any(re.search(r"\b" + w, text) for w in words)


FX_CCY = {"USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK",
          "SGD", "HKD", "MXN", "ZAR", "TRY", "PLN", "CNH", "CNY", "INR"}
FX_NAMES = {"cable": "GBPUSD", "fiber": "EURUSD", "fibre": "EURUSD", "euro": "EURUSD",
            "pound": "GBPUSD", "sterling": "GBPUSD", "yen": "USDJPY", "gopher": "USDJPY",
            "loonie": "USDCAD", "aussie": "AUDUSD", "kiwi": "NZDUSD", "swissie": "USDCHF",
            "franc": "USDCHF", "guppy": "GBPJPY", "geppy": "GBPJPY"}


def find_pairs(text: str) -> list[str]:
    hits: list[tuple[int, str]] = []
    for m in re.finditer(r"(?<![A-Za-z])([A-Za-z]{3})\s*[/_-]?\s*([A-Za-z]{3})(?![A-Za-z])", text):
        a, b = m.group(1).upper(), m.group(2).upper()
        spaced = re.search(r"\s", m.group(0)) is not None
        if spaced and not (m.group(1).isupper() and m.group(2).isupper()):
            continue  # "try usd" is not the lira; "TRY USD" or "tryusd" is
        if a in FX_CCY and b in FX_CCY and a != b:
            hits.append((m.start(), a + b))
    low = text.lower()
    for name, pair in FX_NAMES.items():
        for m in re.finditer(r"\b" + name + r"s?\b", low):
            hits.append((m.start(), pair))
    out: list[str] = []
    for _, p in sorted(hits):
        if p not in out:
            out.append(p)
    return out


def fx_numbers(text: str) -> list[float]:
    return [float(x) for x in re.findall(r"(?<![\w.])(\d+\.\d+|\d+)(?![\w%])", text)]


def route_forex(text: str, pairs: list[str]) -> list[tuple[str, list[str]]] | str:
    t = text.lower()
    if has(t, "open", "session", "clock", "closed", "hours", "weekend") and not has(t, "plan", "trade", "lots"):
        return [("forex", ["clock"])]
    if has(t, "scan", "setup", "breakout", "breaking", "trend", "oversold", "overbought", "which pair", "what pair", "movers"):
        return [("forex", ["scan", ",".join(pairs)] if len(pairs) > 1 else ["scan"])]
    if not pairs and has(t, "lots", "size", "how many", "position"):
        args = ["size", "--write"]
        m = re.search(r"\$?([\d,]+(?:\.\d+)?)\s*(k\b)?\s*(?:account|balance)|account (?:of )?\$?([\d,]+)\s*(k\b)?", t)
        if m:
            num, k = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
            args += ["--account", str(float(num.replace(",", "")) * (1000 if k else 1))]
        r = re.search(r"(\d+(?:\.\d+)?)\s*%", t)
        if r:
            args += ["--risk-pct", r.group(1)]
        return [("forex", args)]
    if not pairs:
        if has(t, "plan"):
            return "Which pair? e.g. \"plan EURUSD buy at 1.0850 stop 1.0820 target 2R\"."
        return [("forex", ["clock"]), ("forex", ["quote"])]
    pair = pairs[0]
    if has(t, "pip") and len(fx_numbers(text)) >= 2 and not has(t, "plan", "stop"):
        n = fx_numbers(text)
        return [("forex", ["pips", pair, str(n[0]), str(n[1])])]
    if has(t, "plan", "stop", "target", "long", "short", "buy", "sell", "trade"):
        side = "sell" if has(t, "sell", "short") else "buy"
        args = ["plan", pair, "--side", side]
        e = re.search(r"(?:entry|enter|at|@|from)\s*(\d+\.?\d*)", t)
        if e:
            args += ["--entry", e.group(1)]
        st = re.search(r"stop(?:\s*(?:at|loss|of))?\s*(\d+\.?\d*)\s*(pips?|p\b)?", t)
        if st:
            args += ["--stop", ("pips:" + st.group(1)) if st.group(2) else st.group(1)]
        else:
            args += ["--stop", "pips:30"]
        tg = re.search(r"target(?:\s*(?:at|of))?\s*(\d+\.?\d*)\s*(pips?|p\b|r\b)?", t)
        if tg:
            unit = (tg.group(2) or "").lower()
            args += ["--target", tg.group(1) + "R" if unit == "r" else
                     ("pips:" + tg.group(1)) if unit.startswith("p") else tg.group(1)]
        out = [("forex", args + ["--write"])]
        if not st:
            out.append(("_say", ["(No stop given, so I used 30 pips. Say e.g. \"stop 1.0820\" or \"stop 25 pips\".)"]))
        if has(t, "lots", "size", "how many"):
            out.append(("forex", ["size", "--write"]))
        return out
    return [("forex", ["quote", *pairs])]


def route(text: str) -> list[tuple[str, list[str]]] | str:
    """Map a plain-English request to tool runs, or return a reply string."""
    t = text.lower()
    pairs = find_pairs(text)
    if pairs or has(t, "forex", "\\bfx\\b", "currenc", "\\bpips?\\b", "how many lots", "lot size"):
        if not has(t, "set ", "change ", "update ", "my rules", "settings"):
            return route_forex(text, pairs)
    tickers = find_tickers(text)
    syms = ",".join(tickers)

    if has(t, "my rules", "settings", "my limits", "config"):
        if not has(t, "set ", "change", "update"):
            return show_settings()
    changed = update_setting(text)
    if changed:
        return changed
    if has(t, "hello", "hi\\b", "hey", "thank"):
        return "At your service. Ask about quotes, news, scans, earnings, Congress trades or a trade plan. /help lists examples."
    if has(t, "pelosi", "congress", "politician", "senator", "representative"):
        member = re.search(r"(pelosi|[A-Z][a-z]+(?= (?:trades|bought|sold|filed)))", text, re.I)
        args = ["index", "--limit", "20"]
        if member:
            args += ["--member", member.group(1)]
        return [("pelosi", args)]
    if has(t, "market open", "is the market", "market hours", "opening bell", "clock", "market close", "open today", "closed today", "holiday"):
        return [("alerts", ["clock"])]
    if has(t, "earning", "revenue", "margin", "quarter", "10-q", "10-k", "eps", "profit"):
        if not tickers:
            return "Which company? e.g. \"earnings for AAPL\"."
        return [("analyst", tickers[:3])]
    if has(t, "news", "headline", "why is .* moving", "8-k", "briefing", "what happened"):
        return [("news", ["--tickers", *tickers] if tickers else [])]
    if has(t, "plan", "stop", "target") and tickers and first_price(text):
        return exit_plan(text, tickers[0])
    if has(t, "opening range", "orb\\b"):
        if has(t, "scan", "find", "which", "what", "breakouts"):
            return [("scanner", ["orb", "--symbols", syms] if tickers else ["orb", "--limit", "200"])]
        if tickers:
            return [("entry", ["check", tickers[0]])]
    if has(t, "scan", "setup", "breaking out", "breakout", "bull flag", "oversold", "watchlist", "what should i"):
        if has(t, "watchlist") and has(t, "check", "entry", "trigger"):
            return [("entry", ["watchlist"])]
        return [("scanner", ["daily", "--symbols", syms] if tickers else ["daily", "--limit", "200"])]
    if has(t, "entry", "get in", "broken out", "broke out", "triggered"):
        if not tickers:
            return [("entry", ["watchlist"])]
        args = ["check", tickers[0]]
        lvl = first_price(text)
        if lvl and has(t, "above", "level", "break"):
            args += ["--setup", "level", "--level", str(lvl)]
        return [("entry", args)]
    if has(t, "time machine", "odds", "simulate", "monte carlo", "backtest", "replay", "coin flip"):
        return [("timemachine", ["run", "--replays", "2000"])]
    if has(t, "stop", "target", "exit", "plan", "risk reward", "my r\\b", "get out"):
        if tickers and first_price(text):
            return exit_plan(text, tickers[0])
        if has(t, "make", "set", "new", "create") and not tickers:
            return [("exit", ["plan", "--write"])]
        return [("exit", ["show"])]
    if has(t, "how many shares", "size", "position siz", "budget", "how much should"):
        m = re.search(r"\$?([\d,]+(?:\.\d+)?)\s*(k\b)?", t)
        args = []
        if m and has(t, "budget", "have", "with", "\\$"):
            amt = float(m.group(1).replace(",", "")) * (1000 if m.group(2) else 1)
            args = ["--budget", str(amt)]
        return [("budget", [*args, "--write"])]
    if has(t, "risk", "safe", "check my order"):
        return [("risk", [])]
    if has(t, "ticket", "order", "buy", "sell", "place", "execute"):
        return [("broker", ["show"]),
                ("_say", ["JARVIS can't place orders. To send one, use /trader-broker in Claude Code, which asks for your yes."])]
    if has(t, "alert"):
        if tickers and first_price(text):
            side = "--below" if has(t, "below", "under", "drop", "falls") else "--above"
            return [("alerts", ["add", "--symbol", tickers[0], side, str(first_price(text))])]
        if has(t, "check", "ring", "hit"):
            return [("alerts", ["check"])]
        return [("alerts", ["list"])]
    if tickers or has(t, "price", "quote", "trading at", "how much is"):
        if not tickers:
            return "Which ticker? e.g. \"price of TSLA\"."
        return [("alerts", ["quote", *tickers])]
    return ("I didn't catch that. Try: \"is the market open?\", \"price of TSLA\", \"news on NVDA\", "
            "\"scan AAPL MSFT AMD\", \"earnings for KO\", \"what is Pelosi trading?\" or /help.")


def local_answer(text: str) -> str:
    plan = route(text)
    if isinstance(plan, str):
        return plan
    parts = []
    for name, args in plan:
        if name == "_say":
            parts.append(args[0])
            continue
        print(f"  > {name} {shlex.join(args)}", flush=True)
        out, err = run_tool(name, args)
        if err and name == "alerts" and args[:1] == ["quote"]:
            print("  > Yahoo failed, trying Stooq", flush=True)
            out2, err2 = run_tool(name, [*args, "--source", "stooq"])
            if not err2:
                out, err = out2, err2
        parts.append(("[problem] " if err else "") + out)
    return "\n\n".join(parts)


# ---------------------------------------------------------------- the shell

HELP = """Ask in plain English, for example:
  is the market open?            price of TSLA and NVDA
  news on AAPL                   scan TSLA NVDA AMD for setups
  opening range breakouts in SPY earnings for KO
  has TSLA broken out?           plan TSLA entry 364.20
  what are the odds?             how many shares with a $5000 budget
  risk check                     show my order tickets
  alert me if NVDA goes above 200   what is Pelosi trading?

Forex:
  is forex open?                 price of EURUSD and cable
  scan the forex majors          pip value EURUSD 1.0850 1.0820
  plan EURUSD buy at 1.0850 stop 1.0820 target 2R
  short GBPJPY stop 40 pips target 80 pips    how many lots, 1% risk
  set forex account to 25000     set leverage to 50

Commands:
  /run <tool> <args>   run a skill script directly, e.g. /run alerts clock
  /tools               list tools        /local  /claude   switch brain
  /reset               forget the chat   /help   /quit"""


def handle_run(line: str) -> None:
    parts = shlex.split(line)[1:]
    if not parts:
        print("usage: /run <tool> <args...>   tools: " + ", ".join(TOOLS))
        return
    out, err = run_tool(parts[0], parts[1:])
    print(out if not err else "[error]\n" + out)


def has_credentials() -> bool:
    if os.environ.get("JARVIS_OFFLINE"):
        return False
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return True
    cfg = Path(os.environ.get("ANTHROPIC_CONFIG_DIR", Path.home() / ".config" / "anthropic"))
    return cfg.is_dir() and any(cfg.iterdir())


def make_brain(quiet: bool = False) -> Brain | None:
    if not has_credentials():
        if not quiet:
            print("(No Claude API key found - using JARVIS's built-in brain. "
                  "Set ANTHROPIC_API_KEY for full conversation.)")
        return None
    try:
        return Brain()
    except ImportError:
        print("(anthropic package missing - pip install -r requirements.txt. Using built-in brain.)")
    except Exception as e:
        print(f"(Claude unavailable: {e}. Using built-in brain.)")
    return None


class Session:
    def __init__(self, quiet: bool = False) -> None:
        self.brain = make_brain(quiet)

    def answer(self, text: str) -> None:
        if self.brain is None:
            print("\nJARVIS: " + local_answer(text) + "\n")
            return
        b = self.brain
        a = b.anthropic
        fallback = None
        try:
            print("\nJARVIS: " + b.ask(text) + "\n")
        except (a.AuthenticationError, a.PermissionDeniedError, TypeError):
            fallback = "Claude rejected the API key"
            self.brain = None
        except a.RateLimitError:
            fallback = "Claude is rate limited"
        except a.APIConnectionError:
            fallback = "can't reach Claude"
        except a.APIStatusError as e:
            fallback = f"Claude error {e.status_code}"
        if fallback:
            del b.messages[:]  # start clean next time
            print(f"({fallback} - answering with the built-in brain.)")
            print("\nJARVIS: " + local_answer(text) + "\n")


def main(argv: list[str]) -> int:
    if ensure_config():
        print("(First run: created trader/config.json with starter rules - $5,000 budget, "
              "$50 max loss a trade, paper trading; forex $10,000 account, 1% risk. "
              "Say \"show my rules\" to see them.)")
    ensure_forex_config()
    session = Session(quiet=bool(argv))
    if argv:
        q = " ".join(argv)
        if q.startswith("/run"):
            handle_run(q)
        else:
            session.answer(q)
        return 0
    mode = "Claude" if session.brain else "built-in"
    print(f"JARVIS online ({mode} brain). Ask me about the market, or /help.")
    while True:
        try:
            line = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye.")
            return 0
        if not line:
            continue
        cmd = line.split()[0].lower()
        if cmd in ("/quit", "/exit", "quit", "exit", "bye"):
            print("Goodbye.")
            return 0
        if cmd in ("/help", "help", "?"):
            print(HELP)
        elif cmd == "/tools":
            for n, (_, _, d) in TOOLS.items():
                print(f"  {n:12} {d.split('. ')[0]}")
        elif cmd == "/reset":
            if session.brain:
                session.brain.messages.clear()
            print("Conversation cleared.")
        elif cmd == "/local":
            session.brain = None
            print("Using the built-in brain.")
        elif cmd == "/claude":
            session.brain = make_brain()
            print("Using Claude." if session.brain else "Still on the built-in brain.")
        elif cmd == "/run":
            handle_run(line)
        else:
            session.answer(line)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
