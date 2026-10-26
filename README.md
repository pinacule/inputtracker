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
| `youtube.min_watch_minutes` | `5` | Minimum watched minutes per video on one local day to count (0 disables). |
| `youtube.enrich_per_sync` | `50` | Maximum videos enriched (channel + category via GET oEmbed/watch page) per sync run (0 disables). |
| `ingest.token` | empty | Shared bearer token for phone and PC ingest endpoints; empty disables ingest, a non-empty value must be at least 32 characters. Never logged. |
| `activitywatch.mode` | `pull` | `push` disables server-side ActivityWatch pull. |
| `push.server_url` | empty | InputTracker server base URL on the tailnet; prefer HTTPS. |
| `push.token` | empty | Secret matching the server's `ingest.token`, never logged. |
| `activitywatch.url` | `http://127.0.0.1:5600` | ActivityWatch server URL. |
| `activitywatch.timeout_s` | `20` | Per-request timeout, in seconds. |
| `activitywatch.device` | `pc` | Device label for YouTube plays. |
| `activitywatch.include_music` | `false` | Whether `music.youtube.com` counts. |
| `notify.desktop` | `true` | Desktop notification on sync failure (via `notify-send`; silently ignored when missing). |
| `notify.ntfy_url` | empty | Optional ntfy topic URL for failure alerts, recovery notices and the weekly summary. |
| `notify.ntfy_token` | empty | Optional ntfy access token (`Authorization: Bearer …`); never logged. |
| `notify.app_url` | empty | Web app URL sent as the ntfy `Click` header (e.g. its Tailscale address). |
| `notify.weekly_summary` | `false` | Enable the weekly summary push (title of what you consumed only reaches the ntfy server when this is on). |
| `covers.external` | `true` | When true, searches Open Library for covers of books missing from Audiobookshelf (sends title and author to Open Library). |
| `covers.openlibrary_url` | `https://openlibrary.org` | Open Library API base URL for cover search. |
| `covers.openlibrary_covers_url` | `https://covers.openlibrary.org` | Open Library covers base URL. |
| `metadata.enabled` | `true` | Enables external metadata lookup (`/api/lookup/*` and `/api/meta-cover/*`). |
| `metadata.anilist_url` | `https://graphql.anilist.co` | AniList GraphQL endpoint for anime lookup. |
| `metadata.tvmaze_url` | `https://api.tvmaze.com` | TVmaze API base URL for series lookup. |
| `metadata.cinemeta_url` | `https://v3-cinemeta.strem.io` | Stremio Cinemeta API base URL for film and series lookup. |
| `metadata.itunes_url` | `https://itunes.apple.com` | iTunes Search API base URL for film lookup. |
| `metadata.openlibrary_url` | `covers.openlibrary_url` | Open Library API base URL for book and audiobook lookup. |
| `metadata.openlibrary_covers_url` | `covers.openlibrary_covers_url` | Open Library covers base URL for metadata covers. |
| `metadata.tmdb_url` | `https://api.themoviedb.org/3` | TMDB API base URL (used only when `metadata.tmdb_api_key` is set). |
| `metadata.tmdb_image_url` | `https://image.tmdb.org/t/p` | TMDB image CDN base URL. |
| `metadata.tmdb_api_key` | empty | Optional TMDB API key; when set, TMDB is used for films and series ahead of iTunes and TVmaze. Never logged. |

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

## Demo server

Workers building app skins can run the real server on a throw-away database filled with realistic synthetic data:

```sh
bun scripts/demo-server.ts
```

This starts the server on `http://127.0.0.1:8790` and populates a temporary database with ~120 days of synthetic data across every category (anime, series, films, books, audiobooks, YouTube, podcasts, music, shortform, other) with finished, in-progress, and planned works, plus ratings.

Options:
- `--port <port>`: HTTP port (default `8790`).
- `--dir <path>`: temporary working directory (default `.task/demo` if `.task/` exists in cwd, else a new dir under OS tmpdir).
- `--today <YYYY-MM-DD>`: reference anchor date for the ~120-day window (default: today).

