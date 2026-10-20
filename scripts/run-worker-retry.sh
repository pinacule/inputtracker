#!/usr/bin/env bash
# Run a worker and, when the provider rate-limits it, wait and resume the same session.
# Usage: scripts/run-worker-retry.sh <task> <worker> <model> <prompt-file> [resume-session-id]
# Env: RETRY_MAX (default 8), RETRY_WAIT (seconds, default 90). Prints the final result.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TASK="$1"; WORKER="$2"; MODEL="$3"; PROMPT="$4"; SESSION="${5:-}"
T="$REPO/.worktrees/$TASK/.task"
CONT="$T/continue-after-limit.md"
cat > "$CONT" <<'MSG'
Your run was cut off by a provider rate limit. Continue exactly where you were (the original task
is in .task/prompt.md; re-read it if needed). Finish only when `bun run check` passes (and
`bun run build:web` if you touched web/). Do not spawn subagents. Do not commit. End with the summary.
MSG
for attempt in $(seq 0 "${RETRY_MAX:-8}"); do
  if [ "$attempt" -gt 0 ]; then
    [ -f "$T/oc.jsonl" ] && mv "$T/oc.jsonl" "$T/oc.limit$attempt.jsonl"
    rm -f "$T/result"; sleep "${RETRY_WAIT:-90}"
    PROMPT="$CONT"; SESSION="$(cat "$T/session" 2>/dev/null)"
  fi
  r=$("$REPO/scripts/run-worker.sh" "$TASK" "$WORKER" "$MODEL" "$PROMPT" ${SESSION:+"$SESSION"} | tail -1)
  if [ "$r" = error ] && grep -q "different Azure OpenAI resource" "$T/oc.jsonl" 2>/dev/null; then
    # AgentRouter moved the session to another Azure resource; its stored response items are gone
    # there, so resuming fails too. Start a fresh session that continues from the files on disk.
    echo "[$TASK] router switched Azure resource (attempt $attempt), restarting fresh" >&2
    [ -f "$T/oc.jsonl" ] && mv "$T/oc.jsonl" "$T/oc.resource$attempt.jsonl"
    rm -f "$T/result" "$T/session"; sleep 20
    PROMPT_FRESH="$T/continue-fresh.md"
    { cat "$T/prompt.md"; printf '\n\n## Note\nA previous run of this task was cut off. Some of the work may already be in this folder (check `git status` and `git diff`); continue from there instead of starting over.\n'; } > "$PROMPT_FRESH"
    PROMPT="$PROMPT_FRESH"; SESSION=""
    continue
  fi
  if [ "$r" = error ] && grep -qE '"provider\.(transport|internal)"' "$T/oc.jsonl" 2>/dev/null; then
    # Connection dropped or upstream unavailable: the session is intact, resume it after a wait.
    echo "[$TASK] connection lost (attempt $attempt), resuming" >&2
    continue
  fi
  [ "$r" != limit ] && { echo "$r"; exit 0; }
  echo "[$TASK] rate-limited (attempt $attempt), resuming in ${RETRY_WAIT:-90}s" >&2
done
echo limit
