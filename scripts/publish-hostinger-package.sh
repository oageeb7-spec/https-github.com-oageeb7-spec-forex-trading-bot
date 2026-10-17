#!/usr/bin/env bash
# Rebuilds the `hostinger-deploy` branch: one commit holding os-ai-app.zip, a package of the
# current branch. Hostinger (app.ostradingai.com, Cloud hosting) clones that branch into
# deploy-src/ and builds the zip as a Node.js app. Run from the repository root, then redeploy
# in Hostinger (or ask Claude to) — see docs/HOSTINGER.md.
set -euo pipefail

SOURCE_REF="${1:-HEAD}"
ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'git -C "$ROOT" worktree remove --force "$WORK/wt" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

git -C "$ROOT" archive --format=zip -o "$WORK/os-ai-app.zip" "$SOURCE_REF" -- . ':!.claude' ':!docs/screenshots'
git -C "$ROOT" fetch --quiet origin hostinger-deploy
git -C "$ROOT" worktree add --quiet --detach "$WORK/wt" origin/hostinger-deploy
cd "$WORK/wt"
cp "$WORK/os-ai-app.zip" .
printf '# Hostinger deploy package\n\nBuilt from `%s` (%s). Hostinger clones this branch and builds `os-ai-app.zip`.\n' \
  "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)" "$(git -C "$ROOT" rev-parse --short "$SOURCE_REF")" > README.md
git add -A
git commit --quiet -m "OS AI deploy package ($(git -C "$ROOT" rev-parse --short "$SOURCE_REF"))" -m "${DEPLOY_COMMIT_TRAILER:-}"
git push --quiet origin HEAD:hostinger-deploy
echo "Pushed hostinger-deploy with $(du -h os-ai-app.zip | cut -f1) package."
