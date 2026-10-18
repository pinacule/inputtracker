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

---

# v2.1: editing, ratings 0–10, YouTube by channel/topic, Achriom import, themes

Types: the "v2.1" parts of `src/core/contract.ts`. The data rules above still hold: nothing in
`events` (or any history table) is updated or deleted; every edit is a new row; imports and syncs
are safe to repeat.

## 7. Ratings 0–10 (backend task W04)

- A rating is 0..10 with at most one decimal (`7.5`, `10`, `0`). Store integer tenths (0..100) so
  there is no float drift. Old ratings (integers 1..10 in `annotations`) read as the same value.
  The `annotations.rating` CHECK cannot change in SQLite: add a new migration (v5) with a column or
  table for tenths; keep old rows readable.
- One rating per library work (not per source/title pair): the work page, the quick rating and the
  archive form all set the same value. `LibraryWork.rating` returns it everywhere (library, reviews,
  search, day detail).
- Validation: reject < 0, > 10, NaN, more than one decimal (`7.25`) with a 400 and a clear message.

## 8. Editing any work (backend task W04)

- `POST /api/library/work/edit?key=<key>` with a `WorkEdit` body; returns `LibraryWorkDetail`.
  Partial: omitted fields unchanged, `null` clears the override. Works from every source
  (Audiobookshelf, YouTube, Simkl, archive, Achriom import) can be edited. Overrides live in their
  own append-only table (migration v6); the latest row per work key wins. Source rows never change.
- Overrides apply on every read: library, calendar/day, search, insights/series, reviews, totals.
  `category` override moves the work's time to that category everywhere. `title` override renames it
  everywhere. `hidden: true` removes the work from every view and total; `GET /api/library/hidden`
  lists hidden works so Settings can unhide them. `status` override (incl. `planned`) shows in the
  library. `meta` links the work to a metadata entry (cover via `/api/meta-cover/...`; seasons and
  runtime for the work page).
- **Work keys must be stable** across reads and syncs (they key the overrides). Derive them from a
  canonical identity (metadata provider+id, external ids, else normalised category+title), never
  from list order (the current `#2` suffixes). Old keys that differ: no migration needed (no edits
  exist yet).
- `LibraryWork.edited` is true when any override exists.
- Planned works (`status: "planned"`, from the archive form or the Achriom import) are in the
  library with 0 minutes and are left out of calendar, charts and reviews.
- Archive entries keep their own edit path (`POST /api/archive` with the same `entry_id`).

## 9. Several categories at once (backend task W04)

