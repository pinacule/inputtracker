# Shared helpers for the orchestration scripts. Source, don't run.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORCH="$REPO/.orchestrator"
STATE="$ORCH/state.json"
CURRENT="$ORCH/current.json"
REPORT="$REPO/MORNING_REPORT.md"
mkdir -p "$ORCH"

# Free opencode models only, in preference order (your decision 2026-10-17: no nebius/*).
OPENCODE_MODELS=(
  opencode/deepseek-v4.1-flash-free
  opencode/glm-5.3-flash-free
  opencode/nemotron-3-ultra-free
  opencode/mimo-v2.6-flash-free
  opencode/big-pickle
)
AGY_MODEL="gemini-3.8-flash-high"

now() { date +%s; }
ts() { date '+%Y-%m-%d %H:%M %Z'; }
log() { echo "[$(ts)] $*" | tee -a "$ORCH/overnight.log" >&2; }

# Append one line to the "Limit pauses" log at the end of MORNING_REPORT.md.
report_limit() { echo "- $(ts) — $*" >> "$REPORT"; }

[ -f "$STATE" ] || echo '{"antigravity":{"until":0,"backoff":0},"opencode":{"models":{}}}' > "$STATE"
state_get() { jq -r "$1" "$STATE"; }
state_set() { local t; t=$(mktemp -p "$ORCH"); jq "$1" "$STATE" > "$t" && mv "$t" "$STATE"; }
