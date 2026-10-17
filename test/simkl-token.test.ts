import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStoredToken,
  readSimklToken,
  simklTokenPath,
  writeSimklToken,
  type SimklToken,
} from "../src/sources/simkl/token.ts";

const FAKE_AT = "simkl_at_FAKE_ACCESS_1";
const FAKE_RT = "simkl_rt_FAKE_REFRESH_1";

describe("Simkl token storage", () => {
  test("simklTokenPath derives secrets path from storage.db_path", () => {
    const config = {
      storage: {
        db_path: "/var/data/inputtracker/inputtracker.db",
        backup_dir: "/var/data/inputtracker/backups",
        backup_keep: 14,
      },
    };
    const path = simklTokenPath(config);
    expect(path).toBe("/var/data/inputtracker/secrets/simkl-token.json");
  });

  test("readSimklToken returns null for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "it-simkl-token-"));
    try {
      const nonExistent = join(dir, "secrets", "simkl-token.json");
      expect(readSimklToken(nonExistent)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readSimklToken returns null for malformed JSON without leaking contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "it-simkl-token-"));
    try {
      const tokenPath = join(dir, "simkl-token.json");
      writeFileSync(tokenPath, `{"access_token": "${FAKE_AT}", broken...`);
      expect(readSimklToken(tokenPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readSimklToken returns null for incomplete token shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "it-simkl-token-"));
    try {
      const tokenPath = join(dir, "simkl-token.json");
      writeFileSync(tokenPath, JSON.stringify({ access_token: FAKE_AT }));
      expect(readSimklToken(tokenPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeSimklToken sets directory mode 0700 and file mode 0600 atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "it-simkl-token-"));
    try {
      const secretsDir = join(dir, "secrets");
      const tokenPath = join(secretsDir, "simkl-token.json");
      const token: SimklToken = {
        access_token: FAKE_AT,
        refresh_token: FAKE_RT,
        scope: "media:read",
        expires_at: "2026-10-24T18:00:00.000Z",
        obtained_at: "2026-10-17T18:00:00.000Z",
      };

      writeSimklToken(tokenPath, token);

      // Check directory permissions
      const dirStat = statSync(secretsDir);
      expect(dirStat.mode & 0o777).toBe(0o700);

      // Check file permissions
      const fileStat = statSync(tokenPath);
      expect(fileStat.mode & 0o777).toBe(0o600);

      // Check that .tmp file does not exist
      expect(existsSync(`${tokenPath}.tmp`)).toBe(false);

      // Round-trip read
      const read = readSimklToken(tokenPath);
      expect(read).toEqual(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeSimklToken tightens existing directory permissions to 0700", () => {
    const dir = mkdtempSync(join(tmpdir(), "it-simkl-token-"));
    try {
      const secretsDir = join(dir, "secrets");
      const tokenPath = join(secretsDir, "simkl-token.json");
      // Create with looser permissions
      writeSimklToken(tokenPath, {
        access_token: FAKE_AT,
        refresh_token: FAKE_RT,
        scope: "media:read",
        expires_at: "2026-10-24T18:00:00.000Z",
        obtained_at: "2026-10-17T18:00:00.000Z",
      });
      chmodSync(secretsDir, 0o755);
      expect(statSync(secretsDir).mode & 0o777).toBe(0o755);

      // Writing again should chmod to 0700
      writeSimklToken(tokenPath, {
        access_token: FAKE_AT,
        refresh_token: FAKE_RT,
        scope: "media:read",
        expires_at: "2026-10-24T18:00:00.000Z",
        obtained_at: "2026-10-17T18:00:00.000Z",
      });
      expect(statSync(secretsDir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("createStoredToken helper", () => {
    test("computes UTC ISO timestamps from expires_in and now", () => {
      const baseNow = 1792250000000;
      const stored = createStoredToken(
        {
          access_token: FAKE_AT,
          refresh_token: FAKE_RT,
          expires_in: 3600,
          scope: "media:read",
        },
        { now: baseNow }
      );

      expect(stored.access_token).toBe(FAKE_AT);
      expect(stored.refresh_token).toBe(FAKE_RT);
      expect(stored.scope).toBe("media:read");
      expect(stored.obtained_at).toBe(new Date(baseNow).toISOString());
      expect(stored.expires_at).toBe(new Date(baseNow + 3600 * 1000).toISOString());
    });

    test("keeps old refresh token if response has none", () => {
      const stored = createStoredToken(
        {
          access_token: FAKE_AT,
          expires_in: 3600,
        },
        { oldRefreshToken: FAKE_RT, now: 1000000 }
      );

      expect(stored.access_token).toBe(FAKE_AT);
      expect(stored.refresh_token).toBe(FAKE_RT);
    });

    test("prefers new refresh token when returned", () => {
      const NEW_RT = "simkl_rt_FAKE_REFRESH_2";
      const stored = createStoredToken(
        {
          access_token: FAKE_AT,
          refresh_token: NEW_RT,
          expires_in: 3600,
        },
        { oldRefreshToken: FAKE_RT, now: 1000000 }
      );

      expect(stored.access_token).toBe(FAKE_AT);
      expect(stored.refresh_token).toBe(NEW_RT);
    });
  });
});
