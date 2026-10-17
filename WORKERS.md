# Workers

Verified on this PC on 2026-10-17 against real `--help` output and live test runs.

| Worker | Binary | Version | Auth state |
|---|---|---|---|
| Antigravity CLI | `antigravity` (alias `agy`, via mise shim) | 1.4.0 | signed in, Gemini quota 100% |
| opencode | `opencode` | v2.0.31 | OpenCode Zen free models (Nebius paid models exist but are not allowed) |

Both workers run **in the task's git worktree** `.worktrees/<task>` inside the project, jailed with bubblewrap so they can only write there. Neither may push,
touch `main`, or read `inputtracker.config.toml` (secrets). The manager runs the final
checks, merges and pushes.

---

## Antigravity

### Model

`antigravity models` (live output):

```
gemini-3.8-flash-high     Gemini 3.8 Flash (High)    <- use this
gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low      Gemini 3.8 Flash (Low)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
```

The thinking level is baked into the model ID: `--model gemini-3.8-flash-high`.
(`--effort` exists too, but is not needed with the `-high` ID.) Note: no Gemini Pro
is offered on this account right now, so Flash High is the most capable Gemini model.

### Headless command (tested), jailed to the task worktree

```bash
WT=~/Projects/inputtracker/.worktrees/T07
cd "$WT"
timeout 50m bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
  --bind "$WT" "$WT" \
  --bind ~/.gemini ~/.gemini --bind ~/.cache ~/.cache --bind ~/.bun ~/.bun \
  --ro-bind /dev/null ~/Projects/inputtracker/inputtracker.config.toml \
  --die-with-parent --chdir "$WT" \
  antigravity -p "$(cat .task/prompt.md)" \
    --model gemini-3.8-flash-high \
    --output-format json \
    --print-timeout 45m \
  > .task/agy.json 2> .task/agy.err
echo $? > .task/exit
```

- Prompt: `-p "<text>"` (`--print`). Long prompts: write to a file and pass `"$(cat file)"`.
- Working dir: the current directory is the workspace (`--add-dir` adds more).
- **Folder limit = bubblewrap** (tested 2026-10-17): the whole filesystem is read-only except
  the worktree and the CLI's own state/cache dirs; writing to `~/` failed with
  "Read-only file system", writing in the worktree and `bun --version` worked.
  The real config file is masked with `/dev/null`, so the worker can't read your token.
  Network stays on (the model API needs it).
- **Mode**: you allowed `--mode auto`, but the CLI says *"--mode auto is not available for this
  account; continuing in the default mode."* In default headless mode it still ran
  `bun test` and shell commands with no prompt (tested), so no mode flag is needed.
- `--sandbox` is **not** usable: in the test it blocked writes in the working dir and allowed
  a write to the parent dir — the opposite of what we need.
- `--dangerously-skip-permissions` was blocked by Claude Code's safety classifier. Not used.

### Output and finish signals

stdout (with `--output-format json`) is one JSON object when the run ends:

```json
{"conversation_id":"…","status":"SUCCESS","response":"…","duration_seconds":9.1,
 "num_turns":1,"usage":{"input_tokens":27036,"output_tokens":1105,…}}
```

| Situation | How to tell |
|---|---|
| Finished OK | exit `0`, `status":"SUCCESS"` |
| Usage error | exit `2` |
| Other CLI error (bad agent/schema) | exit `1` |
| Model/agent error **incl. quota/rate limit** | exit `3`, stderr has a line `AGY_ERROR: {...}` (canonical status, HTTP/gRPC code, retryable flag) |
| Credits/plan exhausted | message "Your AI credits balance is too low to continue." |
| Stuck | outer `timeout 50m` fires (exit `124`) or `--print-timeout` hits |

Rate limits: the CLI itself retries short per-minute 429s; it **stops immediately** when the
server's retry delay is >30 s or the cap is daily/weekly. So exit 3 + `AGY_ERROR` with
429 / `RESOURCE_EXHAUSTED` / "quota" = **limit**, not task failure.

### Quota check (tested, costs nothing)

