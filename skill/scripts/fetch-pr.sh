#!/usr/bin/env bash
# fetch-pr.sh — Step 4 of the review pass, fully deterministic.
#
# Fetches PR metadata, applies every non-judgment gate (state / own-PR /
# allowlist), and on success prints the metadata block + full diff for the
# model to review. The model does NOT re-derive any of these gh calls or gates.
#
# Usage:
#   bash fetch-pr.sh <pr-url>
#   bash fetch-pr.sh <owner> <repo> <number>
#
# Env:
#   PRB_REPO_ALLOWLIST  Optional. Space/comma-separated owner/repo entries.
#                       Empty (default) = all repos allowed.
#   PRB_SKIP_OWN_PRS    Default "true". Set "false" to review own PRs too.
#
# Exit codes:
#   0 — Reviewable. stdout = metadata block, then "--- DIFF ---", then the diff.
#   2 — PR is MERGED (nothing to review). stdout carries the canned thread line.
#   3 — PR is CLOSED (unmerged, nothing to review). Canned thread line on stdout.
#   4 — Own PR — skip (SKIP_OWN_PRS). Canned thread line on stdout.
#   5 — Repo not in PRB_REPO_ALLOWLIST — skip. Canned thread line on stdout.
#   1 — Error (bad args, gh failure). Detail on stderr.
#
# Compatibility: Bash 3.2+, Git Bash on Windows.

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

prb_require_gh
read -r OWNER REPO NUM <<<"$(prb_parse_target "$@")"
SLUG="$OWNER/$REPO"

# ─── allowlist gate ──────────────────────────────────────────────────────────
ALLOW="${PRB_REPO_ALLOWLIST:-}"
if [[ -n "${ALLOW// /}" ]]; then
    normalized=" ${ALLOW//,/ } "
    if [[ "$normalized" != *" $SLUG "* ]]; then
        echo "Skipped — $SLUG is not in the repo allowlist."
        exit 5
    fi
fi

# ─── one metadata fetch ──────────────────────────────────────────────────────
META="$(gh pr view "$NUM" --repo "$SLUG" \
    --json state,author,title,body,additions,deletions,changedFiles,baseRefName,headRefName,headRefOid \
    2>/dev/null)" || prb_die "gh pr view failed for $SLUG#$NUM (does it exist?)."

STATE="$(prb_json_get "$META" state)"
AUTHOR="$(prb_json_get "$META" author.login)"
HEAD_OID="$(prb_json_get "$META" headRefOid)"

# ─── state gate (before anything else, precedes own-PR) ──────────────────────
case "$STATE" in
    OPEN) ;;
    MERGED) echo "Nothing to review — PR is already merged."; exit 2 ;;
    CLOSED) echo "Nothing to review — PR is already closed.";  exit 3 ;;
    *)      prb_die "unexpected PR state '$STATE' for $SLUG#$NUM." ;;
esac

# ─── own-PR gate ─────────────────────────────────────────────────────────────
if [[ "${PRB_SKIP_OWN_PRS:-true}" == "true" ]]; then
    ME="$(prb_me)"
    if [[ -n "$ME" && "$AUTHOR" == "$ME" ]]; then
        echo "Skipping — bot doesn't review its owner's PRs."
        exit 4
    fi
fi

# ─── reviewable: emit metadata + diff ────────────────────────────────────────
echo "PRB_REPO=$SLUG"
echo "PRB_NUMBER=$NUM"
echo "PRB_STATE=$STATE"
echo "PRB_AUTHOR=$AUTHOR"
echo "PRB_HEAD_OID=$HEAD_OID"
echo "PRB_TITLE=$(prb_json_get "$META" title)"
echo "PRB_BASE=$(prb_json_get "$META" baseRefName)"
echo "PRB_HEAD=$(prb_json_get "$META" headRefName)"
echo "PRB_ADDITIONS=$(prb_json_get "$META" additions)"
echo "PRB_DELETIONS=$(prb_json_get "$META" deletions)"
echo "PRB_CHANGED_FILES=$(prb_json_get "$META" changedFiles)"
echo "--- BODY ---"
prb_json_get "$META" body
echo "--- DIFF ---"
gh pr diff "$NUM" --repo "$SLUG" || prb_die "gh pr diff failed for $SLUG#$NUM."
