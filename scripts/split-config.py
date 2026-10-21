#!/usr/bin/env python3
"""Split one InputTracker config into the server (VM) and PC halves of MIGRATION.md.

  split-config.py vm <pc-config> <out> --vm-url URL --abs-url URL
      Write the server copy to <out> (mode 0600): storage paths dropped (the VM's
      defaults apply), audiobookshelf.url = --abs-url, activitywatch.mode = "push",
      [push] removed, notify.desktop = false, notify.app_url = --vm-url.
      Requires an [ingest] token (the phone and the PC push use it).

  split-config.py pc <pc-config> --vm-url URL
      Edit the PC config in place for push mode: activitywatch.mode = "push",
      [push] server_url = --vm-url and token = the [ingest] token.

Values are never printed: only key names and what changed. Writes are atomic and
keep the file's permissions (0600 for new files). Safe to run repeatedly.
"""
import argparse
import json
import os
import re
import sys
import tempfile

HEADER = re.compile(r"\s*\[([^\[\]]+)\]\s*(#.*)?$")


def key_re(key):
    return re.compile(r"\s*" + re.escape(key) + r"\s*=")


def parse(lines):
    """Map table name -> (start, end) line span of its body ('' is the root)."""
    spans, name, start = {}, "", 0
    for i, line in enumerate(lines):
        m = HEADER.match(line)
        if m:
            spans.setdefault(name, (start, i))
            name, start = m.group(1).strip(), i + 1
    spans.setdefault(name, (start, len(lines)))
    return spans


def get(lines, table, key):
    spans = parse(lines)
    if table not in spans:
        return None
    a, b = spans[table]
    for line in lines[a:b]:
        if key_re(key).match(line):
            value = line.split("=", 1)[1].strip()
            try:
                return json.loads(value.split(" #")[0].strip()) if value.startswith('"') else value
            except ValueError:
                return None
    return None


def set_key(lines, table, key, value):
    """Set a string or boolean value (JSON quoting matches TOML basic strings)."""
    out_line = f"{key} = {json.dumps(value)}"
    spans = parse(lines)
    if table not in spans:
        if lines and lines[-1].strip():
            lines.append("")
        lines += [f"[{table}]", out_line]
        return
    a, b = spans[table]
    for i in range(a, b):
        if key_re(key).match(lines[i]):
            lines[i] = out_line
            return
    # After the table's last non-blank line.
    j = b
    while j > a and not lines[j - 1].strip():
        j -= 1
    lines.insert(j, out_line)


def drop_key(lines, table, key):
    spans = parse(lines)
    if table in spans:
        a, b = spans[table]
        lines[a:b] = [l for l in lines[a:b] if not key_re(key).match(l)]


def drop_table(lines, table):
    spans = parse(lines)
    if table in spans:
        a, b = spans[table]
        del lines[a - 1:b]


def write(path, lines, mode=None):
    if mode is None:
        mode = os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o600
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".cfg-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines).rstrip("\n") + "\n")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("role", choices=["vm", "pc"])
    ap.add_argument("config")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--vm-url", required=True)
    ap.add_argument("--abs-url")
    args = ap.parse_args()
    if not re.match(r"^https?://[^/@?#\s]+/?$", args.vm_url):
        sys.exit("--vm-url must be a plain http(s)://host[:port] URL")
    vm_url = args.vm_url.rstrip("/")

    lines = open(args.config, encoding="utf-8").read().split("\n")
    ingest = get(lines, "ingest", "token")
    if not isinstance(ingest, str) or len(ingest) < 32:
        sys.exit("No [ingest] token of 32+ characters in the config; run `bun run it ingest token` first.")

    if args.role == "vm":
        if not args.out or not args.abs_url:
            sys.exit("vm needs <out> and --abs-url")
        drop_key(lines, "storage", "db_path")
        drop_key(lines, "storage", "backup_dir")
        set_key(lines, "audiobookshelf", "url", args.abs_url)
        set_key(lines, "activitywatch", "mode", "push")
        drop_table(lines, "push")
        set_key(lines, "notify", "desktop", False)
        set_key(lines, "notify", "app_url", vm_url)
        write(args.out, lines, 0o600)
        print(f"VM config written to {args.out}: storage paths -> defaults, audiobookshelf.url, "
              "activitywatch.mode=push, [push] removed, notify.desktop=false, notify.app_url")
    else:
        set_key(lines, "activitywatch", "mode", "push")
        set_key(lines, "push", "server_url", vm_url)
        set_key(lines, "push", "token", ingest)
        write(args.config, lines)
        print(f"PC config updated: activitywatch.mode=push, push.server_url, push.token (= ingest token)")


if __name__ == "__main__":
    main()
