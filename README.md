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

Without credentials JARVIS still runs skills directly: `/run alerts clock`,
`/run scanner daily --symbols TSLA,NVDA`. Type `/help` for commands.

**Safety:** JARVIS never places, approves or records orders. It can only *show* tickets;
sending an order stays a manual step through `/trader-broker` in Claude Code.
Data is free, delayed and unofficial. This is not financial advice.

Settings (env vars): `JARVIS_MODEL` (default `claude-opus-5-5`), `JARVIS_EFFORT`
(default `medium`), `JARVIS_TOOL_TIMEOUT` seconds (default 300).
Working files go in `trader/` (git-ignored).
