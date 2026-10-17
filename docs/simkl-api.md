# Simkl API — what InputTracker uses

Source: the official docs at https://api.simkl.org (OpenAPI spec `https://api.simkl.org/openapi.json`),
read 2026-10-17. The old Apiary docs are frozen and AUTH V1 (old PIN flow) retires around April 2027,
so InputTracker uses **AUTH V2** only. Not yet verified against a real account (no client_id yet):
tests mock `fetch` with the shapes below.

## Rules for InputTracker

- Read-only: never write to the user's Simkl account. Data calls are **GET** only.
  The only POSTs allowed are the two auth endpoints `POST /oauth2/device` and `POST /oauth2/token`.
  The client enforces this with a method + path allow-list (like the ABS client).
- Scope: request `media:read` only (omitting `scope` also gives `media:read`).
- Host: `https://api.simkl.com`.
- `client_id` is public (Simkl says it is safe to ship) but still lives in the config file.
  Tokens are secrets: never log or print them, never print `device_code`.

## Every request

URL parameters on **every** call: `client_id=<id>&app-name=inputtracker&app-version=<package.json version>`.
Header `User-Agent: inputtracker/<version>` always. Header `Authorization: Bearer <access_token>` on
`/sync/*` calls. (`simkl-api-key: <client_id>` header is an accepted alternative to the
`client_id` param; use the param.)

Rate limits: 10 GET/s per user. `429` bodies: `{"error":"rate_limit"}` → wait ~1 s and retry once;
`{"error":"user_limit_exceeded"}` → daily quota spent, wait `Retry-After` seconds (stop this run,
fail as "limit", do not loop). Dates are ISO 8601 UTC with `Z` (e.g. `2026-05-13T16:08:00Z`).

## Auth: device flow (AUTH V2, RFC 8628)