To run the Vite frontend against the demo server:

```sh
INPUTTRACKER_API=http://127.0.0.1:8790 bun run dev:web
```
(or `INPUTTRACKER_API=http://127.0.0.1:8790 bunx vite --config web/vite.config.ts`).

## App skins

Settings › Appearance offers four skins; **Dot** is the default. The choice is stored on each device
(`localStorage["inputtracker.theme"]`). Effects (rain, firelight, tape glitches, ambient loops) load
only for the chosen skin, never block taps or clicks, pause in a background tab and switch off with
the system "reduce motion" setting. Design details: `web/DESIGN.md`.

### Dot

Black blocks, dot-matrix numbers and a red accent. Static, no effects.

### Night City

_Filled in by task NC-d._

### Rewind

Blue VCR menus, yellow selection strips and square frames sit over a wall of old televisions.
VT323 headings and Share Tech Mono counters give it the look of a tape deck; body text uses IBM Plex Sans.
Changing day, week or month briefly slips the wallpaper and safe slices of changed cards, then locks TRACKING into PLAY.
Large time digits roll into their exact values, and frames acquire a signal when they first appear.
A slow scan band and a decorative Home REC lamp accompany occasional tracking marks, dropouts, seams, streaks and corner glints.
The stepped arrow and play-notch pointer leave tiny phosphor beads in empty desktop gutters; phones keep the same screen effects without a cursor.
Reduced motion keeps static scanlines, frames and steady OSD marks; background tabs pause the effects.
The Settings tile is a static CRT miniature with its own yellow menu strip and tape counter.
Photo and font sources, authors and licences are in [wallpaper credits](web/public/wallpapers/rewind/CREDITS.md) and [font licences](web/public/fonts/rewind/LICENSE.md).

### Thinker

_Filled in by task TH-d._

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
| `--role pc\|server\|local` | PC: push timer only, no web build; server: normal units without ActivityWatch pull; local (default): original deployment |
| `--no-start` | render the units and reload systemd, but do not enable or start anything |
| `--no-build` | skip `bun install` and the web build |
| `--dry-run` | print what would happen and touch nothing |

Re-running the script is also the update step: it rebuilds the web app and
restarts the server.

Units and timers the default local role installs (PC installs only push units;
server omits the ActivityWatch pull timer):

| Unit | What it does | Schedule |
|---|---|---|
| `inputtracker.service` | runs the HTTP server | always (restarts on failure) |
| `inputtracker-sync@.service` | oneshot `it sync %i` | launched by its timer |
| `inputtracker-sync@audiobookshelf.timer` | Audiobookshelf sync | hourly, persistent, up to 120 s jitter |
| `inputtracker-sync@simkl.timer` | Simkl sync | hourly at :30, persistent, up to 120 s jitter |
| `inputtracker-sync@activitywatch.timer` | ActivityWatch sync (YouTube) | every 10 minutes (`*:0/10`), persistent, up to 30 s jitter |
| `inputtracker-push@.service` (PC role) | oneshot `it push %i` | launched by its timer |
| `inputtracker-push@activitywatch.timer` (PC role) | ActivityWatch push to the VM | every 10 minutes, persistent, up to 30 s jitter |
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

For the PC/cloud split use `scripts/install.sh --role pc` on the PC and
`scripts/install.sh --role server` on the VM. Keep ActivityWatch on localhost;
set server `activitywatch.mode = "push"` and PC `push.server_url` / `push.token`.
The `inputtracker-push@activitywatch.timer` runs every 10 minutes. Exact steps,
verification and rollback: [MIGRATION.md](MIGRATION.md).

Run commands with `bun run it <command>`.

