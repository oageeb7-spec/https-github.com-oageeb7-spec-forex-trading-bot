# Strix security testing

[Strix](https://strix.ai) is an autonomous pentest agent. It spins up a Docker
sandbox and actively attacks a target, hunting for web-app flaws (SQLi, XSS,
auth bypass, SSRF, etc.). Only ever point it at something you own.

## Install

The `strix.ai/install` script host is blocked by this project's cloud network
policy, so install from PyPI instead:

```bash
uv tool install strix-agent   # provides the `strix` CLI
```

Strix runs scans inside Docker, so a working Docker daemon is required.

## Its own LLM key (required)

Strix drives itself with a **third-party** model — this is NOT your Anthropic
key. It reads two environment variables:

```bash
export STRIX_LLM="openrouter/z-ai/glm-5.3"   # any provider Strix supports
export LLM_API_KEY="your-key"
```

- Local: put these in your shell profile.
- Cloud sessions: add them under the environment's variables/secrets, and add
  the `uv tool install strix-agent` line to the setup script.

## Run

```bash
strix --target ./            # scan this working tree
strix --target http://localhost:8000   # scan a running service
```

## Caveat for this repo

This project is local CLI trading scripts plus `jarvis.py` — there is no web
server or HTTP endpoint, so Strix (a web-app attacker) has little to bite on
here. Use it against a deployed web target; for this code, a manual review of
the order-sending and credential paths is a better fit.
