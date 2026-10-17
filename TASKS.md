# Tasks

Status: `TODO | RUNNING | REVIEW | DONE | BLOCKED`. Worker: AG = Antigravity (`gemini-3.8-flash-high`),
OC = opencode (free model, actual model logged on completion). Every task ends with `bun run check` green.
Design reference: PLAN.md. Fixtures are synthetic only.

## M0 — Manager setup (configs/tooling, no feature code)

| ID | Task | Status |
|---|---|---|
| M01 | `scripts/run-worker.sh` (wrapper: timeout, stall watch, result classification), `scripts/jail.sh`, `scripts/probe-worker.sh`, `scripts/check-secrets.sh` + `.githooks/pre-push`, `scripts/overnight.sh` + `scripts/manager/step.md` | DONE 2026-10-17 (both workers tested through wrapper + jail) |
| M02 | `AGENTS.md` worker rules, `inputtracker.config.example.toml` (no `opencode.json` needed: bwrap jail works for opencode with `--standalone`) | DONE 2026-10-17 |
| M04 | Capture field names (no values) of `GET /api/me` mediaProgress and `GET /api/me/listening-stats` into `docs/abs-fields.md` | DONE 2026-10-17 |
| — | Session field names captured into `docs/abs-fields.md`; ABS key verified (HTTP 200) | DONE 2026-10-17 |

## v1

