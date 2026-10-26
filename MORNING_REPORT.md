# Morning report — skins night 2026-10-26

Goal: three new skins next to Dot (Night City, Rewind, Thinker), selectable in Settings, Dot stays
the default. Previous report (2026-10-17 overnight build): `docs/reports/2026-10-17-overnight.md`.

## Summary

**Paused 2026-10-26 ~01:15: the manager (Claude) hit its usage limit after setup.** No worker has
started yet and no skin code exists. Done: uncommitted WIP committed (128196e), all three workers
tested jailed, Codex added to the scripts and WORKERS.md, review tool `scripts/shots.ts`, Dot
baseline (`.orchestrator/dot-baseline.json`), task list in TASKS.md (847ff23).
Next on restart: write `.task/prompt.md` for S0 (Codex), NC-a (Codex) and RW-a (opencode), create
their worktrees from main, run them in parallel, then TH-a on opencode.

## Workers (step 0, tested 2026-10-26 00:40–01:10)

| Worker | Command | Test |
|---|---|---|
| Codex CLI 0.164.0 | `codex --search exec -m gpt-6.1-sol -c model_reasoning_effort="high" -s workspace-write -c sandbox_workspace_write.network_access=true …` in `scripts/jail.sh` | jailed: wrote a file, `bun --version`, `curl`, web search, `exec resume <id>` |
| opencode v2.1.4 | `opencode run --standalone --auto --format json --model agentrouter-responses/gpt-6.1-sol#high` in the jail | jailed: wrote a file, `bun --version`, `--session <id>` continue |
| Antigravity 1.4.7 | `antigravity -p … --model gemini-3.8-flash-high --output-format json` in the jail | jailed: wrote a file; quota 5 h 100 %, weekly 99.5 % |

Review tool: `scripts/shots.ts` (headless Chromium over CDP): screenshots per page at 1440 px and
390 px @2x, an animation frame sequence + animated WebP, and two automatic checks: sideways overflow
and controls whose centre is covered by another element (compared with a Dot baseline).

## Skin: Rewind (`rewind`) — DONE

![Home desktop](docs/skins/rewind/calendar-desktop.webp)

| Home (phone) | Insights (phone) | Settings (phone) |
|---|---|---|
| ![](docs/skins/rewind/calendar-phone.webp) | ![](docs/skins/rewind/insights-phone.webp) | ![](docs/skins/rewind/settings-phone.webp) |

Desktop: [Insights](docs/skins/rewind/insights-desktop.webp) · [Settings](docs/skins/rewind/settings-desktop.webp)

**Look chosen: A, blue VCR menu (shown on a CRT).** The worker built all three looks quickly
([side by side](docs/skins/rewind/three-looks-compared.webp): A blue VCR, B black CRT, C warm home
video). I kept A because the blue screen with yellow selection strips is the most instantly
recognisable VHS image; B read at a glance like Dot (black) with a mint accent; C's warm palette
overlaps Thinker's firelight. A keeps B's best parts: static scanlines, an RGB glow on the outside of
the frames and a dark vignette. (The worker had recommended B.)

- **Signature effect — tracking lock:** switching day, week or month makes the changed cards slip in
  2–4 horizontal slices with an RGB fringe for ≤ 240 ms, the wallpaper bands slide, ◀◀/▶▶ streaks
  race through the margins and an OSD plaque flips `TRACKING` → `PLAY ▶`. Data updates immediately
  underneath; clicks are never blocked. [Frames 50 ms apart](docs/skins/rewind/tracking-glitch-frames.webp) ·
  [animation](docs/skins/rewind/tracking-glitch.webp).
- **Always on:** faint full-screen scanlines with a slow rolling bright band, `REC ●` blinking in the
  Home masthead, `PLAY ▶ SP` and a tape counter as decoration; big numbers roll like a mechanical tape
  counter when they appear or change; cards "acquire signal" (a noise band) when they enter.
- **Ambient loops** (now and then, only in free space, max 2 at once / 1 on phone): `TRACKING` OSD
  fading in, a VHS dropout line rolling through empty wallpaper, head-switching noise at the bottom
  edge, rewind streaks, a reel glint, a phosphor afterglow speck.
- **Cursor:** stepped pixel arrow, a pointer with a ▶ notch, a slim I-beam; tiny phosphor beads trail
  behind it in empty gutters (desktop only).
- **Wallpaper:** a wall of old TVs (Unsplash licence, Liana S.), tinted VCR blue; fonts VT323, Share
  Tech Mono, IBM Plex Sans (OFL). Credits: `web/public/wallpapers/rewind/CREDITS.md`.
- **Workers:** brief RW-a opencode (Sol high, 1 send-back for livelier motion); base RW-b Codex
  (opencode was rate-limited before it started) incl. the three-look comparison; animations RW-c
  Codex; Settings tile/tests/docs RW-d started on Codex, cut by Codex's usage limit, finished by
  Antigravity.
- Checks: overflow 0 on all pages at 1440 and 390 px; no control covered beyond Dot's own (the
  phone tab bar over list items); `bun run check` green.

## Done

| task | worker | model | attempts | commit |
|---|---|---|---|---|

## Failed / sent back

## BLOCKED

## AgentRouter restarts

| task | time | what happened | action |
|---|---|---|---|
| TH-b | 03:07 | opencode exited with "different Azure OpenAI resource" (router moved the session; stored items gone) | `run-worker-retry.sh` restarted fresh with the same prompt + "continue from the files on disk"; finished 03:22, not counted as an attempt |
| TH-c | 03:48 | opencode stopped mid-task: `provider.invalid-request` "Upstream rejected the request as invalid" (after a tool-calls step) | continued the same session with "continue where you stopped" (restart 1) |

## Limit pauses

| worker | model | hit at | recovered at | message |
|---|---|---|---|---|
| codex | gpt-6.1-sol high | 2026-10-26 03:42 (NC-c revision, RW-d) | (reset 06:51) | `You've hit your usage limit … try again at 6:51 AM.` RW-d moved to Antigravity with the partial work kept; NC-c revision waits for the reset (same session). Not counted as attempts. |
| opencode | agentrouter-responses/gpt-6.1-sol#high | 2026-10-26 02:20–02:27 (RW-b, 3 retries 90 s apart) | — | `rate_limit_exceeded: … gpt-6.1-sol in eastus2 have exceeded token rate limit` (no reset time given). Probe at 02:42 OK. RW-b moved to Codex before any work was done; not counted as an attempt. |

## Decisions needed
