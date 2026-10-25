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

## Quick path (scripted)

What was run for the first VM (`input-tracker`, x86_64, Ubuntu 24.04). Repeat it for
the next server by changing `VM` and `VM_URL`. The detailed sections below explain
each step and the rollback.

```sh
VM=input-tracker                                  # ssh alias (user ubuntu)
VM_URL=https://<vm-name>.<your-tailnet>.ts.net  # its Tailscale name
ABS_URL=http://<pc-name>.<your-tailnet>.ts.net:13378  # where ABS runs

# 1. VM packages and Bun (same version as the PC; Bun has x86_64 and arm64 builds)
BUNV=$(bun --version)
ssh $VM "sudo apt-get update -qq && sudo apt-get install -y -qq unzip sqlite3 rsync &&
  curl -fsSL https://bun.sh/install | bash -s bun-v$BUNV && sudo loginctl enable-linger \$USER"
# Join the tailnet first (sudo tailscale up --hostname=<name>) so $VM_URL resolves.

# 2. Stop every writer on the PC, then take a checked snapshot
systemctl --user stop inputtracker.service 'inputtracker-sync@*' 'inputtracker-backup*' 'inputtracker-weekly*'
D=~/.cache/inputtracker-vm; mkdir -p $D && chmod 700 $D
sqlite3 ~/.local/share/inputtracker/inputtracker.db ".backup '$D/final.db'"
bun run it verify-copy $D/final.db                # must end "copy OK"

# 3. Server config (never printed, never in git) and data
scripts/split-config.py vm inputtracker.config.toml $D/vm.config.toml --vm-url $VM_URL --abs-url $ABS_URL
ssh $VM 'systemctl --user stop inputtracker.service 2>/dev/null; mkdir -p ~/inputtracker ~/.local/share/inputtracker;
  rm -f ~/.local/share/inputtracker/inputtracker.db-wal ~/.local/share/inputtracker/inputtracker.db-shm'
rsync -a $D/vm.config.toml $VM:inputtracker/inputtracker.config.toml
rsync -a $D/final.db $VM:.local/share/inputtracker/inputtracker.db
(cd ~/.local/share/inputtracker && rsync -a secrets covers metadata-cache posters thumbs $VM:.local/share/inputtracker/)
ssh $VM 'chmod 600 ~/inputtracker/inputtracker.config.toml ~/.local/share/inputtracker/inputtracker.db;
  chmod 700 ~/.local/share/inputtracker/secrets'

# 4. Code: committed HEAD + web build from the PC (the VM never builds)
scripts/deploy-vm.sh $VM                          # also the update command later

# 5. Move the URL and switch the PC to pushing ActivityWatch
tailscale serve reset
ssh $VM 'sudo tailscale serve --bg 8787'
scripts/split-config.py pc inputtracker.config.toml --vm-url $VM_URL
scripts/install.sh --role pc --no-build
```

Then on the phone: set the InputTracker URL in the Second Brain app to `$VM_URL` and
re-add the PWA from `$VM_URL`. The ingest token is unchanged.

Updates later: commit on the PC, then `scripts/deploy-vm.sh input-tracker`.

After the split, the VM owns the archive. The PC pushes ActivityWatch using a
small cursor file and leaves its old database untouched as a cold backup.
ActivityWatch stays at `127.0.0.1:5600`: never expose it through Tailscale,
Tailscale Serve, a reverse proxy or the firewall.

## 1. Before: prepare the VM

1. Join the tailnet: install Tailscale, run `tailscale up`, and confirm the VM is
   listed with `tailscale status`.
2. Install git and Bun. Bun ships a `linux-arm64` build, so the normal installer
   works: `curl -fsSL https://bun.sh/install | bash`.
3. Clone the repository, install dependencies, and run the environment check on the VM:

   ```sh
   git clone <your-repo-url> inputtracker
    cd inputtracker
    bun install --frozen-lockfile
   bun run it doctor
   ```

   Until the config is copied (step 4) `doctor` runs on the built-in defaults:
   `config` shows `audiobookshelf token: empty` and `db` says "will be created".
   That is expected; there should be no `FAIL` line.

