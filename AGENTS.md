# Rules for coding agents working on InputTracker

You are a worker. The manager reviews your work, commits and merges it. Your task is in
`.task/prompt.md` (or `.task/feedback.md` when sent back).

## Always
- Stay inside this task's scope and this folder. Don't commit, push, or change git config.
- TypeScript (strict) on Bun. Tests with `bun test`. Finish only when `bun run check` passes.
- No new native dependencies (must run on Linux x86_64 and ARM64). Prefer no new deps at all;
  allowed: hono, preact, vite, @preact/preset-vite. Ask in your summary if you think you need more.
- Test data is **synthetic** (fake titles, fake IDs). Never use real personal data.
- Tests never touch the network: mock `fetch`.
- Never read or print `inputtracker.config.toml`; never log tokens (use `redact()` from config).

## Data rules (from PLAN.md)
- `events` is append-only: never UPDATE or DELETE it (the DB has triggers that abort).
  A changed record is a new row; inserts are `INSERT OR IGNORE` on `record_hash`.
- Timestamps stored as UTC ISO 8601 (`2026-10-17T08:15:00.000Z`); Europe/Bratislava only for display/bucketing.
- Calendar, heat map, stats and lists read **`events_latest` only**, never sum over `events`.
- Audiobookshelf: **GET requests only**, via `src/sources/audiobookshelf/client.ts`.
  Real field names: `docs/abs-fields.md`.
- Nothing PC-specific hard-coded: DB path, backup dir, bind/port, source URLs come from config.

## Finish with
A short summary: files changed, tests added, anything not done or uncertain.
