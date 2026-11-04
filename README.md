# JARVIS — trading assistant

JARVIS is a terminal assistant that answers trading questions in plain English by running the
trader skills in `.claude/skills/` (scanner, news, entry, exit, time machine, budget, risk,
broker tickets, alerts, earnings, Congress trades). Claude picks the skill, runs it and
summarises the output.

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...     # or: ant auth login
python jarvis.py                         # chat
python jarvis.py "is the market open?"  # one question
```

Examples: "is the market open?", "scan TSLA, NVDA and AMD for setups", "any news on my
watchlist?", "how did Apple's last quarter look?", "what has Pelosi filed lately?".

**No API key? It still works.** Without a key JARVIS uses a built-in rule-based brain that
understands the common requests: market clock, quotes, news, scans, opening-range
breakouts, entries, trade plans ("plan TSLA entry 364.20 stop 358 target 380"), the time
machine, position sizing, risk checks, tickets, alerts, earnings and Congress trades. With a key
(`ANTHROPIC_API_KEY`) Claude handles free-form conversation instead. Switch with `/local` or
`/claude`. `/run <tool> <args>` runs any skill script directly. Type `/help` for examples.

On first run JARVIS creates `trader/config.json` with starter rules ($5,000 budget, $50 max
loss a trade, paper trading). Say "show my rules", or "set budget to 10000" / "set max loss to 100".
Set `sec_user_agent` in that file to your name and email for the SEC (news, earnings).

**Safety:** JARVIS never places, approves or records orders. It can only *show* tickets;
sending an order stays a manual step through `/trader-broker` in Claude Code.
Data is free, delayed and unofficial. This is not financial advice.

Settings (env vars): `JARVIS_OFFLINE=1` forces the built-in brain; `JARVIS_MODEL` (default `claude-opus-5-5`), `JARVIS_EFFORT`
(default `medium`), `JARVIS_TOOL_TIMEOUT` seconds (default 300).
Working files go in `trader/` (git-ignored).
