# Graph Report - https-github.com-oageeb7-spec-forex-trading-bot  (2026-11-04)

## Corpus Check
- 37 files · ~70,191 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: (none) 2)

## Summary
- 935 nodes · 2294 edges · 25 communities (24 shown, 1 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 76 edges (avg confidence: 0.85)
- Token cost: 233,412 input · 0 output

## Community Hubs (Navigation)
- Chart Scanner Script
- Entry Timer Script
- Time Machine Simulator
- Broker Ticket Script
- Exit Planner Script
- Price Alerts Script
- Position Sizing Script
- MT5 Forex Connector
- News Monitor Script
- Pelosi PTR Tracker
- Risk Check Script
- JARVIS Assistant Core
- Earnings Facts Script
- Forex Desk Script
- Order Approval Safeguards
- Entry and Exit Rules
- Scanner Setups
- Risk Limits Policy
- JARVIS Forex Features
- Earnings Analysis Concepts
- Alerts and Flat-by-Close
- Monte Carlo Replay Concepts
- News Sources and Tags
- Voice Mode
- Context7 MCP Config

## God Nodes (most connected - your core abstractions)
1. `JARVIS Trading Assistant` - 26 edges
2. `cmd_orb()` - 23 edges
3. `trader-risk (Risk Manager)` - 22 edges
4. `build_plan()` - 20 edges
5. `evaluate()` - 19 edges
6. `trader-broker (Order Executor)` - 19 edges
7. `check()` - 18 edges
8. `cmd_send()` - 17 edges
9. `main()` - 17 edges
10. `ScanError` - 17 edges

## Surprising Connections (you probably didn't know these)
- `/fxsend Command` --semantically_similar_to--> `trader-risk (Risk Manager)`  [INFERRED] [semantically similar]
  README.md → .claude/skills/trader-broker/SKILL.md
- `History: Same Rule on Past Sessions` --semantically_similar_to--> `Opening-Range Breakout Scan`  [INFERRED] [semantically similar]
  .claude/skills/trader-timemachine/SKILL.md → .claude/skills/trader-scanner/SKILL.md
- `JARVIS Trading Assistant` --references--> `trader-alerts (Price Alerts)`  [EXTRACTED]
  README.md → .claude/skills/trader-alerts/SKILL.md
- `JARVIS Trading Assistant` --references--> `trader-analyst (Earnings Analyst)`  [EXTRACTED]
  README.md → .claude/skills/trader-analyst/SKILL.md
- `JARVIS Trading Assistant` --references--> `trader-broker (Order Executor)`  [EXTRACTED]
  README.md → .claude/skills/trader-broker/SKILL.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Day-trade pipeline: entry -> exit plan -> sizing -> risk -> broker** — claude_skills_trader_entry_skill_trader_entry, claude_skills_trader_exit_skill_trader_exit, claude_skills_trader_timemachine_skill_trader_timemachine, claude_skills_trader_budget_skill_trader_budget, claude_skills_trader_risk_skill_trader_risk, claude_skills_trader_broker_skill_trader_broker, claude_skills_trader_alerts_skill_trader_alerts [EXTRACTED 1.00]
- **Shared trade-plan JSON handoff files** — trader_entry, trader_plan, trader_orders, trader_prices, trader_state_risk [INFERRED 0.85]
- **Order safety gates across stock and FX brokers** — claude_skills_trader_broker_skill_three_gate_approval, claude_skills_trader_broker_skill_needs_approval_permission, claude_skills_trader_broker_skill_paper_trading_default, claude_skills_trader_broker_skill_keys_never_in_chat, claude_skills_trader_forex_skill_fx_send_gate [INFERRED 0.85]
- **Day-Trade Skill Pipeline (scan -> news -> entry -> exit -> time machine -> budget -> risk -> broker)** — claude_skills_trader_scanner_skill_trader_scanner, claude_skills_trader_news_skill_trader_news, claude_skills_trader_entry_skill_trader_entry, claude_skills_trader_exit_skill_trader_exit, claude_skills_trader_timemachine_skill_trader_timemachine, claude_skills_trader_budget_skill_trader_budget, claude_skills_trader_risk_skill_trader_risk, claude_skills_trader_broker_skill_trader_broker [EXTRACTED 1.00]
- **Day-Trade Risk Limits** — claude_skills_trader_risk_skill_max_loss_per_trade, claude_skills_trader_risk_skill_reward_risk_minimum, claude_skills_trader_risk_skill_daily_loss_limit, claude_skills_trader_risk_skill_entry_window, claude_skills_trader_risk_skill_pdt_guard [EXTRACTED 1.00]
- **Daily Close Setups** — claude_skills_trader_scanner_skill_breakout_20d, claude_skills_trader_scanner_skill_bull_flag, claude_skills_trader_scanner_skill_reclaim_ma20, claude_skills_trader_scanner_skill_oversold, claude_skills_trader_scanner_skill_oversold_bounce [EXTRACTED 1.00]

## Communities (25 total, 1 thin omitted)

### Community 0 - "Chart Scanner Script"
Cohesion: 0.05
Nodes (53): _absorb(), build_universe(), chart_path(), classify(), clock_label(), cmd_daily(), cmd_orb(), confirm() (+45 more)

### Community 1 - "Entry Timer Script"
Cohesion: 0.06
Nodes (48): ampm(), bar_line(), chart_path(), chart_range(), cmd_check(), cmd_watch(), emit(), on_trigger() (+40 more)

### Community 2 - "Time Machine Simulator"
Cohesion: 0.05
Nodes (44): build_pool(), cents_away(), chart_result(), chart_url(), clock12(), clock24(), cmd_chart(), cmd_run() (+36 more)

### Community 3 - "Broker Ticket Script"
Cohesion: 0.09
Nodes (44): amount_numbers(), apply_fill(), _clock(), cmd_approve(), cmd_decline(), cmd_fill(), cmd_flatten(), cmd_log() (+36 more)

### Community 4 - "Exit Planner Script"
Cohesion: 0.08
Nodes (40): ampm(), atr_of(), build_plan(), cents(), cmd_plan(), cmd_show(), compute(), D() (+32 more)

### Community 5 - "Price Alerts Script"
Cohesion: 0.08
Nodes (40): active(), AlertError, cmd_add(), cmd_check(), cmd_clock(), cmd_list(), cmd_quote(), cmd_reset() (+32 more)

### Community 6 - "Position Sizing Script"
Cohesion: 0.07
Nodes (35): allocate(), bracket_order(), eastern_offset(), eastern_to_utc(), _f(), fresh_price(), load_config(), load_prices() (+27 more)

### Community 7 - "MT5 Forex Connector"
Cohesion: 0.10
Nodes (49): account(), broker_numbers(), check_order(), cmd_account(), cmd_check(), cmd_positions(), cmd_preview(), cmd_send() (+41 more)

### Community 8 - "News Monitor Script"
Cohesion: 0.07
Nodes (31): cik_map(), collect(), collect_moves(), dedupe(), eastern_offset(), Fetcher, fingerprint(), _json_ready() (+23 more)

### Community 9 - "Pelosi PTR Tracker"
Cohesion: 0.07
Nodes (33): _amount(), describe(), download(), _fetch_and_read(), _finish(), iso(), load_index(), load_state() (+25 more)

### Community 10 - "Risk Check Script"
Cohesion: 0.07
Nodes (34): account(), business_days(), _cent(), check(), day_trades(), eastern_offset(), eastern_to_utc(), _f() (+26 more)

### Community 11 - "JARVIS Assistant Core"
Cohesion: 0.08
Nodes (25): Brain, ensure_config(), ensure_forex_config(), entry_time_now(), exit_plan(), find_pairs(), find_tickers(), first_price() (+17 more)

### Community 12 - "Earnings Facts Script"
Cohesion: 0.08
Nodes (25): analyse(), changes(), clean_title(), _date(), exhibit_name(), facts_for(), FactsError, Fetcher (+17 more)

### Community 13 - "Forex Desk Script"
Cohesion: 0.15
Nodes (28): analyse(), atr(), cmd_clock(), cmd_pips(), cmd_plan(), cmd_quote(), cmd_scan(), cmd_size() (+20 more)

### Community 14 - "Order Approval Safeguards"
Cohesion: 0.17
Nodes (8): Alpaca MCP server (alpaca-mcp-server), Bracket order (stop-loss + take-profit), Alpaca place_stock_order tool, trader-broker (Order Executor), Cash buffer, Max loss per trade, trader-budget (Budget Manager), Weights mode (budget split across a list)

### Community 15 - "Entry and Exit Rules"
Cohesion: 0.18
Nodes (12): Entry window (no entries before 9:45 or after 15:30), Level setup, Long side only, Opening range (first 15 minutes), Opening-range breakout (ORB), trader-entry (Entry Timer), Volume check (--min-volume-x), ATR stop (14-bar) (+4 more)

### Community 16 - "Scanner Setups"
Cohesion: 0.17
Nodes (13): breakout_20d Setup, bull_flag Setup, Daily Pre-Market Scan, Nasdaq Trader Symbol Directory, NYSE Holidays and Early Closes 2026-2027, oversold Setup (RSI14 < 30), oversold_bounce Setup, reclaim_ma20 Setup (+5 more)

### Community 17 - "Risk Limits Policy"
Cohesion: 0.17
Nodes (9): Daily Loss Limit, Entry Window (no_entries_before/after), FINRA Regulatory Notice 26-10, Max Loss Per Trade, PASS / BLOCK Verdict, Reward:Risk Minimum, trader-risk (Risk Manager), Starter Config ($5,000 budget, $50 max loss, paper) (+1 more)

### Community 18 - "JARVIS Forex Features"
Cohesion: 0.20
Nodes (11): FX Sessions (Sydney, Tokyo, London, New York), /fxsend Command, Gold and Silver (XAUUSD / XAGUSD), JARVIS Trading Assistant, JARVIS Env Settings (JARVIS_OFFLINE, JARVIS_MODEL, JARVIS_EFFORT, JARVIS_TOOL_TIMEOUT), OANDA, Pip Math and Lot Sizing, Built-in Rule-Based Brain (offline) (+3 more)

### Community 19 - "Earnings Analysis Concepts"
Cohesion: 0.18
Nodes (6): Earnings 8-K item 2.02 / EX-99.1 press release, One-off flag (net income above operating income), SEC EDGAR XBRL company facts, trader-analyst (Earnings Analyst), Trailing twelve months (TTM), trader/watchlist.json

### Community 20 - "Alerts and Flat-by-Close"
Cohesion: 0.22
Nodes (8): NYSE Clock (hours, 2026/2027 holidays, early closes), Stooq CSV quotes, trader-alerts (Price Alerts), Yahoo chart JSON quotes, Flatten ticket (close by flat_by), Interactive Brokers connector, Flat by time (15:55, no overnight hold), FX sessions (Sydney, Tokyo, London, New York, overlap)

### Community 21 - "Monte Carlo Replay Concepts"
Cohesion: 0.32
Nodes (4): History: Same Rule on Past Sessions, Monte Carlo Replay (10,000 sessions), R Multiple, trader-timemachine (Time Machine)

### Community 22 - "News Sources and Tags"
Cohesion: 0.38
Nodes (7): Important 8-K Items (2.02, 5.02, 2.06, 3.01, 4.02, 1.03, 1.05), News Tags (earnings, analyst, legal, deal, halt, regulatory, macro), SEC EDGAR 8-K Atom Feed, sec_user_agent Config, trader-news (News Monitor), Yahoo Finance Chart Endpoint, Yahoo Finance Headline RSS

### Community 23 - "Voice Mode"
Cohesion: 0.50
Nodes (4): Google Web Speech Recognizer, PyAudio, pyttsx3, SpeechRecognition

## Knowledge Gaps
- **45 isolated node(s):** `trader/metrics.json`, `trader/alerts.json`, `trader/state/alerts.json`, `SEC EDGAR XBRL company facts`, `Earnings 8-K item 2.02 / EX-99.1 press release` (+40 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 301 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `JARVIS Trading Assistant` connect `JARVIS Forex Features` to `MT5 Forex Connector`, `Pelosi PTR Tracker`, `JARVIS Assistant Core`, `Forex Desk Script`, `Order Approval Safeguards`, `Entry and Exit Rules`, `Scanner Setups`, `Risk Limits Policy`, `Earnings Analysis Concepts`, `Alerts and Flat-by-Close`, `Monte Carlo Replay Concepts`, `News Sources and Tags`, `Voice Mode`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **What connects `trader/metrics.json`, `trader/alerts.json`, `trader/state/alerts.json` to the rest of the system?**
  _45 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Chart Scanner Script` be split into smaller, more focused modules?**
  _Cohesion score 0.0515406162464986 - nodes in this community are weakly interconnected._
- **Why does `trader-scanner (Chart Scanner)` connect `Scanner Setups` to `Chart Scanner Script`, `Pelosi PTR Tracker`, `Entry and Exit Rules`, `JARVIS Forex Features`, `News Sources and Tags`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Should `Entry Timer Script` be split into smaller, more focused modules?**
  _Cohesion score 0.06049213943950786 - nodes in this community are weakly interconnected._
- **Why does `trader-risk (Risk Manager)` connect `Risk Limits Policy` to `Pelosi PTR Tracker`, `Risk Check Script`, `Order Approval Safeguards`, `Entry and Exit Rules`, `JARVIS Forex Features`, `Earnings Analysis Concepts`, `Alerts and Flat-by-Close`, `News Sources and Tags`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Should `Time Machine Simulator` be split into smaller, more focused modules?**
  _Cohesion score 0.05251141552511415 - nodes in this community are weakly interconnected._