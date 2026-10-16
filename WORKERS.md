# Workers

Verified on this PC on 2026-10-17 against real `--help` output and live test runs.

| Worker | Binary | Version | Auth state |
|---|---|---|---|
| Antigravity CLI | `antigravity` (alias `agy`, via mise shim) | 1.4.0 | signed in, Gemini quota 100% |
| opencode | `opencode` | v2.0.31 | OpenCode Zen free models + Nebius (paid, API key stored) |

Both workers run **in the task's git worktree** (`cd` into it first). Neither may push,
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

### Headless command (tested)

```bash
cd ../inputtracker-wt/T07
timeout 50m antigravity -p "$(cat .task/prompt.md)" \
  --model gemini-3.8-flash-high \
  --mode accept-edits \
  --output-format json \
  --print-timeout 45m \
  > .task/agy.json 2> .task/agy.err
echo $? > .task/exit
```

- Prompt: `-p "<text>"` (`--print`). Long prompts: write to a file and pass `"$(cat file)"`.
- Working dir: the current directory is the workspace (`--add-dir` adds more).
- `--mode accept-edits`: tested — it created files and ran `ls` with no prompt.
  Not yet tested: whether it runs `bun install` / `bun test` without approval. First
  overnight task verifies this; fallback is `--mode auto`.
- `--dangerously-skip-permissions` was **blocked** by Claude Code's auto-mode safety
  classifier when I tried it. Don't plan on it.
- `--sandbox` is available if we want terminal restrictions.

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
opencode/big-pickle
```

Paid (Nebius API key is stored, **costs money**): e.g. `nebius/moonshotai/Kimi-K2.7-Code`,
`nebius/zai-org/GLM-5.3`, `nebius/deepseek-ai/DeepSeek-V4-Pro`, `nebius/Qwen/Qwen3.5-397B-A17B`,
`nebius/MiniMaxAI/MiniMax-M3`, `nebius/moonshotai/Kimi-K3` and others.
Local: `ollama/qwen2.5:3b` (too small for coding).

Plan: start on `opencode/deepseek-v4.1-flash-free`, fall back to `opencode/glm-5.3-flash-free`,
then `opencode/nemotron-3-ultra-free`. Nebius only if you approve paid use (see SETUP.md).
Every run's model is logged in `MORNING_REPORT.md`.

### Headless command (tested)

```bash
cd ../inputtracker-wt/T05
timeout 45m opencode run \
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
