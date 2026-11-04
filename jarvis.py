#!/usr/bin/env python3
"""JARVIS - a trading assistant for this repo.

Talk to it in plain English ("is the market open?", "scan for breakouts",
"any news on TSLA?", "plan a trade on NVDA at 182.40 with the stop at the
range low"). Claude decides which trader skill to run, runs the script in
.claude/skills/, reads the output and answers.

Safety: JARVIS never places, approves or records an order. The broker skill
is limited to `show` (rendering tickets). Sending an order stays a manual
step through trader-broker's three gates.

Without credentials it still runs in command mode:  /run <tool> <args...>

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


# ---------------------------------------------------------------- the shell

HELP = """Commands:
  <anything>             ask JARVIS in plain English (needs Claude credentials)
  /run <tool> <args>     run a skill script directly, e.g. /run alerts clock
  /tools                 list tools
  /reset                 forget the conversation
  /help                  this help
  /quit                  exit"""


def handle_run(line: str) -> None:
    parts = shlex.split(line)[1:]
    if not parts:
        print("usage: /run <tool> <args...>   tools: " + ", ".join(TOOLS))
        return
    out, err = run_tool(parts[0], parts[1:])
    print(out if not err else "[error]\n" + out)


def make_brain() -> Brain | None:
    try:
        return Brain()
    except ImportError:
        print("! The anthropic package is not installed: pip install -r requirements.txt")
    except Exception as e:  # missing credentials raise at construction
        print(f"! Claude is not available ({e.__class__.__name__}: {e}).")
        print("  Set ANTHROPIC_API_KEY or run `ant auth login`.")
    print("  Command mode only: /run <tool> <args>. Type /help.")
    return None


def answer(brain: Brain | None, text: str) -> None:
    if brain is None:
        print("I need Claude credentials to understand plain English. Try /run alerts clock")
        return
    a = brain.anthropic
    try:
        print("\nJARVIS: " + brain.ask(text) + "\n")
    except a.AuthenticationError:
        print("! Invalid API key. Check ANTHROPIC_API_KEY.")
        brain.messages.pop()
    except a.RateLimitError:
        print("! Rate limited. Wait a moment and try again.")
        brain.messages.pop()
    except a.APIStatusError as e:
        print(f"! Claude API error {e.status_code}: {e.message}")
        brain.messages.clear()
    except a.APIConnectionError:
        print("! Can't reach the Claude API. Check your connection.")
        brain.messages.pop()
    except TypeError as e:  # raised when no credentials could be resolved
        print(f"! No Claude credentials: {e}\n  Set ANTHROPIC_API_KEY or run `ant auth login`.")
        brain.messages.clear()


def main(argv: list[str]) -> int:
    brain = make_brain()
    if argv:
        q = " ".join(argv)
        if q.startswith("/run"):
            handle_run(q)
        else:
            answer(brain, q)
        return 0
    print("JARVIS online. Ask me about the market, or /help.")
    while True:
        try:
            line = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye.")
            return 0
        if not line:
            continue
        cmd = line.split()[0].lower()
        if cmd in ("/quit", "/exit", "quit", "exit"):
            print("Goodbye.")
            return 0
        if cmd == "/help":
            print(HELP)
        elif cmd == "/tools":
            for n, (_, _, d) in TOOLS.items():
                print(f"  {n:12} {d.split('. ')[0]}")
        elif cmd == "/reset":
            if brain:
                brain.messages.clear()
            print("Conversation cleared.")
        elif cmd == "/run":
            handle_run(line)
        else:
            answer(brain, line)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
