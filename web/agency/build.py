#!/usr/bin/env python3
"""Build the Agency Roster website from a clone of msitarzewski/agency-agents.

Usage:
    git clone --depth 1 https://github.com/msitarzewski/agency-agents.git /path/to/agency-agents
    python3 web/agency/build.py /path/to/agency-agents

Writes web/agency/index.html (template.html in a full page) and agents.json. Serve the folder with any
static host (GitHub Pages, Netlify, `python3 -m http.server`); index.html
fetches agents.json, so opening it straight from disk (file://) will not work.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # small fallback for flat "key: value" frontmatter
    yaml = None

HERE = Path(__file__).resolve().parent
REPO_URL = "https://github.com/msitarzewski/agency-agents"


def parse_frontmatter(text):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.S)
    if not m:
        return None, text
    raw, body = m.group(1), text[m.end():]
    if yaml:
        try:
            meta = yaml.safe_load(raw) or {}
        except yaml.YAMLError:
            meta = None
        if isinstance(meta, dict):
            return meta, body
    meta = {}
    for line in raw.splitlines():
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip().strip("'\"")
    return meta, body


def clean(v):
    return re.sub(r"\s+", " ", str(v)).strip() if v is not None else ""


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1]).resolve()
    divisions = json.loads((src / "divisions.json").read_text())["divisions"]

    try:
        commit = subprocess.run(["git", "-C", str(src), "log", "-1", "--format=%h|%cs"],
                                capture_output=True, text=True, check=True).stdout.strip()
        sha, date = commit.split("|")
    except Exception:
        sha, date = "", ""

    agents, seen = [], set()
    for div in sorted(divisions):
        for path in sorted((src / div).rglob("*.md")):
            meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
            if not meta or not meta.get("name"):
                continue
            rel = path.relative_to(src).as_posix()
            slug = re.sub(r"[^a-z0-9-]+", "-", path.stem.lower()).strip("-")
            base, n = slug, 2
            while slug in seen:
                slug, n = f"{base}-{n}", n + 1
            seen.add(slug)
            sub = path.parent.relative_to(src / div).as_posix()
            agents.append({
                "slug": slug,
                "name": clean(meta.get("name")),
                "division": div,
                "group": "" if sub == "." else sub,
                "description": clean(meta.get("description")),
                "vibe": clean(meta.get("vibe")),
                "emoji": clean(meta.get("emoji")),
                "path": rel,
                "words": len(body.split()),
                "body": body.strip(),
            })

    counts = {d: 0 for d in divisions}
    for a in agents:
        counts[a["division"]] += 1
    out = {
        "source": REPO_URL,
        "commit": sha,
        "commitDate": date,
        "divisions": [
            {"id": d, "label": v["label"], "color": v["color"], "count": counts[d]}
            for d, v in divisions.items() if counts[d]
        ],
        "agents": agents,
    }
    dest = HERE / "agents.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    page = (
        '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
        'body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n'
        '</head>\n<body>\n' + (HERE / "template.html").read_text(encoding="utf-8") + '\n</body>\n</html>\n'
    )
    (HERE / "index.html").write_text(page, encoding="utf-8")
    write_cdn_assets()
    print(f"Wrote index.html and {dest} with {len(agents)} agents in {len(out['divisions'])} divisions "
          f"({dest.stat().st_size / 1e6:.1f} MB) from commit {sha or 'unknown'}")


def write_cdn_assets():
    """Split template.html into cdn/app.css, cdn/app.js and cdn/body.html.

    A host that serves only a small HTML shell (desksix.com on AppDeploy) loads
    app.css, app.js and agents.json from a pinned commit through jsDelivr and
    embeds body.html as its markup.
    """
    s = (HERE / "template.html").read_text(encoding="utf-8")
    i, j = s.index("<style>"), s.index("</style>")
    rest = s[j + len("</style>"):]
    k = rest.index('<script src="https://cdnjs')
    m = rest.index("<script>\n", k)
    out = HERE / "cdn"
    out.mkdir(exist_ok=True)
    (out / "app.css").write_text(s[i + len("<style>"):j].strip() + "\n", encoding="utf-8")
    (out / "app.js").write_text(rest[m + len("<script>\n"):rest.rindex("</script>")], encoding="utf-8")
    (out / "body.html").write_text(rest[:k].strip() + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
