/**
 * Simkl token storage.
 *
 * Reads and writes `<dirname(storage.db_path)>/secrets/simkl-token.json`.
 * Directory mode is 0700 and file mode is 0600.
 * Writes are atomic (write to .tmp then rename).
 * Secrets never appear in error messages.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../../core/config.ts";

export interface SimklToken {
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_at: string;
  obtained_at: string;
}

export interface SimklTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

/**
 * Returns the path to the Simkl token storage file:
 * `<dirname(storage.db_path)>/secrets/simkl-token.json`.
 */
export function simklTokenPath(config: Pick<Config, "storage"> | Config): string {
  const baseDir = dirname(config.storage.db_path);
  return join(baseDir, "secrets", "simkl-token.json");
}

/**
 * Reads the stored Simkl token from disk.
 * Returns null if the file does not exist or if the content is malformed.
 * Never leaks file contents in errors.
 */
export function readSimklToken(path: string): SimklToken | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      return null;
    }
    return null;
  }

  try {
    const data = JSON.parse(content);
    if (
      !data ||
      typeof data !== "object" ||
      typeof data.access_token !== "string" ||
      typeof data.refresh_token !== "string" ||
      typeof data.expires_at !== "string"
    ) {
      return null;
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      scope: typeof data.scope === "string" ? data.scope : "media:read",
      expires_at: data.expires_at,
      obtained_at:
        typeof data.obtained_at === "string" ? data.obtained_at : data.expires_at,
    };
  } catch {
    return null;
  }
}

/**
 * Atomically writes a Simkl token to disk with restricted permissions:
 * - Directory mode is 0700.
 * - Temporary file `simkl-token.json.tmp` written with mode 0600.
 * - Renamed over the destination file.
 */
export function writeSimklToken(path: string, token: SimklToken): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);

  const tmpPath = `${path}.tmp`;
  const json = JSON.stringify(token, null, 2);
  writeFileSync(tmpPath, json, { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}

/**
 * Helper to construct a SimklToken from an OAuth token response.
 * Keeps old refresh_token if new one is not returned.
 */
export function createStoredToken(
  response: SimklTokenResponse,
  options?: { oldRefreshToken?: string; now?: number }
): SimklToken {
  const nowMs = options?.now ?? Date.now();
  const obtained_at = new Date(nowMs).toISOString();
  const expires_at = new Date(nowMs + response.expires_in * 1000).toISOString();
  const refresh_token = response.refresh_token || options?.oldRefreshToken || "";
  const scope = response.scope || "media:read";

  return {
    access_token: response.access_token,
    refresh_token,
    scope,
    expires_at,
    obtained_at,
  };
}
