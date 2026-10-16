# Setup checklist

✅ = already done/verified on this PC. **First build** = needed before the overnight v1 run.
**Later** = only needed for Simkl/YouTube or optional features.

## Already in place (checked 2026-10-17)

- ✅ bun 1.4.2, node 26, git 2.55, gh 2.102 (logged in as `pinacule`), tmux 3.7c, sqlite3, jq, yt-dlp, uv/python
- ✅ Antigravity CLI 1.4.0 signed in, `gemini-3.8-flash-high` available, quota 100%
- ✅ opencode 2.0.31, free models working
- ✅ Tailscale up; phone `motorola-edge-40-pro` is on the tailnet with this PC (`pinpc`)
- ✅ Private repo created: https://github.com/pinacule/inputtracker
- ✅ gitleaks 8.30.1 installed globally via mise (used by the pre-push hook)
- ✅ adb present (not needed for the PWA route)

## First build — you do these

- [x] **Audiobookshelf**: `http://localhost:13378`, API key in gitignored `inputtracker.config.toml`
  (mode 600). Verified 2026-10-17 with one GET → HTTP 200, 302 sessions.
- [x] **Worker permissions**: Antigravity autonomous but limited to the project folder
  (enforced with bubblewrap; `--mode auto` isn't available on your account, default headless
  mode works). opencode: free models only, no Nebius.
- [x] **Phone**: `tailscale serve` running, https://pinpc.taild61ed4.ts.net/ → port 8787.
- [ ] **Accept/reject extra features** F1–F15 in PLAN.md (v1 builds none of them).
- [ ] **Keep the PC awake overnight** (no suspend) and stay logged in so tmux + workers keep running.

## Later — Simkl (after v1)

- [ ] Simkl account linked to Stremio via SyncriBullet (you have this).
- [ ] Create a Simkl app: https://simkl.com/settings/developer/ → **Client ID** (and secret).
      Redirect URI can be `urn:ietf:wg:oauth:2.0:oob`.
- [ ] Authorize once with the PIN flow (the app will print a code to enter at simkl.com/pin) →
      access token saved to `inputtracker.config.toml`.

## Later — YouTube

- [ ] Google Takeout: select only **YouTube → history**, format **JSON** →
      `watch-history.json`, upload it in the Import page.
- [ ] For yt-dlp `:ythistory` polling: browser cookies for YouTube.
      Either `--cookies-from-browser chromium` (you're logged into YouTube in Chromium) or an
      exported `cookies.txt` stored outside the repo; path goes in the config file.
      Note: this uses your Google login session; Google can rate-limit or flag it.

## Not needed (with the PWA plan)

- Java, Android SDK/Studio, Flutter, Gradle. Only needed if you later want a native/TWA APK.
- Any public hosting or domain.
