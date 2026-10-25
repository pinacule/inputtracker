# Orchestration

Manager = Claude Code (plans, reviews, merges; writes no feature code).
Workers = Codex CLI (`gpt-6.1-sol` high, from 2026-10-26), opencode (`agentrouter-responses/gpt-6.1-sol#high`, then `gpt-6-astra`) and Antigravity (`gemini-3.8-flash-high`). Commands: WORKERS.md.

## Picking a worker

Default routing (logged per task in TASKS.md and MORNING_REPORT.md):

- **Antigravity**: logic where correctness matters (schema/hash, ABS client + mapping, API
  aggregation, calendar/heat map components). Stronger model, quota-limited, so spend it on hard tasks.
- **opencode (AgentRouter)**: boilerplate and well-specified tasks (scaffold, config loader, export/import,
  CLI wiring, PWA files, systemd units, docs).
- If the preferred worker is limited, the other one takes the task when it can do it.

## Task lifecycle

1. **Prepare** (manager)
   ```bash
   git worktree add .worktrees/T07 -b task/T07 main
   ```
   Write `.worktrees/T07/.task/prompt.md` (`.task/` is gitignored) containing:
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
   git worktree remove .worktrees/T07 && git branch -d task/T07
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
  model in the list (models have separate limits; never a paid `nebius/*` model); if all models are limited,
  `until` = now + 15 min.
- **Probe** when `until` passes: the PONG prompt from WORKERS.md. Still limited → back off
  15 → 30 → 60 min (cap 60). Recovered → resume.
- Other worker keeps working meanwhile. Both limited → loop sleeps until the earliest `until`.
- Every limit hit and recovery (time, worker, model, message) is appended to MORNING_REPORT.md.
- If the **manager** (Claude) hits its own limit, the loop simply pauses; on restart it
  reads TASKS.md + `.orchestrator/state.json` and continues from where it left off.

## Overnight loop

Runs in tmux session **`inputtracker-overnight`**, wrapped in `systemd-inhibit` so the PC doesn't sleep:

```bash
tmux new-session -d -s inputtracker-overnight -c ~/Projects/inputtracker \
  'systemd-inhibit --what=idle:sleep --why="InputTracker overnight build" scripts/overnight.sh'
tmux attach -t inputtracker-overnight      # watch;  Ctrl-b d to detach
touch .orchestrator/STOP                   # stop after the current step
```

`scripts/overnight.sh` (bash supervisor) alternates:
1. **Manager step**: `claude -p "<scripts/manager/step.md + live status>" --permission-mode auto
   --model sonnet`. Fresh context each step (cheaper; all state lives in TASKS.md,
   MORNING_REPORT.md and `.orchestrator/current.json`). The step reviews/merges/pushes the last
   worker result or prepares the next task, and writes `current.json` (`next: run|wait|finished`).
2. **Worker run**: `scripts/run-worker.sh` in the jail → `ok|limit|error|stuck` → back to 1.

Limits are handled in bash (state in `.orchestrator/state.json`): worker limits per Limits above;
a Claude usage limit makes the supervisor parse the reset time (fallback 30 min), sleep, and
resume — it never stops on a limit. Every hit/recovery is appended to MORNING_REPORT.md.
Serial: one task at a time (simpler, and merges never race). Log: `.orchestrator/overnight.log`.

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

Decided 2026-10-17: Antigravity may act autonomously but only inside the project folder;
opencode: AgentRouter models only (gpt-6-astra, gpt-6.1-sol).

- **Folder limit is enforced by bubblewrap**, not by the CLIs: every worker runs in a `bwrap`
  jail where `/` is read-only and only its own worktree `.worktrees/<task>` (plus the CLI's
  state/cache dirs and `~/.bun`) is writable; `inputtracker.config.toml` is masked with
  `/dev/null`. Tested for Antigravity. Commands in WORKERS.md.
- Antigravity: default headless mode (`--mode auto` is not available on your account; default
  mode already ran `bun test` without prompts). `--sandbox` is not used (wrong behaviour in test).
- opencode: `--auto --standalone` inside the same jail (jail untested yet; M01 checks it). Fallback
  if the jail breaks opencode: unjailed with project `opencode.json` denying `git push`,
  `git commit`, `rm -rf` and the config file — logged in the morning report.
- Inside the jail git metadata of the main repo is read-only, so workers can't commit — intended.
- Integration against your real ABS is run by the manager only, with output redacted.

## MORNING_REPORT.md format

```
# Morning report – <date>
## Done          | task | worker | model | attempts | commit |
## Failed / sent back
## BLOCKED       | task | reason |
## Limit pauses  | worker | model | hit at | recovered at | message |
## Decisions needed
```
