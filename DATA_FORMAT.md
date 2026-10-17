# Data format

How InputTracker stores its data, for other programs that want to read the
SQLite database or an export. The code is the source of truth:
`src/core/db.ts` (schema), `src/core/events.ts` (hashing/normalization),
`src/io/export-*.ts` / `src/io/import-native.ts` (exports and import),
`src/sources/simkl/map.ts` (Simkl events) and `src/sources/youtube/takeout.ts`
(YouTube Takeout events).

## Where the data lives

The database file is the configured `[storage] db_path`. Its default is
`$XDG_DATA_HOME/inputtracker/inputtracker.db`, falling back to
`~/.local/share/inputtracker/inputtracker.db` when `XDG_DATA_HOME` is unset.

Open it read-only, so a reader can never trigger the append-only guards or
disturb a running server:

```sh
sqlite3 -readonly "$DB_PATH" 'SELECT COUNT(*) FROM events_latest;'
```

or, when opening by URI:

```
file:/path/to/inputtracker.db?mode=ro
```

The app opens the database with `PRAGMA journal_mode = WAL;`, so a live database
also has `-wal` and `-shm` sidecar files. A read-only connection can read the
WAL; if you copy the database for offline use, either copy all three files
together or run a checkpoint / use `VACUUM INTO` first. Foreign keys are ON, and
`busy_timeout` is 5000 ms.

Next to the database (in the same directory) the app keeps files that are **not**
part of the data format and are not in any export or backup:
`secrets/simkl-token.json` holds the Simkl OAuth tokens (the `secrets` directory
is mode 0700, the file mode 0600) and is a secret — never commit or share it.
`it export` writes `events` rows only, and `it backup` copies the database
itself (`VACUUM INTO`) plus that export, so neither includes the token file.

## Table `events`

The append-only archive. One row per decoded record.

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Insertion order. The newest row per key has the highest `id`. |
| `record_hash` | TEXT NOT NULL UNIQUE | SHA-256 hex of the canonical record (see below). The uniqueness that makes inserts idempotent. |
| `source` | TEXT NOT NULL | Where the row came from. |
| `source_kind` | TEXT NOT NULL | What kind of row it is (session, progress, manual, …). |
| `source_id` | TEXT NOT NULL | Stable id inside the source. |
| `external_ids` | TEXT | JSON text: an object of source ids, or `NULL`. |
| `media_type` | TEXT NOT NULL | One of the allowed media types. |
| `title` | TEXT | Display title, or `NULL`. |
| `parent_title` | TEXT | Series/show/author context, or `NULL`. |
| `season` | INTEGER | Season number, or `NULL`. |
| `episode` | INTEGER | Episode number, or `NULL`. |
| `started_at` | TEXT NOT NULL | Start time, UTC ISO 8601. |
| `ended_at` | TEXT | End time (UTC ISO 8601) or `NULL`. |
| `duration_seconds` | REAL | Time actually consumed, in seconds, or `NULL`. |
| `progress` | REAL | Fractional progress in `0..1`, or `NULL`. |
| `device` | TEXT | Device label, or `NULL`. |
| `raw` | TEXT | JSON text of the source payload, or `NULL` (`ipAddress` is stripped). |
| `ingested_at` | TEXT NOT NULL | When this row was inserted, UTC ISO 8601. |
| `ingest_run_id` | INTEGER | `ingest_runs.id` that produced the row, or `NULL`. |

Values the code produces today:

- `source`: `audiobookshelf` (sync), `simkl` (sync), `youtube` (a YouTube
  Takeout import), `manual` (the `add` command / web form). An import (the
  `import` command / web upload) keeps each row's original `source`. Only the
  `ingest_runs.source` changes: a native export import writes `native-import`,
  a YouTube Takeout import writes `youtube-takeout` (its event rows are still
  `source = youtube`).
- `source_kind`: from Audiobookshelf — `listening_session`, `media_progress`,
  `daily_stat`; from Simkl — `watch` (one row per watch); from a YouTube Takeout
  import — `history_item`; from manual entry — `history_item`. An import keeps
  whatever `source_kind` was in the file.
- `media_type`: one of `audiobook`, `podcast_episode`, `movie`, `episode`,
  `video`, `book`, `other`. Audiobookshelf sync only ever produces `audiobook`,
  `podcast_episode` or `other`; Simkl sync produces `movie` or `episode`; a
  YouTube Takeout import produces `video`; manual entry accepts any of the
  seven.

