# InputTracker

InputTracker is a personal media/input tracker. It records what you consume and
shows it as a calendar, heat map, stats and in-progress/finished lists.
Everything is stored in a local SQLite database, and the web app is a PWA you
can install on your phone.

Sources: Audiobookshelf and Simkl (both read-only syncs) and YouTube Takeout
imports (local files). Manual entries are supported too.

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
| `simkl.client_id` | empty | Simkl V2 app client id; required for Simkl sync. |
| `simkl.base_url` | `https://api.simkl.com` | Simkl API base URL. |
| `simkl.poster_base_url` | `https://simkl.in/posters` | Base URL for Simkl poster images. |
| `simkl.timeout_s` | `20` | Per-request timeout, in seconds. |
| `youtube.thumb_base_url` | `https://i.ytimg.com/vi` | Base URL for YouTube video thumbnails. |
| `ingest.token` | empty | Shared bearer token for `POST /api/ingest/youtube-plays` (phone); empty disables ingest, a non-empty value must be at least 32 characters. Never logged. |
| `activitywatch.url` | `http://127.0.0.1:5600` | ActivityWatch server URL. |
| `activitywatch.timeout_s` | `20` | Per-request timeout, in seconds. |
| `activitywatch.device` | `pc` | Device label for YouTube plays. |
| `activitywatch.include_music` | `false` | Whether `music.youtube.com` counts. |
| `notify.desktop` | `true` | Desktop notification on sync failure (via `notify-send`; silently ignored when missing). |
| `notify.ntfy_url` | empty | Optional ntfy topic URL for failure alerts, recovery notices and the weekly summary. |
| `notify.ntfy_token` | empty | Optional ntfy access token (`Authorization: Bearer …`); never logged. |
| `notify.app_url` | empty | Web app URL sent as the ntfy `Click` header (e.g. its Tailscale address). |
| `notify.weekly_summary` | `false` | Enable the weekly summary push (title of what you consumed only reaches the ntfy server when this is on). |

The Audiobookshelf token stays server-side. It is read from the config and is
never sent to the browser: cover images and every Audiobookshelf call are
proxied by the server, so the browser never sees the token or the
Audiobookshelf URL either. The `ingest` token is treated the same way: phones
send it in the `Authorization` header, and the server only compares it.

## Phone notifications (ntfy)

