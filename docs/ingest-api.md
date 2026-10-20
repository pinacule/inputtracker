# Ingest API — phone plays and daily short-form time

The second-brain Android app reads what the YouTube app plays and POSTs batches
to InputTracker. This document is the fixed contract.

Endpoint: `POST /api/ingest/youtube-plays`. The user generates a token with
`bun run it ingest token`, puts it under `[ingest] token` in
`inputtracker.config.toml`, and restarts the server (`scripts/install.sh`).
An empty token disables ingest.

## Request

```http
POST /api/ingest/youtube-plays
Authorization: Bearer <token>
Content-Type: application/json

{
  "device": "phone",
  "plays": [
    {
      "play_id": "0d1f6a2b-9c4e-4a1e-b2f2-5b1f5f5f5f5f",
      "app": "com.google.android.youtube",
      "title": "A synthetic video title",
      "channel": "Synthetic Channel",
      "video_id": "dQw4w9WgXcQ",
      "started_at": "2026-10-17T18:02:11.000Z",
      "ended_at": "2026-10-17T18:08:23.000Z",
      "watched_seconds": 412,
      "media_duration_seconds": 900,
      "last_position_seconds": 412
    }
  ]
}
```

Field rules:

| Field | Rule |
|---|---|
| `device` | 1–32 chars, `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `plays` | array, 1–200 items |
| `play_id` | required, UUID (any version accepted; stored lower-cased) |
| `app` | required, 1–100 chars, `^[A-Za-z0-9_.]+$` |
| `title` | required, 1–500 chars after trimming trailing whitespace |
| `channel` | string ≤ 200 chars or `null`; empty string → `null` |
| `video_id` | `^[A-Za-z0-9_-]{11}$` or `null` |
| `started_at` | UTC ISO 8601 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$`; more than 5 minutes in the future is rejected |
| `ended_at` | same format; `>= started_at` |
| `watched_seconds` | integer 0–86400 |
| `media_duration_seconds` | integer or `null`; outside 0–86400 it is stored as `null` |
| `last_position_seconds` | integer or `null`; outside 0–86400 it is stored as `null` |

Unknown extra fields are ignored. The body is at most 1 MB (larger → `413`,
checked on `Content-Length` when present and on the actual body).

## Responses

Errors use the usual `{ "error": "…" }` shape; the checks run in this order:

| Status | When | Body |
|---|---|---|
| `400` | unknown query parameter | `{ "error": "Unknown query parameter: '…'" }` |
| `503` | ingest disabled (empty token) | `{ "error": "ingest is disabled" }` |
| `401` | missing/wrong `Authorization: Bearer <token>` (or another scheme) | `{ "error": "unauthorized" }` |
| `413` | body larger than 1 MB | `{ "error": "body too large (max 1 MB)" }` |
| `400` | invalid JSON or any invalid field, e.g. `plays[3].watched_seconds must be an integer 0–86400` | `{ "error": "…" }` |
| `500` | insertion failed | `{ "error": "ingest failed" }` |
| `200` | all plays valid | `{ "accepted": <plays.length>, "inserted": <rows actually inserted> }` |

One bad play rejects the whole batch: nothing is inserted. The token is never
logged and never written back in any response.

## What gets stored

Each play becomes one append-only event row:

- `source = youtube`, `source_kind = phone_play`, `source_id = <play_id lower-cased>`,
  `media_type = video` (or `music` for `com.google.android.apps.youtube.music`),
  `title`, `parent_title = <channel or NULL>`,
  `started_at`/`ended_at` normalized to millisecond precision
  (`…:11.000Z`), `duration_seconds = watched_seconds`,
  `device = <device>`.
- `progress = last_position / media_duration`, clamped to `0..1`, when both are
  present and the media duration is > 0; otherwise `NULL`.
- `external_ids = {"youtube_video": "<video id>", "android_package": "<app>"}`
  (`youtube_video` omitted when the play has no video id).
- `raw` is the validated play object rebuilt in a fixed key order.
- The insertion runs inside one ingest run (`ingest_runs.source = youtube`,
  `kind = phone`).

## Idempotency

- Re-sending an identical play inserts nothing (`inserted: 0`), because
  `record_hash` (SHA-256 over the normalized event fields) already exists and
  inserts are `INSERT OR IGNORE`.
- Re-sending the same `play_id` with a larger `watched_seconds`/later
  `ended_at` inserts a **new row** (`events` is append-only; rows are never
  updated or deleted). The `events_latest` view — which the calendar, heat map,
  stats and lists all read — then shows the newest row (highest `id`).

## Daily short-form app time

`POST /api/ingest/shortform` accepts daily phone usage totals, not individual
Shorts/Reels videos. It uses the **same Bearer token**, disabled/auth checks,
1 MB body limit, whole-batch validation and response/error shapes as the plays
endpoint. Unknown query parameters are rejected; extra JSON fields are ignored.

```json
{
  "days": [
    { "date": "2026-10-17", "app": "instagram", "seconds": 2820 },
    { "date": "2026-10-17", "app": "youtube", "seconds": 900 }
  ]
}
```

- `days`: required array of 1–200 objects; duplicate app/date pairs reject the batch.
- `date`: a real `YYYY-MM-DD` calendar date in the configured timezone
  (Europe/Bratislava by default), no later than today. No UTC timestamp is needed.
- `app`: 1–100 characters matching `^[A-Za-z0-9_.]+$`; common names are
  `instagram`, `youtube`, `tiktok`, or an Android package name. Spelling/case is
  identity: send a stable value for each app. No `device` field is required.
- `seconds`: integer 0–86400. Zero is valid and can correct an earlier total.
  Send the **whole current daily total**, not a delta. The phone app decides
  what usage counts as short-form; the server cannot distinguish Reels from
  other Instagram activity within a supplied app total.

Success is `{ "accepted": <days.length>, "inserted": <new rows> }`. Each
app/day becomes `source=phone`, `source_kind=shortform_day`,
`source_id=phone:<app>:<date>`, `media_type=shortform`, and
`duration_seconds=seconds`. `started_at` is local midnight converted to UTC;
it is a date anchor, **not an observed watching time**. `raw` contains only
validated `date`, `app`, and `seconds`; `external_ids.android_package` holds app.

Daily records are append-only and latest wins. Repeating the current total
inserts nothing. A changed total (including returning to an older total)
appends a revision; `external_ids.shortform_revision` identifies the transition
when needed. There is no upload ordering/version field: the last accepted changed
snapshot wins, so the sender must not replay stale snapshots out of order.

This time appears in Calendar, heatmaps, Insights, Reviews and totals, but never
creates a Library work, play count, item count or ranking entry. Hourly charts
omit daily totals because their hour placement is unknown. For `app: "youtube"` the phone sends the YouTube app's whole screen time; on read the
server subtracts that day's recorded phone video plays (`phone_play`, not music), so only
Shorts and browsing remain (never below 0). Phone app time stays
separate from PC ActivityWatch time; only measured PC Shorts suppress same-day
Takeout estimates. The phone app itself is outside this server contract.
