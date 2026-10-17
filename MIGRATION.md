# Moving InputTracker from the PC to a VM

This moves the running instance from the current PC to an Oracle Cloud Ampere
(ARM64) VM on the same Tailscale tailnet. Audiobookshelf (ABS) stays on the PC
and is reached over the tailnet. Nothing is rewritten: the PC keeps its database
as a cold backup and can be brought back with the rollback steps at the end.

Placeholders to replace before running anything:

- `<pc-name>.<your-tailnet>.ts.net` — the PC's Tailscale name,
- `<vm-name>.<your-tailnet>.ts.net` — the VM's Tailscale name,
- `<user>` — your login name on both machines,
- `<port>` — the value of `server.port` (default `8787`),
- `<snapshot>` — the backup file name, e.g. `inputtracker-2026-10-17.db`.

Write access on the PC happens only through `it sync` (the two sync timers) and
the server. `it doctor` is read-only and `it backup` only reads the database.

## 1. Before: prepare the VM

1. Join the tailnet: install Tailscale, run `tailscale up`, and confirm the VM is
   listed with `tailscale status`.
2. Install git and Bun. Bun ships a `linux-arm64` build, so the normal installer
   works: `curl -fsSL https://bun.sh/install | bash`.
3. Clone the repository and run the environment check on the VM:

   ```sh
   git clone <your-repo-url> inputtracker
   cd inputtracker
   bun run it doctor
   ```

   Until the config is copied (step 4) `doctor` runs on the built-in defaults:
   `config` shows `audiobookshelf token: empty` and `db` says "will be created".
   That is expected; there should be no `FAIL` line.

## 2. Stop writes on the PC

```sh
systemctl --user stop inputtracker-sync@audiobookshelf.timer inputtracker-sync@simkl.timer inputtracker-backup.timer inputtracker.service
```

## 3. Snapshot and check on the PC

```sh
bun run it backup
```

This writes `inputtracker-YYYY-MM-DD.db` and `inputtracker-YYYY-MM-DD.json` into
`storage.backup_dir` (the `.db` is a `VACUUM INTO` snapshot). Point the check at
that snapshot and confirm every event is present:

```sh
bun run it verify-copy <backup_dir>/inputtracker-YYYY-MM-DD.db
```

The last line must read `copy OK: every event present`. That snapshot is the
`<snapshot>` copied in the next step.

## 4. Copy over Tailscale (never via git)

`scp` the snapshot to the VM's `storage.db_path`, then the `secrets/` directory
that sits next to the database (it holds the Simkl token) and the config file.
Both the database and the config contain personal data and secrets, so never put
them in git.

```sh
# on the PC
scp <snapshot> <user>@<vm-name>.<your-tailnet>.ts.net:<db_path>
scp -r <db-dir>/secrets <user>@<vm-name>.<your-tailnet>.ts.net:<db-dir>/secrets
scp inputtracker.config.toml <user>@<vm-name>.<your-tailnet>.ts.net:<config-path>
sha256sum <snapshot>
```

Then, on the VM, restrict the permissions and compare the checksums:

```sh
chmod 700 <db-dir>/secrets
chmod 600 <db-dir>/secrets/simkl-token.json inputtracker.config.toml
sha256sum <snapshot>
```

The two `sha256sum` outputs must match.

## 5. Configure on the VM

Edit `inputtracker.config.toml`:

- `audiobookshelf.url` → `http://<pc-name>.<your-tailnet>.ts.net:13378`. ABS on
  the PC must be reachable on the tailnet interface; test it from the VM:

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' http://<pc-name>.<your-tailnet>.ts.net:13378/ping
  ```

- `storage.*` paths if they differ from the PC.
- `server.bind` / `server.port` as needed.

## 6. Install on the VM

```sh
scripts/install.sh
loginctl enable-linger <user>
bun run it doctor
bun run it sync audiobookshelf
bun run it sync simkl
```

`doctor` should now be all `OK`. A `port` WARN is fine once
`inputtracker.service` is running (the port is in use by this app).

## 7. Move the URL

```sh
# on the PC
tailscale serve reset
# on the VM
tailscale serve --bg <port>
```

Open `https://<vm-name>.<your-tailnet>.ts.net/` on the phone and re-install the
PWA so it points at the VM.

## 8. Disable the PC units

```sh
systemctl --user disable --now inputtracker.service inputtracker-sync@audiobookshelf.timer inputtracker-sync@simkl.timer inputtracker-backup.timer
```

Keep the old database on the PC as a cold backup: it is the rollback source.

## 9. Roll back

To move back to the PC, stop the VM, then re-enable the PC's units and serve the
URL from the PC again:

```sh
# on the VM
systemctl --user disable --now inputtracker.service inputtracker-sync@audiobookshelf.timer inputtracker-sync@simkl.timer inputtracker-backup.timer
tailscale serve reset
# on the PC
systemctl --user enable --now inputtracker.service inputtracker-sync@audiobookshelf.timer inputtracker-sync@simkl.timer inputtracker-backup.timer
tailscale serve --bg <port>
```

Syncs re-fetch from ABS and Simkl, so the PC catches up on its own; only manual
entries and YouTube imports made on the VM in between have to be redone (or
moved with `it export` on the VM and `it import` on the PC).

## Notes

- The PC being off is normal: ABS syncs then fail as logged, retried runs, and
  succeed again once the PC is back on the tailnet.
- `it verify-copy` compares the configured database with a copy by record hash,
  so it can be re-run any time to prove nothing was lost.
