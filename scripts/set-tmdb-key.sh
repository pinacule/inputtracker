#!/usr/bin/env bash
# Put a TMDB API key (v3 "API Key", 32 hex chars) into inputtracker.config.toml without ever
# showing it: hidden prompt -> check against TMDB (GET /3/configuration) -> write the
# [metadata] tmdb_api_key line -> restart the server.
# The key never appears in arguments, the process list, logs or output.
# Usage: scripts/set-tmdb-key.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CFG=inputtracker.config.toml
[ -f "$CFG" ] || { echo "No $CFG here." >&2; exit 1; }

read -rsp "Paste the TMDB API Key (the short one, hidden): " KEY; echo
[ -n "$KEY" ] || { echo "No key entered; nothing changed."; exit 1; }
[[ "$KEY" =~ ^[0-9a-fA-F]{32}$ ]] || {
  echo "That is not a 32-character API Key (the long 'Read Access Token' is a different thing); nothing changed." >&2
  exit 1
}

# The URL (with the key) goes to curl through stdin, not through arguments.
code=$(printf 'url = "https://api.themoviedb.org/3/configuration?api_key=%s"\n' "$KEY" |
  curl -s -m 15 -o /dev/null -w '%{http_code}' -K - || true)
if [ "$code" != 200 ]; then
  echo "TMDB did not accept the key (HTTP $code); $CFG left unchanged." >&2
  exit 1
fi

# Rewrite only the tmdb_api_key line inside [metadata] (add the section if missing);
# atomic replace, permissions kept.
TMDB_KEY="$KEY" python3 - "$CFG" <<'EOF'
import json, os, re, sys, tempfile
path = sys.argv[1]
key = os.environ["TMDB_KEY"]
line_out = "tmdb_api_key = " + json.dumps(key)
lines = open(path, encoding="utf-8").read().split("\n")
out, section, done = [], None, False
for line in lines:
    m = re.match(r"\s*\[([^\]]+)\]\s*(#.*)?$", line)
    if m:
        if section == "metadata" and not done:
            out.append(line_out); done = True
        section = m.group(1).strip()
    if section == "metadata" and re.match(r"\s*tmdb_api_key\s*=", line):
        if not done:
            out.append(line_out); done = True
        continue
    out.append(line)
if not done:
    if section == "metadata":
        out.append(line_out)
    else:
        out += ["", "[metadata]", line_out]
mode = os.stat(path).st_mode
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=".cfg-")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("\n".join(out))
os.chmod(tmp, mode)
os.replace(tmp, path)
EOF
unset KEY
echo "Key saved (accepted by TMDB). Restarting the server..."
scripts/install.sh --no-build >/dev/null
echo "Done. TMDB is now used for film and series lookups."