| ID | Task | Worker (why) | Depends | Acceptance | Status |
|---|---|---|---|---|---|
| T01 | **Scaffold**: `package.json` (bun), `tsconfig` strict, folder layout from PLAN.md, scripts `check` (= `tsc --noEmit && bun test`), `dev`, `it` (CLI), one trivial passing test | OC (boilerplate) | M02 | `bun run check` passes | RUNNING (OC) |
| T02 | **DB core**: `src/core/db.ts` open DB at the configured path (WAL, foreign keys), migrations table, create `events`, `ingest_runs` (with `status`, redacted `error`), `sync_state`, view `events_latest` (max `id` per source+source_kind+source_id), triggers aborting UPDATE/DELETE on `events` | AG (correctness) | T01 | Tests: tables exist; UPDATE and DELETE on events throw; migrations idempotent; `events_latest` returns one row per key | TODO |
| T03 | **Event model**: `src/core/events.ts` type `NewEvent`, `normalize()`, `recordHash()` (sha256 of canonical JSON, fixed key order), `insertEvents(db, runId, events)` → `{seen, inserted}` with `INSERT OR IGNORE`; `startRun/finishRun` | AG (dedup is the core rule) | T02 | Tests: same input twice → 0 new rows; changed progress → new row; hash stable across key order | TODO |
| T04 | **Time utils**: `toUtcIso()` from epoch ms / ISO with offset / date; `localParts(iso, "Europe/Bratislava")` → date, hour, weekday | OC (small, well-specified) | T01 | Tests incl. DST days 2026-03-29 and 2026-10-25, midnight boundary | TODO |
| T05 | **Config**: `src/core/config.ts` load `inputtracker.config.toml` (path override via env `INPUTTRACKER_CONFIG`); keys from PLAN.md (timezone, server.bind/port, storage.db_path/backup_dir/backup_keep, audiobookshelf.url/token/timeout_s, notify.*); defaults from XDG dirs, never PC-specific paths; `redact()` for logs | OC | T01 | Tests: missing file → defaults; every key overridable; token never appears in `String(config)`/log output | TODO |
| T06 | **ABS client**: `src/sources/audiobookshelf/client.ts` GET-only (`get(path, query)`), Bearer auth, base URL from config, path allow-list (`/api/me`, `/api/me/listening-sessions`, `/api/me/listening-stats`, `/api/items/:id/cover`), 0-based pagination helper, timeout, retries on 5xx, typed `SourceUnavailable` error when the host is unreachable | AG (safety rule) | T05 | Tests with mocked `fetch`: only GET ever issued; non-allow-listed path throws; pagination collects all pages; connection refused → `SourceUnavailable`; token not in error messages | TODO |
| T07 | **ABS mapping** per `docs/abs-fields.md` (real field names): sessions → `listening_session` events; `/api/me` mediaProgress → `media_progress` events; listening-stats → `daily_stat` snapshot rows; strip `deviceInfo.ipAddress` from `raw` | AG (field semantics) | T03, T04, T06, M04 | Tests on synthetic fixtures in `test/fixtures/abs/` using the exact field names; podcast episode vs book handled; no `ipAddress` in stored raw | TODO |
| T08 | **ABS sync + CLI**: `src/sources/audiobookshelf/sync.ts` = fetch → map → `Sink` interface (v1: `LocalDbSink`); `sync_state` cursor (idempotent if cursor lost); CLI `bun run it sync audiobookshelf` (standalone, one source per command) printing counts; on failure: run stored as `failed` with redacted error, cursor not advanced, exit code 2 | OC | T07 | Tests with mocked client: two runs → second inserts 0; **one session synced three times (growing) → 3 rows in `events`, 1 in `events_latest`**; unreachable host → failed run logged, no rows changed, next run succeeds | TODO |
| T09 | **Export**: JSON (`inputtracker-export` v1) and CSV of all events, CLI `it export --format json|csv --out file` | OC | T03 | Tests: all columns present, UTC preserved, CSV escaping | TODO |
| T10 | **Import native**: re-import own JSON and CSV export; hashes recomputed | OC | T09 | Round-trip test: export → import into same DB → 0 inserted; into empty DB → identical rows | TODO |
| T11 | **Manual entry**: `src/io/manual.ts` validate + insert (`source=manual`, UUID source_id), CLI `it add` | OC | T03, T04 | Tests: required fields, local-time input converted to UTC | TODO |
| T12 | **HTTP API**: Hono app with routes from PLAN.md; bind/port from config; calendar and heat map aggregation in local tz (by day; by hour×weekday; source filter) **reading only `events_latest`** and only consumption kinds (PLAN.md counting rule); multipart import (native JSON/CSV); serve `web/dist` | AG (aggregation logic) | T08–T11 | Tests via `app.request()`: each route; heat map counts and minutes correct across DST; **a session synced three times is counted once in calendar and heat map with its latest duration** | TODO |
| T13 | **Web scaffold**: Vite + Preact in `web/`, nav (Calendar, Heatmap, Import/Export, Add), API client, mobile-first layout, build to `web/dist` | OC | T12 | `bun run build:web` works; served page loads at 375 px width | TODO |
| T14 | **Calendar view**: month grid, per day items (icon by source, title, local time, duration), day detail panel, month navigation | AG | T13 | Renders fixture data correctly; usable at 375 px | TODO |
| T15 | **Heat map view**: year grid (days, colour by minutes or count), hour×weekday grid, source filter, year switch, tap a day → calendar day | AG | T13 | Correct colouring on fixture DB; source filter changes data | TODO |
| T16 | **Import/Export/Add page**: file upload with result counts, export buttons, manual entry form, "Sync now" button with last-run status | OC | T13 | Upload of an export → shows "0 new" second time | TODO |
| T17 | **PWA**: manifest, icons (generated simple SVG/PNG), service worker caching shell + last API responses, offline banner | OC | T14–T16 | Lighthouse-style check: installable; reload offline shows cached calendar | TODO |
| T18 | **Deploy (generic, reusable on the VM)**: `deploy/` systemd user units `inputtracker.service`, `inputtracker-sync@.service` + `inputtracker-sync@audiobookshelf.timer` (hourly), `inputtracker-backup.timer` (nightly); only `%h` and config paths, no PC-specific paths, `bun` found via PATH; `scripts/install.sh` (no sudo, idempotent) | OC | T12, F14 | `systemd-analyze --user verify` passes; grep finds no `/home/pinacule` or `localhost:13378` in `deploy/` | TODO |
| T19 | **Smoke test**: script builds web, starts server on a temp DB with fixtures, hits all API routes and `/`, imports + exports, stops | AG | T17, F01, F09, F10, F14, F15 | `bun run smoke` green | TODO |
| T20 | **Docs**: README (run, CLI, phone install), `DATA_FORMAT.md` for other programs (schema, how to read `events_latest`, UTC rule) | OC | T19 | Manager review | TODO |
| F01 | **Stats dashboard** (F1): API `GET /api/stats?from&to&source` (minutes per source per week/month, top items) + `web` Stats page; from `events_latest` only | AG (aggregation) | T12, T13 | Tests: session synced three times counted once; totals match fixture | TODO |
| F09 | **ABS covers** (F9): server route `GET /api/cover/:itemId` proxies ABS `GET /api/items/:id/cover` with token server-side, caches files under data dir, 404 fallback icon; used in calendar/lists | OC | T06, T14 | Tests: only GET to ABS; token never in response/headers to browser; cache hit avoids 2nd fetch | TODO |
| F10 | **In progress / finished** (F10): API `GET /api/progress` from latest `media_progress` rows (`isFinished`, `progress`, last update) + page with two lists | OC | T07, T13 | Tests: item with 3 progress rows shows latest only; finished items in finished list | TODO |
| F14 | **Nightly backup** (F14): `it backup` = `VACUUM INTO` snapshot + JSON export into `backup_dir` (default `~/.local/share/inputtracker/backups/`), names `inputtracker-YYYY-MM-DD.db` / `.json`, keep last `backup_keep` (14) nightly sets, prune only files matching that pattern | OC | T09 | Tests on temp dir: 16 runs on fake dates → 14 kept; unrelated files untouched; snapshot opens and has same row count | TODO |
| F15 | **Sync failure notification** (F15): notifier interface; desktop via `notify-send` (skip silently if missing/headless); notify on first failure and on recovery only, state in `sync_state`; ntfy stub behind config key | OC | T08 | Tests with fake notifier: 3 failures → 1 notification; recovery → 1 notification | TODO |
| M03 | Manager: real ABS sync run against your server (GET-only, redacted output), check counts look sane | manager | T08 + your token | — | TODO |

## After v1 (later, not now)

Remaining proposed features (F2–F8, F11–F13), TMDB/OMDb covers, ntfy, HTTP ingest sink
for remote sources, VM move (MIGRATION.md).


| ID | Task | Worker | Status |
|---|---|---|---|
| S01 | Simkl auth (PIN flow) + client (`simkl-api-key` header, Bearer token), GET-only | AG | TODO |
| S02 | Simkl `/sync/all-items/?date_from=` incremental sync → movie/episode events with IMDb/Simkl IDs, season/episode | AG | TODO |
| S03 | Simkl in UI filters + icon | OC | TODO |
| Y01 | YouTube Takeout `watch-history.json` importer (video ID from `titleUrl`, channel from `subtitles`, `time` UTC, skip ads/removed videos, `products`) | OC | TODO |
| Y02 | yt-dlp `:ythistory` poller (`--flat-playlist -J`, cookies from config path), dedup with Takeout rows by video ID + time window | AG | TODO |
| Y03 | YouTube in UI | OC | TODO |
