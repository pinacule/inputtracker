# InputTracker for Android

A dedicated Android app for InputTracker: a thin native shell (one Kotlin
activity, framework WebView, no third-party libraries) around the
self-hosted InputTracker web app. The server — Bun, SQLite, the
Audiobookshelf/Simkl syncs — still runs on the server machine; this app is
the PWA's permanent home on the phone, with its own launcher icon and the
native behaviours a home-screen PWA install gets wrong.

## What it does

- Opens straight into InputTracker, fullscreen under a slim native bar
  showing the connected server.
- **Server URL is a setting, not a constant** (toolbar ⋮ → *Server URL…*).
  Default: `https://input-tracker.taild61ed4.ts.net` (the Oracle VM via
  Tailscale Serve). Moving the server never needs a rebuild — the address
  is stored in the app's preferences, not the APK.
- **File upload works**: the Import page's file picker (YouTube Takeout,
  JSON import) opens the Android document chooser, single or multiple files.
- **Exports download properly**: `/api/export.json` and `/api/export.csv`
  go through the system DownloadManager (with the WebView's cookies) into
  the phone's Downloads folder.
- Links to any other host (e.g. the Simkl sign-in page) open in the
  browser; the server's own pages stay in the app. The Android back button
  walks the app's history instead of leaving the app.
- The PWA's offline cache keeps working (DOM storage + service workers are
  enabled), subject to the note below.

## Requirements and limits

- **Tailscale must be connected.** The server is tailnet-only, exactly as
  with the PWA. With Tailscale off, the app shows a "could not reach"
  screen with Retry and Change-server-URL actions.
- **The offline cache starts empty.** The WebView has its own storage,
  separate from Chrome's: pages are cached the first time you open them
  in the app while online.
- Android 8.0 (API 26) or newer.
- Plain-HTTP server URLs are allowed (`usesCleartextTraffic`) because a
  tailnet/LAN address never leaves the private network — on Tailscale the
  traffic is WireGuard-encrypted either way. Prefer the HTTPS Tailscale
  Serve address.

## Signing

**CI builds the debug variant** (decided 2026-10-22). Gradle signs it
automatically with the runner's debug key, so the pipeline needs no
secrets at all. Know the tradeoff: every GitHub Actions runner generates
a **fresh debug key**, so each CI build has a different signature and
Android refuses to install it over the previous CI build — uninstall the
old copy first, losing its settings (e.g. a changed server URL). The
debug package id is `dev.pinacule.inputtracker.debug`, so a CI build
coexists with a release install instead of fighting it.

**Release builds** are signed with a dedicated release keystore created
for this app, so every release APK updates in place. The keystore itself
is **never committed**. A release CI pipeline would receive it through
four repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of the `.p12` keystore file |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias (`inputtracker`) |
| `ANDROID_KEY_PASSWORD` | key password |

`app/build.gradle.kts` reads the same four values as environment variables
(`KEYSTORE_PATH`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`), so a
local release build — or a future release CI pipeline — signs identically
every time. Without them, `assembleRelease` produces an unsigned APK — a
loud failure at install time, never a silently wrong signature. To return
CI to release builds: add the four secrets, restore the keystore-decode
step in `.github/workflows/android-apk.yml`, and switch `assembleDebug`
back to `assembleRelease`.

**Keep the keystore file and its password in a password manager.** If they
are lost, no future APK can ever update an installed copy; the app would
have to be uninstalled and reinstalled under a new identity.

## Building

CI: push to `muse/android-apk` (touching `android/**`) or run the
*Android APK* workflow manually; the debug APK is the run's artifact.

Local (JDK 21 + Android SDK platform 35 / build-tools 35 on PATH):

```sh
cd android
export KEYSTORE_PATH=/path/to/inputtracker-release.p12
export KEYSTORE_PASSWORD=… KEY_ALIAS=inputtracker KEY_PASSWORD=…
./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

Bump `versionCode` (and `versionName`) in `app/build.gradle.kts` for each
release you hand out.

## Layout

```
android/
  settings.gradle.kts, build.gradle.kts, gradle.properties
  app/
    build.gradle.kts            signing-from-env lives here
    src/main/
      AndroidManifest.xml
      java/dev/pinacule/inputtracker/MainActivity.kt   the whole app
      res/…                     icon (from web/public), theme, layout, menu
```
