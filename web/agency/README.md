# The Agency Roster

A static website for browsing every agent in
[msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)
(MIT, © AgentLand Contributors).

- **Give any agent a job.** Each agent runs on Claude with its full brief as its
  instructions and hands back the real deliverable (code, copy, plans, reviews),
  in a chat you can keep refining. Pick Fast, Standard or Deep.
- **Autopilot.** Write one business goal. The Agents Orchestrator plans the
  work, picks specialists from the whole roster and runs them one after another,
  each building on the last, then writes a launch kit: what was built, a launch
  checklist, how the money comes in (as labelled estimates), what to measure and
  the risks. The agents produce the work; a person launches it. They cannot take
  payments, post, send email or spend money, so nothing goes out on its own.
- **Run a team.** Pick several agents and give them one job; each works in turn
  and builds on what the teammates before it delivered. Copy the full report.
- Search by role, skill or vibe, and filter by the repo's 18 divisions
- Open any agent to read its full brief, copy the prompt, or copy a one-line install command
- Pick a team and get one install script for Claude Code (`~/.claude/agents/`)
- Links are shareable: `index.html#engineering-backend-architect` opens that agent

## How agents run

- **Inside claude.ai** (the published Artifact): runs on the viewer's own Claude
  account. The first run asks the viewer to allow it.
- **Anywhere else** (GitHub Pages, localhost): the page asks for an Anthropic API
  key. The key is kept in that browser's localStorage and sent only to
  `api.anthropic.com` (Fast = Haiku, Standard = Sonnet, Deep = Opus). Usage is
  billed to that key. Only use your own key on a copy you control.

Agents can't browse the web or run code; they work from what you give them.
Chats are saved in your browser per agent.

## Files

| File | What it is |
| --- | --- |
| `template.html` | The page itself (styles, markup, script) |
| `index.html` | `template.html` wrapped in a full HTML document; generated |
| `agents.json` | Every agent's metadata and full brief; generated |
| `build.py` | Regenerates `index.html` and `agents.json` from a clone of the repo |

## Update to the latest agents

```bash
git clone --depth 1 https://github.com/msitarzewski/agency-agents.git /tmp/agency-agents
python3 web/agency/build.py /tmp/agency-agents
```

## Run locally

`index.html` loads `agents.json` with `fetch`, so serve the folder over HTTP:

```bash
cd web/agency && python3 -m http.server 8000
# open http://localhost:8000
```

Any static host works (GitHub Pages, Netlify, Cloudflare Pages): upload the
`web/agency` folder as-is.