| Command | Options | Example |
|---|---|---|
| `sync <source>` | source is `audiobookshelf`, `simkl`, or `activitywatch` | `bun run it sync activitywatch` |
| `push activitywatch` | none | `bun run it push activitywatch` |
| `auth simkl` | `[--status]` | `bun run it auth simkl` |
| `add` | `--type <t> --title <title> --start <local> [--end <local>] [--duration-min <n>] [--parent <title>] [--season <n>] [--episode <n>] [--progress <0..1>] [--device <name>]` | `bun run it add --type audiobook --title "The Synthetic Tale" --start "2026-10-17 21:30" --duration-min 45` |
| `export` | `--format json\|csv --out <file>` | `bun run it export --format json --out archive.json` |
| `import` | `<file> [--format json\|csv]` | `bun run it import archive.json` |
| `import youtube-takeout` | `<file>` | `bun run it import youtube-takeout watch-history.json` |
| `backup` | none | `bun run it backup` |
| `notify test\|weekly` | none | `bun run it notify test` |
| `ingest token\|status\|remap` | none | `bun run it ingest token` |
| `youtube enrich` | `[--limit <n>]` | `bun run it youtube enrich --limit 100` |
| `doctor` | none | `bun run it doctor` |
| `verify-copy <copy.db>` | none | `bun run it verify-copy copies/2026-10-18.db` |

Details:

- `sync audiobookshelf` fetches sessions, media progress and daily stats from
  Audiobookshelf and inserts the new rows. It only ever issues GET requests.
- `sync activitywatch` queries local ActivityWatch for browser YouTube activity
  and inserts new plays. It only ever issues GET requests.
- `auth simkl` connects Simkl via device flow (prints a link + code);
  `--status` shows whether it is connected, without network.
- `push activitywatch` reads local ActivityWatch via GET and pushes bounded
  batches to `POST /api/ingest/events` using the server's `ingest.token`.
  Cursors and notification state live in `activitywatch-push-state.json` beside
  `storage.db_path`, without opening the PC archive. Unacknowledged batches
  retry next run. Enrichment and music cover lookup run only on the server.
  `sync activitywatch` skips pull when `activitywatch.mode = "push"`.
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
- `notify test` sends one test notification through every configured channel
  and prints a `name: ok|failed` line per channel (never a URL or token). Exit
  0 when at least one channel succeeded, 1 when none is configured, 2 when all
  configured channels failed. `notify weekly` builds the weekly summary and
  pushes it; without `notify.weekly_summary` it only prints `weekly summary
  disabled` and exits 0.
- `ingest token` prints a fresh random ingest token plus a one-line hint; it
  never reads the config or writes a file. `ingest status` prints
  `ingest: enabled` or `ingest: disabled` from the config. `ingest remap`
  re-maps every stored phone play through the current mapping rules (for
  example a YouTube Music package becoming `music`): a play whose mapping
  changed is written as a **new** event row (append-only), an unchanged play
  hashes the same and inserts nothing — so it is safe to repeat.
- `doctor` is a read-only environment check. It prints one line per check as
  `OK|WARN|FAIL <name>: <detail>` for: architecture (x86_64 or aarch64), the
  Bun version, the config (with tokens redacted), the database (its schema
  version vs this build, or "will be created" when it does not exist yet and
  the parent directory is writable), the backup directory, whether the
  configured port is free (in use is only a WARN — that just means the service
  is probably running), the systemd user manager, lingering, and the
  `tailscale` binary. Secrets never reach the output and nothing is ever
  written: the DB is only opened read-only. Exit 0 unless a check FAILs, then 1
  (WARNs do not fail the run).
- `verify-copy <copy.db>` proves that a copied database holds every row of the
  configured one. Both databases are opened read-only and compared by
  `record_hash` for `events`, `goals` and `annotations` (missing hashes are
  printed). Extra rows in the copy are reported but are not a failure — the
  copy may simply have synced more since it was taken. Exit 0 when everything
  is present; 1 for bad usage **or** missing rows; 2 when a database is
  missing or unreadable.
- `it help`, `it --help` and `it -h` print the usage text and exit 0. Running
  with no command prints the usage text and exits 1.