`external_ids` and `raw` are stored as JSON **text** (not JSONB). A typical
`external_ids` value for an Audiobookshelf session looks like
`{"abs_item":"item-fake-book-1"}` (plus `abs_episode` for podcast episodes).

### Simkl events

Simkl sync writes one event per watch. `source = simkl`, `source_kind = watch`,
`started_at` is the watch time normalized to UTC ISO 8601 with milliseconds;
`ended_at`, `progress` and `device` are `NULL`.

- Movie: `media_type = movie`, `source_id = movie:<simkl id>:<started_at>`. An
  anime entry whose `anime_type` is `movie` is stored the same way.
- Episode: `media_type = episode`,
  `source_id = ep:<show simkl id>:<season>:<episode>:<started_at>`, with the
  `season` and `episode` columns set to those numbers.
- `title` is the movie or show title; `parent_title` is `NULL`.
- `duration_seconds` is the item's `runtime` in minutes × 60, rounded, or `NULL`
  when the runtime is missing, zero or not a number.
- `external_ids` is the item's `ids` object (`simkl`, `imdb`, `tmdb`, `tvdb`,
  `mal`, `slug`, … as present, non-null values only) plus `simkl_poster` = the
  poster path when the item has one. Example:
  `{"simkl":12345,"imdb":"tt0000000","simkl_poster":"74/74415673dcdc9cdd"}`.
- A rewatch is a separate event: the watch time is part of `source_id`, so
  nothing is overwritten.
- `raw` is the whole Simkl movie entry for a movie; for an episode it is the
  episode object plus `show: {"title": …, "ids": …}`.

### YouTube Takeout events

A Takeout import writes one event per view. `source = youtube`,
`source_kind = history_item`, `media_type = video`, and
`source_id = <11-char videoId>:<started_at>`, where `started_at` is the record's
`time` normalized to UTC ISO 8601 with milliseconds. `title` is the record title
with a leading `Watched ` removed; `parent_title` is the channel name or `NULL`;
`ended_at`, `duration_seconds`, `progress` and `device` are `NULL`; `raw` is the
record as read.

`external_ids` is
`{"youtube_video": "<video id>", "youtube_channel": "<channel id or null>"}`,
plus `"youtube_music": true` when the record's `header` is `YouTube Music`.

### Manual entry events

