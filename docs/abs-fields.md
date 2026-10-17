# Audiobookshelf API — real field names

Captured 2026-10-17 from your server (`GET /api/me/listening-sessions?itemsPerPage=1`, HTTP 200).
Field **names and types only**; no values from your archive are stored in the repo.
Fixtures in `test/fixtures/abs/` must use exactly these names with fake values.

## Envelope

| Field | Type | Notes |
|---|---|---|
| `total` | number | total sessions (302 at capture) |
| `numPages` | number | |
| `page` | number | **0-based** |
| `itemsPerPage` | number | |
| `sessions` | array | newest first |

## Session object

| Field | Type | Seen value / format | Maps to |
|---|---|---|---|
| `id` | string | | `source_id` (kind `listening_session`) |
| `userId` | string | | — (raw only) |
| `libraryId` | string | | raw |
| `libraryItemId` | string | | `external_ids.abs_item` |
| `bookId` | string | | raw |
| `episodeId` | string \| null | null for books | `external_ids.abs_episode` |
| `mediaType` | string | `"book"` (podcasts: `"podcast"`) | `media_type` = `audiobook` / `podcast_episode` |
| `mediaMetadata` | object | keys: `title, subtitle, authors[{id,name}], narrators, series, genres, publishedYear, publishedDate, publisher, description, isbn, asin, language, explicit, abridged` | raw |
| `chapters` | array | can be empty | raw |
| `displayTitle` | string | | `title` |
| `displayAuthor` | string | | `parent_title` |
| `coverPath` | string \| null | | raw |
| `duration` | number | seconds, length of the whole item | raw |
| `playMethod` | number | `0` | raw |
| `mediaPlayer` | string | `"html5"` | raw |
| `deviceInfo` | object | `id, userId, deviceId, ipAddress, browserName, browserVersion, osName, osVersion, clientVersion, manufacturer, model, sdkVersion, clientName, deviceName` | `device` = `deviceName` → `clientName` + `osName` fallback; **`ipAddress` is stripped from `raw`** |
| `serverVersion` | string | | raw |
| `date` | string | `YYYY-MM-DD` (server-local date) | not used for bucketing (we use UTC `startedAt` → Europe/Bratislava) |
| `dayOfWeek` | string | `"Friday"` | not used |
| `timeListening` | number | seconds actually listened | `duration_seconds` |
| `startTime` | number | position (s) at session start | raw (+ progress calc) |
| `currentTime` | number | position (s) at session end | raw; `progress` = `currentTime / duration` |
| `startedAt` | number | **epoch milliseconds** | `started_at` (UTC ISO) |
| `updatedAt` | number | epoch ms; `updatedAt - startedAt` ≈ wall-clock length | `ended_at` (UTC ISO); also the incremental-sync cursor |

Note: a session can keep growing (`updatedAt`, `timeListening`, `currentTime` change while you
listen) → the next sync creates a new row with a new hash; `events_latest` shows the final state.

## `GET /api/me` (captured 2026-10-17)

Top level: `id, username, email, type, mediaProgress[], seriesHideFromContinueListening, bookmarks,
isActive, isLocked, lastSeen, createdAt, permissions, librariesAccessible, itemTagsSelected,
hasOpenIDLink`. We use **only `mediaProgress`**; nothing else from the user object is stored.

### `mediaProgress[]` item

| Field | Type | Seen value / format | Maps to |
|---|---|---|---|
| `id` | string | | raw |
| `userId` | string | | raw |
| `libraryItemId` | string | | `source_id` (kind `media_progress`) = `libraryItemId` or `libraryItemId:episodeId` |
| `episodeId` | string \| null | null for books | part of `source_id` |
| `mediaItemId` | string | | raw |
| `mediaItemType` | string | `"book"` / `"podcastEpisode"` | `media_type` |
| `duration` | number | seconds | raw |
| `progress` | number | 0..1 | `progress` |
| `currentTime` | number | seconds | raw |
| `isFinished` | boolean | | raw (F10 finished list) |
| `hideFromContinueListening` | boolean | | raw |
| `ebookLocation` | string \| null | | raw |
| `ebookProgress` | number | | raw |
| `lastUpdate` | number | epoch ms | `started_at` of the progress row (UTC ISO) |
| `startedAt` | number | epoch ms | raw |
| `finishedAt` | number \| null | epoch ms | `ended_at` |

`title` is not in mediaProgress: take it from the matching session (`libraryItemId`) or from
`listening-stats.items[id].mediaMetadata.title`; fall back to `libraryItemId`.

## `GET /api/me/listening-stats` (captured 2026-10-17)

| Field | Type | Notes |
|---|---|---|
| `totalTime` | number | seconds |
| `items` | object | keyed by libraryItemId → `{ id, mediaMetadata, timeListening }` |
| `days` | object | `"YYYY-MM-DD"` → seconds |
| `dayOfWeek` | object | `"Monday"`… → seconds |
| `today` | number | seconds |
| `recentSessions` | array | same shape as sessions above |

`days` become `daily_stat` snapshot rows (`source_id` = the date) for cross-checks only; they are
never counted in heat map/calendar (sessions are).
