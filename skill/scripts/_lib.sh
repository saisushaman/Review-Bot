#!/usr/bin/env bash
# _lib.sh — Shared helpers for the pr-review-bot GitHub scripts.
#
# Source from a sibling script:
#   source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
#
# These helpers cover ONLY the GitHub side (all `gh` CLI). Slack discovery,
# claim, and notify stay model-driven because they go through MCP tools that
# bash cannot call. See SKILL.md.
#
# Compatibility: Bash 3.2+, Linux/macOS, Git Bash on Windows.

set -euo pipefail

# Force UTF-8 in every python/gh subprocess. Windows python defaults to cp1252
# for stdio and chokes on non-Latin-1 chars (→, —, …) common in PR bodies/diffs.
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

# ─── python detection ────────────────────────────────────────────────────────
# On this environment `python3` is the Windows Store stub (broken); the real
# interpreter is `python`. Pick whichever actually runs. Prints the command.
prb_python() {
    local candidate
    for candidate in python python3; do
        if command -v "$candidate" >/dev/null 2>&1 \
           && "$candidate" -c "import sys" >/dev/null 2>&1; then
            echo "$candidate"
            return 0
        fi
    done
    echo "ERROR: no working python interpreter found (need python or python3)." >&2
    return 1
}

# ─── error helper ────────────────────────────────────────────────────────────
prb_die() { echo "ERROR: $*" >&2; exit 1; }

# ─── gh auth guard ───────────────────────────────────────────────────────────
prb_require_gh() {
    command -v gh >/dev/null 2>&1 || prb_die "gh CLI not found in PATH."
    gh auth status >/dev/null 2>&1 || prb_die "gh not authenticated (run: gh auth login)."
}

# ─── authenticated login (for the own-PR gate) ──────────────────────────────
# Not cached: the own-PR skip depends on this being correct, and one gh call is
# cheap. Prints the login. PRB_ME_OVERRIDE forces the identity (testing, or
# running the bot under a service account whose gh login differs).
prb_me() { echo "${PRB_ME_OVERRIDE:-$(gh api user -q .login)}"; }

# ─── target parsing ──────────────────────────────────────────────────────────
# Accepts either a PR URL or three positional args (owner repo number).
# Prints three space-separated tokens: "<owner> <repo> <number>".
#   prb_parse_target "https://github.com/o/r/pull/12"
#   prb_parse_target o r 12
prb_parse_target() {
    if [[ $# -eq 1 ]]; then
        # github.com/<owner>/<repo>/pull/<n>   (with or without scheme/host)
        if [[ "$1" =~ github\.com[/:]([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
            echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]}"
            return 0
        fi
        prb_die "could not parse PR URL: $1"
    elif [[ $# -eq 3 ]]; then
        echo "$1 $2 $3"
        return 0
    fi
    prb_die "usage: <pr-url> | <owner> <repo> <number>"
}

# ─── JSON field extraction ───────────────────────────────────────────────────
# Pull a dotted path out of a JSON string using python (no jq dependency).
#   prb_json_get "$json" state
#   prb_json_get "$json" author.login
# Prints the value (empty string if missing/null).
prb_json_get() {
    local json="$1" path="$2" py
    py="$(prb_python)" || return 1
    PRB_JSON="$json" PRB_PATH="$path" "$py" - <<'PY'
import json, os
data = json.loads(os.environ["PRB_JSON"])
cur = data
for part in os.environ["PRB_PATH"].split("."):
    if isinstance(cur, dict):
        cur = cur.get(part)
    else:
        cur = None
        break
print("" if cur is None else cur)
PY
}
