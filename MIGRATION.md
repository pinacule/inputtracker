# Moving InputTracker from the PC to a VM

For later (Oracle Cloud Ampere VM on your tailnet). Nothing here is set up yet.

## On the VM

1. Join the tailnet: install Tailscale, `tailscale up`.
2. Install git and Bun (Bun has a linux-arm64 build): `curl -fsSL https://bun.sh/install | bash`.
3. `git clone https://github.com/pinacule/inputtracker.git && cd inputtracker && bun install && bun run build:web`

## Move data and config (PC → VM)

1. On the PC, stop writes: `systemctl --user stop inputtracker.service 'inputtracker-sync-*.timer'`
2. Take a consistent copy (safe even with WAL):
   ```bash
   bun run it backup --now        # writes a snapshot into backup_dir
   ```
   or `sqlite3 ~/.local/share/inputtracker/inputtracker.db "VACUUM INTO '/tmp/it.db'"`.
3. Copy the snapshot and the config over Tailscale (both contain personal data/secrets — never via git):
   ```bash
   scp /tmp/it.db vm:~/.local/share/inputtracker/inputtracker.db
   scp inputtracker.config.toml vm:~/inputtracker/inputtracker.config.toml
   ```
4. Edit the config on the VM:
   - `audiobookshelf.url` → the PC's Tailscale address, e.g. `http://pinpc.taild61ed4.ts.net:13378`
     (ABS must listen on the tailnet interface, not only localhost).
   - `server.bind` / `port` as needed; `storage.*` paths if different.
5. Install the same units: `scripts/install.sh` (no PC-specific paths), then
   `tailscale serve --bg 8787` on the VM.
6. Check: `bun run it sync audiobookshelf` (works when the PC is on; a failed run is logged and retried
   when it's off), open the VM's `https://<vm>.<tailnet>.ts.net/` on the phone and re-install the PWA.
7. On the PC: leave the old DB as a cold backup; disable its server and timers. If yt-dlp polling
   stays on the PC, configure its sink to the VM's ingest URL (feature to be built later).

## Verify nothing was lost

`bun run it export --format json` on both machines → same `record_hash` set
(`jq -r '.events[].record_hash' | sort | sha256sum`).
