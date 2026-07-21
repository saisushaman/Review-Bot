#!/usr/bin/env bash
# approve.sh — the ceiling of the bot's authority: APPROVE only.
#
# Never closes, merges, or REQUEST_CHANGES. Call ONLY after check-addressed.sh
# exits 0 AND the model has done its two judgment checks (Slack "addressed"
# reply present, fix verified as real, no competing duplicate).
#
# Usage:
#   bash approve.sh <pr-url>
#   bash approve.sh <owner> <repo> <number>
#
# Exit codes:
#   0 — Approved.
#   1 — Error. Detail on stderr.
#
# Compatibility: Bash 3.2+, Git Bash on Windows.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

prb_require_gh
read -r OWNER REPO NUM <<<"$(prb_parse_target "$@")"

gh pr review "$NUM" --repo "$OWNER/$REPO" --approve \
    --body "Findings addressed & verified — approving." \
    || prb_die "approve failed for $OWNER/$REPO#$NUM."

echo "APPROVED $OWNER/$REPO#$NUM"
