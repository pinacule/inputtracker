/**
 * Config loading and redaction.
 *
 * Reads `inputtracker.config.toml` (path override via the `INPUTTRACKER_CONFIG`
 * env var, or `opts.path`), merges file values over defaults per key, and never
 * leaks the Audiobookshelf token through logs.
 *
 * Nothing machine-specific is hard-coded: the data directory comes from
 * `XDG_DATA_HOME` (falling back to `~/.local/share`), and the token is stored as
 * a non-enumerable property so `String(config)`, `JSON.stringify(config)` and
 * `util.inspect(config)` cannot reveal it.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ServerConfig {
  bind: string;
  port: number;
}

export interface StorageConfig {
  db_path: string;
  backup_dir: string;
  backup_keep: number;
}

export interface AudiobookshelfConfig {
  url: string;
  token: string;
  timeout_s: number;
}

export interface SimklConfig {
  client_id: string;
  base_url: string;
  /** Base URL for poster images (e.g. `https://simkl.in/posters`). */
  poster_base_url: string;
  timeout_s: number;
}

export interface YoutubeConfig {
  /** Base URL for video thumbnails (e.g. `https://i.ytimg.com/vi`). */
  thumb_base_url: string;
  /** Minimum watched minutes per video per local day to count (default 5; 0 disables). */
  min_watch_minutes?: number;
  /** Maximum videos enriched per ActivityWatch/YouTube sync run (default 50; 0 disables). */
  enrich_per_sync?: number;
  /** Optional base URL for YouTube oEmbed and watch page requests (default `https://www.youtube.com`). */
  base_url?: string;
}

export interface IngestConfig {
  /**
   * Shared bearer token for both ingest endpoints. Empty disables
   * ingest; a non-empty token must be at least 32 characters. Never logged.
   */
  token: string;
}

export interface ActivityWatchConfig {
  mode?: "pull" | "push";
  url: string;
  timeout_s: number;
  device: string;
  include_music: boolean;
}

export interface PushConfig {
  server_url: string;
  token: string;
}

export interface NotifyConfig {
  desktop: boolean;
  ntfy_url: string;
  /** Optional ntfy access token (`Authorization: Bearer …`); never logged. */
  ntfy_token: string;
  /** Web app URL sent as the ntfy `Click` header when set. */
  app_url: string;
  /** Weekly summary push, off by default. */
  weekly_summary: boolean;
}

export interface CoversConfig {
  external: boolean;
  openlibrary_url: string;
  openlibrary_covers_url: string;
}

export interface MetadataConfig {
  enabled: boolean;
  anilist_url: string;
  tvmaze_url: string;
  cinemeta_url: string;
  itunes_url: string;
  openlibrary_url: string;
  openlibrary_covers_url: string;
  tmdb_url: string;
  tmdb_image_url: string;
  /** Optional TMDB API key; non-enumerable secret, never logged. */
  tmdb_api_key: string;
}

export interface Config {
  timezone: string;
  server: ServerConfig;
  storage: StorageConfig;
  audiobookshelf: AudiobookshelfConfig;
  simkl: SimklConfig;
  youtube: YoutubeConfig;
  /**
   * Cover lookup fallback options. Optional in hand-built (test/partial)
   * configs; `loadConfig` always populates it with defaults.
   */
  covers?: CoversConfig;
  /**
   * Metadata lookup options. Optional in hand-built (test/partial) configs;
   * `loadConfig` always populates it with defaults.
   */
  metadata?: MetadataConfig;
  /**
   * Optional: hand-built (test/partial) configs may omit `ingest`; a missing
   * or empty token disables the ingest endpoint.
   */
  ingest?: IngestConfig;
  activitywatch?: ActivityWatchConfig;
  push?: PushConfig;
  notify: NotifyConfig;
  /** Redacted plain object (JSON.stringify uses this automatically). */
  toJSON(): unknown;
  /** Redacted JSON string. */
  toString(): string;
}