Sync failures, backup failures (one alert per outage plus one recovery), and
the optional weekly summary go to [ntfy](https://ntfy.sh) so they reach your
phone:

1. Install the ntfy app on the phone.
2. Pick a **long random topic name** — ntfy.sh topics are public by name, so
   anyone who learns the string can see your pushes — and subscribe to it.
3. Set `[notify] ntfy_url` (e.g. `"https://ntfy.sh/<your-random-topic>"`) in
   `inputtracker.config.toml`; optionally `ntfy_token` for an access-token
   protected server and `app_url` (e.g. the Tailscale URL of the web app) to
   make the pushes tappable.
4. Check the setup:

   ```sh
   bun run it notify test
   ```

   It sends one test notification through every configured channel and prints
   which ones succeeded (never the URL or token).

The weekly summary is off by default; enable `[notify] weekly_summary = true`
and install (`scripts/install.sh`) the `inputtracker-weekly.timer`, which runs
`it notify weekly` Sundays at 19:00 local time. Note that enabling the summary
also puts the titles of what you watched on the ntfy server.

## Run in development

```sh
bun install
bun run build:web   # the server serves web/dist, which is not in git
bun run dev         # http://<bind>:<port>, default http://127.0.0.1:8787
```

Checks:

```sh
bun run check   # tsc for src/ and web/, then bun test
bun run smoke   # end-to-end run against fake Audiobookshelf, Simkl and YouTube servers (temp dirs, no outside network)
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
| `inputtracker-sync@simkl.timer` | Simkl sync | hourly at :30, persistent, up to 120 s jitter |
| `inputtracker-sync@activitywatch.timer` | ActivityWatch sync (YouTube) | every 10 minutes (`*:0/10`), persistent, up to 30 s jitter |
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
| `sync <source>` | source is `audiobookshelf`, `simkl`, or `activitywatch` | `bun run it sync activitywatch` |
| `auth simkl` | `[--status]` | `bun run it auth simkl` |
| `add` | `--type <t> --title <title> --start <local> [--end <local>] [--duration-min <n>] [--parent <title>] [--season <n>] [--episode <n>] [--progress <0..1>] [--device <name>]` | `bun run it add --type audiobook --title "The Synthetic Tale" --start "2026-10-17 21:30" --duration-min 45` |
| `export` | `--format json\|csv --out <file>` | `bun run it export --format json --out archive.json` |
| `import` | `<file> [--format json\|csv]` | `bun run it import archive.json` |
| `import youtube-takeout` | `<file>` | `bun run it import youtube-takeout watch-history.json` |
| `backup` | none | `bun run it backup` |

Details:

- `sync audiobookshelf` fetches sessions, media progress and daily stats from
  Audiobookshelf and inserts the new rows. It only ever issues GET requests.
- `sync activitywatch` queries local ActivityWatch for browser YouTube activity
  and inserts new plays. It only ever issues GET requests.
- `auth simkl` connects Simkl via device flow (prints a link + code);
  `--status` shows whether it is connected, without network.
- `add` records a consumed item by hand. `--type`, `--title` and `--start` are
  required. `--duration-min` (minutes) wins over `--end`; without either the
  duration is left empty. `--progress` is a fraction between 0 and 1;
  `--season` and `--episode` are non-negative integers. `--start` and `--end`
  are local wall-clock times in the configured timezone (`YYYY-MM-DD HH:MM`,
  `YYYY-MM-DDTHH:MM`, an optional `:SS`, or a bare date). A value that already
  ends in `Z` or a numeric offset is respected as-is.
- `export` writes the full archive (every row) as JSON (events, goals, ratings
  and notes) or CSV (events only). `import` reads such a file back; the record
  hash is recomputed, so re-importing adds nothing.
- `backup` writes `inputtracker-YYYY-MM-DD.db` (a `VACUUM INTO` snapshot) and
  the matching `.json` export into `backup_dir`, then prunes older date sets.
- `it help`, `it --help` and `it -h` print the usage text and exit 0. Running
  with no command prints the usage text and exits 1.

Exit codes: `0` success, `1` bad usage (also invalid `add` input), `2` failure
(missing/unreadable config, database, sync, export or import errors).

## Simkl (TV shows, movies, anime)

1. Register a **V2** app at https://simkl.com/settings/developer/ with client type
   **"TV, devices & command line"**. It needs no client secret and no redirect URI.
2. Copy the commented `[simkl]` block from `inputtracker.config.example.toml` into
   `inputtracker.config.toml` and paste the app's `client_id` there. The block's other
   keys are `base_url` (default `https://api.simkl.com`), `poster_base_url` (default
   `https://simkl.in/posters`) and `timeout_s` (default `20`). The `client_id` is not a
   secret, but the config file stays out of git.
3. Run `bun run it auth simkl`. It prints an approval link on one line, plus a fallback
   link and code: open the link on any device and approve. The command polls until it
   succeeds, then exits by itself; it stops after at most 10 minutes and prints
   `code expired, run 'it auth simkl' again`. `bun run it auth simkl --status` shows
   whether Simkl is connected, the scope and the date the access token is valid until
   (no network; it never prints tokens).
4. Tokens are stored in `<directory of db_path>/secrets/simkl-token.json`: the `secrets`
   directory is mode 0700 and the file mode 0600. Never commit or share that file. The
   access token refreshes automatically; if a refresh fails, the sync error tells you to
   run `it auth simkl` again.
5. Re-run `scripts/install.sh` so the new `inputtracker-sync@simkl.timer` is installed and
   enabled. It runs the Simkl sync hourly at :30, persistent, with up to 120 s of jitter
   (the Audiobookshelf timer runs on the hour).
6. Sync now with `bun run it sync simkl`, or use "Sync Simkl now" on the Import/Export
   page (`POST /api/sync/simkl`). If `simkl.client_id` is empty or the account is not
   authorised, `sync simkl` prints a hint and exits 0, so the timer records no failed run
   and sends no notification.

InputTracker only reads from Simkl: every data call is a GET, and the only POSTs are the
two sign-in endpoints (`/oauth2/device` and `/oauth2/token`). It never changes anything in
your Simkl account. Posters are fetched from `simkl.in` directly by the server and cached
on disk; no third-party image proxy is used.

## YouTube watch history (Google Takeout)

1. Go to https://takeout.google.com, choose **Deselect all**, then select only
   **YouTube and YouTube Music**.
2. Open "All YouTube data included" and keep only **history**. Under "Multiple formats"
   set History to **JSON** (HTML is not supported).
3. Create the export, download it and unzip it. The file you need is
   `Takeout/YouTube and YouTube Music/history/watch-history.json`.
4. Import it with `bun run it import youtube-takeout <path to watch-history.json>`. It
   prints the record count, the views seen, the views inserted and the skip counts. You
   can also upload the file on the Import/Export page; that path accepts files up to
   512 MB, so use the CLI for bigger exports.
