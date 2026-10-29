/**
 * Read-only settings view (`GET /api/settings`, v2 section 5).
 *
 * Security rules:
 * - Strictly read-only: never modifies the database or filesystem.
 * - Never returns secrets (tokens, API keys, credentials in URLs).
 * - URLs are reduced to `host` only (no scheme, path, query, or userinfo).
 */

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  isIngestEnabled,
  redactString,
  type Config,
} from "../core/config.ts";
import type {
  MetaProvider,
  SettingsView,
  SourceStatus,
} from "../core/contract.ts";
import type { IngestRunStatus } from "../core/schema.ts";
import { APP_VERSION } from "../core/version.ts";
import { BACKUP_FILE_RE } from "../io/backup.ts";
import { countEvents } from "../io/export-json.ts";
import {
  isSimklAuthorised,
  isSimklConfigured,
} from "../sources/simkl/sync.ts";
import {
  readSimklToken,
  type SimklToken,
} from "../sources/simkl/token.ts";

const SIMKL_TOKEN_RE = /\b(?:simkl_at_|simkl_rt_)[A-Za-z0-9_\-]+\b/gi;

/** Extract only the `host` (`hostname` or `hostname:port`) from a URL string, or null. */
export function extractHost(urlStr: string | undefined | null): string | null {
  if (typeof urlStr !== "string" || urlStr.trim() === "") {
    return null;
  }
  try {
    const parsed = new URL(urlStr.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.host || null;
  } catch {
    return null;
  }
}

function isAbsConfigured(config: Config): boolean {
  const abs = config.audiobookshelf;
  if (!abs) return false;
  const url = typeof abs.url === "string" ? abs.url.trim() : "";
  const token = typeof abs.token === "string" ? abs.token.trim() : "";
  return url !== "" && token !== "";
}

function cleanError(err: string | null, config: Config): string | null {
  if (err === null || err === undefined || err === "") {
    return null;
  }
  let masked = err.replace(SIMKL_TOKEN_RE, "***");
  masked = redactString(masked, config);
  const tmdbKey = (
    config as { metadata?: { tmdb_api_key?: string } }
  ).metadata?.tmdb_api_key;
  if (typeof tmdbKey === "string" && tmdbKey !== "") {
    masked = masked.split(tmdbKey).join("***");
  }
  return masked;
}

function getDatabaseSizeBytes(dbPath: string | undefined): number | null {
  if (!dbPath || dbPath === ":memory:") {
    return null;
  }
  try {
    if (!existsSync(dbPath)) {
      return null;
    }
    const st = statSync(dbPath);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function getLastBackupAt(backupDir: string | undefined): string | null {
  if (!backupDir) {
    return null;
  }
  try {
    if (!existsSync(backupDir)) {
      return null;
    }
    const entries = readdirSync(backupDir);
    let newestMs = -1;
    let newestIso: string | null = null;
    for (const name of entries) {
      const m = BACKUP_FILE_RE.exec(name);
      if (!m) continue;
      const fullPath = join(backupDir, name);
      try {
        const st = statSync(fullPath);
        if (st.mtimeMs > newestMs) {
          newestMs = st.mtimeMs;
          newestIso = new Date(st.mtimeMs).toISOString();
        }
      } catch {
        // ignore unreadable file
      }
    }
    return newestIso;
  } catch {
    return null;
  }
}

export interface GetSettingsDeps {
  db: Database;
  config: Config;
  readSimklToken?: (path: string) => SimklToken | null;
}

export function getSettings(deps: GetSettingsDeps): SettingsView {
  const { db, config } = deps;
  const tokenReader = deps.readSimklToken ?? readSimklToken;

  const latestRuns = db
    .query<
      {
        id: number;
        source: string;
        started_at: string;
        finished_at: string | null;
        status: IngestRunStatus;
        error: string | null;
      },
      []
    >(
      `SELECT id, source, started_at, finished_at, status, error
       FROM ingest_runs
       WHERE id IN (SELECT MAX(id) FROM ingest_runs GROUP BY source)
       ORDER BY id DESC;`
    )
    .all();

  const runBySource = new Map<
    string,
    {
      id: number;
      started_at: string;
      finished_at: string | null;
      status: IngestRunStatus;
      error: string | null;
    }
  >();
  for (const r of latestRuns) {
    runBySource.set(r.source, r);
  }

  const absEnabled = isAbsConfigured(config);
  const simklConfigured = isSimklConfigured(config);
  const simklAuthed = simklConfigured && isSimklAuthorised(config, tokenReader);
  const awEnabled = Boolean(
    config.activitywatch?.url && config.activitywatch.url.trim() !== ""
  );
  const ytEnabled = isIngestEnabled(config);

  const ytRun =
    runBySource.get("youtube") ?? runBySource.get("youtube-takeout");

  const buildStatus = (
    source: string,
    enabled: boolean,
    host: string | null,
    canSyncNow: boolean,
    run = runBySource.get(source)
  ): SourceStatus => ({
    source,
    enabled,
    host,
    last_sync_at: run ? (run.finished_at ?? run.started_at) : null,
    last_status: run ? run.status : null,
    last_error: run ? cleanError(run.error, config) : null,
    can_sync_now: canSyncNow,
  });

  const sources: SourceStatus[] = [
    buildStatus(
      "audiobookshelf",
      absEnabled,
      extractHost(config.audiobookshelf?.url),
      absEnabled
    ),
    buildStatus(
      "simkl",
      simklConfigured,
      extractHost(config.simkl?.base_url),
      simklAuthed
    ),
    buildStatus(
      "activitywatch",
      awEnabled,
      config.activitywatch?.mode === "push" ? null : extractHost(config.activitywatch?.url),
      false
    ),
    buildStatus("youtube", ytEnabled, null, false, ytRun),
  ];

  const metaCfg = (
    config as { metadata?: { enabled?: boolean; tmdb_api_key?: string } }
  ).metadata;
  const metaEnabled = metaCfg?.enabled ?? true;
  const tmdbKeySet =
    typeof metaCfg?.tmdb_api_key === "string" &&
    metaCfg.tmdb_api_key.trim() !== "";

  const metadata_providers: Array<{ provider: MetaProvider; enabled: boolean }> =
    [
      { provider: "anilist", enabled: metaEnabled },
      { provider: "tvmaze", enabled: metaEnabled },
      { provider: "itunes", enabled: metaEnabled },
      { provider: "openlibrary", enabled: metaEnabled },
      { provider: "steam", enabled: metaEnabled },
      { provider: "tmdb", enabled: metaEnabled && tmdbKeySet },
    ];

  return {
    timezone: config.timezone,
    version: APP_VERSION,
    sources,
    metadata_providers,
    covers_external: config.covers?.external ?? true,
    ingest_token_set: isIngestEnabled(config),
    database: {
      events: countEvents(db),
      size_bytes: getDatabaseSizeBytes(config.storage?.db_path),
      last_backup_at: getLastBackupAt(config.storage?.backup_dir),
    },
  };
}
