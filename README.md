# InputTracker

InputTracker is a personal media/input tracker. It records what you consume and
shows it as a calendar, heat map, stats and in-progress/finished lists.
Everything is stored in a local SQLite database, and the web app is a PWA you
can install on your phone.

The v1 source is Audiobookshelf (read-only); manual entries are supported too.

## Requirements

- Bun (a recent 1.x release).
- Linux on x86_64 or ARM64.
- For the service install: a systemd user session (a normal login gives you one).

## Configure

Copy the example config and restrict it:

```sh
cp inputtracker.config.example.toml inputtracker.config.toml
chmod 600 inputtracker.config.toml
```

`inputtracker.config.toml` is gitignored. The app reads it from the current
directory by default; set `INPUTTRACKER_CONFIG=/path/to/file.toml` to point at a
different file (the explicit path option built into the code beats the env var).

Every key, its default and what it means:

| Key | Default | Meaning |
|---|---|---|
| `timezone` | `Europe/Bratislava` | IANA zone used only for display and bucketing. Stored timestamps are UTC. |
| `server.bind` | `127.0.0.1` | Interface the HTTP server listens on. |
| `server.port` | `8787` | HTTP port. |
| `storage.db_path` | `$XDG_DATA_HOME/inputtracker/inputtracker.db`, else `~/.local/share/inputtracker/inputtracker.db` | SQLite database file. |
| `storage.backup_dir` | `$XDG_DATA_HOME/inputtracker/backups`, else `~/.local/share/inputtracker/backups` | Where `it backup` writes its snapshots. |
| `storage.backup_keep` | `14` | How many dated backup sets to keep (clamped to at least 1). |
| `audiobookshelf.url` | `http://localhost:<port>` (default port 13378) | Audiobookshelf server base URL. |
| `audiobookshelf.token` | empty | Audiobookshelf API token; required for syncing. |
| `audiobookshelf.timeout_s` | `20` | Per-request timeout, in seconds. |
| `notify.desktop` | `true` | Desktop notification on sync failure (via `notify-send`; silently ignored when missing). |
| `notify.ntfy_url` | empty | Optional ntfy topic URL for sync failure alerts. |

The Audiobookshelf token stays server-side. It is read from the config and is
never sent to the browser: cover images and every Audiobookshelf call are
proxied by the server, so the browser never sees the token or the
Audiobookshelf URL either.

## Run in development

```sh
bun install
bun run build:web   # the server serves web/dist, which is not in git
bun run dev         # http://<bind>:<port>, default http://127.0.0.1:8787
```

Checks:

```sh
bun run check   # tsc for src/ and web/, then bun test
bun run smoke   # end-to-end run against a fake Audiobookshelf (temp dirs, no outside network)
```

## Install as a service

`scripts/install.sh` renders the templates in `deploy/` into your systemd
**user** unit directory (default `~/.config/systemd/user`), replacing the
`@APP_DIR@` and `@BUN@` placeholders with this repository and your Bun path, and
then reloads systemd. No sudo is needed.

A full run:

1. renders the units and runs `systemctl --user daemon-reload`;
2. runs `bun install --frozen-lockfile` and `bun run build:web`;
3. runs `systemctl --user enable --now inputtracker.service` plus the timers;
4. restarts `inputtracker.service` so it picks up the new build.

Flags:

| Flag | Effect |
|---|---|
| (none) | the full run described above |
| `--no-start` | render the units and reload systemd, but do not enable or start anything |
| `--no-build` | skip `bun install` and the web build |
| `--dry-run` | print what would happen and touch nothing |

Re-running the script is also the update step: it rebuilds the web app and
restarts the server.

Units and timers it installs:

| Unit | What it does | Schedule |
|---|---|---|
| `inputtracker.service` | runs the HTTP server | always (restarts on failure) |
| `inputtracker-sync@.service` | oneshot `it sync %i` | launched by its timer |
| `inputtracker-sync@audiobookshelf.timer` | Audiobookshelf sync | hourly, persistent, up to 120 s jitter |
| `inputtracker-backup.service` | oneshot `it backup` | launched by its timer |
| `inputtracker-backup.timer` | database snapshot + JSON export | daily at 03:30, persistent |

Inspect the service and timers, and read the logs:

```sh
systemctl --user status inputtracker.service
systemctl --user list-timers
journalctl --user -u inputtracker.service -f
journalctl --user -u inputtracker-sync@audiobookshelf.service
```