5. Re-importing the same file, or a newer export that overlaps an older one, adds only the
   new views; duplicates are ignored.
6. Keep the Takeout file out of the repo: `.gitignore` already ignores
   `watch-history*.json` and `Takeout/`.

YouTube records carry no watch duration, so YouTube views count as views, not minutes.
When the source filter is YouTube, Stats and Heat map default to the Count metric, and a
minutes view shows the note "YouTube counts views, not minutes." Thumbnails are fetched
from `i.ytimg.com` by the server and cached on disk (`GET /api/thumb/youtube/<videoId>`);
no third-party image proxy is used. The import reads the local file only, no network.

Skipped records are counted per reason: `ads` (Google Ads), `no_video` (removed or private
videos, and anything without a usable video id), `other` (records whose `products` do not
include `YouTube`) and `invalid` (a record with no parseable time).

## YouTube from ActivityWatch

ActivityWatch runs on your PC with its browser extension (`aw-watcher-web`) in
Chrome and Firefox. It records active tab URLs, titles, duration, and whether
audio was playing. InputTracker queries ActivityWatch to turn browser YouTube
activity into `youtube` events:

- Needs ActivityWatch running locally (default `http://127.0.0.1:5600`) and the
  `aw-watcher-web` browser extension installed.
- Incognito tabs are ignored completely.
- The channel is unknown from tab titles, so it is left empty.
- Runs every 10 minutes via the `inputtracker-sync@activitywatch.timer` systemd timer.
- Only issues read-only `GET` requests to the local ActivityWatch API.
- When the server moves to a cloud VM, this sync will need to run on the PC (where the browser runs).

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

## Ingest from the phone

The second-brain Android app reads what the YouTube app plays and POSTs each
batch to InputTracker. Set it up:

1. Generate a token: `bun run it ingest token`.
2. Put that value under `[ingest] token` in `inputtracker.config.toml`
   (leave it empty to keep ingest off; a shorter value is a config error).
3. Run `scripts/install.sh` to restart the server with the new config.
4. In the phone app, enter the server URL and the same token.

The endpoint is `POST /api/ingest/youtube-plays`; the request/response contract,
the size limit and the idempotency rules are in
[`docs/ingest-api.md`](docs/ingest-api.md). `bun run it ingest status` shows
whether ingest is enabled. The token never appears in logs, the web app or
error responses. `bun run it ingest remap` re-maps stored phone plays through
current mapping rules (e.g. promoting YouTube Music plays to `music`) in an
append-only run.

## Backups, export and import

- `it backup` writes a dated SQLite snapshot and a full JSON export into
  `backup_dir`, keeping the newest `backup_keep` date sets (at least one). The
  backup timer does this nightly at 03:30.
- `it export --format json|csv --out <file>` writes the full archive. JSON is an
  envelope with every row of `events`, `goals` and `annotations` (see
  `DATA_FORMAT.md`); CSV has `events` only, one header row with every column. The web app offers the same two downloads at `/api/export.json` and
  `/api/export.csv`.
- `it import <file>` (or the web upload) reads a native export back. The record
  hash is recomputed from the data, and inserts are `INSERT OR IGNORE`, so
  re-importing the same file adds nothing twice.

The exact column types, the `events_latest` view and worked SQL examples are in
[`DATA_FORMAT.md`](DATA_FORMAT.md).

## Moving to another machine

- `it doctor` checks the environment (architecture, Bun, config, database, backup
  directory, port, systemd, lingering, Tailscale) and exits non-zero on a real
  problem. It is strictly read-only.
- `it verify-copy <copy.db>` checks a copied database against the configured one
  and reports any events, goals or annotations missing from the copy.

The step-by-step PC → VM move (Tailscale, snapshot, copy, install, rollback) is
in [`MIGRATION.md`](MIGRATION.md).

## Data safety rules in short

- `events` is append-only: database triggers abort every `UPDATE` and `DELETE`.
  A changed record is written as a new row; inserts use `INSERT OR IGNORE` on
  the unique `record_hash`.
- Audiobookshelf is only read from: every request is a GET through the
  allow-listed client in `src/sources/audiobookshelf/client.ts`.
- Simkl is only read from too: data requests go through the allow-listed client
  in `src/sources/simkl/client.ts` (GET only; the two sign-in endpoints are the
  only POSTs). Nothing is ever written to the Simkl account.
- A YouTube Takeout import reads the local file only; it never uses the network.
- Timestamps are stored as UTC ISO 8601 with milliseconds; the configured
  timezone is applied only for display and bucketing.
