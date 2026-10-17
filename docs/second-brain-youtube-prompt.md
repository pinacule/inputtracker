# Prompt for a Claude Code session in pinacule/second-brain

Repo: pinacule/second-brain (branch `master`). Work only in the Android app (`android/`); don't change
the second-brain server. Work on a new branch `feat/youtube-plays` made from `master`. Don't open a PR
unless I ask. Never commit secrets or tokens. You may run the JVM unit tests (`./gradlew test`), but ask
me before building or installing an APK.

## Goal

Record which YouTube videos I watch in the YouTube app on my phone (title, channel, when, how many
minutes actually played) and send them to my other app, **InputTracker**, a media consumption tracker
that runs on my server. second-brain already tracks app usage with `UsageStatsManager`
(`UsageCapture.kt`, `CaptureWorker.kt`, `CaptureOutbox.kt`). That only knows minutes per app, not which
video, so add a media-session listener next to it.

## How to capture

- Add a `NotificationListenerService` (only so `MediaSessionManager.getActiveSessions(component)` is
  allowed; don't read or store notification contents). Register `MediaController.Callback`s for active
  sessions, and follow `OnActiveSessionsChangedListener`.
- Only track packages in an allowlist: default `com.google.android.youtube` and
  `app.revanced.android.youtube`. Add YouTube Music (`com.google.android.apps.youtube.music`) as a
  setting that is off by default. Ignore every other app.
- From `MediaMetadata`: title = `METADATA_KEY_TITLE` (or `DISPLAY_TITLE`), channel =
  `METADATA_KEY_ARTIST` (or `DISPLAY_SUBTITLE`), length = `METADATA_KEY_DURATION`. From
  `PlaybackState`: state and position.
- A **play** is one video's continuous viewing:
  - It starts when the state first becomes PLAYING for a title+channel.
  - It ends when the title/channel changes, playback stops, the session goes away, or it has been
    paused for more than 30 minutes.
  - `watched_seconds` counts only time in PLAYING (pauses, buffering, and seeking don't count).
  - Keep `last_position_seconds` from the last state.
- Each play gets a `play_id` (random UUID) created once when it starts.
- Drop plays with `watched_seconds` < 30 (this skips most ads and accidental taps). Make that number a
  constant.
- Put all of this play-building logic in a **pure Kotlin object** (like `UsageCapture`) that takes
  plain data (timestamped metadata and state changes) and returns plays, so it is unit-testable on the
  JVM without Robolectric. Android types are mapped into plain data at the boundary.
- Persist in-progress and finished plays (like `CaptureOutbox`, surviving process death and up to 14
  days offline) so nothing is lost if Android kills the app.
- I'm not sure YouTube Shorts publish a media session. Note what you find, but don't build anything
  special for them.

## How to send (InputTracker ingest API — follow exactly)

```
POST {inputtracker_url}/api/ingest/youtube-plays
Authorization: Bearer {ingest_token}
Content-Type: application/json

{
  "device": "phone",                       // the existing deviceName setting, 1–32 chars [a-z0-9-]
  "plays": [                               // 1–200 plays per request
    {
      "play_id": "3f0c…-uuid",             // UUID v4, created once per play; re-sends reuse it
      "app": "com.google.android.youtube", // package name
      "title": "Some video title",         // 1–500 chars, exactly as in the metadata
      "channel": "Some channel",           // ≤ 200 chars, or null
      "video_id": null,                    // 11-char YouTube id if ever known, else null
      "started_at": "2026-10-17T18:02:11.000Z", // UTC ISO 8601 with ms: first PLAYING
      "ended_at": "2026-10-17T18:09:03.000Z",   // UTC: last PLAYING moment (≥ started_at)
      "watched_seconds": 412,              // integer 0–86400, PLAYING time only
      "media_duration_seconds": 900,       // integer or null
      "last_position_seconds": 412         // integer or null
    }
  ]
}
```

- Response `200 {"accepted": n, "inserted": m}`. Delete plays from the outbox only after a 2xx.
- `401`: wrong or missing token. Keep the plays and show "InputTracker: token rejected" in the sync
  status.
- `400 {"error": "…"}`: a bad payload. Log the error message (never the token), drop only that batch,
  and show it in the status.
- Network error or 5xx: keep everything and retry on the next run.
- **Re-sending is safe.** The server ignores an identical play, and a play re-sent with the same
  `play_id` but larger `watched_seconds`/`ended_at` replaces the older version. So upload in-progress
  plays at each 15-minute worker run (as a checkpoint) and again when they finish.
- Upload from the existing periodic `CaptureWorker` run (and "Sync now"), as a separate step from the
  second-brain uploads. A failure on one side must not block the other.

## Settings (existing `SettingsActivity`)

- "YouTube → InputTracker" section:
  - an enable switch (off by default)
  - the InputTracker URL (https only; default empty; it is `https://pinpc.taild61ed4.ts.net` today
    and will move to a cloud VM later)
  - the ingest token (password field, never shown again after saving, never logged)
  - the YouTube Music switch
  - a "Grant notification access" button that opens
    `Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS`, with a granted/not granted status line
  - the last upload result
- Store the URL and token in the app's private prefs (`Prefs.kt` pattern).

## Rules

- No new dependencies unless really needed (WorkManager is already there; use
  `HttpURLConnection` like the existing client code).
- Don't log titles at info level, and never log the token.
- Timestamps are UTC on the wire.
- Keep `minSdk 26` working.

## Tests

- JVM unit tests for the pure play builder, covering:
  - play / pause / resume in one play
  - title change splits a play
  - pause > 30 min ends a play
  - < 30 s dropped
  - non-allowlisted package ignored
  - buffering not counted
  - ended_at ≥ started_at
- JSON body builder (exact field names, nulls, UTC formatting).
- Outbox keeps plays until 2xx, keeps them on 401/5xx, and drops only the batch on 400.

## Finish with

A short summary covering:
- files changed and tests added
- what I must do on the phone: grant notification access, enter the URL and token
- anything uncertain (Shorts, ReVanced, YouTube Music behaviour)