On a headless machine, enable lingering so the units keep running without an
open session: `loginctl enable-linger $USER` (the installer prints this hint).

## CLI

Run commands with `bun run it <command>`.

| Command | Options | Example |
|---|---|---|
| `sync audiobookshelf` | source name; only `audiobookshelf` is accepted | `bun run it sync audiobookshelf` |
| `auth simkl` | `[--status]` | `bun run it auth simkl` |
| `add` | `--type <t> --title <title> --start <local> [--end <local>] [--duration-min <n>] [--parent <title>] [--season <n>] [--episode <n>] [--progress <0..1>] [--device <name>]` | `bun run it add --type audiobook --title "The Synthetic Tale" --start "2026-10-17 21:30" --duration-min 45` |
| `export` | `--format json\|csv --out <file>` | `bun run it export --format json --out archive.json` |
| `import` | `<file> [--format json\|csv]` | `bun run it import archive.json` |
| `import youtube-takeout` | `<file>` | `bun run it import youtube-takeout watch-history.json` |
| `backup` | none | `bun run it backup` |

Details:

- `sync audiobookshelf` fetches sessions, media progress and daily stats from
  Audiobookshelf and inserts the new rows. It only ever issues GET requests.
- `auth simkl` connects Simkl via device flow (prints a link + code);
  `--status` shows whether it is connected, without network.
- `add` records a consumed item by hand. `--type`, `--title` and `--start` are
  required. `--duration-min` (minutes) wins over `--end`; without either the
  duration is left empty. `--progress` is a fraction between 0 and 1;
  `--season` and `--episode` are non-negative integers. `--start` and `--end`
  are local wall-clock times in the configured timezone (`YYYY-MM-DD HH:MM`,
  `YYYY-MM-DDTHH:MM`, an optional `:SS`, or a bare date). A value that already
  ends in `Z` or a numeric offset is respected as-is.
- `export` writes the full archive (every row) as JSON or CSV. `import` reads
  such a file back; the record hash is recomputed, so re-importing adds nothing.
- `backup` writes `inputtracker-YYYY-MM-DD.db` (a `VACUUM INTO` snapshot) and
  the matching `.json` export into `backup_dir`, then prunes older date sets.
- `it help`, `it --help` and `it -h` print the usage text and exit 0. Running
  with no command prints the usage text and exits 1.

Exit codes: `0` success, `1` bad usage (also invalid `add` input), `2` failure
(missing/unreadable config, database, sync, export or import errors).

## Phone install (PWA)

Reach the server over a private network. With Tailscale, serve the server port on
your tailnet:

```sh
tailscale serve --bg 8787
```

Then open `https://<your-machine>.<your-tailnet>.ts.net/` in Chrome and choose
"Install app". Access control is the private network: do not expose the server
publicly.

What works offline:

- the cached app shell and the last successfully loaded read-only data
  (calendar, heat map, stats, lists), because same-origin `GET /api/*` responses
  are cached and served when the network is down;
- navigation to already-cached pages.

What needs the server:

- syncing with Audiobookshelf, importing a file, and adding manual entries (all
  of these are writes, and export/import/sync responses are never cached);
- any data you have not loaded at least once while online.

## Backups, export and import

- `it backup` writes a dated SQLite snapshot and a full JSON export into
  `backup_dir`, keeping the newest `backup_keep` date sets (at least one). The
  backup timer does this nightly at 03:30.
- `it export --format json|csv --out <file>` writes the full `events` archive.
  JSON is an envelope (see `DATA_FORMAT.md`); CSV has one header row with every
  column. The web app offers the same two downloads at `/api/export.json` and
  `/api/export.csv`.
- `it import <file>` (or the web upload) reads a native export back. The record
  hash is recomputed from the data, and inserts are `INSERT OR IGNORE`, so
  re-importing the same file adds nothing twice.

The exact column types, the `events_latest` view and worked SQL examples are in
[`DATA_FORMAT.md`](DATA_FORMAT.md).

## Data safety rules in short

- `events` is append-only: database triggers abort every `UPDATE` and `DELETE`.
  A changed record is written as a new row; inserts use `INSERT OR IGNORE` on
  the unique `record_hash`.
- Audiobookshelf is only read from: every request is a GET through the
  allow-listed client in `src/sources/audiobookshelf/client.ts`.
- Timestamps are stored as UTC ISO 8601 with milliseconds; the configured
  timezone is applied only for display and bucketing.
