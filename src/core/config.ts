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
}

export interface IngestConfig {
  /**
   * Shared bearer token for `POST /api/ingest/youtube-plays`. Empty disables
   * ingest; a non-empty token must be at least 32 characters. Never logged.
   */
  token: string;
}

export interface ActivityWatchConfig {
  url: string;
  timeout_s: number;
  device: string;
  include_music: boolean;
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
   * Optional: hand-built (test/partial) configs may omit `ingest`; a missing
   * or empty token disables the ingest endpoint.
   */
  ingest?: IngestConfig;
  activitywatch?: ActivityWatchConfig;
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
  const youtube: YoutubeConfig = {
    thumb_base_url: readString(
      youtubeTable,
      "thumb_base_url",
      "youtube.thumb_base_url",
      "https://i.ytimg.com/vi"
    ),
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

  const config = {
    timezone,
    server,
    storage,
    audiobookshelf,
    simkl,
    youtube,
    covers,
    ingest,
    activitywatch,
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
    if ((value as Config).ingest) {
      add((value as Config).ingest?.token);
    }
  }
  if (activeConfig) {
    add(activeConfig.audiobookshelf.token);
    add(activeConfig.notify?.ntfy_token);
    if (activeConfig.ingest) {
      add(activeConfig.ingest.token);
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
  return maskString(text, secrets);
}
