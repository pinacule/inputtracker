#!/usr/bin/env bash
# Is a worker usable right now? Tiny PONG prompt (and quota check for Antigravity).
# Usage: scripts/probe-worker.sh <antigravity|opencode> [model]
# Exit 0 = works. Exit 10 = limited; prints reset epoch seconds if known (else nothing).
# Exit 1 = other failure.
source "$(dirname "$0")/lib.sh"
WORKER="$1"; MODEL="${2:-}"
cd "$(mktemp -d)"
case "$WORKER" in
antigravity)
  u=$(timeout 60 antigravity -p "/usage" --output-format json 2>/dev/null)
  # If any Gemini bucket is (almost) empty, report its reset time.
  reset=$(echo "$u" | jq -r '[.command.data.groups[]? | select(.name|test("Gemini")) | .buckets[]
          | select(.remaining_fraction < 0.01) | .reset_time] | max // empty' 2>/dev/null)
  if [ -n "$reset" ]; then date -d "$reset" +%s; exit 10; fi
  out=$(timeout 120 antigravity -p "Reply with exactly: PONG" --model "${MODEL:-$AGY_MODEL}" \
        --output-format json --print-timeout 100s 2>&1)
  echo "$out" | grep -q PONG && exit 0
  echo "$out" | grep -Eq '429|RESOURCE_EXHAUSTED|[Qq]uota|[Rr]ate|credits' && exit 10
  exit 1 ;;
opencode)
  out=$(timeout 120 opencode run --model "${MODEL:-${OPENCODE_MODELS[0]}}" --format json \
        "Reply with exactly: PONG" 2>&1)
  echo "$out" | grep -q PONG && exit 0
  echo "$out" | grep -Eq '429|[Qq]uota|[Rr]ate|[Ll]imit|[Ee]xhausted' && exit 10
  exit 1 ;;
esac
exit 1
