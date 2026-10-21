#!/usr/bin/env bash
# Ship the committed app to the server VM and (re)start it there.
#
# Heavy work stays on this machine: the web app is built here and copied as
# web/dist; the VM only runs `bun install --production` and scripts/install.sh.
# The code is the committed HEAD (git archive), never the working tree, so local
# experiments and gitignored files (config, databases, .task) are never sent.
# The VM's own config and data are kept (rsync protects them).
#
# Usage: scripts/deploy-vm.sh <ssh-host> [--no-build]
#   <ssh-host>  e.g. input-tracker (an ~/.ssh/config alias) or ubuntu@100.x.y.z
# Remote layout: ~/inputtracker (code + config), data in ~/.local/share/inputtracker.
set -euo pipefail

HOST="${1:?usage: scripts/deploy-vm.sh <ssh-host> [--no-build]}"
NO_BUILD=0
[ "${2:-}" = "--no-build" ] && NO_BUILD=1
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain -- web src package.json bun.lock deploy)" ]; then
  echo "deploy-vm: uncommitted changes in web/, src/, deploy/ or the lockfile; commit first." >&2
  exit 1
fi

STAGE="${HOME}/.cache/inputtracker-deploy"
rm -rf "$STAGE"
mkdir -p "$STAGE"
git archive HEAD | tar -x -C "$STAGE"
if [ "$NO_BUILD" = 0 ]; then bun run build:web >/dev/null; fi
[ -f web/dist/index.html ] || { echo "deploy-vm: web/dist missing; run without --no-build" >&2; exit 1; }
cp -a web/dist "$STAGE/web/dist"

# P = protect on the receiver: keep the VM's config, deps and data untouched by --delete.
rsync -az --delete \
  --filter='P /inputtracker.config.toml' --filter='P /node_modules/' --filter='P /.task/' \
  "$STAGE/" "${HOST}:inputtracker/"

ssh "$HOST" 'set -e; cd ~/inputtracker
  ~/.bun/bin/bun install --frozen-lockfile --production >/dev/null
  scripts/install.sh --role server --no-build
  for i in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/)" = 200 ] && { echo "server up"; exit 0; }
    sleep 1
  done
  echo "server did not answer on 127.0.0.1:8787" >&2; exit 1'
echo "Deployed $(git rev-parse --short HEAD) to ${HOST}."
