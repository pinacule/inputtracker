#!/usr/bin/env bash
# Commit a reviewed worker result and land it on main, in the only safe order:
# commit in worktree -> merge -> check on main -> secret check -> push -> clean up.
# On any failure main is left as it was before the merge and the worktree is kept.
# Usage: scripts/merge-task.sh <task> "<title>"
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
T="$1"; TITLE="$2"; WT=".worktrees/$T"
[ -d "$WT" ] || { echo "merge-task: no worktree $WT" >&2; exit 2; }
MODEL=$(cat "$WT/.task/model" 2>/dev/null || echo unknown)

# 1. Commit the worker's changes on the task branch.
git -C "$WT" add -A
if ! git -C "$WT" diff --cached --quiet; then
  git -C "$WT" commit -q -m "$T: $TITLE" -m "Worker model: $MODEL"
fi
git rev-parse -q --verify "task/$T" >/dev/null || { echo "merge-task: no branch task/$T" >&2; exit 2; }
[ "$(git rev-list --count "main..task/$T")" -gt 0 ] || { echo "merge-task: task/$T has no new commits" >&2; exit 3; }

# 2. Save pending manager/supervisor edits on main so a rollback can't lose them.
git add TASKS.md MORNING_REPORT.md 2>/dev/null || true
git diff --cached --quiet || git commit -q -m "Manager: report update"

# 3. Merge and verify on main; roll back on failure.
before=$(git rev-parse HEAD)
if ! git merge --no-ff -q "task/$T" -m "Merge $T: $TITLE"; then
  git merge --abort || true; echo "merge-task: merge conflict, main unchanged" >&2; exit 4
fi
if [ -f package.json ]; then
  if ! { bun install >/dev/null && bun run check; }; then
    git reset -q --hard "$before"; echo "merge-task: check failed on main, merge rolled back" >&2; exit 5
  fi
fi
if ! scripts/check-secrets.sh; then
  git reset -q --hard "$before"; echo "merge-task: secret check failed, merge rolled back" >&2; exit 6
fi

# 4. Push, then clean up.
git push -q origin main
git worktree remove --force "$WT"
git branch -D -q "task/$T"
echo "merge-task: $T merged and pushed as $(git rev-parse --short HEAD)"
