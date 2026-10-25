#!/usr/bin/env bash
# Run a command so it can only write inside one worktree (plus the CLIs' own state/cache dirs).
# The whole filesystem is read-only, the real config file (secrets) is hidden.
# Usage: scripts/jail.sh <worktree-dir> <command> [args...]
set -euo pipefail
WT="$(cd "$1" && pwd)"; shift
REPO="$(cd "$(dirname "$0")/.." && pwd)"

args=(--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind "$WT" "$WT")
for d in "$HOME/.gemini" "$HOME/.cache" "$HOME/.bun" \
         "$HOME/.local/share/opencode" "$HOME/.local/state/opencode" \
         "$HOME/.local/share/muse" "$HOME/.local/state/muse" "$HOME/.codex"; do
  [ -d "$d" ] && args+=(--bind "$d" "$d")
done
[ -e "$REPO/inputtracker.config.toml" ] && args+=(--ro-bind /dev/null "$REPO/inputtracker.config.toml")

exec bwrap "${args[@]}" --die-with-parent --chdir "$WT" "$@"