Exit codes: `0` success, `1` bad usage (also invalid `add` input), `2` failure
(missing/unreadable config, database, sync, export or import errors). Two
commands deviate: `doctor` exits 1 when any check fails, and `verify-copy`
exits 1 both for bad usage and when rows are missing from the copy.

## Goals

A goal is a yearly target: a year, a metric and a target number, plus optional
source and media type filters.

| Field | Meaning |
|---|---|
| `year` | The calendar year the goal counts (2000–2100). |
| `metric` | `items` (consumed items), `hours` (summed duration), `titles` (distinct titles/series) or `active_days` (days with at least one item). |
| `target` | A positive number to reach. |
| `source` | Optional filter, e.g. only `audiobookshelf`. |
| `media_type` | Optional filter, e.g. only `audiobook`. |
| `archived` | Archived goals leave the normal list; `GET /api/goals?archived=1` still shows them. |

Progress is counted from the same deduplicated display data the calendar and
stats use (`events_latest`, filtered by the goal's `source` and `media_type`),
so a watch logged by hand and also synced from Simkl counts once. For a goal
in the current year the app compares progress with a linear expectation
(`target × days elapsed / days in year`) and labels it `done`, `on_track`,
`behind` or `not_started`; goals for past years end up `done` or `missed`
depending on whether the target was reached.

Editing or archiving a goal never rewrites the old row: every edit is a new
revision in the append-only `goals` archive (a new `rev_id` under the same
`goal_id`), and reads use the `goals_latest` view, so only the latest revision
of each goal is ever shown. In the web app, goals live in the Goals card on
the Year review and Stats pages (create, edit and archive there). The JSON
export carries every revision, and importing it back uses `INSERT OR IGNORE`,
so re-importing adds nothing twice.

## Ratings and notes

You can give any title a rating from 1 to 10 (shown as five stars with
halves) and a free-text note of up to 5000 characters. A title here is the
same group the Search page uses: `source` + title (or series name), so a note
on a show covers all of its episodes.

Both are stored as rows of the append-only `annotations` table bound to a work
key when identifiable (legacy `source` + `title` rows remain readable): every
save is a new revision (a retried save with the same
`rev_id` inserts nothing), reads use the `annotations_latest` view, so the
latest revision wins. Clearing the rating or the note is also just a new row
(with `NULL`s); nothing is ever updated in place.

In the app, the rating editor is on the Search and Progress pages. Under the
hood it is `GET /api/annotations?source=<s>&title=<t>` and
`POST /api/annotations`, and every revision is included in the JSON export
(v2), so `it export` and `it import` round-trip them like events and goals.
Work aliases and override revisions also round-trip in optional v2 fields.
Links, refreshes and archive renames append old→new aliases so ratings, notes,
category, hidden state, topics and old work URLs follow the current identity.

## Metadata lookup

When adding older anime, series, films, books or audiobooks by hand, the server
looks up titles, covers, seasons, episode counts, runtimes and page counts:

- `GET /api/lookup/search?q=<1..200 chars>&category=<Category|any>` fans out in
  parallel to the providers that match the category (each with an 8 s timeout
  and concurrency limit), merges and ranks the hits (exact title match first,
  then by popularity and year, up to 20 results), and lists any failed upstream
  in `failed_providers` without failing the request.
- `GET /api/lookup/work/:provider/:id` returns the full `WorkDetails` snapshot
  for one work (404 when unknown, 502 when the provider fails).
- `GET /api/meta-cover/:provider/:id` downloads the cover image once (validating
  an `image/*` content type and a 5 MB limit) and stores it permanently under
  `<directory of db_path>/covers/meta/`, so archived covers keep working even if
  a provider disappears.

Providers (all keyless except optional TMDB; GET-only except AniList's read-only
GraphQL query):

- **Anime → AniList** (`https://graphql.anilist.co`): follows `PREQUEL` back to
  Season 1 and `SEQUEL` forward over `TV` / `TV_SHORT` / `ONA` entries (up to 15
  hops) to assemble the full season list in watch order; `MOVIE` entries return
  `runtime_minutes` and no seasons.
- **Series → TVmaze** (`https://api.tvmaze.com`), plus **Cinemeta** as a second
  provider (deduplicated by IMDb id): `/search/shows`, `/shows/:id/seasons` and
  `/shows/:id/episodes`, summing per-episode runtimes for each season's
  `total_minutes`.
- **Films → Cinemeta** (`https://v3-cinemeta.strem.io`, keyless, IMDb ids), with
  **iTunes Search** (`https://itunes.apple.com`) as a fallback.
- **Books & audiobooks → Open Library** (`https://openlibrary.org`):
  `search.json`, `/works/:id.json` and `/works/:id/editions.json` for page
  counts and ISBNs, and `covers.openlibrary.org` for covers by `cover_i`.
- **TMDB (optional)**: when `metadata.tmdb_api_key` is set in
  `inputtracker.config.toml`, TMDB is queried for films and series and ranked
  ahead of iTunes and TVmaze. The key is redacted everywhere.

Search responses are cached on disk for 7 days and work details for 30 days
under `<directory of db_path>/metadata-cache/`.

## Archive and library

Besides automatic syncs, you can add works from the past to the archive
(`POST /api/archive`, `GET /api/archive`, `POST /api/archive/:entry_id/delete`).
Each entry carries a work snapshot (seasons, runtimes, pages, external ids and
cover metadata) and is stored in `events` as append-only units (`source = "manual"`,
`source_kind = "archive"`, `source_id = "archive:<entry_id>:<unit>"`): one unit
per watched season (`s<n>`), one per film viewing (`v<n>`), or one per
book/audiobook/other (`b`).

Date precision (`day`, `month`, `year`, `unknown`) controls where an archive
entry counts:

- **Calendar, heat map, streaks and hour × weekday charts** include only `day`
  precision events.
- **Month review** (`GET /api/review/month?month=YYYY-MM`) includes `day` and
  `month` precision events of that month (`month` precision time is also
  reported in `undated_minutes`).
- **Year review** (`GET /api/review/year?year=YYYY`) combines the twelve months
  plus `year` precision archive entries (`undated_minutes`); `unknown`
  precision entries are left out.
- **Library and all-time totals** (`GET /api/library`, `GET /api/library/work`)
  include every precision.

Editing an archive entry with the same `entry_id` writes new unit revisions and
writes tombstones (`raw.deleted = true`, `duration_seconds = 0`) for removed
units; deleting an entry tombstones all of its units. The `events_latest` view
(migration v4) hides tombstoned units from all reads while `events` keeps the
full history forever.

The library groups events across all sources into works by category and
normalized series-or-title or shared external id (`anilist`, `mal`, `imdb`,
`tvmaze`, `abs_item`, `meta_id`), with YouTube grouped by channel. Read-only
server status and source configuration are exposed at `GET /api/settings`
(hosts only, never secrets).

## Duplicates across sources

The same watch often arrives twice: once logged by hand (`manual`) and once
synced from Simkl. The calendar, heat map, stats, year review, lists and goal
progress show it **once**. This is display-only deduplication: nothing in the
database is deleted or changed, and the export still contains both raw rows.

Two events pair up only when all of these hold:

- one of the two sources is `manual` (two synced sources are never merged,
  and neither are two manual rows);
- the media type is `movie` or `episode`, and for episodes the season and
  episode numbers match too;
- the title or series name matches after the Search-page normalization;
- the watch falls on the same local date in the configured timezone.

When a pair matches, the non-manual (synced) event wins and the manual one is
absorbed: the merged row is marked "also from manual", and it keeps its own
duration unless it has none (then the manual one's is used). The start times
do not have to be equal — the closest pair wins, ties go to the lower row id.

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

To import older browser history that predates the initial 7-day sync window, run a backfill with `it sync activitywatch --since YYYY-MM-DD` (for example, `bun run it sync activitywatch --since 2026-01-01`). This queries past plays in 7-day chunks up to the oldest stored play in the configured timezone, leaves the regular sync cursor untouched, and is safe to repeat.

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
