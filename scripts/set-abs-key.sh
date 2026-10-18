#!/usr/bin/env bash
# Replace the Audiobookshelf API key in inputtracker.config.toml without ever showing it:
# hidden prompt -> read-only check (GET /api/me) -> write the [audiobookshelf] token line -> one sync.
# The key never appears in arguments, logs or output. Audiobookshelf itself is only read.
# Usage: scripts/set-abs-key.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CFG=inputtracker.config.toml
[ -f "$CFG" ] || { echo "No $CFG here." >&2; exit 1; }

URL=$(bun -e 'import { loadConfig } from "./src/core/config.ts";
console.log(loadConfig({ path: "inputtracker.config.toml" }).audiobookshelf.url.replace(/\/+$/, ""))')

read -rsp "Paste the new Audiobookshelf API key (hidden): " KEY; echo
[ -n "$KEY" ] || { echo "No key entered; nothing changed."; exit 1; }

code=$(printf 'Authorization: Bearer %s\n' "$KEY" |
  curl -s -m 15 -o /dev/null -w '%{http_code}' -H @- "$URL/api/me" || true)
if [ "$code" != 200 ]; then
  echo "Audiobookshelf did not accept the key (HTTP $code); $CFG left unchanged." >&2
  exit 1
fi

# Rewrite only the token line inside [audiobookshelf]; atomic replace, permissions kept.
ABS_KEY="$KEY" python3 - "$CFG" <<'EOF'
import json, os, re, sys, tempfile
path = sys.argv[1]
key = os.environ["ABS_KEY"]
lines = open(path, encoding="utf-8").read().split("\n")
out, section, done = [], None, False
for line in lines:
    m = re.match(r"\s*\[([^\]]+)\]\s*(#.*)?$", line)
    if m:
        if section == "audiobookshelf" and not done:
            out.append("token = " + json.dumps(key)); done = True
        section = m.group(1).strip()
    if section == "audiobookshelf" and re.match(r"\s*token\s*=", line):
        if not done:
            out.append("token = " + json.dumps(key)); done = True
        continue
    out.append(line)
if not done:
    if section == "audiobookshelf":
        out.append("token = " + json.dumps(key))
    else:
        out += ["", "[audiobookshelf]", "token = " + json.dumps(key)]
mode = os.stat(path).st_mode
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=".cfg-")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("\n".join(out))
os.chmod(tmp, mode)
os.replace(tmp, path)
EOF
unset KEY
echo "Key saved (accepted by Audiobookshelf). Running one sync..."
bun run src/cli/index.ts sync audiobookshelf
