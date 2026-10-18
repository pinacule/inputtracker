# InputTracker v2: archive, library, reviews, settings

Types: `src/core/contract.ts` (the server returns exactly these shapes; the web app imports them with
`import type`). Categories: `src/core/category.ts` (`categoryOf(event)`). Change either only together
with this doc.

InputTracker is two things: a viewer of what I consume, and a **clean archive** of it. Besides the
automatic sources (Audiobookshelf, YouTube, Simkl), I add things from the past by hand: "Vinland Saga,
watched seasons 1 and 2 around 2021". The app looks the work up (cover, seasons, episodes, runtimes),
I say what I watched and roughly when, and it lands in the Anime group of the library and counts toward
anime time and total time everywhere.

## Data rules (unchanged, from PLAN.md)

- `events` is append-only. A changed record is a new row with the same (source, source_kind,
  source_id); `events_latest` shows the newest. Inserts are `INSERT OR IGNORE` on `record_hash`, so
  every write is safe to repeat.
- Timestamps stored as UTC ISO; local time (config timezone, Europe/Bratislava) only for display and
  bucketing.
- Every read uses `events_latest`.

## 1. Metadata lookup (backend task B1)

Endpoints:
- `GET /api/lookup/search?q=<1..200 chars>&category=<Category|any>` → `LookupSearchResult`.
  Fan out to the providers that fit the category in parallel, each with a timeout (8 s) and a
  concurrency limit; merge and rank (exact title match first, then by popularity/year); at most 20.
  A provider failing goes into `failed_providers`; the request still succeeds.
- `GET /api/lookup/work/:provider/:id` → `WorkDetails` (404 if unknown, 502 if the provider failed).
- `GET /api/meta-cover/:provider/:id` → the cover image, downloaded once and cached on disk next to the
  existing cover cache (`dirname(db_path)/covers/meta/`), served with a long cache header; 404 if none.
  An archive must keep working when a provider disappears, so covers are cached for good once fetched.

Providers (all keyless except TMDB; GET requests only, except AniList's read-only GraphQL query, which
is a POST by protocol):
- **Anime → AniList** (`https://graphql.anilist.co`). A franchise is several AniList entries; build
  `seasons` by following `SEQUEL` relations of TV/TV_SHORT/ONA format from the first season (follow
  `PREQUEL` back first if the hit is a later season), in order, max 15 hops. Episode length from
  `duration`. External ids: `anilist`, `mal` (`idMal`).
- **Series → TVmaze** (`https://api.tvmaze.com`): `/search/shows`, `/shows/:id/seasons`,
  `/shows/:id/episodes` (sum the real per-episode runtimes for `total_minutes`). External ids: `tvmaze`,
  `imdb`, `thetvdb`.
- **Films → Cinemeta** (`https://v3-cinemeta.strem.io`, keyless, IMDb ids; also a second source for
  series), then **iTunes Search** as a fallback (its `media=movie` search returned nothing in October
  2026; `/lookup?id=` works): runtime from `trackTimeMillis`, artwork from `artworkUrl100` upscaled to
  600x600. External ids: `imdb`, `itunes`.
- **Books → Open Library** (reuse `src/server/openlibrary.ts` helpers where it fits): `search.json`,
  works/editions for pages (`number_of_pages_median`), covers by `cover_i`. External ids: `openlibrary`,
  `isbn` when present.
- **Audiobooks →** Open Library for the book data (category "audiobook"; runtime unknown, the user
  types hours).
- **TMDB** only when `metadata.tmdb_api_key` is set in config (secret: redact it, never log it). When
  set, use it for films and series ahead of iTunes/TVmaze.

Config: a new `[metadata]` section (`enabled` default true, per-provider base URLs for tests,
`tmdb_api_key` optional). Update `inputtracker.config.example.toml` and the README config table.
Responses from providers are cached on disk for 7 days (search) / 30 days (work details) so repeated
lookups are fast and gentle on the providers. Tests mock `fetch`; never hit the network.

## 2. Archive entries (backend task B2)

`POST /api/archive` with `ArchiveRequest` → `ArchiveResult`.
- Each archive entry is stored as **units**: one event per watched season (series/anime), one per
  film viewing, one per book/audiobook/other. `source = "manual"`, `source_kind = "archive"`,
  `source_id = "archive:<entry_id>:<unit>"` (unit: `s<season>`, `v<n>`, `b`). Add `"archive"` to
  `CONSUMPTION_KINDS`.
- `media_type`: episode (seasons), movie, book, audiobook, video, other. `raw` holds
  `{ category, entry_id, work (the snapshot), consumed, when, estimated }`. `raw.category` makes
  `categoryOf` return the user's category. `external_ids` holds the work's external ids plus
  `meta_provider` and `meta_id`; `coverUrlFor` returns `/api/meta-cover/<meta_provider>/<meta_id>` for
  them.
