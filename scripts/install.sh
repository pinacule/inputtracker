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
# Usage: scripts/install.sh [--no-start] [--dry-run]
#   --no-start  render units and reload systemd, but do not enable/start them
#   --dry-run   print what would happen and touch nothing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
UNIT_SRC="${APP_DIR}/deploy"
UNIT_DST="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"

DRY_RUN=0
NO_START=0

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --no-start) NO_START=1 ;;
    -h|--help)
      sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "install.sh: unknown option: ${arg}" >&2
      echo "Usage: $0 [--no-start] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

# Template -> rendered unit file, in a stable order.
UNITS=(
  "inputtracker.service"
  "inputtracker-sync@.service"
  "inputtracker-sync@audiobookshelf.timer"
  "inputtracker-backup.service"
  "inputtracker-backup.timer"
)
TIMERS=(
  "inputtracker-sync@audiobookshelf.timer"
  "inputtracker-backup.timer"
)
LINGER_HINT="loginctl enable-linger ${USER:-$(id -un)}"

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "Dry run: nothing will be written or enabled."
  echo "  Repository:   ${APP_DIR}"
  echo "  Unit source:  ${UNIT_SRC}"
  echo "  Unit target:  ${UNIT_DST}"
  echo "  Would render: ${UNITS[*]}"
  echo "  Would run:    systemctl --user daemon-reload"
  if [ "${NO_START}" -eq 0 ]; then
    echo "  Would run:    systemctl --user enable --now inputtracker.service ${TIMERS[*]}"
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
  printf '%s\n' "${content//@APP_DIR@/${APP_DIR}}" > "${tmp}"
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
  systemctl --user enable --now "inputtracker.service" "${TIMERS[@]}"
  echo "InputTracker service and timers enabled."
else
  echo "--no-start: units reloaded; enable them with: systemctl --user enable --now inputtracker.service ${TIMERS[*]}"
fi

echo "Hint: ${LINGER_HINT}"
exit 0
