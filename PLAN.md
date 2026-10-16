# InputTracker — Plan

## Stack (chosen)

| Part | Choice | Why |
|---|---|---|
| Language | **TypeScript on Bun** (1.4, installed) | One language for server, CLI and UI; built-in SQLite, test runner and TOML; workers write TS well |
| Storage | **SQLite** file (WAL mode) | Single file any program can read (Python, Go, `sqlite3`, DB browsers); safe concurrent reads by your other app |
| Server | **Hono** on `Bun.serve` | Tiny, typed, easy for workers |
| UI | **Preact + Vite**, served as static files by the server | Small bundle for phone; plain components |
| Phone | **PWA** over **Tailscale** (`tailscale serve` → HTTPS `*.ts.net`) | No Android SDK/Java needed; your phone is already on your tailnet |
| Scheduling | systemd **user** units: server service + sync timer | Native on Arch, survives reboot |
| Tests | `bun test` + synthetic fixtures | Fast; fixtures are fake, never real archive data |

Rejected: Tauri/Capacitor native Android app (needs Java + Android SDK + NDK, slower
overnight builds, two data copies to sync). Can wrap the PWA later as a TWA if wanted.

## How it runs

- **Arch PC** is the hub: the server owns the database and runs all syncs
  (Audiobookshelf/Simkl/yt-dlp are reached from the PC). Bound to `127.0.0.1:8787`.
  Open `http://localhost:8787` in a browser, or use the CLI (`bun run it <cmd>`).
- **Android**: `tailscale serve` publishes the server at `https://pinpc.<tailnet>.ts.net`.
  Open in Chrome → "Install app". Service worker caches the app shell and the last
  loaded data, so calendar/heat map still open read-only when the PC is off.
  Uploads, manual entries and syncs need the PC reachable (offline queue = proposed feature F11).
- Access control = Tailscale (only your devices). No public exposure.

## Storage

Database: `~/.local/share/inputtracker/inputtracker.db` (path configurable; **outside the repo**).
Config/secrets: `inputtracker.config.toml` in the repo root, gitignored
(`inputtracker.config.example.toml` is committed).

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
- View `events_latest`: newest row per `(source, source_kind, source_id)`.
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

API (JSON, times UTC): `GET /api/events?from&to&source`, `GET /api/calendar?month=2026-10`,
`GET /api/heatmap?from&to&source&mode=day|hour-weekday`, `POST /api/import` (multipart),
`GET /api/export.json`, `GET /api/export.csv`, `POST /api/events` (manual),
`POST /api/sync/:source`, `GET /api/runs`.

Audiobookshelf safety: `client.ts` exposes only a `get(path)` method; a unit test fails if
any non-GET request is made, and the path allow-list is `/api/me`, `/api/me/listening-sessions`,
`/api/me/listening-stats` (+ `/api/items/:id` read-only for metadata if needed).

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
