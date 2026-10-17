# InputTracker — Plan

## Stack (chosen)

| Part | Choice | Why |
|---|---|---|
| Language | **TypeScript on Bun** (1.4, installed) | One language for server, CLI and UI; built-in SQLite, test runner and TOML; workers write TS well |
| Storage | **SQLite** file (WAL mode) | Single file any program can read (Python, Go, `sqlite3`, DB browsers); safe concurrent reads by your other app |
| Server | **Hono** on `Bun.serve` | Tiny, typed, easy for workers |
| UI | **Preact + Vite**, served as static files by the server | Small bundle for phone; plain components |
| Phone | **PWA** over **Tailscale** (`tailscale serve` → HTTPS `*.ts.net`) | No Android SDK/Java needed; your phone is already on your tailnet |
| Scheduling | systemd **user** units: server service + one timer per source + nightly backup timer | Native on Arch and on any systemd Linux VM |
| Platforms | Linux **x86_64 and ARM64** (Oracle Ampere later) | Bun ships both; no native npm deps (bun:sqlite is built in, Vite/esbuild ship arm64 builds) |
| Tests | `bun test` + synthetic fixtures | Fast; fixtures are fake, never real archive data |

Rejected: Tauri/Capacitor native Android app (needs Java + Android SDK + NDK, slower
overnight builds, two data copies to sync). Can wrap the PWA later as a TWA if wanted.

## How it runs

- **Arch PC** is the hub for now: the server owns the database and runs the syncs.
  Defaults: bind `127.0.0.1:8787`. Open `http://localhost:8787` in a browser, or use the CLI (`bun run it <cmd>`).
- **Nothing assumes the PC**: DB path, backup path, bind address/port, timezone and every source
  URL come from config (defaults only where noted). See "Future hosting" below and MIGRATION.md.
- **Android**: `tailscale serve` publishes the server at https://pinpc.taild61ed4.ts.net/ (running).
  Open in Chrome → "Install app". Service worker caches the app shell and the last
  loaded data, so calendar/heat map still open read-only when the PC is off.
  Uploads, manual entries and syncs need the PC reachable (offline queue = proposed feature F11).
- Access control = Tailscale (only your devices). No public exposure.

## Storage

Database: default `$XDG_DATA_HOME/inputtracker/inputtracker.db` (`~/.local/share/...`), set by
`[storage] db_path`; **outside the repo**. Backups: `[storage] backup_dir`, default
`~/.local/share/inputtracker/backups/`.
Config/secrets: `inputtracker.config.toml` in the repo root (or path in env `INPUTTRACKER_CONFIG`),
gitignored (`inputtracker.config.example.toml` is committed).

Config keys (all overridable, nothing hard-coded elsewhere):

```toml
timezone = "Europe/Bratislava"
[server]   bind = "127.0.0.1"   port = 8787
[storage]  db_path = "…"        backup_dir = "…"   backup_keep = 14
[audiobookshelf]  url = "http://localhost:13378"   token = "…"   timeout_s = 20
[notify]   desktop = true        ntfy_url = ""      # ntfy later
```

### Table `events` (append-only)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | insertion order |
| `record_hash` | TEXT UNIQUE | sha256 of canonical JSON of the normalized fields below (not `id`, `ingested_at`, `raw`) |
| `source` | TEXT | `audiobookshelf`, `simkl`, `youtube`, `manual` |
| `source_kind` | TEXT | e.g. `listening_session`, `media_progress`, `daily_stat`, `history_item`, `watch` |
| `source_id` | TEXT | stable ID (ABS session/item ID, Simkl ID, IMDb ID, YouTube video ID, UUID for manual) |
| `external_ids` | TEXT JSON | `{"imdb":"tt…","simkl":123,"tmdb":…}` |
| `media_type` | TEXT | `audiobook`, `podcast_episode`, `movie`, `episode`, `video`, `book`, `other` |
| `title` | TEXT | |
| `parent_title` | TEXT | show / podcast / author / channel |
| `season`, `episode` | INTEGER | nullable |
| `started_at` | TEXT | UTC ISO 8601, `2026-10-17T08:15:00.000Z` |
| `ended_at` | TEXT | UTC, nullable |
| `duration_seconds` | REAL | time actually consumed, nullable |
| `progress` | REAL | 0..1, nullable |
| `device` | TEXT | nullable |
| `raw` | TEXT JSON | original source payload (secrets stripped) |
| `ingested_at` | TEXT | UTC |
| `ingest_run_id` | INTEGER | FK `ingest_runs.id` |

- SQLite **triggers abort any UPDATE or DELETE** on `events` — append-only is enforced by the DB.
- Inserts use `INSERT OR IGNORE` on `record_hash` → repeating an import/sync adds nothing.
  A changed record (e.g. new progress) hashes differently → new row.
- View `events_latest`: newest row (max `id`) per `(source, source_kind, source_id)`.

### Counting rule (design fix, 2026-10-17)

An ABS session is synced several times while it grows, so one session has several rows.
**Heat map, calendar, stats, in-progress/finished lists and exports-for-display read only
`events_latest`; nothing ever sums over `events`.** Only consumption kinds count as activity
(`listening_session`, `watch`, `history_item`, manual entries); `media_progress` and `daily_stat`
feed the in-progress list and cross-checks only. Required test: one session synced three
times with growing `timeListening` → calendar, heat map and stats count it **once**, with the
latest duration. (Full JSON/CSV archive export still contains every row.)
- Table `ingest_runs`: every import/sync (source, started/finished, rows seen/inserted, error).
- Table `sync_state`: per-source cursor (e.g. last `updatedAt`) — only metadata, may be updated.
- Timestamps are always UTC in storage; Europe/Bratislava conversion happens in the UI/API layer
  with `Intl` (DST-correct). Heat map buckets use local day/hour.
