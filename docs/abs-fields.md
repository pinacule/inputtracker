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

Still to capture (same way, by the manager, names only): `GET /api/me` (`mediaProgress[]`) and
`GET /api/me/listening-stats`, and one podcast session if you have any.