export interface LoadConfigOptions {
  /** Explicit config path; beats the env var and the default. */
  path?: string;
  /** Environment to read from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

type Table = Record<string, unknown>;

const DEFAULT_TIMEZONE = "Europe/Bratislava";
const DEFAULT_DB_NAME = "inputtracker.db";
const DEFAULT_BACKUP_DIR_NAME = "backups";

/** Most recently loaded config, used to redact free text in `redact()`. */
let activeConfig: Config | null = null;

/**
 * Data directory: `$XDG_DATA_HOME/inputtracker`, else
 * `<home>/.local/share/inputtracker`. Never a hard-coded user path.
 */
function defaultDataDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_DATA_HOME;
  if (typeof xdg === "string" && xdg.trim() !== "") {
    return join(xdg, "inputtracker");
  }
  return join(homedir(), ".local", "share", "inputtracker");
}

function resolveConfigPath(
  opts: LoadConfigOptions,
  env: Record<string, string | undefined>
): string {
  const explicit = opts.path;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return explicit;
  }

  const fromEnv = env.INPUTTRACKER_CONFIG;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv;
  }

  return resolve("inputtracker.config.toml");
}

/**
 * Read and parse the config file. Returns `null` when the file does not exist
 * (callers fall back to defaults). Error messages never include file contents,
 * so a token in a malformed file cannot leak into an exception.
 */
function readConfigFile(path: string): Table | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    throw new Error(`Config file "${path}" is not valid TOML`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file "${path}" must contain a TOML table`);
  }

  return parsed as Table;
}

// --- typed readers (never echo values, so secrets cannot appear) ---

function readTable(source: Table, prop: string, path: string): Table {
  const value = source[prop];
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Config key "${path}" must be a table`);
  }
  return value as Table;
}

function readString(source: Table, prop: string, path: string, fallback: string): string {
  const value = source[prop];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(`Config key "${path}" must be a string`);
  }
  return value;
}

function readNumber(source: Table, prop: string, path: string, fallback: number): number {
  const value = source[prop];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Config key "${path}" must be a number`);
  }
  return value;
}

function readBoolean(source: Table, prop: string, path: string, fallback: boolean): boolean {
  const value = source[prop];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Config key "${path}" must be a boolean`);
  }
  return value;
}

