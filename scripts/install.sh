#!/usr/bin/env bash
# Install InputTracker as systemd *user* units.
#
# Renders the templates in deploy/ into the user unit directory, replacing the
# @APP_DIR@ placeholder with the absolute path of this repository (computed from
# this script's own location). Then reloads systemd and enables the service and
# timers. No sudo. Safe to run repeatedly.
#
# The app config path is not baked in here: the units let the app read
# INPUTTRACKER_CONFIG from the environment, falling back to its own default.
# This script never reads or prints the app config file.
#
# Usage: scripts/install.sh [--no-start] [--no-build] [--dry-run]
#   --no-start  render units and reload systemd, but do not enable/start them
#   --no-build  skip `bun install` and the web build before starting
#   --dry-run   print what would happen and touch nothing
# Re-running it is also the update step: it rebuilds the web app and restarts the server.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
UNIT_SRC="${APP_DIR}/deploy"
UNIT_DST="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"

DRY_RUN=0
NO_START=0
NO_BUILD=0

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --no-start) NO_START=1 ;;
    --no-build) NO_BUILD=1 ;;
    -h|--help)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "install.sh: unknown option: ${arg}" >&2
      echo "Usage: $0 [--no-start] [--no-build] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

# Resolve the Bun executable to an absolute path. systemd *user* units do not
# inherit the login shell's PATH (notably ~/.bun/bin), so the units must point
# at Bun directly instead of relying on `/usr/bin/env bun`.
BUN=""
if command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
elif [ -n "${HOME:-}" ] && [ -x "${HOME}/.bun/bin/bun" ]; then
  BUN="${HOME}/.bun/bin/bun"
fi
if [ -z "${BUN}" ]; then
  echo "install.sh: bun not found." >&2
  echo "  Looked for 'bun' on PATH and for an executable \${HOME}/.bun/bin/bun." >&2
  echo "  Install Bun (https://bun.sh) or put it on PATH, then retry." >&2
  exit 1
fi

# Template -> rendered unit file, in a stable order.
UNITS=(
  "inputtracker.service"
  "inputtracker-sync@.service"
  "inputtracker-sync@audiobookshelf.timer"
  "inputtracker-sync@simkl.timer"
  "inputtracker-backup.service"
  "inputtracker-backup.timer"
)
TIMERS=(
  "inputtracker-sync@audiobookshelf.timer"
  "inputtracker-sync@simkl.timer"
  "inputtracker-backup.timer"
)
LINGER_HINT="loginctl enable-linger ${USER:-$(id -un)}"

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "Dry run: nothing will be written or enabled."
  echo "  Repository:   ${APP_DIR}"
  echo "  Unit source:  ${UNIT_SRC}"
  echo "  Unit target:  ${UNIT_DST}"
  echo "  Bun:          ${BUN}"
  echo "  Would render: ${UNITS[*]}"
  echo "  Would run:    systemctl --user daemon-reload"
  if [ "${NO_START}" -eq 0 ]; then
    if [ "${NO_BUILD}" -eq 0 ]; then
      echo "  Would run:    ${BUN} install --frozen-lockfile && ${BUN} run build:web"
    fi
    echo "  Would run:    systemctl --user enable --now inputtracker.service ${TIMERS[*]}"
    echo "  Would run:    systemctl --user restart inputtracker.service"
  else
    echo "  (--no-start) would not enable or start any unit"
  fi
  echo "  Hint: ${LINGER_HINT}"
  exit 0
fi

HAVE_SYSTEMCTL=0
if command -v systemctl >/dev/null 2>&1; then
  HAVE_SYSTEMCTL=1
fi

mkdir -p "${UNIT_DST}"

for unit in "${UNITS[@]}"; do
  src="${UNIT_SRC}/${unit}"
  dst="${UNIT_DST}/${unit}"
  tmp="${dst}.tmp.$$"
  content="$(<"${src}")"
  # Bash replacement (not sed) so '&' and '|' in the path are safe.
  content="${content//@APP_DIR@/${APP_DIR}}"
  content="${content//@BUN@/${BUN}}"
  printf '%s\n' "${content}" > "${tmp}"
  if [ -f "${dst}" ] && cmp -s "${tmp}" "${dst}"; then
    rm -f "${tmp}"
  else
    mv -f "${tmp}" "${dst}"
    echo "installed ${unit}"
  fi
done

if [ "${HAVE_SYSTEMCTL}" -eq 0 ]; then
  echo "systemctl not found; units rendered to ${UNIT_DST} but not reloaded or enabled." >&2
  echo "Hint: ${LINGER_HINT}"
  exit 0
fi

systemctl --user daemon-reload

if [ "${NO_START}" -eq 0 ]; then
  if [ "${NO_BUILD}" -eq 0 ]; then
    # The server serves web/dist, which is not in git: build it before (re)starting.
    (cd "${APP_DIR}" && "${BUN}" install --frozen-lockfile && "${BUN}" run build:web)
  fi
  systemctl --user enable --now "inputtracker.service" "${TIMERS[@]}"
  # enable --now leaves an already running server on old code; restart picks up updates.
  systemctl --user restart "inputtracker.service"
  echo "InputTracker service and timers enabled."
else
  echo "--no-start: units reloaded; enable them with: systemctl --user enable --now inputtracker.service ${TIMERS[*]}"
fi

echo "Hint: ${LINGER_HINT}"
exit 0
