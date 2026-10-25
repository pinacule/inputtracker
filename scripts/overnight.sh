#!/usr/bin/env bash
# Overnight supervisor. Alternates between a Claude manager step (plan/review/merge, one
# `claude -p` call with fresh context) and a jailed worker run. Handles worker limits and
# Claude's own usage limit by sleeping and probing, never by giving up.
# Stop gracefully: touch .orchestrator/STOP
source "$(dirname "$0")/lib.sh"
cd "$REPO"
MANAGER_MODEL="${MANAGER_MODEL:-sonnet}"
MAX_STEPS="${MAX_STEPS:-300}"

sleep_until() {  # sleep in 60 s chunks so STOP is honoured
  local until=$1
  while [ "$(now)" -lt "$until" ]; do [ -f "$ORCH/STOP" ] && return 1; sleep 60; done
}

worker_until() {  # epoch until which a worker (or opencode model) is limited
  case "$1" in
    antigravity) state_get '.antigravity.until' ;;
    opencode) state_get "(.opencode.models[\"$2\"].until // 0)" ;;
  esac
}

opencode_model() {  # first model not currently limited
  for m in "${OPENCODE_MODELS[@]}"; do
    [ "$(worker_until opencode "$m")" -le "$(now)" ] && { echo "$m"; return 0; }
  done
  return 1
}

status_text() {
  local a="available" o
  [ "$(worker_until antigravity)" -gt "$(now)" ] && a="LIMITED until $(date -d @"$(worker_until antigravity)" '+%H:%M %Z')"
  o=$(opencode_model) && o="available (next model: $o)" || o="LIMITED (all free models)"
  echo "- antigravity ($AGY_MODEL): $a"
  echo "- opencode: $o"
  echo "- time now: $(ts)"
  echo "- current.json: $(cat "$CURRENT" 2>/dev/null || echo '{}')"
}

# Recovery check: probe every worker whose limit time has passed.
recover_check() {
  local u b
  u=$(worker_until antigravity)
  if [ "$u" -gt 0 ] && [ "$u" -le "$(now)" ]; then
    if scripts/probe-worker.sh antigravity >/dev/null 2>&1; then
      state_set '.antigravity.until=0 | .antigravity.backoff=0'
      report_limit "antigravity ($AGY_MODEL) RECOVERED"; log "antigravity recovered"
    else
      b=$(state_get '.antigravity.backoff'); b=$(( b==0 ? 15 : (b*2>60 ? 60 : b*2) ))
      state_set ".antigravity.until=$(( $(now) + b*60 )) | .antigravity.backoff=$b"
      log "antigravity still limited, next probe in ${b}m"
    fi
  fi
  for m in "${OPENCODE_MODELS[@]}"; do
    u=$(worker_until opencode "$m")
    if [ "$u" -gt 0 ] && [ "$u" -le "$(now)" ]; then
      if scripts/probe-worker.sh opencode "$m" >/dev/null 2>&1; then
        state_set "del(.opencode.models[\"$m\"])"
        report_limit "opencode $m RECOVERED"; log "opencode $m recovered"
      else
        b=$(state_get "(.opencode.models[\"$m\"].backoff // 15)"); b=$(( b*2>60 ? 60 : b*2 ))
        state_set ".opencode.models[\"$m\"]={until:$(( $(now) + b*60 )),backoff:$b}"
      fi
    fi
  done
}

handle_worker_limit() {  # worker model task
  local w=$1 m=$2 t=$3 until msg
  msg=$(grep -h -m1 -E 'AGY_ERROR|"type":"error"' ".worktrees/$t/.task/"*.err ".worktrees/$t/.task/oc.jsonl" 2>/dev/null | cut -c1-200)
  if [ "$w" = antigravity ]; then
    until=$(scripts/probe-worker.sh antigravity 2>/dev/null); rc=$?
    [ $rc -eq 10 ] && [ -n "$until" ] || until=$(( $(now) + 900 ))
    state_set ".antigravity.until=$until | .antigravity.backoff=15"
  else
    until=$(( $(now) + 900 ))
    state_set ".opencode.models[\"$m\"]={until:$until,backoff:15}"
  fi
  report_limit "$w $m LIMIT HIT on $t, retry after $(date -d @"$until" '+%H:%M %Z') — ${msg:-no message}"
  log "$w $m limited until $(date -d @"$until")"
}