## 2. Stop writes on the PC

```sh
systemctl --user stop inputtracker-sync@audiobookshelf.timer inputtracker-sync@simkl.timer inputtracker-sync@activitywatch.timer inputtracker-backup.timer inputtracker-weekly.timer inputtracker.service
systemctl --user stop inputtracker-sync@audiobookshelf.service inputtracker-sync@simkl.service inputtracker-sync@activitywatch.service inputtracker-backup.service inputtracker-weekly.service
```

Skip unit names that have never been installed. If a push timer/service already
exists, stop both too. Wait for active oneshots to exit: stopping a timer alone
does not stop an active service.

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
chmod 600 <db-dir>/secrets/simkl-token.json <config-path> <db_path>
sha256sum <db_path>
```

The two `sha256sum` outputs must match.
Create the destination directories first and copy `secrets/` only if it exists.
Optional `metadata/` and `covers/` directories beside the database may also be
copied to keep cached metadata and artwork available immediately.

## 5. Configure on the VM

Edit `inputtracker.config.toml`:

- `audiobookshelf.url` → `http://<pc-name>.<your-tailnet>.ts.net:13378`. ABS on
  the PC must be reachable on the tailnet interface; test it from the VM:

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' http://<pc-name>.<your-tailnet>.ts.net:13378/ping
  ```

- `storage.*` paths if they differ from the PC.
- `server.bind` / `server.port` as needed.
- Keep `server.bind = "127.0.0.1"` when using Tailscale Serve below.
- Run `bun run it ingest token` locally to generate a fresh random shared
  token. Paste it privately into the VM's `[ingest] token` and the PC's
  `[push] token`. Keep it out of logs, command arguments, screenshots and git;
  never reuse an Audiobookshelf or Simkl token.
- Set `[activitywatch] mode = "push"`; leave `[push]` empty on the VM.
  The VM will skip ActivityWatch even for a manual sync request.
- Keep `timezone`, `youtube.min_watch_minutes` and music policy aligned on
  both machines so per-day totals and filtering agree.

## 6. Install on the VM

```sh
scripts/install.sh --role server
loginctl enable-linger <user>
bun run it doctor
bun run it sync audiobookshelf
bun run it sync simkl
```

`doctor` should now be all `OK`. A `port` WARN is fine once
`inputtracker.service` is running (the port is in use by this app).
The installer disables existing ActivityWatch pull/push timers on the VM.
`bun run it ingest status` must report enabled; `bun run it sync activitywatch`
must report that local pull was skipped.

Opening the VM archive applies migration 14 (`work_identity_aliases`): immutable
work aliases plus nullable `annotations.work_key`, preserving existing rows.
The manager must coordinate this version with other branches before deployment.
With SQLite CLI installed, verify the configured VM database read-only:

```sh
sqlite3 -readonly <db_path> "SELECT version FROM schema_migrations WHERE version = 14;"
sqlite3 -readonly <db_path> "PRAGMA integrity_check;"
sqlite3 -readonly <db_path> "SELECT COUNT(*) FROM events_latest;"
```

Expect `14`, `ok`, and the migrated event count. On a synthetic test work, link
and refresh metadata, then verify category/rating/note/topic and hidden state
remain intact and the former work URL still resolves. No pre-existing lost
identities are reconstructed automatically.

## 7. Move the URL

```sh
# on the PC
tailscale serve reset
# on the VM
tailscale serve --bg <port>
```

Open `https://<vm-name>.<your-tailnet>.ts.net/` on the phone and re-install the
PWA so it points at the VM.

## 8. Configure and enable the PC push

On the PC, retain its old `storage.db_path` (only the directory is used by
push), keep ActivityWatch local, and merge these keys into existing TOML
sections (do not duplicate sections):

```toml
[activitywatch]
mode = "push"
url = "http://127.0.0.1:5600"
device = "pc"
include_music = false

[push]
server_url = "https://<vm-name>.<your-tailnet>.ts.net"
token = "<same-random-ingest-token>"
```

