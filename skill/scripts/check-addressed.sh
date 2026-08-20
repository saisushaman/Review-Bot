#!/usr/bin/env bash
# check-addressed.sh — Follow-up gate (mechanical parts only).
#
# Reports whether a PR the bot already reviewed is ready to APPROVE, checking
# the deterministic conditions:
#   0. PR is still OPEN.
#   2. Every bot-authored review thread is resolved (>=1 must exist — a clean
#      0-finding review has nothing to address and is never auto-approved).
#   3. The bot has not already APPROVED it.
#
# NOT checked here (stay model/MCP-side): the Slack "addressed" reply, the
# fix-is-real spot check, and the competing-duplicate guard. See SKILL.md.
#
# Usage:
#   bash check-addressed.sh <pr-url>
#   bash check-addressed.sh <owner> <repo> <number>
#
# Exit codes:
#   0 — Approvable now (mechanical gates pass; do the Slack + verify checks, then approve.sh).
#   2 — Not approvable yet. stdout = "PRB_REASON=<why>".
#   1 — Error. Detail on stderr.
#
# Compatibility: Bash 3.2+, Git Bash on Windows.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

prb_require_gh
read -r OWNER REPO NUM <<<"$(prb_parse_target "$@")"

DATA="$(gh api graphql \
    -f query='query($owner:String!,$repo:String!,$num:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$num){
          state
          reviews(first:100){ nodes{ author{login} state } }
          reviewThreads(first:100){ nodes{ isResolved comments(first:1){ nodes{ author{login} } } } }
        }
      }
    }' \
    -f owner="$OWNER" -f repo="$REPO" -F num="$NUM" 2>/dev/null)" \
    || prb_die "GraphQL query failed for $OWNER/$REPO#$NUM."

ME="$(prb_me)"
PY="$(prb_python)" || exit 1

# Python decides; prints "APPROVABLE" or "REASON=<text>" on stdout.
RESULT="$(PRB_DATA="$DATA" PRB_ME="$ME" "$PY" - <<'PY'
import json, os
data = json.loads(os.environ["PRB_DATA"])
me = os.environ["PRB_ME"]
pr = data["data"]["repository"]["pullRequest"]

if pr["state"] != "OPEN":
    print(f"REASON=PR is {pr['state']} — nothing to approve"); raise SystemExit

if any(r["author"] and r["author"]["login"] == me and r["state"] == "APPROVED"
       for r in pr["reviews"]["nodes"]):
    print("REASON=already approved by the bot"); raise SystemExit

bot_threads = [
    t for t in pr["reviewThreads"]["nodes"]
    if t["comments"]["nodes"] and t["comments"]["nodes"][0]["author"]
    and t["comments"]["nodes"][0]["author"]["login"] == me
]
if not bot_threads:
    print("REASON=no bot findings to address (clean review is not auto-approved)"); raise SystemExit

unresolved = sum(1 for t in bot_threads if not t["isResolved"])
if unresolved:
    print(f"REASON={unresolved} of {len(bot_threads)} bot finding thread(s) still unresolved"); raise SystemExit

print("APPROVABLE")
PY
)"

if [[ "$RESULT" == "APPROVABLE" ]]; then
    exit 0
fi
echo "PRB_$RESULT"
exit 2