- `duration_seconds`: season = sum of watched episodes' minutes (whole season → `total_minutes`, else
  `episodes * episode_minutes`); film = `runtime_minutes * times`; book/audiobook = `minutes_override`,
  else for books `pages * 1.5 min * progress` (estimated), else null. `minutes_override` always wins.
- **Dates**: `started_at` = local noon of the first day of the period (`day`/`month`/`year` precision)
  converted to UTC; for `unknown`, the time the entry was created. Several units are spread evenly
  between `date` and `end_date` when a range is given. `raw.when.precision` is kept.
  - Calendar, heat map and hour/weekday charts include only `day` precision events.
  - Month review: `day` and `month` precision events of that month (`month` ones also counted in
    `undated_minutes`). Year review: all except `unknown`; `year` precision counted in
    `undated_minutes`. Library and all-time totals include everything.
- **Editing**: re-sending `POST /api/archive` with the same `entry_id` writes new versions of the
  units; units that no longer exist get a tombstone version (`raw.deleted = true`,
  `duration_seconds = 0`). Re-sending an identical request inserts nothing.
- `POST /api/archive/:entry_id/delete` writes tombstones for every unit of the entry.
- Migration v4 redefines `events_latest` to hide tombstones:
  `... WHERE id IN (SELECT MAX(id) ... GROUP BY source, source_kind, source_id) AND
  COALESCE(json_extract(raw, '$.deleted'), 0) = 0`. Every read already goes through the view, so
  nothing else needs to know about deletes. The history rows stay in `events` forever.
- `rating`/`note` go to the existing annotations table (append-only), keyed like the library work.
- `GET /api/archive?category=` → `ArchiveEntrySummary[]` (newest first) to list and edit entries.

## 3. Library (backend task B2)

- `GET /api/library?category=<Category>&q=&sort=recent|time|title` → `LibraryResult`.
  `categories` always lists every category that has data (for the tabs), `works` the filtered list.
- A **work** joins events of every source that belong together: same category and the same normalized
  series-or-title (reuse `getSeriesOrTitle` and `normalizeForSearch`), or the same external id
  (`anilist`, `mal`, `imdb`, `tvmaze`, `abs_item`, `meta_id`). YouTube works are channels
  (`LibraryWork.title` = channel name, `units` = videos); the work detail lists the videos.
- `status`: finished when progress ≥ 0.95, every season fully watched, or an archive entry with
  progress 1 / whole seasons; in_progress when started and not finished; else unknown.
- `GET /api/library/work?key=` → `LibraryWorkDetail`.
- Totals use the deduped events (`dedupeConsumption`), so a play seen by two sources counts once.

## 4. Reviews and charts (backend task B2)

- `GET /api/series` → `SeriesResult`: minutes per category per day/week/month for stacked charts.
- `GET /api/review/month?month=YYYY-MM` → `MonthReview`.
- `GET /api/review/year?year=YYYY` → `YearReviewV2`, built from the twelve months (same numbers as
  summing the month reviews, plus `year` precision archive time).
- `/api/stats`, `/api/calendar`, `/api/year-review` and other existing endpoints keep working (the old
  UI and tests use them) but should include archive events where the date precision allows, and every
  calendar/stat item gains a `category` field.

## 5. Settings (backend task B2)

- `GET /api/settings` → `SettingsView`. Read-only: never return secrets, URLs only as host. Actions stay
  on their existing endpoints (`POST /api/sync/*`, `/api/import`, `/api/export.*`).

## 6. Web app (frontend tasks)

The web app is rebuilt on design A (`web/DESIGN.md`). Information architecture:
- **Today/Calendar** (home): the month calendar shows what was consumed per day without a wall of
  covers (colour by category, titles where there is room, a small time bar); covers appear in the
  selected day's detail.
- **Library**: tabs per category with totals; a grid of works with covers (this is where covers shine);
  work detail page with cover, seasons/episodes progress, history, rating and note, edit/delete for
  archive entries.
- **Insights**: graphs over numbers. Stacked minutes by category over time (day/week/month), category
  share, hour × weekday punch card, streak calendar (the heat map lives here, not as its own page).
- **Review**: Month in review by default (month picker); a Year view combines the months. Not a
  permanent top-level page with year-only content.
- **Add**: search a title (lookup), pick the work, choose what was consumed (season chips with
  episode counts, times watched, progress), when (exact day / month / year / don't know), optional
  rating and note; shows the computed time before saving; works offline through the existing queue
  for plain entries.
- **Search** stays reachable from the sidebar/header.
- **Settings** (gear, not in the main nav): sources and their sync status with "Sync now", import and
  export, ingest token status, metadata providers, appearance.
