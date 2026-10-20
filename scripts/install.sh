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
# Usage: scripts/install.sh [--role pc|server|local] [--no-start] [--no-build] [--dry-run]
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
ROLE=local

while [ "$#" -gt 0 ]; do
  arg="$1"
  shift
  case "${arg}" in
    --role)
      if [ "$#" -eq 0 ]; then echo "install.sh: missing --role" >&2; exit 2; fi
      ROLE="$1"; shift ;;
    --role=*) ROLE="${arg#--role=}" ;;
    --dry-run) DRY_RUN=1 ;;
    --no-start) NO_START=1 ;;
    --no-build) NO_BUILD=1 ;;
    -h|--help)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "install.sh: unknown option: ${arg}" >&2
      echo "Usage: $0 [--role pc|server|local] [--no-start] [--no-build] [--dry-run]" >&2
      exit 2
      ;;
  esac
done
case "$ROLE" in pc|server|local) ;; *) echo "install.sh: invalid role" >&2; exit 2 ;; esac

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
  "inputtracker-sync@activitywatch.timer"
  "inputtracker-backup.service"
  "inputtracker-backup.timer"
  "inputtracker-weekly.service"
  "inputtracker-weekly.timer"
)
TIMERS=(
  "inputtracker-sync@audiobookshelf.timer"
  "inputtracker-sync@simkl.timer"
  "inputtracker-sync@activitywatch.timer"
  "inputtracker-backup.timer"
  "inputtracker-weekly.timer"
)
LINGER_HINT="loginctl enable-linger ${USER:-$(id -un)}"
START_UNITS=("inputtracker.service" "${TIMERS[@]}")
DISABLE_UNITS=()
STOP_UNITS=()
if [ "$ROLE" = local ]; then
  DISABLE_UNITS+=("inputtracker-push@activitywatch.timer")
  STOP_UNITS+=("inputtracker-push@activitywatch.service")
fi
if [ "$ROLE" = server ]; then
  UNITS=("${UNITS[@]/inputtracker-sync@activitywatch.timer}")
  TIMERS=("${TIMERS[@]/inputtracker-sync@activitywatch.timer}")
  # Drop empty entries produced by array replacement.
  filtered=(); for unit in "${UNITS[@]}"; do [ -z "$unit" ] || filtered+=("$unit"); done; UNITS=("${filtered[@]}")
  filtered=(); for unit in "${TIMERS[@]}"; do [ -z "$unit" ] || filtered+=("$unit"); done; TIMERS=("${filtered[@]}")
  START_UNITS=("inputtracker.service" "${TIMERS[@]}")
  DISABLE_UNITS+=("inputtracker-sync@activitywatch.timer")
  DISABLE_UNITS+=("inputtracker-push@activitywatch.timer")
  STOP_UNITS+=("inputtracker-sync@activitywatch.service" "inputtracker-push@activitywatch.service")
elif [ "$ROLE" = pc ]; then
  DISABLE_UNITS=("inputtracker.service" "${TIMERS[@]}")
  STOP_UNITS=("inputtracker-sync@audiobookshelf.service" "inputtracker-sync@simkl.service"
    "inputtracker-sync@activitywatch.service" "inputtracker-backup.service" "inputtracker-weekly.service")
  UNITS=("inputtracker-push@.service" "inputtracker-push@activitywatch.timer")
  TIMERS=("inputtracker-push@activitywatch.timer")
  START_UNITS=("${TIMERS[@]}")
  NO_BUILD=1
fi

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "Dry run: nothing will be written or enabled."
  echo "  Repository:   ${APP_DIR}"
  echo "  Unit source:  ${UNIT_SRC}"
  echo "  Unit target:  ${UNIT_DST}"
  echo "  Bun:          ${BUN}"
  echo "  Role:         ${ROLE}"
  echo "  Would render: ${UNITS[*]}"
  echo "  Would run:    systemctl --user daemon-reload"
  if [ "${NO_START}" -eq 0 ]; then
    if [ "${NO_BUILD}" -eq 0 ]; then
      echo "  Would run:    ${BUN} install --frozen-lockfile && ${BUN} run build:web"
    fi
    echo "  Would disable existing incompatible units: ${DISABLE_UNITS[*]}"
    echo "  Would stop active incompatible services: ${STOP_UNITS[*]}"
    echo "  Would run:    systemctl --user enable --now ${START_UNITS[*]}"
    if [ "$ROLE" != pc ]; then echo "  Would run:    systemctl --user restart inputtracker.service"; fi
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
  for unit in "${DISABLE_UNITS[@]}"; do
    if systemctl --user cat "$unit" >/dev/null 2>&1; then systemctl --user disable --now "$unit"; fi
  done
  # Disabling a timer alone leaves an already-running oneshot writing the old archive.
  for unit in "${STOP_UNITS[@]}"; do
    if systemctl --user cat "$unit" >/dev/null 2>&1; then systemctl --user stop "$unit"; fi
  done
  systemctl --user enable --now "${START_UNITS[@]}"
  # enable --now leaves an already running server on old code; restart picks up updates.
  if [ "$ROLE" != pc ]; then systemctl --user restart "inputtracker.service"; fi
  echo "InputTracker service and timers enabled."
else
  echo "--no-start: units reloaded; enable them with: systemctl --user enable --now ${START_UNITS[*]}"
fi

echo "Hint: ${LINGER_HINT}"
exit 0
