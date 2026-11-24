# The Agency Roster

A static website for browsing every agent in
[msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents)
(MIT, © AgentLand Contributors).

- Search by role, skill or vibe, and filter by the repo's 18 divisions
- Open any agent to read its full brief, copy the prompt, or copy a one-line install command
- Pick a team and get one install script for Claude Code (`~/.claude/agents/`)
- Links are shareable: `index.html#backend-architect` opens that agent

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