- `DATA_FORMAT.md` (task T20) documents this for your other app.

### Export / import

- JSON: `{ "format": "inputtracker-export", "version": 1, "events": [ …all columns… ] }`
- CSV: one row per event, same columns, JSON columns as strings.
- Re-import recomputes `record_hash` from the normalized fields → no duplicates, even if hashes in the file were edited.

## Architecture

```
src/
  core/        db.ts (open, migrations, triggers), schema.ts, events.ts (normalize, hash, insert),
               time.ts (UTC + local bucketing), config.ts (TOML, redaction)
  sources/
    audiobookshelf/  client.ts (GET-only), map.ts, sync.ts
    simkl/           (after v1)
    youtube/         takeout.ts, ytdlp.ts (after v1)
  io/          export-json.ts, export-csv.ts, import-native.ts, manual.ts
  server/      app.ts (Hono routes), main.ts
  cli.ts       sync | import | export | add | serve
web/           Preact + Vite: Calendar, Heatmap, Import/Export, Add entry; PWA manifest + SW
deploy/        systemd user units, tailscale serve notes
test/          bun tests + fixtures/ (synthetic only)
```

### Sources are separable

Each source is its own module and its own command: `it sync audiobookshelf`, `it sync simkl`,
`it sync youtube-ytdlp`, each with its own systemd timer. A sync = fetch → map to `NewEvent[]` →
hand to a **sink**. v1 sink: local DB. Later sink: HTTP `POST /api/ingest` (token-protected) on the
server, so e.g. yt-dlp polling can stay on a home machine (YouTube distrusts data-centre IPs)
while the server runs on the VM. The ingest path uses the same `insertEvents` dedup.

### Failure handling (source offline)

If a source is unreachable (e.g. PC off when the server is on the VM): the run is recorded in
`ingest_runs` with `status=failed` and a redacted error, the sync cursor is **not** advanced,
nothing already stored is touched, and the next timer run retries. Because inserts are
idempotent, a retry after a partial run never duplicates. Failures trigger F15 notification
(only on first failure and on recovery, not on every retry).

API (JSON, times UTC): `GET /api/events?from&to&source`, `GET /api/calendar?month=2026-10`,
`GET /api/heatmap?from&to&source&mode=day|hour-weekday`, `POST /api/import` (multipart),
`GET /api/export.json`, `GET /api/export.csv`, `POST /api/events` (manual),
`POST /api/sync/:source`, `GET /api/runs`.

Audiobookshelf field mapping uses the real field names in `docs/abs-fields.md`
(`startedAt`/`updatedAt` are epoch ms, `timeListening` seconds, `page` 0-based;
`deviceInfo.ipAddress` is stripped before storing `raw`).

Audiobookshelf safety: `client.ts` exposes only a `get(path)` method; a unit test fails if
any non-GET request is made, and the path allow-list is `/api/me`, `/api/me/listening-sessions`,
`/api/me/listening-stats` (+ `/api/items/:id` read-only for metadata if needed).

## Accepted for v1 (2026-10-17)

- **F1 Stats dashboard** — hours per source / week / month, top items; from `events_latest` only.
- **F9 Covers from Audiobookshelf only** — via `GET /api/items/:id/cover` proxied and cached by our
  server (GET-only; token never sent to the browser). No TMDB/OMDb yet.
- **F10 In progress / finished list** — from latest `media_progress` rows (`isFinished`, `progress`).
- **F14 Nightly backup** — SQLite online backup (`VACUUM INTO`) + full JSON export into
  `backup_dir` (default `~/.local/share/inputtracker/backups/`), keep the last **14** nightly
  snapshots, older ones pruned. Pruning only touches files in the backup dir that match our
  naming pattern.
- **F15 Sync failure notification** — desktop `notify-send` first; ntfy later (config key ready).

All other features below: later, not now.

## Future hosting: Oracle Cloud VM (design only, build nothing yet)

- Server + DB move to an Ampere ARM64 VM on the tailnet; phone and PC reach it via Tailscale.
- Audiobookshelf stays on the PC → `audiobookshelf.url` changes from `http://localhost:13378` to
  the PC's Tailscale address; the PC being off is a normal, logged, retried failure.
- yt-dlp polling may stay on a home machine using the future HTTP ingest sink.
- `deploy/` units use `%h`/env/config paths only, no PC-specific paths, so they install the same on
  the VM. Steps to move data and config: MIGRATION.md.

## Proposed extra features (accept / reject — none built without approval)

| # | Feature | Notes |
|---|---|---|
| F1 | Stats dashboard | Hours per source/week/month, top shows/books/channels |
| F2 | Streaks | Current/longest daily streak, per source |
| F3 | Ratings + notes | Stored as separate append-only `annotations` rows |
| F4 | Tags / lists | e.g. "favourites", "rewatch" |
| F5 | Search + filters | Full-text over titles (SQLite FTS5) |
| F6 | "On this day" | What you consumed this date in earlier years |
| F7 | Year in review | Yearly summary page / shareable image |
| F8 | Goals | e.g. 30 books/year, progress bar |
| F9 | Covers/posters | From ABS covers, TMDB/OMDb (needs free API key) |
| F10 | Currently in progress / finished list | From latest progress rows |
| F11 | Offline manual-entry queue on phone | Sync when PC reachable |
| F12 | More sources | Last.fm/ListenBrainz (music), Trakt, Letterboxd CSV, Goodreads CSV, Spotify export, Kindle |
| F13 | Cross-source dedup / linking | Same movie from Simkl + manual shown once |
| F14 | Automatic backups | Nightly DB snapshot + export to a backup folder / restic |
| F15 | Sync failure notification | Desktop notify / ntfy push to phone |
