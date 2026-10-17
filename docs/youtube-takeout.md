# YouTube Takeout watch history — what InputTracker reads

Source: Google's My Activity schema (https://developers.google.com/data-portability/schema-reference/my_activity)
plus the well-known shape of Takeout's `YouTube and YouTube Music/history/watch-history.json`.
Not yet checked against the user's own export: the importer must tolerate missing fields and log
counts of what it skipped, so the manager can adjust after the first real import.

The user must choose **JSON** (not HTML) for "History" when creating the Takeout export.

## File shape

One JSON array of activity records, newest first, often 10–200 MB:

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
  },
  {
    "header": "YouTube",
    "title": "Watched Some Ad",
    "titleUrl": "https://www.youtube.com/watch?v=ZzZzZzZzZzZ",
    "time": "2026-10-17T08:14:00Z",
    "products": ["YouTube"],
    "details": [{"name": "From Google Ads"}],
    "activityControls": ["YouTube watch history"]
  },
  {
    "header": "YouTube",
    "title": "Watched a video that has been removed",
    "time": "2026-10-16T21:00:00.000Z",
    "products": ["YouTube"],
    "activityControls": ["YouTube watch history"]
  },
  {
    "header": "YouTube Music",
    "title": "Watched Some Song",
    "titleUrl": "https://music.youtube.com/watch?v=MmMmMmMmMmM",
    "subtitles": [{"name": "Some Artist - Topic", "url": "https://www.youtube.com/channel/UC…"}],
    "time": "2026-10-16T20:00:00.000Z",
    "products": ["YouTube"]
  }
]
```

Field notes:
- `time`: ISO 8601 UTC with `Z`, with or without milliseconds. Normalize with `toUtcIso()`.
- `titleUrl`: video id = the `v` query parameter (11 chars, `[A-Za-z0-9_-]{11}`). Works for
  `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, and `youtu.be/<id>`. Shorts appear as
  normal `watch?v=` URLs.
- `title`: `"Watched "` + video title in English exports. Other UI languages use another prefix;
  strip only the exact English `"Watched "` prefix and otherwise keep the title as it is.
- `subtitles[0]`: channel `name` and `url` (`/channel/<UC… id>`); missing for removed videos and
  sometimes for ads.
- `details[].name == "From Google Ads"` marks an ad.
- `products` should contain `"YouTube"`; `header` is `"YouTube"` or `"YouTube Music"`.
- No duration anywhere in the export.

## Mapping to events

| Record | Result |
|---|---|
| has `details` with name `From Google Ads` | skip (count as `ads`) |
| no `titleUrl` or no video id in it (removed/private video, survey, post) | skip (count as `no_video`) |
| `products` present and without `"YouTube"` | skip (count as `other`) |
| otherwise | one event |

Event: `source=youtube`, `source_kind=history_item`, `media_type=video`,
`source_id=<videoId>:<time as normalized UTC ISO>` (each view is its own event),
`title` = title without the `Watched ` prefix, `parent_title` = channel name or null,
`started_at` = normalized time, `duration_seconds` = null,
`external_ids` = `{"youtube_video": "<id>", "youtube_channel": "<UC… id or null>"}`
plus `"youtube_music": true` when `header` is `YouTube Music`,
`raw` = the record as read.

Re-importing the same file, or a newer export that overlaps an older one, inserts 0 duplicates
(`INSERT OR IGNORE` on `record_hash`). The import is an `ingest_runs` row with source
`youtube-takeout` like the native import.

## Size

Parse the file once (`JSON.parse` of a 200 MB file is fine on the PC) and insert in batches
inside transactions (e.g. 1000 rows per transaction), never one transaction per row.
The CLI path (`it import youtube-takeout <file>`) is the main path for big files; the web upload
must accept at least 300 MB or tell the user to use the CLI.
