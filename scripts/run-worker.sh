#!/usr/bin/env bash
# Run one worker on one task, jailed to its worktree, and classify the result.
# Usage: scripts/run-worker.sh <task> <antigravity|opencode> <model> <prompt-file> [resume-session-id]
# Writes .worktrees/<task>/.task/{result,model,session,exit,<worker logs>} and prints the result:
#   ok | limit | error | stuck
source "$(dirname "$0")/lib.sh"
TASK="$1"; WORKER="$2"; MODEL="$3"; PROMPT_FILE="$4"; RESUME="${5:-}"
WT="$REPO/.worktrees/$TASK"; T="$WT/.task"
mkdir -p "$T"
PROMPT="$(cat "$PROMPT_FILE")"
echo "$MODEL" > "$T/model"
LIMIT_RE='429|RESOURCE_EXHAUSTED|[Qq]uota|[Rr]ate.?limit|credits balance|[Ee]xhausted|[Uu]sage limit|[Tt]oo many requests'

# Vertex models (paid from the user's Google Cloud credits) authenticate with gcloud's
# application-default credentials; opencode also needs the project and location.
if [[ "$MODEL" == google-vertex/* ]]; then
  export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
  export VERTEX_LOCATION="${VERTEX_LOCATION:-global}"
fi

case "$WORKER" in
antigravity)
  extra=(); [ -n "$RESUME" ] && extra=(--conversation "$RESUME")
  timeout 50m "$REPO/scripts/jail.sh" "$WT" antigravity -p "$PROMPT" --model "$MODEL" \
    --output-format json --print-timeout 45m "${extra[@]}" > "$T/agy.json" 2> "$T/agy.err"
  rc=$?; echo "$rc" > "$T/exit"
  jq -r '.conversation_id // empty' "$T/agy.json" 2>/dev/null > "$T/session"
  if [ $rc -eq 124 ]; then r=stuck
  elif [ $rc -eq 0 ] && [ "$(jq -r .status "$T/agy.json" 2>/dev/null)" = SUCCESS ]; then r=ok
  elif grep -Eq "$LIMIT_RE" "$T/agy.err" "$T/agy.json" 2>/dev/null; then r=limit
  else r=error; fi
  ;;
opencode)
  extra=(); [ -n "$RESUME" ] && extra=(--session "$RESUME")
  out="$T/oc.jsonl"; : > "$out"
  timeout 45m "$REPO/scripts/jail.sh" "$WT" opencode run --standalone --auto --format json \
    --model "$MODEL" --title "$TASK" "${extra[@]}" "$PROMPT" > "$out" 2> "$T/oc.err" &
  pid=$!
  # Stall watch: no new output for 10 minutes -> stuck.
  last=$(now); size=0; stalled=0
  while kill -0 $pid 2>/dev/null; do
    sleep 30
    s=$(stat -c %s "$out" 2>/dev/null || echo 0)
    if [ "$s" != "$size" ]; then size=$s; last=$(now)
    elif [ $(( $(now) - last )) -gt 600 ]; then stalled=1; kill $pid; sleep 5; kill -9 $pid 2>/dev/null; break; fi
  done
  wait $pid; rc=$?; echo "$rc" > "$T/exit"
  head -1 "$out" | jq -r '.sessionID // empty' 2>/dev/null > "$T/session"
  if [ $stalled -eq 1 ] || [ $rc -eq 124 ]; then r=stuck
  elif jq -r 'select(.type=="error") | .error | tostring' "$out" 2>/dev/null | grep -Eq "$LIMIT_RE" \
       || grep -Eq "$LIMIT_RE" "$T/oc.err" 2>/dev/null; then r=limit
  elif [ $rc -eq 0 ] && grep -q '"type":"step_finish"' "$out"; then r=ok
  else r=error; fi
  ;;
*) echo "unknown worker $WORKER" >&2; exit 2 ;;
esac

echo "$r" > "$T/result"
log "worker $WORKER ($MODEL) on $TASK -> $r (exit $rc)"
echo "$r"