Every endpoint that filters by category accepts a comma list and an exclusion list:
`category=anime,film` and `exclude=youtube` (unknown names are a 400). Applies to library, series,
calendar/day lists, heat maps, search, stats and reviews. Totals in the response follow the filter;
`LibraryResult.categories` always lists all categories (for the chips' counts).

## 10. YouTube (backend task W05)

- **Minimum watch time.** Config `[youtube] min_watch_minutes` (default 5). A video counts only when
  its watched time on one local day is at least that. Plays below it are **not stored** by new syncs
  when the source can tell (ActivityWatch plays are rebuilt from buckets each sync: merge per video
  per local day first, then decide; a later sync that pushes the day's total over the limit stores
  it then). Plays already stored below the limit are left out of every read (calendar, library,
  stats, charts, reviews, search, YouTube views); the rows stay (append-only).
  `YoutubeOverview.short_plays_hidden` counts what was left out.
- **Channel and topic.** ActivityWatch plays have no channel. Enrich each video id once with GET
  requests only: YouTube oEmbed (`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json`
  gives `author_name` = channel, `author_url`, `thumbnail_url`) and the watch page's
  `<meta itemprop="genre" content="...">` (YouTube's category, e.g. "Science & Technology", used as
  the default topic). Cache results permanently in the DB (migration v7, its own table; failures
  cached with a retry-after). Enrichment runs during the YouTube/ActivityWatch sync, at most N
  videos per run (config, default 50), with a small delay between requests; never during a read.
  Takeout and phone plays already carry the channel: use it.
- **User topics.** `POST /api/youtube/channel-topic` `{ channel, topic | null }` sets the topic for a
  whole channel (append-only, latest wins). `WorkEdit.topic` sets one video's topic. Precedence:
  video edit > channel topic > YouTube category > null.
- **Endpoints:** `GET /api/youtube` → `YoutubeOverview`; `GET /api/youtube/videos` →
  `YoutubeVideosResult` (filters channel, topic, from, to, q; paging). `LibraryWork.channel` and
  `.topic` are set for YouTube works. Video thumbnails go through the existing local cover/cache
  path (no hot-linking from the browser).
- **"All" without YouTube.** The web app's "All" view excludes YouTube by default (`exclude=youtube`);
  YouTube has its own view grouped by topic and channel. A setting can include it in "All".

## 11. Achriom import (backend task W06)

- Input: the Achriom library export (`achriom-library-YYYY-MM-DD.zip` with `books.csv`,
  `movies.csv`, `shows.csv`, `anime.csv`, `albums.csv`, `podcasts.csv`, `games.csv`), or one of
  those CSV files. Real headers are in the task prompt. RFC 4180 CSV (quoted fields with commas,
  quotes and newlines). Zip: read with `node:zlib` (`inflateRawSync`), no new dependency.
- Each row becomes one archive entry through the same code path as `POST /api/archive`, with a
  deterministic `entry_id` (UUID v5-style hash of `achriom`, file, and the row's stable id:
  anilist_id / imdb_id / tmdb_id / isbn, else normalised title+year). A repeat import changes
  nothing; a changed row becomes a new revision of the same entry.
- Mapping: statuses `completed`/`finished`/`watched` → finished (whole work); `plan_to_watch`/
  `unread`/`unwatched` → `status: "planned"`; `abandoned` → `status: "dropped"` with no time unless
  the row has progress. Ratings are 0..5 in halves → ×2 (4.5 → 9). Dates: `finished_at`/
  `last_watched_at` → day precision; else `unknown` (`created_at` is when the row was added to
  Achriom, not a watch date: don't use it). Notes → note.
- Time: films use `runtime_minutes`; anime `episodes × episode_duration` (one AniList entry per
  row; `episodes_watched` is 0 even for completed rows, so completed = all episodes); books use the
  page estimate; shows have no season data in the export: look the show up (TVmaze/Cinemeta by
  title + first_air_date year) and count all seasons for finished rows. Use the metadata providers
  (`lookupWork` by anilist id / imdb id when present, else search) to get covers and seasons; when
  nothing matches, store a ManualWork with the export's cover URL fetched once into the permanent
  cover cache. `games.csv`, `albums.csv`, `podcasts.csv` rows: games are not a tracked category
  (skip with a reason); albums → music, podcasts → podcast.
- `POST /api/import/achriom` (multipart field `file`, `?dry_run=1`) → `AchriomImportResult`; CLI
  `bun run src/cli/index.ts import achriom <path> [--dry-run]` prints the same summary. Network
  only through the metadata providers (GET); tests mock everything.

## 12. Web app v2.1 (frontend task W07)

- **Themes, dark only.** Remove light mode and "system". Offer 4–5 named dark themes (one is the
  current warm dark), picked in Settings › Appearance with live swatches, stored in localStorage.
  All colours via tokens; category colours stay distinct and AA on every theme.
- **YouTube out of "All".** "All" means every category except YouTube (a Settings toggle can include
  it). YouTube gets its own view (Library › YouTube, and a section in Insights): topics → channels
  → videos, with time per topic/channel as bars, a channel page, and quick "set topic" for a
  channel. In calendar cells and the day panel, a day's YouTube plays collapse to one line
  ("12 videos · 48 min") that expands.
- **Several categories at once.** Category chips are toggles (multi-select) everywhere they filter;
  "All" clears the selection. The selection is in the URL (`?cat=anime,film`).
- **Ratings 0–10, one decimal, without opening the work.** A compact rating control (e.g. a tap on
  the rating pill opens a small popover with a 0–10 slider in 0.5 steps plus a number field that
  accepts one decimal; keyboard arrows ±0.1/±0.5) on library cards/rows, the day panel rows, review
  lists and the work page. Saves through `WorkEdit.rating` immediately, optimistic with undo.
- **Right-click (and long-press on phone) quick menu,** depending on where you are: rate, edit
  (title, category, status), change topic (YouTube), add more seasons / log again, hide, open work,
  delete (archive entries only, with confirm). Keyboard reachable (context-menu key / Shift+F10).
- **Edit any work** from its page: title, category, status (incl. planned), link to a metadata match
  (search picker), rating, note, hide. Imported (Achriom) entries edit like archive entries.
- **Planned / watchlist** filter in the Library.
- **Home page clarity.** The current home is unclear: the stats banner uses jargon ("ACTIVE RHYTHM
  11 / 31d"), filter chips and the sidebar legend repeat each other, calendar cells are full of
  truncated titles, and the day panel header ("18.10.2026" above "Sunday, Oct 18, 2026") is
  repetitive and heavy. Redesign it so one glance answers: what did I do today / this week, what am
  I in the middle of, and how does this month look. Calm, readable, fewer words.
- **Import** in Settings: upload the Achriom zip, show the dry-run summary, then import.
- **Hidden works** list in Settings with unhide.
