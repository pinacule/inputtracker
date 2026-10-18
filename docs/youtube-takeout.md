# YouTube Takeout import — what InputTracker reads

InputTracker imports Google Takeout's `YouTube and YouTube Music` export from:
- `history/watch-history.html` (HTML format)
- `history/watch-history.json` (JSON format)
- `playlists/Favorite Songs-videos.csv` (favourite tracks)
- `subscriptions/subscriptions.csv` (channel subscriptions)
- A `YouTube and YouTube Music` folder or a Takeout `.zip` archive containing the above files

Everything else in the export (comments, live chats, posts, channel settings, search history,
music library songs, other playlists) is out of scope and ignored. There is **no network** during
Takeout import: files are parsed locally.

## 1. HTML format (`watch-history.html`)

Entries are `<div class="outer-cell …">` blocks parsed with a linear scan (no DOM library):
- `<p class="mdl-typography--title">` contains `"YouTube"` or `"YouTube Music"`.
- A `content-cell … body-1` div contains:
  ```html
  Watched <a href="https://www.youtube.com/watch?v=AbCdEfGhIjK">Video title</a><br>
  <a href="https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx">Channel name</a><br>
  Oct 18, 2026, 3:25:57 AM CEST<br>
  ```
  - Removed videos that still carry a link omit the channel line:
    `Watched <a href="https://www.youtube.com/watch?v=AbCdEfGhIjK">https://www.youtube.com/watch?v=AbCdEfGhIjK</a><br>Oct 18, 2026, 3:25:57 AM CEST<br>`
  - Removed videos without a link are plain text:
    `Watched a video that has been removed<br>Oct 18, 2026, 3:25:57 AM CEST<br>`
  - Titles and channel names are HTML-escaped (`&amp;`, `&quot;`, `&#39;`, etc.).
  - YouTube Music links may use `music.youtube.com/watch?v=`.
  - Dates are English `MMM D, YYYY, h:mm:ss AM|PM TZ` (the space before `AM`/`PM` may be `U+202F`).
    Timezone abbreviations (`CEST` +02:00, `CET` +01:00, `UTC`/`GMT` +00:00, plus common EU/US zones)
    are mapped to fixed offsets and stored as UTC ISO 8601 (`2026-10-18T01:25:57.000Z`). Unknown
    timezone abbreviations are skipped and counted as `invalid`.
- A `mdl-typography--caption` cell contains `Products: YouTube` and, for advertisements,
  `Details: From Google Ads`.

## 2. JSON format (`watch-history.json`)

One JSON array of activity records:

```json
[
  {
    "header": "YouTube",
    "title": "Watched Some Synthetic Video",
    "titleUrl": "https://www.youtube.com/watch?v=AbCdEfGhIjK",
    "subtitles": [{"name": "Synthetic Channel", "url": "https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx"}],
    "time": "2026-10-17T08:15:00.123Z",
    "products": ["YouTube"],
    "activityControls": ["YouTube watch history"]
  }
]
```

## 3. Skip rules

| Entry | Result |
|---|---|
| Missing or unparseable timestamp, or unknown TZ abbreviation | skip (`invalid`) |
| Caption / `details` has `From Google Ads` | skip (`ads`) |
| `Products` without `YouTube`, or HTML entry not starting with `Watched ` (`Viewed …` posts, `Visited …`) | skip (`other`) |
| No `watch?v=` / `youtu.be/` video ID (removed/private videos without a link) | skip (`no_video`) |
| Otherwise | candidate view |

## 4. Gap rule for watch duration

Takeout history has no watch duration. Candidate views (videos and music) are sorted chronologically
by `started_at`; for each view, `gap` = `next.started_at − this.started_at`:

- **YouTube videos (`media_type = "video"`):**
  - If `gap < [youtube] min_watch_minutes` (default 5 min = 300 s), the view was watched less than
    the threshold and is **not stored** (counted as `gap_skipped`; `gap == 300 s` is kept).
  - Every other video view is stored with `duration_seconds = min(gap, video length)` and marked
    estimated (`raw.estimated = "gap"`, `raw.gap_seconds = gap`).
  - While the video length is unknown, `min(gap, 3 h)` (`10800 s`) is used.
  - The newest view (no next view) uses the known video length or `30 min` (`1800 s`).
- **YouTube Music (`header = "YouTube Music"`, `media_type = "music"`):**
  - Exempt from the 5-minute minimum watch rule.
  - Stored with `duration_seconds = min(gap, track length, or 4 min when length is unknown)` (`240 s`).

## 5. Video/track length enrichment & re-saving revisions

`src/sources/youtube/enrich.ts` parses the video/track length from the YouTube watch page
(`"lengthSeconds":"123"` in the player JSON, or `<meta itemprop="duration" content="PT12M3S">`)
and stores `length_seconds` in the append-only `youtube_videos` table (migration v8).

When a video's length becomes known later, affected Takeout views in `events_latest` are re-saved
as new revisions with the capped duration (same `source_id`, append-only; `events_latest` picks the
newest row).

CLI command:
```sh
bun run src/cli/index.ts youtube enrich --takeout [--limit N]
```
Enriches videos referenced by Takeout views (~1 request/s, respecting `Retry-After` on HTTP 429)
and re-saves affected Takeout views.

## 6. Deduplication with measured plays (`aw_play` / `phone_play`)

- **At import:** a Takeout view is skipped (`dedup_skipped`) when a measured play (`source_kind`
  `aw_play` or `phone_play`) of the same video already exists on the same local day in the
  configured timezone.
- **On read:** `dedupeConsumption` (`src/server/dedup.ts`) and `partitionYoutubeEvents`
  (`src/server/youtube-filter.ts`) drop any stored Takeout `history_item` when a measured play of
  the same video exists on the same local day (carrying over the Takeout channel name if the
  measured play has none), so later ActivityWatch or phone syncs never double count.

## 7. Favourites & subscriptions (migration v8)

- `playlists/Favorite Songs-videos.csv` (`Video ID,Playlist Video Creation Timestamp`): stored in
  the append-only `youtube_favorites` table (`youtube_favorites_latest` view) and exposed as
  `favorite?: boolean` on `LibraryWork`.
- `subscriptions/subscriptions.csv` (`Channel Id,Channel Url,Channel Title`): stored in the
  append-only `youtube_subscriptions` table (`youtube_subscriptions_latest` view) and exposed as
  `subscribed?: boolean` on `YoutubeChannel`.

## 8. CLI and HTTP interface

- CLI:
  ```sh
  bun run src/cli/index.ts import youtube-takeout <path> [--dry-run]
  ```
  `<path>` can be `watch-history.html`, `watch-history.json`, the `YouTube and YouTube Music`
  folder, or a Takeout `.zip`. `--dry-run` prints the counts (records, views, stored, new, music,
  estimated hours, skipped by kind, gap-skipped, favourites, subscriptions) without writing.
- HTTP: `POST /api/import` (multipart form field `file`) accepts both the HTML and JSON watch
  history files (as well as a Takeout `.zip`).
- Re-importing the same export or a newer overlapping export is idempotent and writes nothing new
  for unchanged views.