```bash
antigravity -p "/usage" --output-format json | jq '.command.data.groups[] | select(.name=="Gemini Models") | .buckets[] | {name, remaining_fraction, reset_time}'
```

Gives a 5-hour bucket and a weekly bucket, each with `remaining_fraction` and a UTC
`reset_time`. When limited: sleep until `reset_time` instead of blind polling.

### Liveness probe (tested, ~7 s)

```bash
antigravity -p "Reply with exactly: PONG" --model gemini-3.8-flash-high --output-format json --print-timeout 2m | jq -r .status
```

Logs: `~/.gemini/antigravity-cli/cli.log` (override with `--log-file`).

---

## opencode

### Models available now (`opencode models`, 34 total)

Free (OpenCode Zen, no cost):

```
opencode/deepseek-v4.1-flash-free
opencode/glm-5.3-flash-free          <- tested, works
opencode/nemotron-3-ultra-free
opencode/nemotron-3.5-lightning-free
opencode/nemotron-3.5-super-vl-free
opencode/mimo-v2.6-flash-free
opencode/longcat-2.5-preview-free
opencode/space-bunny-free
opencode/beam-free
```

`opencode/big-pickle` is listed too but not labelled Free, so it is not used.

Paid Nebius models (`nebius/*`) are also listed — **not allowed** (your decision 2026-10-17:
free models only). Local `ollama/qwen2.5:3b` is too small for coding.

Plan: start on `opencode/deepseek-v4.1-flash-free`, fall back to `opencode/glm-5.3-flash-free`,
then the other free ones in the order of `OPENCODE_MODELS` in `scripts/lib.sh` (all nine Free models).
Every run's model is logged in `MORNING_REPORT.md`.

### Headless command (tested inside the jail, 2026-10-17)

Same bubblewrap jail as Antigravity, with opencode's state dirs writable and `--standalone`
so tools run inside the jail instead of in the background service (which lives outside it).
Tested: created a file in the worktree and finished with `step_finish`, exit 0.
In practice the scripts do this: `scripts/run-worker.sh <task> <worker> <model> <prompt-file> [session]`.

```bash
WT=~/Projects/inputtracker/.worktrees/T05
cd "$WT"
timeout 45m bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
  --bind "$WT" "$WT" \
  --bind ~/.local/share/opencode ~/.local/share/opencode \
  --bind ~/.local/state/opencode ~/.local/state/opencode \
  --bind ~/.cache ~/.cache --bind ~/.bun ~/.bun \
  --ro-bind /dev/null ~/Projects/inputtracker/inputtracker.config.toml \
  --die-with-parent --chdir "$WT" \
opencode run --standalone \
  --model opencode/deepseek-v4.1-flash-free \
  --auto \
  --format json \
  --title "T05" \
  "$(cat .task/prompt.md)" \
  > .task/oc.jsonl 2> .task/oc.err
echo $? > .task/exit
```

- Prompt: positional message. `--file/-f` attaches files. Model: `--model provider/model[#variant]`.
- `--auto` auto-approves permissions not explicitly denied (tested: wrote a file headless).
- Runs in the current directory.
- `--session <id>` / `--continue` resumes a session (used for the "send back once" retry).

### Output and finish signals

stdout with `--format json` is **JSON Lines**, one event per line:
`step_start`, `text` (`.part.text`), `tool_use`, `step_finish`, `error`.

| Situation | How to tell |
|---|---|
| Finished OK | exit `0`, last lines include `step_finish` |
| Error | exit `1`, a line `{"type":"error","error":{"type":"…","message":"…"}}` (tested with a bad model: `provider.no-route`) |
| Rate/quota limit | `error` event whose type/message matches `429`, `rate`, `quota`, `limit`, `exhausted` |
| Stuck | no new line in `oc.jsonl` for 10 min, or outer `timeout` exit `124` |

The exact error text for a free-tier rate limit is **not yet observed**; the wrapper
classifies by the keywords above and logs the raw message so we can tighten it.

### Liveness probe (tested, ~4 s)

```bash
opencode run --model opencode/glm-5.3-flash-free --format json "Reply with exactly: PONG" | jq -r 'select(.type=="text").part.text'
```

Usage stats: `opencode stats`.
