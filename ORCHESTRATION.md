# Orchestration

Manager = Claude Code (plans, reviews, merges; writes no feature code).
Workers = Antigravity (`gemini-3.8-flash-high`) and opencode (free models first). Commands: WORKERS.md.

## Picking a worker

Default routing (logged per task in TASKS.md and MORNING_REPORT.md):

- **Antigravity**: logic where correctness matters (schema/hash, ABS client + mapping, API
  aggregation, calendar/heat map components). Stronger model, quota-limited, so spend it on hard tasks.
- **opencode (free)**: boilerplate and well-specified tasks (scaffold, config loader, export/import,
  CLI wiring, PWA files, systemd units, docs).
- If the preferred worker is limited, the other one takes the task when it can do it.

## Task lifecycle

1. **Prepare** (manager)
   ```bash
   git worktree add ../inputtracker-wt/T07 -b task/T07 main
   ```
   Write `../inputtracker-wt/T07/.task/prompt.md` (`.task/` is gitignored) containing:
   task text from TASKS.md, files allowed to touch, acceptance criteria, `AGENTS.md` rules
   (no secrets, no real data in fixtures, no network in tests, GET-only for ABS,
   never commit/push, run `bun run check` before finishing).
2. **Run** worker headless in the worktree (WORKERS.md command), output to `.task/`.
   Wrapper `scripts/run-worker.sh <worker> <task> <model>` (first manager task of the night,
   config/tooling only) does: timeout, stall watch, exit-code classification → writes
   `.task/result` = `ok | limit | error | stuck`, plus raw logs.
3. **Classify**
   - `limit` → not a failure. Put task back in queue, mark worker limited (see Limits).
   - `stuck` → kill, count as a failed attempt.
   - `ok`/`error` → review.
4. **Review** (manager)
   - `git -C <wt> diff main...` — only allowed files touched, no secrets, no real data,
     no `fetch` with non-GET to ABS, no UPDATE/DELETE on `events`.
   - Run in the worktree: `bun install --frozen-lockfile` (if deps changed), `bun run check`
     (typecheck + tests), plus task-specific checks (e.g. curl an endpoint, open a page in
     the browser pane at mobile width for UI tasks).
   - Pass → step 5. Fail → feedback.
5. **Merge**
   ```bash
   git -C <wt> add -A && git -C <wt> commit -m "T07: <title>"   # manager commits worker output
   git checkout main && git merge --no-ff task/T07
   bun run check                         # on main again
   scripts/check-secrets.sh              # also runs as pre-push hook
   git push origin main
   git worktree remove ../inputtracker-wt/T07 && git branch -d task/T07
   ```
   Update TASKS.md status + MORNING_REPORT.md, commit those with the merge.

## Failure policy

1. Attempt 1 fails review/tests → send back **once** to the same worker, same session
   (`opencode run --session <id>` / `antigravity --conversation <id> -p`), with specific
   feedback: failing test output, the exact lines/rules violated.
2. Fails again → reset the worktree to `main`, give the task to the **other worker** with the
   original prompt + a short note of what went wrong.
3. Fails again → mark **BLOCKED** in TASKS.md with a one-line reason; continue with the next
   task whose dependencies are met. Tasks depending on a BLOCKED task are skipped and listed.

Limit hits never count as attempts.

## Limits

State per worker in `.orchestrator/state.json` (gitignored): `available | limited(until)`.

- **Antigravity**: exit 3 + `AGY_ERROR` with 429/`RESOURCE_EXHAUSTED`/quota, or "credits balance
  is too low" → read `antigravity -p /usage --output-format json`; `until` = the Gemini bucket's
  `reset_time` (5-hour or weekly) when remaining is ~0, else now + 15 min.
- **opencode**: `error` event matching 429/rate/quota/limit/exhausted → first switch to the next
  free model in the list (models have separate limits); if all free models are limited,
  `until` = now + 15 min.
- **Probe** when `until` passes: the PONG prompt from WORKERS.md. Still limited → back off
  15 → 30 → 60 min (cap 60). Recovered → resume.
- Other worker keeps working meanwhile. Both limited → loop sleeps until the earliest `until`.
- Every limit hit and recovery (time, worker, model, message) is appended to MORNING_REPORT.md.
- If the **manager** (Claude) hits its own limit, the loop simply pauses; on restart it
  reads TASKS.md + `.orchestrator/state.json` and continues from where it left off.

## Overnight loop

Runs in tmux so it survives the terminal closing:

```bash
tmux new -s inputtracker -c ~/Projects/inputtracker
claude   # then: "Run the overnight loop per ORCHESTRATION.md"
```

Loop (one task in flight per worker, so up to 2 in parallel on independent files):

```
while TASKS.md has TODO tasks with met dependencies:
    for each available worker without a running task:
        pick next eligible task for it (routing rules) -> prepare -> start in background
    wait for a worker to finish (background task notification, not polling)
    classify -> review -> merge+push | feedback | reassign | BLOCKED
    if both workers limited: sleep until earliest reset, probe
write final MORNING_REPORT.md, push, stop
```

Merges are serialized (one at a time); a second worktree whose branch conflicts after a merge
is rebased by the manager or re-run by the worker on the new `main`.

## Secrets and data safety (before every push)

- `.gitignore`: `inputtracker.config.toml`, `*.db*`, `data/`, `exports/`, `.task/`, `.orchestrator/`,
  `*.cookies.txt`, `watch-history*.json`, `.env*`.
- Pre-push hook (`.githooks/pre-push`, enabled via `git config core.hooksPath .githooks`)
  runs `scripts/check-secrets.sh`: `gitleaks` on the commits being pushed + a check that no
  ignored-pattern file (db, export, takeout, config) is tracked. Hook failure = no push,
  noted as BLOCKED-PUSH in the report.
- Logs never print tokens: config loader exposes `redact()`; worker prompts never contain
  config values; tests use fake tokens like `test-token`.
- Fixtures are synthetic (fake titles/IDs), never copied from your real ABS/Simkl/Takeout data.

## Worker permissions

- Antigravity: `--mode accept-edits` (tested OK for edits + simple shell). If it can't run
  `bun test`, switch to `--mode auto` (needs your OK, see SETUP.md).
- opencode: `--auto`. A project `opencode.json` will deny `git push`, `git commit`, `rm -rf`,
  and reading `inputtracker.config.toml` (first manager task of the night; exact permission
  syntax to be checked against opencode 2.x docs).
- Workers never get the real config file; integration against your real ABS is run by the
  manager only, with output redacted.

## MORNING_REPORT.md format

```
# Morning report – <date>
## Done          | task | worker | model | attempts | commit |
## Failed / sent back
## BLOCKED       | task | reason |
## Limit pauses  | worker | model | hit at | recovered at | message |
## Decisions needed
```
