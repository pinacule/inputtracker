# Tasks

Status: `TODO | RUNNING | REVIEW | DONE | BLOCKED`. Worker: AG = Antigravity (`gemini-3.8-flash-high`),
OC = opencode (free model, actual model logged on completion). Every task ends with `bun run check` green.
Design reference: PLAN.md. Fixtures are synthetic only.

## M0 — Manager setup (configs/tooling, no feature code)

| ID | Task | Status |
|---|---|---|
| M01 | `scripts/run-worker.sh` (wrapper: timeout, stall watch, result classification), `scripts/probe-worker.sh`, `scripts/check-secrets.sh` + `.githooks/pre-push` | TODO |
| M02 | `AGENTS.md` worker rules, `opencode.json` permission denies, `inputtracker.config.example.toml` | TODO |

## v1

| ID | Task | Worker (why) | Depends | Acceptance | Status |
|---|---|---|---|---|---|
| T01 | **Scaffold**: `package.json` (bun), `tsconfig` strict, folder layout from PLAN.md, scripts `check` (= `tsc --noEmit && bun test`), `dev`, `it` (CLI), one trivial passing test | OC (boilerplate) | M02 | `bun run check` passes | TODO |
| T02 | **DB core**: `src/core/db.ts` open DB (WAL, foreign keys), migrations table, create `events`, `ingest_runs`, `sync_state`, view `events_latest`, triggers aborting UPDATE/DELETE on `events` | AG (correctness) | T01 | Tests: tables exist; UPDATE and DELETE on events throw; migrations idempotent | TODO |
| T03 | **Event model**: `src/core/events.ts` type `NewEvent`, `normalize()`, `recordHash()` (sha256 of canonical JSON, fixed key order), `insertEvents(db, runId, events)` → `{seen, inserted}` with `INSERT OR IGNORE`; `startRun/finishRun` | AG (dedup is the core rule) | T02 | Tests: same input twice → 0 new rows; changed progress → new row; hash stable across key order | TODO |
| T04 | **Time utils**: `toUtcIso()` from epoch ms / ISO with offset / date; `localParts(iso, "Europe/Bratislava")` → date, hour, weekday | OC (small, well-specified) | T01 | Tests incl. DST days 2026-03-29 and 2026-10-25, midnight boundary | TODO |
| T05 | **Config**: `src/core/config.ts` load `inputtracker.config.toml` (path override via env `INPUTTRACKER_CONFIG`), defaults (db path in XDG data dir, port 8787, tz), `redact()` for logs | OC | T01 | Tests: missing file → defaults; token never appears in `String(config)`/log output | TODO |
| T06 | **ABS client**: `src/sources/audiobookshelf/client.ts` GET-only (`get(path, query)`), Bearer auth, path allow-list, pagination helper for `/api/me/listening-sessions` (`itemsPerPage`, `page`), timeouts, retries on 5xx | AG (safety rule) | T05 | Tests with mocked `fetch`: only GET ever issued; non-allow-listed path throws; pagination collects all pages; token not in error messages | TODO |
| T07 | **ABS mapping**: sessions → `listening_session` events (id, libraryItemId, episodeId, displayTitle/Author, mediaType, startedAt/updatedAt ms → UTC, timeListening, deviceInfo); `/api/me` mediaProgress → `media_progress` events; listening-stats → `daily_stat` snapshot rows | AG (field semantics) | T03, T04, T06 | Tests on synthetic fixtures in `test/fixtures/abs/`; podcast episode vs book handled | TODO |
| T08 | **ABS sync + CLI**: `src/sources/audiobookshelf/sync.ts`, `sync_state` cursor (still idempotent if cursor lost), CLI `bun run it sync audiobookshelf` printing counts | OC | T07 | Tests with mocked client: two runs → second inserts 0; run logged in `ingest_runs` | TODO |
| T09 | **Export**: JSON (`inputtracker-export` v1) and CSV of all events, CLI `it export --format json|csv --out file` | OC | T03 | Tests: all columns present, UTC preserved, CSV escaping | TODO |
| T10 | **Import native**: re-import own JSON and CSV export; hashes recomputed | OC | T09 | Round-trip test: export → import into same DB → 0 inserted; into empty DB → identical rows | TODO |
| T11 | **Manual entry**: `src/io/manual.ts` validate + insert (`source=manual`, UUID source_id), CLI `it add` | OC | T03, T04 | Tests: required fields, local-time input converted to UTC | TODO |
| T12 | **HTTP API**: Hono app with routes from PLAN.md; calendar and heat map aggregation in local tz (by day; by hour×weekday; source filter); multipart import (native JSON/CSV); serve `web/dist` | AG (aggregation logic) | T08–T11 | Tests via `app.request()`: each route, heat map counts and minutes correct across DST | TODO |
| T13 | **Web scaffold**: Vite + Preact in `web/`, nav (Calendar, Heatmap, Import/Export, Add), API client, mobile-first layout, build to `web/dist` | OC | T12 | `bun run build:web` works; served page loads at 375 px width | TODO |
| T14 | **Calendar view**: month grid, per day items (icon by source, title, local time, duration), day detail panel, month navigation | AG | T13 | Renders fixture data correctly; usable at 375 px | TODO |
| T15 | **Heat map view**: year grid (days, colour by minutes or count), hour×weekday grid, source filter, year switch, tap a day → calendar day | AG | T13 | Correct colouring on fixture DB; source filter changes data | TODO |
| T16 | **Import/Export/Add page**: file upload with result counts, export buttons, manual entry form, "Sync now" button with last-run status | OC | T13 | Upload of an export → shows "0 new" second time | TODO |
| T17 | **PWA**: manifest, icons (generated simple SVG/PNG), service worker caching shell + last API responses, offline banner | OC | T14–T16 | Lighthouse-style check: installable; reload offline shows cached calendar | TODO |
| T18 | **Deploy**: `deploy/` systemd user units `inputtracker.service` + `inputtracker-sync.timer` (hourly ABS sync), `scripts/install.sh` (no sudo), README section on `tailscale serve --bg 8787` | OC | T12 | `systemd-analyze --user verify` passes on unit files | TODO |
| T19 | **Smoke test**: script builds web, starts server on a temp DB with fixtures, hits all API routes and `/`, imports + exports, stops | AG | T17 | `bun run smoke` green | TODO |
| T20 | **Docs**: README (run, CLI, phone install), `DATA_FORMAT.md` for other programs (schema, how to read `events_latest`, UTC rule) | OC | T19 | Manager review | TODO |
| M03 | Manager: real ABS sync run against your server (GET-only, redacted output), check counts look sane | manager | T08 + your token | — | TODO |

## After v1

| ID | Task | Worker | Status |
|---|---|---|---|
| S01 | Simkl auth (PIN flow) + client (`simkl-api-key` header, Bearer token), GET-only | AG | TODO |
| S02 | Simkl `/sync/all-items/?date_from=` incremental sync → movie/episode events with IMDb/Simkl IDs, season/episode | AG | TODO |
| S03 | Simkl in UI filters + icon | OC | TODO |
| Y01 | YouTube Takeout `watch-history.json` importer (video ID from `titleUrl`, channel from `subtitles`, `time` UTC, skip ads/removed videos, `products`) | OC | TODO |
| Y02 | yt-dlp `:ythistory` poller (`--flat-playlist -J`, cookies from config path), dedup with Takeout rows by video ID + time window | AG | TODO |
| Y03 | YouTube in UI | OC | TODO |