Keep filtering/timezone policy aligned with the VM, restrict the config with
`chmod 600`, and configure `[notify]` on the PC for failure/recovery alerts.
If the config is outside the checkout, set `INPUTTRACKER_CONFIG` in the
systemd user environment before starting units (`systemctl --user
set-environment INPUTTRACKER_CONFIG=<config-path>`), and persist that
environment across logins on both machines.

```sh
scripts/install.sh --role pc
loginctl enable-linger <user>
bun run it push activitywatch
systemctl --user status inputtracker-push@activitywatch.timer
systemctl --user list-timers
journalctl --user -u inputtracker-push@activitywatch.service -n 30
```

The PC installer disables its old server/pull/backup/weekly timers and installs
only the push units (no web build). The first push reads the last seven days.
Later pushes overlap the cursor's whole local day to preserve complete totals.
State is `<directory of storage.db_path>/activitywatch-push-state.json`, mode
0600, with an exclusive `.lock`. Do not delete it during normal updates.
Only acknowledged buckets advance; failed chunks retry safely, including
chunks stored by the VM whose responses were lost.

On the VM, check push ingest runs in Settings and today's YouTube/music totals.
`journalctl --user -u inputtracker.service -n 30` checks server health.
Insertion is acknowledged before server-only enrichment/cover lookup finishes.
A repeat without new activity should insert zero rows. During VM outages the
PC keeps its cursor and retries every 10 minutes, sending one failure alert and
one recovery. ActivityWatch must retain source events throughout the outage;
never clear its buckets while history remains unconfirmed.

On the VM, this read-only query shows confirmed batches (including retries):

```sh
sqlite3 -readonly <db_path> "SELECT id, status, rows_seen, rows_inserted FROM ingest_runs WHERE source = 'activitywatch' AND kind = 'push' ORDER BY id DESC LIMIT 10;"
```

For outage verification, briefly stop the VM's `inputtracker.service`, run
`bun run it push activitywatch` on the PC twice, then restart the VM and push
again. Expect failure on both offline runs, one failure alert, then a recovery
alert and successful insertion/retry. New PC activity must remain in ActivityWatch.
An abandoned `.lock` whose PID no longer exists is recovered automatically. If
its PID was reused by an unrelated process, stop the push timer, confirm no push
process is running, and remove only that `.lock`; retain the JSON state file.

Keep the old PC database as a cold backup: push never opens it.

## 9. Roll back

To move back, stop PC pushes first, stop VM writers, take a final VM snapshot,
then restore it before enabling the PC's local units:

```sh
# on the PC
systemctl --user disable --now inputtracker-push@activitywatch.timer
systemctl --user stop inputtracker-push@activitywatch.service
# on the VM
systemctl --user disable --now inputtracker.service inputtracker-sync@audiobookshelf.timer inputtracker-sync@simkl.timer inputtracker-backup.timer inputtracker-weekly.timer
systemctl --user stop inputtracker-sync@audiobookshelf.service inputtracker-sync@simkl.service inputtracker-backup.service inputtracker-weekly.service
bun run it backup
tailscale serve reset
# copy and verify the final snapshot/secrets/caches over the tailnet; on the PC:
# after restoring the final VM snapshot and setting activitywatch.mode = "pull":
scripts/install.sh --role local
tailscale serve --bg <port>
```

Before enabling local units, stop all active writers and copy a final VM `.db`
snapshot and adjacent `secrets/`, metadata and cover caches back to the PC.
Preserve the original PC snapshot separately. This includes edits, aliases,
phone plays and pushed history: source retention may not cover the whole split
period, so do not assume the cold PC database can catch up by syncing alone.
Clear PC `[push]` settings and change `activitywatch.mode` to `pull`.
Never replace a database while its process or old WAL/SHM files are active;
preserve the old database and its sidecars separately before restoring the snapshot.
Native JSON export/import also carries overrides and aliases, but a full
SQLite snapshot is the preferred migration/rollback path.

## Notes

- The PC being off is normal: ABS syncs then fail as logged, retried runs, and
  succeed again once the PC is back on the tailnet.
- `it verify-copy` compares the configured database with a copy by record hash,
  so it can be re-run any time to prove nothing was lost.
