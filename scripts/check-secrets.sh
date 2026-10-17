#!/usr/bin/env bash
# Block pushes that contain secrets or personal archive data. Used by .githooks/pre-push
# and run by the manager before every push. Never prints secret values.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
fail=0
GITLEAKS=$(command -v gitleaks || echo "mise exec gitleaks@latest -- gitleaks")

# 1. gitleaks over the whole history that would be pushed.
$GITLEAKS git . --no-banner --redact --log-level warn || { echo "check-secrets: gitleaks found a leak" >&2; fail=1; }

# 2. No secret/personal-data files tracked.
bad=$(git ls-files | grep -E '(^|/)inputtracker\.config\.toml$|\.db$|\.db-|\.sqlite|cookies|watch-history|(^|/)Takeout/|^data/|^exports/|^backups/|\.env' || true)
[ -n "$bad" ] && { echo "check-secrets: forbidden files tracked:" >&2; echo "$bad" >&2; fail=1; }

# 3. The real ABS token must not appear anywhere in tracked content.
if [ -f inputtracker.config.toml ]; then
  while IFS= read -r tok; do
    [ ${#tok} -ge 12 ] || continue
    if git grep -qF -- "$tok" HEAD 2>/dev/null || git log -p --all | grep -qF -- "$tok"; then
      echo "check-secrets: a token from inputtracker.config.toml is in the repo" >&2; fail=1
    fi
  done < <(sed -n 's/^[a-z_]*token[a-z_]* *= *"\(.*\)"$/\1/p' inputtracker.config.toml)
fi

[ $fail -eq 0 ] && echo "check-secrets: OK"
exit $fail