/**
 * Load the config: explicit path > `INPUTTRACKER_CONFIG` > `./inputtracker.config.toml`.
 * Missing file yields all defaults; malformed TOML or wrong types throw.
 */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const path = resolveConfigPath(opts, env);
  const file = readConfigFile(path) ?? {};

  const timezone = readString(file, "timezone", "timezone", DEFAULT_TIMEZONE);

  const serverTable = readTable(file, "server", "server");
  const server: ServerConfig = {
    bind: readString(serverTable, "bind", "server.bind", "127.0.0.1"),
    port: readNumber(serverTable, "port", "server.port", 8787),
  };

  const dataDir = defaultDataDir(env);
  const storageTable = readTable(file, "storage", "storage");
  const storage: StorageConfig = {
    db_path: readString(
      storageTable,
      "db_path",
      "storage.db_path",
      join(dataDir, DEFAULT_DB_NAME)
    ),
    backup_dir: readString(
      storageTable,
      "backup_dir",
      "storage.backup_dir",
      join(dataDir, DEFAULT_BACKUP_DIR_NAME)
    ),
    backup_keep: readNumber(storageTable, "backup_keep", "storage.backup_keep", 14),
  };

  const absTable = readTable(file, "audiobookshelf", "audiobookshelf");
  const token = readString(absTable, "token", "audiobookshelf.token", "");
  const audiobookshelf = {
    url: readString(absTable, "url", "audiobookshelf.url", "http://localhost:13378"),
    timeout_s: readNumber(absTable, "timeout_s", "audiobookshelf.timeout_s", 20),
  } as AudiobookshelfConfig;

  // Non-enumerable: invisible to JSON.stringify/util.inspect/Object.keys.
  Object.defineProperty(audiobookshelf, "token", {
    value: token,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  const simklTable = readTable(file, "simkl", "simkl");
  const simkl: SimklConfig = {
    client_id: readString(simklTable, "client_id", "simkl.client_id", ""),
    base_url: readString(simklTable, "base_url", "simkl.base_url", "https://api.simkl.com"),
    poster_base_url: readString(
      simklTable,
      "poster_base_url",
      "simkl.poster_base_url",
      "https://simkl.in/posters"
    ),
    timeout_s: readNumber(simklTable, "timeout_s", "simkl.timeout_s", 20),
  };

  const youtubeTable = readTable(file, "youtube", "youtube");
  const minWatchMinutes = readNumber(
    youtubeTable,
    "min_watch_minutes",
    "youtube.min_watch_minutes",
    5
  );
  if (minWatchMinutes < 0 || minWatchMinutes > 1440) {
    throw new Error(
      `Config key "youtube.min_watch_minutes" must be between 0 and 1440 (got ${minWatchMinutes})`
    );
  }
  const enrichPerSync = readNumber(
    youtubeTable,
    "enrich_per_sync",
    "youtube.enrich_per_sync",
    50
  );
  if (!Number.isInteger(enrichPerSync) || enrichPerSync < 0) {
    throw new Error(
      `Config key "youtube.enrich_per_sync" must be a non-negative integer (got ${enrichPerSync})`
    );
  }
  const youtubeBaseUrl =
    youtubeTable.base_url !== undefined && youtubeTable.base_url !== null
      ? readString(
          youtubeTable,
          "base_url",
          "youtube.base_url",
          "https://www.youtube.com"
        )
      : undefined;
  const youtube: YoutubeConfig = {
    thumb_base_url: readString(
      youtubeTable,
      "thumb_base_url",
      "youtube.thumb_base_url",
      "https://i.ytimg.com/vi"
    ),
    min_watch_minutes: minWatchMinutes,
    enrich_per_sync: enrichPerSync,
    ...(youtubeBaseUrl !== undefined ? { base_url: youtubeBaseUrl } : {}),
  };

  // The ingest token is a secret exactly like the ABS token: non-enumerable
  // (invisible to JSON.stringify/util.inspect/Object.keys) and masked by the
  // `token` key-name rule and `secretsFrom`.
  const ingestTable = readTable(file, "ingest", "ingest");
  const ingestToken = readString(ingestTable, "token", "ingest.token", "");
  if (ingestToken !== "" && ingestToken.length < 32) {
    throw new Error(
      `Config key "ingest.token" must be at least 32 characters (got ${ingestToken.length})`
    );
  }
  const ingest = {} as IngestConfig;
  Object.defineProperty(ingest, "token", {
    value: ingestToken,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  const awTable = readTable(file, "activitywatch", "activitywatch");
  const awMode = readString(awTable, "mode", "activitywatch.mode", "pull");
  if (awMode !== "pull" && awMode !== "push") {
    throw new Error('Config key "activitywatch.mode" must be pull or push');
  }
  const awDevice = readString(awTable, "device", "activitywatch.device", "pc");
  if (
    awDevice.length < 1 ||
    awDevice.length > 32 ||
    !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(awDevice)
  ) {
    throw new Error(
      `Config key "activitywatch.device" must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be 1–32 chars`
    );
  }
  const activitywatch: ActivityWatchConfig = {
    mode: awMode,
    url: readString(
      awTable,
      "url",
      "activitywatch.url",
      "http://127.0.0.1:5600"
    ),
    timeout_s: readNumber(
      awTable,
      "timeout_s",
      "activitywatch.timeout_s",
      20
    ),
    device: awDevice,
    include_music: readBoolean(
      awTable,
      "include_music",
      "activitywatch.include_music",
      false
    ),
  };

  const pushTable = readTable(file, "push", "push");
  const pushToken = readString(pushTable, "token", "push.token", "");
  if (pushToken !== "" && (pushToken.length < 32 || /[\s\x00-\x1f\x7f]/.test(pushToken))) {
    throw new Error('Config key "push.token" must be at least 32 characters without whitespace');
  }
  const push = { server_url: readString(pushTable, "server_url", "push.server_url", "") } as PushConfig;
  if (push.server_url !== "") {
    try {
      const url = new URL(push.server_url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { throw new Error('Config key "push.server_url" must be an HTTP(S) URL without credentials, query or fragment'); }
  }
  Object.defineProperty(push, "token", { value: pushToken, enumerable: false });

  const notifyTable = readTable(file, "notify", "notify");
  const notify: NotifyConfig = {
    desktop: readBoolean(notifyTable, "desktop", "notify.desktop", true),
    ntfy_url: readString(notifyTable, "ntfy_url", "notify.ntfy_url", ""),
    ntfy_token: readString(notifyTable, "ntfy_token", "notify.ntfy_token", ""),
    app_url: readString(notifyTable, "app_url", "notify.app_url", ""),
    weekly_summary: readBoolean(
      notifyTable,
      "weekly_summary",
      "notify.weekly_summary",
      false
    ),
  };
  // `ntfy_token` is handled by the key-name rule in `redactValue` (any key
  // matching /token/ is masked) and by `secretsFrom` for free-text masking, so
  // `config.toJSON()`/`toString()`/`redact(config)` can never reveal it.

  const coversTable = readTable(file, "covers", "covers");
  const covers: CoversConfig = {
    external: readBoolean(coversTable, "external", "covers.external", true),
    openlibrary_url: readString(
      coversTable,
      "openlibrary_url",
      "covers.openlibrary_url",
      "https://openlibrary.org"
    ),
    openlibrary_covers_url: readString(
      coversTable,
      "openlibrary_covers_url",
      "covers.openlibrary_covers_url",
      "https://covers.openlibrary.org"
    ),
  };

  const metadataTable = readTable(file, "metadata", "metadata");
  const tmdbApiKey = readString(
    metadataTable,
    "tmdb_api_key",
    "metadata.tmdb_api_key",
    ""
  );
  const metadata = {
    enabled: readBoolean(metadataTable, "enabled", "metadata.enabled", true),
    anilist_url: readString(
      metadataTable,
      "anilist_url",
      "metadata.anilist_url",
      "https://graphql.anilist.co"
    ),
    tvmaze_url: readString(
      metadataTable,
      "tvmaze_url",
      "metadata.tvmaze_url",
      "https://api.tvmaze.com"
    ),
    cinemeta_url: readString(
      metadataTable,
      "cinemeta_url",
      "metadata.cinemeta_url",
      "https://v3-cinemeta.strem.io"
    ),
    itunes_url: readString(
      metadataTable,
      "itunes_url",
      "metadata.itunes_url",
      "https://itunes.apple.com"
    ),
    openlibrary_url: readString(
      metadataTable,
      "openlibrary_url",
      "metadata.openlibrary_url",
      covers.openlibrary_url
    ),
    openlibrary_covers_url: readString(
      metadataTable,
      "openlibrary_covers_url",
      "metadata.openlibrary_covers_url",
      covers.openlibrary_covers_url
    ),
    tmdb_url: readString(
      metadataTable,
      "tmdb_url",
      "metadata.tmdb_url",
      "https://api.themoviedb.org/3"
    ),
    tmdb_image_url: readString(
      metadataTable,
      "tmdb_image_url",
      "metadata.tmdb_image_url",
      "https://image.tmdb.org/t/p"
    ),
  } as MetadataConfig;

  Object.defineProperty(metadata, "tmdb_api_key", {
    value: tmdbApiKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  const config = {
    timezone,
    server,
    storage,
    audiobookshelf,
    simkl,
    youtube,
    covers,
    metadata,
    ingest,
    activitywatch,
    push,
    notify,
  } as Config;

  // Redacted serialization: token is non-enumerable, so it is already omitted.
  Object.defineProperty(config, "toJSON", {
    value: () => redactValue(config, secretsFrom(config)),
    enumerable: false,
  });
  Object.defineProperty(config, "toString", {
    value: () => JSON.stringify(redactValue(config, secretsFrom(config))),
    enumerable: false,
  });

  activeConfig = config;
  return config;
}

/** True when a non-empty ingest token is configured (ingest accepts requests). */
export function isIngestEnabled(
  config: { ingest?: { token?: string } } | null | undefined
): boolean {
  const token = config?.ingest?.token;
  return typeof token === "string" && token !== "";
}

// --- redaction ---

const SECRET_KEY_RE = /token|secret|password|api[_-]?key/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

function isConfigLike(value: unknown): value is Config {
  return (
    typeof value === "object" &&
    value !== null &&
    "audiobookshelf" in value &&
    "storage" in value &&
    "server" in value
  );
}

/** Collect tokens that should be masked in free text. */
function secretsFrom(value: unknown): string[] {
  const secrets: string[] = [];
  const add = (token: unknown): void => {
    if (typeof token === "string" && token !== "" && !secrets.includes(token)) {
      secrets.push(token);
    }
  };

  if (isConfigLike(value)) {
    add((value as Config).audiobookshelf?.token);
    add((value as Config).notify?.ntfy_token);
    add((value as Config).push?.token);
    if ((value as Config).ingest) {
      add((value as Config).ingest?.token);
    }
    if ((value as Config).metadata) {
      add((value as Config).metadata?.tmdb_api_key);
    }
  } else if (value && typeof value === "object") {
    const meta = (value as { metadata?: { tmdb_api_key?: unknown } }).metadata;
    if (meta && typeof meta === "object") {
      add(meta.tmdb_api_key);
    }
  }
  if (activeConfig) {
    add(activeConfig.audiobookshelf.token);
    add(activeConfig.notify?.ntfy_token);
    add(activeConfig.push?.token);
    if (activeConfig.ingest) {
      add(activeConfig.ingest.token);
    }
    if (activeConfig.metadata) {
      add(activeConfig.metadata.tmdb_api_key);
    }
  }

  return secrets;
}

function maskString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== "") {
      out = out.split(secret).join("***");
    }
  }
  return out;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return maskString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? "***" : redactValue(val, secrets);
    }
    return out;
  }
  return value;
}

/**
 * Return a string form of `value` with the configured token (and any
 * `token`-like key) replaced by `***`.
 */
export function redact(value: unknown): string {
  if (typeof value === "string") {
    return maskString(value, secretsFrom(activeConfig));
  }
  const redacted = redactValue(value, secretsFrom(value));
  const json = JSON.stringify(redacted, null, 2);
  return json === undefined ? String(value) : json;
}

/** Replace every configured token (ABS API key, ntfy token) in free text. */
export function redactString(text: string, config: Config): string {
  const secrets: string[] = [];
  if (config.push?.token) secrets.push(config.push.token);
  const abs = config?.audiobookshelf?.token;
  if (typeof abs === "string" && abs !== "") {
    secrets.push(abs);
  }
  // Optional in hand-built (partial) configs, hence the guards.
  const notify = (config as { notify?: { ntfy_token?: string } } | null | undefined)
    ?.notify;
  const ntfy = notify?.ntfy_token;
  if (typeof ntfy === "string" && ntfy !== "") {
    secrets.push(ntfy);
  }
  // Optional in hand-built (partial) configs, hence the guard.
  const ingestToken = (
    config as { ingest?: { token?: string } } | null | undefined
  )?.ingest?.token;
  if (typeof ingestToken === "string" && ingestToken !== "") {
    secrets.push(ingestToken);
  }
  const tmdbKey = (
    config as { metadata?: { tmdb_api_key?: string } } | null | undefined
  )?.metadata?.tmdb_api_key;
  if (typeof tmdbKey === "string" && tmdbKey !== "") {
    secrets.push(tmdbKey);
  }
  return maskString(text, secrets);
}
