# Posting an inline GitHub review (exact mechanics)

The hot path is now scripted — `scripts/post-review.sh` builds the envelope and
POSTs it, and `scripts/fetch-pr.sh` resolves the head OID for you. This file is
the reference for the **anchoring** work that stays your judgment, plus the
gotchas the scripts already handle (so you understand them if a script errors).

Validated against `Actual-Reality/customer-portal` PRs #16, #20, #30.

## 1. Anchor to the head commit
Inline comments must reference lines in the PR's **head** revision, not the diff
hunk numbers. `fetch-pr.sh` prints the head OID as `PRB_HEAD_OID=…`; you do not
need to re-fetch it. `post-review.sh` re-reads it and injects it as `commit_id`.

To get the real line a comment should sit on, fetch the file at that ref and grep
for the anchor text (diff hunk headers lie about final line numbers):

```
gh api "repos/<owner>/<repo>/contents/<path>?ref=<PRB_HEAD_OID>" -q .content \
  | base64 -d | grep -n "<anchor snippet>"
```

## 2. The findings file you write (input to post-review.sh)
You supply ONLY your judgment. The script adds `commit_id` and the fixed
`event:"COMMENT"` (a bot never `APPROVE`/`REQUEST_CHANGES` here). Shape:

```json
{
  "body": "<summary: tally by severity + overall read>",
  "comments": [
    { "path": "src/gateways/ocr.gateway.ts", "line": 23, "side": "RIGHT",
      "body": "**[Medium]** No timeout bounds the OCR call; a dense image can pin CPU on the hot path. Wrap in a fail-closed timeout." }
  ]
}
```
- Prefix each comment body with a severity tag: `**[High]**`, `**[Medium]**`, `**[Low]**`.
- Multi-line range: add `start_line` + `start_side` alongside `line`/`side`.
- Two comments may target the same line.
- `comments` may be `[]` (or omitted) for a clean review — the script still posts
  the summary `body` as a COMMENT review.

## 3. What post-review.sh does (and the Windows path gotcha it solves)
```
bash scripts/post-review.sh <findings.json> <owner> <repo> <n>
```
It merges your findings with `commit_id`+`event`, writes the full envelope, and:
```
gh api repos/<owner>/<repo>/pulls/<n>/reviews --method POST --input <envelope> -q '.html_url'
```
On success it prints the review `html_url` (`…/pull/<n>#pullrequestreview-<id>`).

**Why the script — not you — writes the temp file.** `gh` and `python` here are
**native Windows** binaries. Git Bash's `/tmp` maps to
`C:\Users\<user>\AppData\Local\Temp`, and `mktemp` returns a Git-Bash-style path
(`/tmp/tmp.XXXX`) that native `gh`/`python` resolve to a *different* location
(`C:\tmp\…`), so a file written under one path can't be read under the other. The
script sidesteps this entirely: **python creates the temp file via `tempfile` and
prints its native path**, which both `gh` and `python` then resolve identically.
If you ever build a payload by hand, write it with the Write tool to the session
scratchpad dir (given in the system prompt) — never a bare `/tmp` path for `gh`.

## 4. Notes
- One `reviews` POST publishes all inline comments atomically as a single review —
  preferred over N individual comment calls (avoids partial posts and rate limits).
- If a `line`/`path` doesn't exist in the diff, GitHub **422s the whole review**;
  re-verify the anchor against the head file rather than retrying blindly. (This is
  exactly the error `post-review.sh` surfaces on exit 1.)
- Keep the summary `body` short and factual; the value is in the inline comments.
- UTF-8: `_lib.sh` exports `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` so PR bodies
  and diffs containing `→ — …` don't crash python's cp1252 default on Windows.