Manual entry (the `add` command, the web form or a phone's offline queue)
writes `source = manual`, `source_kind = history_item`, and by default a random
UUID as `source_id`. The web form can send an optional `client_id` (a UUID)
with the entry: the server then uses `client:<client_id in lowercase>` as the
`source_id`, so re-sending the exact same body — for example a retry after a
lost response — hits the same `record_hash` and stays a no-op (`inserted: 0`)
instead of creating a second row. An invalid `client_id` is rejected like any
other validation error.

## Append-only rule

Two triggers abort any mutation:

- `events_no_update` — `BEFORE UPDATE ON events` raises `events is append-only`;
- `events_no_delete` — `BEFORE DELETE ON events` raises `events is append-only`.

A record that changes is therefore written as a **new row** (`id` increases); the
previous row stays. Rows are inserted with `INSERT OR IGNORE` on the unique
`record_hash`, so re-seeing the exact same record inserts nothing.

`record_hash` is the SHA-256 of the JSON object built from exactly these fields,
in this key order:

`source`, `source_kind`, `source_id`, `external_ids`, `media_type`, `title`,
`parent_title`, `season`, `episode`, `started_at`, `ended_at`,
`duration_seconds`, `progress`, `device`.

`external_ids` is key-sorted before hashing and timestamps are normalized to UTC
ISO 8601. `id`, `raw`, `ingested_at` and `ingest_run_id` are **not** part of the
hash.

## How to read it correctly

Use the view **`events_latest`**, never raw `events`, for activity views:

```sql
CREATE VIEW events_latest AS
SELECT * FROM events
WHERE id IN (
  SELECT MAX(id) FROM events
  GROUP BY source, source_kind, source_id
);
```

It returns the newest row (max `id`) per `(source, source_kind, source_id)`.

Do **not** sum over `events`: the same session can be inserted many times (an
Audiobookshelf session that keeps growing creates a new row on each sync), so a
session synced three times has three rows. Calendar, heat map, stats and lists
read `events_latest` only.

Only these `source_kind`s count as consumption activity:

- `listening_session`, `watch`, `history_item`.

`media_progress` (in-progress/finished state) and `daily_stat` (daily seconds
totals) are **not** activity and must not be summed into the calendar, heat map
or stats.

Example queries:

Minutes per local day (consumption only). `date(..., 'localtime')` uses the
reader's system timezone; for the configured zone convert with the right offset
instead:

```sql
SELECT
  date(started_at, 'localtime') AS local_day,
  COUNT(*) AS items,
  SUM(COALESCE(duration_seconds, 0)) / 60.0 AS minutes
FROM events_latest
WHERE source_kind IN ('listening_session', 'watch', 'history_item')
GROUP BY local_day
ORDER BY local_day;
```

Latest progress per item:

```sql
SELECT source, source_id, title, progress AS fraction, started_at AS last_update
FROM events_latest
WHERE source_kind = 'media_progress'
ORDER BY started_at DESC;
```

Last 20 consumed items:

```sql
SELECT id, source, title, media_type, started_at, duration_seconds
FROM events_latest
WHERE source_kind IN ('listening_session', 'watch', 'history_item')
ORDER BY started_at DESC
LIMIT 20;
```

## Time rule

Every stored timestamp is UTC ISO 8601 with a trailing `Z` and milliseconds,
e.g. `2026-10-17T08:15:00.000Z`. Convert to the configured timezone (default
`Europe/Bratislava`) only for display and day/hour bucketing, and do it
DST-aware (the app uses `Intl` with the zone name, not a fixed offset). A stored
date like `2026-10-17T23:30:00.000Z` is the next local day.

Offline-synced sessions: the Audiobookshelf Android app can play offline and
upload later. The server then stamps a session's `started_at` and `ended_at` at
sync time, even though the listening happened earlier. Such a row reports
`duration_seconds` longer than the wall-clock span between `started_at` and
`ended_at`:

```
duration_seconds > (ended_at - started_at) / 1000 + 60
```

When that holds (the app calls it `isTimeUncertain()`), the start time is the
upload/sync time, not when the media was actually heard. The calendar still
places the item on its sync day, but the hour grid leaves it out and reports it
separately as `unplaced_count` / `unplaced_minutes`.

## Other tables

- `ingest_runs` — one row per sync / import / manual-entry attempt. Columns:
  `id` (INTEGER PK), `source` (TEXT NOT NULL), `kind` (TEXT), `started_at`
  (TEXT NOT NULL), `finished_at` (TEXT), `status` (TEXT NOT NULL, one of
  `running`, `ok`, `failed`), `rows_seen` (INTEGER), `rows_inserted` (INTEGER),
  `error` (TEXT). `source` is one of `audiobookshelf`, `simkl` (both with
  `kind = sync`), `youtube-takeout`, `native-import` or `manual`.
- `sync_state` — per-source bookkeeping. Columns: `source` (TEXT PRIMARY KEY),
  `cursor` (TEXT), `updated_at` (TEXT NOT NULL). Holds the Audiobookshelf sync
  cursor (max session `updatedAt`) and, under `source = "notify:<source>"`, a
  flag for pending failure notifications.
- `schema_migrations` — which migrations have run. Columns: `version` (INTEGER
  PRIMARY KEY), `applied_at` (TEXT NOT NULL).

## Export formats

Both exports contain **every row of `events`** (the full archive, ordered by
`id`), not the `events_latest` view.

JSON is an envelope:

```json
{
  "format": "inputtracker-export",
  "version": 1,
  "events": [ ... one object per row, all columns ... ]
}
```

CSV is RFC 4180 with one header row naming every column, in this order:

`id`, `record_hash`, `source`, `source_kind`, `source_id`, `external_ids`,
`media_type`, `title`, `parent_title`, `season`, `episode`, `started_at`,
`ended_at`, `duration_seconds`, `progress`, `device`, `raw`, `ingested_at`,
`ingest_run_id`.

In CSV, a field containing a comma, a double quote, CR or LF is wrapped in
double quotes and inner quotes are doubled; `NULL` becomes an empty field. The
`external_ids` and `raw` JSON columns are written as their stored JSON strings,
so they appear quoted. Rows end with `\n`.

Importing an export recomputes `record_hash` and ignores `id`, `record_hash`,
`ingested_at` and `ingest_run_id` from the file, then inserts with
`INSERT OR IGNORE`. Re-importing the same file therefore adds nothing. The
importer picks JSON or CSV from the filename extension, or by
`--format json|csv`.
