/**
 * `it ingest token|status` and the `it doctor` ingest line — synthetic config,
 * no network, no real files written.
 */

import { describe, expect, test } from "bun:test";
import type { Config } from "../src/core/config.ts";
import { generateIngestToken, runCli } from "../src/cli/index.ts";
import { runDoctor, type DoctorDeps, type DoctorRunResult } from "../src/cli/doctor.ts";

const FAKE_INGEST_TOKEN = "synthetic-ingest-token-0123456789abcdef"; // 39 chars

function mockConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    timezone: "Europe/Bratislava",
    server: { bind: "127.0.0.1", port: 8787 },
    storage: { db_path: ":memory:", backup_dir: "/tmp/backups", backup_keep: 14 },
    audiobookshelf: { url: "http://localhost:13378", token: "secret", timeout_s: 20 },
    simkl: { client_id: "", base_url: "https://api.simkl.test", poster_base_url: "https://simkl.in/posters", timeout_s: 20 },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    notify: { desktop: false, ntfy_url: "", ntfy_token: "", app_url: "", weekly_summary: false },
    toJSON: () => ({ ...cfg }),
    toString: () => JSON.stringify(cfg),
    ...overrides,
  };
  return cfg;
}

describe("it ingest token", () => {
  test("prints a 43-char base64url token and the hint, exits 0", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["ingest", "token"], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      // The command must not read the config; a throwing loader proves that.
      loadConfig: () => {
        throw new Error("config must not be read");
      },
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(out[1]).toBe(
      "add it to [ingest] token in your config, then restart the server"
    );
  });

  test("generateIngestToken yields a fresh value on every call", () => {
    const a = generateIngestToken();
    const b = generateIngestToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe("it ingest status", () => {
  test("disabled (empty token) — never prints the token", async () => {
    const out: string[] = [];
    const code = await runCli(["ingest", "status"], {
      out: (l) => out.push(l),
      err: () => {},
      loadConfig: () => mockConfig(),
    });
    expect(code).toBe(0);
    expect(out).toEqual(["ingest: disabled"]);
    expect(out.join("\n")).not.toContain(FAKE_INGEST_TOKEN);
  });

  test("enabled — prints only the status line", async () => {
    const out: string[] = [];
    const code = await runCli(["ingest", "status"], {
      out: (l) => out.push(l),
      err: () => {},
      loadConfig: () => mockConfig({ ingest: { token: FAKE_INGEST_TOKEN } }),
    });
    expect(code).toBe(0);
    expect(out).toEqual(["ingest: enabled"]);
    expect(out.join("\n")).not.toContain(FAKE_INGEST_TOKEN);
  });

  test("a config load failure exits 2", async () => {
    const err: string[] = [];
    const code = await runCli(["ingest", "status"], {
      out: () => {},
      err: (l) => err.push(l),
      loadConfig: () => {
        throw new Error("config unreadable");
      },
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("config unreadable");
  });

  test("unknown subcommand → usage error", async () => {
    const code = await runCli(["ingest", "frobnicate"], {
      out: () => {},
      err: () => {},
    });
    expect(code).toBe(1);
  });
});

describe("it doctor ingest line", () => {
  const lines: string[] = [];
  function deps(config: Config): DoctorDeps {
    return {
      arch: "x64",
      bunVersion: "1.2.3",
      loadConfig: () => config,
      exists: () => false,
      isWritableDir: () => true,
      which: () => null,
      run: (): DoctorRunResult => ({ code: 0, stdout: "" }),
      isPortFree: () => true,
      env: {},
      user: "tester",
      out: (line) => lines.push(line),
    };
  }

  test("ingest: disabled when the token is empty", async () => {
    lines.length = 0;
    await runDoctor(deps(mockConfig()));
    expect(lines.join("\n")).toContain("ingest: disabled");
    expect(lines.join("\n")).not.toContain(FAKE_INGEST_TOKEN);
  });

  test("ingest: enabled with a token, never the value", async () => {
    lines.length = 0;
    await runDoctor(deps(mockConfig({ ingest: { token: FAKE_INGEST_TOKEN } })));
    expect(lines.join("\n")).toContain("ingest: enabled");
    expect(lines.join("\n")).not.toContain(FAKE_INGEST_TOKEN);
  });
});