App registration (done once by the user at https://simkl.com/settings/developer/): a **V2** app,
client type **"TV, devices & command line"**. No client_secret, no redirect URI.

1. `POST https://api.simkl.com/oauth2/device`, `Content-Type: application/x-www-form-urlencoded`,
   body `client_id=<id>&scope=media:read`. Response:
   ```json
   {"device_code":"…","user_code":"BDWP-HQPK","verification_uri":"https://simkl.com/pin",
    "verification_uri_complete":"https://simkl.com/pin?user_code=BDWP-HQPK","expires_in":900,"interval":5}
   ```
   The CLI prints `verification_uri_complete` on its own line and, as fallback,
   `verification_uri` + `user_code` (exactly as returned). Never print `device_code`.
2. Poll `POST https://api.simkl.com/oauth2/token` (form body)
   `grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=<id>&device_code=<code>`
   every `interval` seconds:
   | Status | `error` | Action |
   |---|---|---|
   | 400 | `authorization_pending` | keep polling at the same interval |
   | 400 | `slow_down` | add 5 s to the interval, **wait**, then poll |
   | 400 | `expired_token` | stop, tell the user to run the command again |
   | 401 | `invalid_client` | stop: wrong client_id or a V1 app ("register a V2 app") |
   There is **no deny signal**: a user who clicks "no" just produces `authorization_pending`.
   Use our own deadline (10 min, never beyond `expires_in`).
3. Success: standard token response with `access_token` (`simkl_at_…`, valid 7 days),
   `refresh_token` (`simkl_rt_…`, valid 180 days, sliding, non-rotating), `expires_in`, `scope`.

Refresh: `POST /oauth2/token` with `grant_type=refresh_token&client_id=<id>&refresh_token=<rt>`.
Refresh when the access token is < 1 day from expiry, or once on a `401` (then retry the request
once). A refresh replaces the access token on the grant immediately, so two processes refreshing
at once cut each other off: on a `401`, first re-read the token file; if it holds a different
access token, retry with that instead of refreshing. If the refresh itself fails → the user must
run `it auth simkl` again (sync fails with that message, no secret in it).

## Sync: activities first, then deltas

`GET /sync/activities` returns timestamps per list:
```json
{"all":"2026-05-08T14:23:11Z","settings":{"all":"…"},
 "tv_shows":{"all":"…","watching":"…","plantowatch":"…","hold":"…","completed":"…","dropped":"…","rated_at":"…","playback":"…","removed_from_list":"…"},
 "anime":{…same keys as tv_shows…},
 "movies":{"all":"…","plantowatch":"…","completed":"…","dropped":"…","rated_at":"…","playback":"…","removed_from_list":"…"}}
```

- **First sync** (no saved snapshot): read `/sync/activities` and keep it in memory **before**
  pulling; then pull `/sync/all-items/shows`, `/sync/all-items/movies`, `/sync/all-items/anime`
  **sequentially**, each with `extended=full&episode_watched_at=yes&include_all_episodes=original`.
  Save the snapshot only after all three succeed.
- **Later syncs**: read `/sync/activities`. If its top-level `all` equals the saved snapshot's
  `all` → nothing changed, done (0 seen). Otherwise call
  `/sync/all-items?date_from=<saved snapshot's all, exactly as returned>&extended=full&episode_watched_at=yes&include_all_episodes=original`
  and save the new snapshot only if that succeeded.
- `include_all_episodes=original` (not `yes`): `yes` invents episode rows stamped with the show's
  last-watched time; we only want watches with their real dates.
- `400 {"error":"max_items"}` on a pull → retry that type split by status:
  `/sync/all-items/{type}/{status}` for `watching`, `plantowatch`, `hold`, `completed`, `dropped`.
- Store the snapshot JSON in `sync_state` for source `simkl` (same table as the ABS cursor).

### `GET /sync/all-items` response (fields we use)

```json
{
  "movies": [{
    "last_watched_at": "2026-05-01T20:15:00Z",   // null if never watched
    "status": "completed",                        // watching|plantowatch|hold|completed|dropped
    "user_rating": 8, "user_rated_at": "…",       // may be null
    "movie": {"title": "…", "year": 2010, "poster": "74/74415673dcdc9cdd", "runtime": 148,
              "ids": {"simkl": 53536, "slug": "…", "imdb": "tt1375666", "tmdb": "27205"}}
  }],
  "shows": [{
    "last_watched_at": "…", "status": "watching", "last_watched": "S05E16",
    "show": {"title": "…", "year": 2008, "poster": "…", "runtime": 45,
             "ids": {"simkl": 11121, "slug": "…", "imdb": "tt0903747", "tmdb": "1396", "tvdb": "81189"}},
    "seasons": [{"number": 1, "episodes": [{"number": 1, "watched_at": "2026-04-30T19:02:00Z"}]}]
  }],
  "anime": [{ …same as shows, plus "anime_type": "tv" | "movie" | "ova" | "ona" | "special" | "music video",
              ids may include "mal", "anidb", "anilist", "kitsu" … }]
}
```
`runtime` is whole minutes (movie runtime, or the show's typical episode runtime); may be null.
`poster` is an image path, may be null. `ids` with `extended=full` include the external IDs.

### Mapping to events (one event per watch)

| Simkl | event |
|---|---|
| movie with `last_watched_at` | `source=simkl`, `source_kind=watch`, `media_type=movie`, `source_id=movie:<ids.simkl>:<last_watched_at>`, `title`=movie title, `started_at`=`last_watched_at`, `duration_seconds`=`runtime*60` or null |
| show/anime episode with `watched_at` | `source_kind=watch`, `media_type=episode`, `source_id=ep:<show ids.simkl>:<season>:<episode>:<watched_at>`, `title`=show title, `season`, `episode`, `started_at`=`watched_at`, duration = `runtime*60` or null |
| anime with `anime_type` = `movie` | as a movie (`media_type=movie`) |
| items without a watch time (plantowatch, never watched), episodes without `watched_at` | no event |

`external_ids`: the item's `ids` (`simkl`, `imdb`, `tmdb`, `tvdb`, `mal`, `slug`, …) plus
`simkl_poster` = the `poster` path when present. `raw`: the movie entry, or for episodes the
episode object plus the show's `title`/`ids` (not the whole show with every season).
A watch time in `source_id` makes a rewatch a separate event; re-syncing the same data inserts 0.

### Posters (for the UI)

Image URL: `https://simkl.in/posters/<poster path>_m.webp` (sizes `_m` medium, `_w` larger; `_c` card).
Simkl recommends the third-party proxy wsrv.nl; we do **not** use it (it would leak viewing data to a
third party). Our server fetches `simkl.in` directly (GET, no auth header) and caches on disk like ABS
covers. Validate the path with `^[0-9a-z]+/[0-9a-z]+$` (example `74/74415673dcdc9cdd`) before building a URL.
