#!/usr/bin/env bash
# post-review.sh — Step 7: publish one inline GitHub review atomically.
#
# The model supplies ONLY its judgment as a findings file:
#     { "body": "<severity tally + overall read>",
#       "comments": [ { "path": "...", "line": 23, "side": "RIGHT",
#                       "body": "**[High]** ..." }, ... ] }
# This script injects the deterministic bits (commit_id = head OID, the fixed
# event=COMMENT) and POSTs. The model never hand-builds the reviews envelope.
#
# Usage:
#   bash post-review.sh <findings.json> <pr-url>
#   bash post-review.sh <findings.json> <owner> <repo> <number>
#
# Exit codes:
#   0 — Review posted. stdout = the review html_url.
#   1 — Error (bad findings file, missing anchor 422, gh failure). Detail on stderr.
#
# Compatibility: Bash 3.2+, Git Bash on Windows.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

prb_require_gh

FINDINGS="${1:-}"
[[ -n "$FINDINGS" && -f "$FINDINGS" ]] || prb_die "findings file not found: '${FINDINGS:-<none>}'"
shift
read -r OWNER REPO NUM <<<"$(prb_parse_target "$@")"
SLUG="$OWNER/$REPO"

HEAD_OID="$(gh pr view "$NUM" --repo "$SLUG" --json headRefOid -q .headRefOid)" \
    || prb_die "could not resolve head OID for $SLUG#$NUM."
[[ -n "$HEAD_OID" ]] || prb_die "empty head OID for $SLUG#$NUM."

PY="$(prb_python)" || exit 1

# Merge the model's {body, comments} with commit_id + event → full envelope.
# python owns the temp file so the path is a NATIVE Windows path that both
# `gh` and `python` resolve identically (a Git-Bash /tmp or mktemp path would
# not — see references/github-review.md). It prints that path on stdout.
PAYLOAD="$(PRB_FINDINGS="$FINDINGS" PRB_OID="$HEAD_OID" "$PY" - <<'PY'
import json, os, sys, tempfile
with open(os.environ["PRB_FINDINGS"], encoding="utf-8") as f:
    src = json.load(f)
if not isinstance(src, dict):
    sys.exit("findings file must be a JSON object with 'body' and 'comments'")
comments = src.get("comments", []) or []
if not isinstance(comments, list):
    sys.exit("'comments' must be an array")
payload = {
    "commit_id": os.environ["PRB_OID"],
    "event": "COMMENT",              # bot never APPROVE/REQUEST_CHANGES here
    "body": src.get("body", ""),
    "comments": comments,
}
fd, path = tempfile.mkstemp(prefix="prb-review-", suffix=".json")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(payload, f)
print(f"{len(comments)} inline comment(s)", file=sys.stderr)
print(path)                          # native path, captured by bash
PY
)" || prb_die "failed to assemble the review payload from '$FINDINGS'."
trap '"$PY" -c "import os,sys; p=sys.argv[1]; os.path.exists(p) and os.remove(p)" "$PAYLOAD" 2>/dev/null || true' EXIT

URL="$(gh api "repos/$SLUG/pulls/$NUM/reviews" --method POST --input "$PAYLOAD" -q '.html_url')" \
    || prb_die "review POST failed (a bad path/line 422s the whole review — re-verify anchors against the head file)."

echo "$URL"