claude_reset_epoch() {  # parse a reset time out of Claude's limit message
  local txt="$1" e t
  e=$(echo "$txt" | grep -oE '\|[0-9]{10}' | head -1 | tr -d '|')
  [ -n "$e" ] && { echo "$e"; return; }
  t=$(echo "$txt" | grep -oiE 'resets? (at )?[0-9]{1,2}(:[0-9]{2})? ?(am|pm)?' | head -1 | sed -E 's/resets? (at )?//I')
  if [ -n "$t" ]; then
    e=$(date -d "today $t" +%s 2>/dev/null) || e=""
    [ -n "$e" ] && [ "$e" -le "$(now)" ] && e=$(( e + 86400 ))
    [ -n "$e" ] && { echo $(( e + 120 )); return; }
  fi
  echo $(( $(now) + 1800 ))
}

manager_step() {
  local tries=0 out rc res
  while true; do
    [ -f "$ORCH/STOP" ] && return 1
    out=$(claude -p "$(cat scripts/manager/step.md)

## Live status (from the supervisor)
$(status_text)" --permission-mode auto --model "$MANAGER_MODEL" --output-format json 2>&1)
    rc=$?
    echo "$out" > "$ORCH/last-manager.json"
    res=$(echo "$out" | jq -r '.result // empty' 2>/dev/null)
    if echo "$out" | grep -qiE 'usage limit|hit your limit|limit reached|rate_limit|overloaded' \
       && { [ $rc -ne 0 ] || [ "$(echo "$out" | jq -r '.is_error // false' 2>/dev/null)" = true ]; }; then
      local until; until=$(claude_reset_epoch "$out")
      report_limit "Claude manager LIMIT HIT, pausing until $(date -d @"$until" '+%H:%M %Z')"
      log "claude limited until $(date -d @"$until")"
      sleep_until "$until" || return 1
      report_limit "Claude manager resumed"
      continue
    fi
    if [ $rc -ne 0 ]; then
      tries=$((tries+1)); log "manager step failed (rc=$rc): $(echo "$out" | tail -c 300)"
      [ $tries -ge 3 ] && { report_limit "Claude manager failed 3x in a row, pausing 30 min"; sleep_until $(( $(now)+1800 )) || return 1; tries=0; }
      sleep 30; continue
    fi
    log "manager: $(echo "$res" | tail -c 400 | tr '\n' ' ')"
    return 0
  done
}

log "overnight loop start (manager model $MANAGER_MODEL)"
grep -q '^## Limit pauses' "$REPORT" || printf '\n## Limit pauses (log)\n' >> "$REPORT"
report_limit "overnight loop STARTED"

step=0
while [ $step -lt "$MAX_STEPS" ]; do
  step=$((step+1))
  [ -f "$ORCH/STOP" ] && { log "STOP file found"; break; }
  recover_check
  manager_step || break
  next=$(jq -r '.next // "finished"' "$CURRENT" 2>/dev/null || echo finished)
  case "$next" in
  finished) log "manager says finished"; break ;;
  wait)
    # Everything left needs a limited worker: sleep until the earliest limit ends.
    e=$(jq -r '[.antigravity.until] + [.opencode.models[]?.until] | map(select(. > 0)) | min // 0' "$STATE")
    [ "$e" -le "$(now)" ] && e=$(( $(now) + 900 ))
    report_limit "all needed workers limited, loop paused until $(date -d @"$e" '+%H:%M %Z')"
    sleep_until "$e" || break ;;
  run)
    t=$(jq -r .task "$CURRENT"); w=$(jq -r .worker "$CURRENT")
    p=$(jq -r .prompt "$CURRENT"); s=$(jq -r '.resume // ""' "$CURRENT")
    if [ "$w" = antigravity ]; then
      m=$AGY_MODEL
      [ "$(worker_until antigravity)" -gt "$(now)" ] && { jq '.phase="review"|.result="limit"' "$CURRENT" > "$CURRENT.tmp" && mv "$CURRENT.tmp" "$CURRENT"; continue; }
    else
      m=$(opencode_model) || { jq '.phase="review"|.result="limit"' "$CURRENT" > "$CURRENT.tmp" && mv "$CURRENT.tmp" "$CURRENT"; continue; }
      # A resumed opencode session must keep its model.
      [ -n "$s" ] && [ -f ".worktrees/$t/.task/model" ] && m=$(cat ".worktrees/$t/.task/model")
    fi
    jq --arg m "$m" '.phase="running"|.model=$m' "$CURRENT" > "$CURRENT.tmp" && mv "$CURRENT.tmp" "$CURRENT"
    r=$(scripts/run-worker.sh "$t" "$w" "$m" "$p" "$s" | tail -1)
    [ "$r" = limit ] && handle_worker_limit "$w" "$m" "$t"
    jq --arg r "$r" --arg m "$m" '.phase="review"|.result=$r|.model=$m' "$CURRENT" > "$CURRENT.tmp" && mv "$CURRENT.tmp" "$CURRENT"
    ;;
  *) log "unknown next '$next', asking manager again"; sleep 10 ;;
  esac
done
report_limit "overnight loop ENDED after $step steps"
log "overnight loop end"
