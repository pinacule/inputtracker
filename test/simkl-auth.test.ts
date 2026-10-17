import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import { readSimklToken, simklTokenPath, writeSimklToken, type SimklToken } from "../src/sources/simkl/token.ts";

const FAKE_CLIENT_ID = "test-client-id";
const FAKE_ACCESS_TOKEN = "simkl_at_FAKE_ACCESS_1";
const FAKE_REFRESH_TOKEN = "simkl_rt_FAKE_REFRESH_1";
const FAKE_DEVICE_CODE = "FAKE-DEVICE-CODE-1";
const FAKE_USER_CODE = "BDWP-HQPK";
const FAKE_URI = "https://simkl.com/pin";
const FAKE_URI_COMPLETE = "https://simkl.com/pin?user_code=BDWP-HQPK";

const allCliOutputs: string[] = [];

function makeMockConfig(dir: string, clientId = FAKE_CLIENT_ID, timezone = "Europe/Bratislava"): Config {
  const cfg: Config = {
    timezone,
    server: { bind: "127.0.0.1", port: 8787 },
    storage: {
      db_path: join(dir, "inputtracker.db"),
      backup_dir: join(dir, "backups"),
      backup_keep: 14,
    },
    audiobookshelf: { url: "http://localhost:13378", token: "", timeout_s: 20 },
    simkl: {
      client_id: clientId,
      base_url: "https://api.simkl.test",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 5,
    },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    notify: {
      desktop: false,
      ntfy_url: "",
      ntfy_token: "",
      app_url: "",
      weekly_summary: false,
    },
    toJSON: () => ({ ...cfg }),
    toString: () => JSON.stringify(cfg),
  };
  return cfg;
}

describe("Simkl CLI auth", () => {
  test("client_id empty prints hint and exits 1 without calling fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "it-simkl-cli-"));
    try {
      const outLines: string[] = [];
      const errLines: string[] = [];
      let fetchCalled = false;

      const code = await runCli(["auth", "simkl"], {
        loadConfig: () => makeMockConfig(dir, ""),
        fetch: async () => {
          fetchCalled = true;
          return new Response("{}", { status: 200 });
        },
        out: (line) => {
          outLines.push(line);
          allCliOutputs.push(line);
        },
        err: (line) => {
          errLines.push(line);
          allCliOutputs.push(line);
        },
      });

      expect(code).toBe(1);
      expect(fetchCalled).toBe(false);
      const combined = errLines.join("\n");
      expect(combined).toContain("client_id");
      expect(combined).toContain("https://simkl.com/settings/developer/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("it auth with missing or invalid subcommand exits 1", async () => {
    const errLines: string[] = [];
    const code1 = await runCli(["auth"], {
      err: (line) => errLines.push(line),
    });
    expect(code1).toBe(1);

    const code2 = await runCli(["auth", "unknown-service"], {
      err: (line) => errLines.push(line),
    });
    expect(code2).toBe(1);

    const code3 = await runCli(["auth", "simkl", "--invalid-flag"], {
      err: (line) => errLines.push(line),
    });
    expect(code3).toBe(1);
  });

  describe("Status check (--status)", () => {
    test("--status prints not connected when token file does not exist", async () => {
      const dir = mkdtempSync(join(tmpdir(), "it-simkl-cli-"));
      try {
        const outLines: string[] = [];
        let fetchCalled = false;

        const code = await runCli(["auth", "simkl", "--status"], {
          loadConfig: () => makeMockConfig(dir, FAKE_CLIENT_ID),
          fetch: async () => {
            fetchCalled = true;
            return new Response("{}", { status: 200 });
          },
          out: (line) => {
            outLines.push(line);
            allCliOutputs.push(line);
          },
        });

        expect(code).toBe(0);
        expect(fetchCalled).toBe(false);
        const combined = outLines.join("\n");
        expect(combined).toContain("Simkl: not connected");
        expect(combined).toContain("Client ID: configured");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("--status prints connected with scope and expiry in configured timezone", async () => {
      const dir = mkdtempSync(join(tmpdir(), "it-simkl-cli-"));
      try {
        const config = makeMockConfig(dir, FAKE_CLIENT_ID, "Europe/Bratislava");
        const tokenPath = simklTokenPath(config);
        const token: SimklToken = {
          access_token: FAKE_ACCESS_TOKEN,
          refresh_token: FAKE_REFRESH_TOKEN,
          scope: "media:read",
          // 2026-10-24 18:00 UTC -> 24.10.2026 in Europe/Bratislava
          expires_at: "2026-10-24T18:00:00.000Z",
          obtained_at: "2026-10-17T18:00:00.000Z",
        };
        writeSimklToken(tokenPath, token);

        const outLines: string[] = [];
        let fetchCalled = false;

        const code = await runCli(["auth", "simkl", "--status"], {
          loadConfig: () => config,
          fetch: async () => {
            fetchCalled = true;
            return new Response("{}", { status: 200 });
          },
          out: (line) => {
            outLines.push(line);
            allCliOutputs.push(line);
          },
        });

        expect(code).toBe(0);
        expect(fetchCalled).toBe(false);
        const combined = outLines.join("\n");
        expect(combined).toContain("Simkl: connected");
        expect(combined).toContain("Client ID: configured");
        expect(combined).toContain("Scope: media:read");
        expect(combined).toContain("24.10.2026");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Device flow polling outcomes", () => {
    test("device flow success: prints URIs, polls, writes token file with 0600 mode, exits 0", async () => {
      const dir = mkdtempSync(join(tmpdir(), "it-simkl-cli-"));
      try {
        const config = makeMockConfig(dir, FAKE_CLIENT_ID, "Europe/Bratislava");
        const outLines: string[] = [];
        const errLines: string[] = [];
        const requestedBodies: string[] = [];
        const sleepCalls: number[] = [];

        const mockFetch = async (input: string | URL | Request, init?: RequestInit) => {
          const urlStr = input.toString();
          if (init?.body) {
            requestedBodies.push(init.body.toString());
          }

          if (urlStr.includes("/oauth2/device")) {
            return new Response(
              JSON.stringify({
                device_code: FAKE_DEVICE_CODE,
                user_code: FAKE_USER_CODE,
                verification_uri: FAKE_URI,
                verification_uri_complete: FAKE_URI_COMPLETE,
                expires_in: 900,
                interval: 5,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }

          if (urlStr.includes("/oauth2/token")) {
            return new Response(
              JSON.stringify({
                access_token: FAKE_ACCESS_TOKEN,
                token_type: "Bearer",
                expires_in: 604800,
                refresh_token: FAKE_REFRESH_TOKEN,
                scope: "media:read",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }

          throw new Error(`Unexpected call to ${urlStr}`);
        };

        const code = await runCli(["auth", "simkl"], {
          loadConfig: () => config,
          fetch: mockFetch,
          sleep: async (ms) => {
            sleepCalls.push(ms);
          },
          nowMs: () => 1792250000000,
          out: (line) => {
            outLines.push(line);
            allCliOutputs.push(line);
          },
          err: (line) => {
            errLines.push(line);
            allCliOutputs.push(line);
          },
        });

        expect(code).toBe(0);
        expect(errLines.length).toBe(0);

        // Verification URI complete on its own line
        expect(outLines).toContain(FAKE_URI_COMPLETE);

        // Fallback line contains verification_uri and user_code
        const fallback = outLines.find((l) => l.includes(FAKE_URI) && l.includes(FAKE_USER_CODE));
        expect(fallback).toBeDefined();

        // Device flow sleep was called with initial interval (5000 ms)
        expect(sleepCalls).toEqual([5000]);

        // Success message
        const successMsg = outLines.find((l) => l.includes("Simkl connected"));
        expect(successMsg).toBeDefined();
        expect(successMsg).toContain("media:read");

        // Verify request bodies were form-encoded as specified
        const deviceForm = new URLSearchParams(requestedBodies[0]);
        expect(deviceForm.get("client_id")).toBe(FAKE_CLIENT_ID);
        expect(deviceForm.get("scope")).toBe("media:read");
        expect(Array.from(deviceForm.keys()).sort()).toEqual(["client_id", "scope"]);

        const pollForm = new URLSearchParams(requestedBodies[1]);
        expect(pollForm.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
        expect(pollForm.get("client_id")).toBe(FAKE_CLIENT_ID);
        expect(pollForm.get("device_code")).toBe(FAKE_DEVICE_CODE);
        expect(Array.from(pollForm.keys()).sort()).toEqual(["client_id", "device_code", "grant_type"]);

        // Verify token file was written
        const tokenPath = simklTokenPath(config);
        const stored = readSimklToken(tokenPath);
        expect(stored?.access_token).toBe(FAKE_ACCESS_TOKEN);
        expect(stored?.refresh_token).toBe(FAKE_REFRESH_TOKEN);

        // Verify file mode is 0600 and dir is 0700
        expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, "secrets")).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("slow_down adds 5s to the interval and next wait is +5s", async () => {
      const dir = mkdtempSync(join(tmpdir(), "it-simkl-cli-"));
      try {
        const config = makeMockConfig(dir, FAKE_CLIENT_ID);
        const sleepCalls: number[] = [];
        let pollCount = 0;

        const mockFetch = async (input: string | URL | Request) => {
          const urlStr = input.toString();
          if (urlStr.includes("/oauth2/device")) {
            return new Response(
              JSON.stringify({
                device_code: FAKE_DEVICE_CODE,
                user_code: FAKE_USER_CODE,
                verification_uri: FAKE_URI,
                verification_uri_complete: FAKE_URI_COMPLETE,
                expires_in: 900,
                interval: 5,
              }),
              { status: 200 }
            );
          }

          if (urlStr.includes("/oauth2/token")) {
            pollCount++;
            if (pollCount === 1) {
              // 400 slow_down
              return new Response(JSON.stringify({ error: "slow_down" }), { status: 400 });
            }
            // Second poll succeeds
            return new Response(
              JSON.stringify({
                access_token: FAKE_ACCESS_TOKEN,
                refresh_token: FAKE_REFRESH_TOKEN,
                expires_in: 604800,
              }),
              { status: 200 }
            );
          }

          throw new Error(`Unexpected url ${urlStr}`);
        };

        const code = await runCli(["auth", "simkl"], {
          loadConfig: () => config,
          fetch: mockFetch,
          sleep: async (ms) => {
            sleepCalls.push(ms);
          },
          nowMs: () => 1792250000000,
          out: (line) => allCliOutputs.push(line),
          err: (line) => allCliOutputs.push(line),
        });

        expect(code).toBe(0);
        expect(pollCount).toBe(2);
        // Initial wait is 5000ms. After slow_down, interval += 5s, so next wait is 10000ms!
        expect(sleepCalls).toEqual([5000, 10000]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("pending keeps the same interval", async () => {
      const dir = mkdtempSync(join(tmpdir(), "it-simkl-cli-"));
      try {
        const config = makeMockConfig(dir, FAKE_CLIENT_ID);
        const sleepCalls: number[] = [];
        let pollCount = 0;

        const mockFetch = async (input: string | URL | Request) => {
          const urlStr = input.toString();
          if (urlStr.includes("/oauth2/device")) {
            return new Response(
              JSON.stringify({
                device_code: FAKE_DEVICE_CODE,
                user_code: FAKE_USER_CODE,
                verification_uri: FAKE_URI,
                verification_uri_complete: FAKE_URI_COMPLETE,
                expires_in: 900,
                interval: 5,
              }),
              { status: 200 }
            );
          }

          if (urlStr.includes("/oauth2/token")) {
            pollCount++;
            if (pollCount === 1) {
              return new Response(JSON.stringify({ error: "authorization_pending" }), {
                status: 400,
              });
            }
            return new Response(
              JSON.stringify({
                access_token: FAKE_ACCESS_TOKEN,
                refresh_token: FAKE_REFRESH_TOKEN,
                expires_in: 604800,
              }),
              { status: 200 }
            );
          }

          throw new Error(`Unexpected url ${urlStr}`);
        };

        const code = await runCli(["auth", "simkl"], {
          loadConfig: () => config,
          fetch: mockFetch,
          sleep: async (ms) => {
            sleepCalls.push(ms);
          },
          nowMs: () => 1792250000000,
          out: (line) => allCliOutputs.push(line),
          err: (line) => allCliOutputs.push(line),
        });

        expect(code).toBe(0);
        expect(pollCount).toBe(2);
        // Both intervals are 5000ms
        expect(sleepCalls).toEqual([5000, 5000]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("expired_token stops, prints message, and exits 2", async () => {
      const dir = mkdtempSync(join(tmpdir(), "it-simkl-cli-"));
      try {
        const config = makeMockConfig(dir, FAKE_CLIENT_ID);
        const errLines: string[] = [];

        const mockFetch = async (input: string | URL | Request) => {
          const urlStr = input.toString();
          if (urlStr.includes("/oauth2/device")) {
            return new Response(
              JSON.stringify({
                device_code: FAKE_DEVICE_CODE,
                user_code: FAKE_USER_CODE,
                verification_uri: FAKE_URI,
                verification_uri_complete: FAKE_URI_COMPLETE,
                expires_in: 900,
                interval: 5,
              }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/oauth2/token")) {
            return new Response(JSON.stringify({ error: "expired_token" }), { status: 400 });
          }
          throw new Error(`Unexpected ${urlStr}`);
        };

        const code = await runCli(["auth", "simkl"], {
          loadConfig: () => config,
          fetch: mockFetch,
          sleep: async () => {},
          out: (line) => allCliOutputs.push(line),
          err: (line) => {
            errLines.push(line);
            allCliOutputs.push(line);
          },
        });

        expect(code).toBe(2);
        const combined = errLines.join("\n");
        expect(combined).toContain("code expired, run 'it auth simkl' again");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("invalid_client stops, prints register V2 app message, and exits 2", async () => {
      const dir = mkdtempSync(join(tmpdir(), "it-simkl-cli-"));
      try {
        const config = makeMockConfig(dir, FAKE_CLIENT_ID);
        const errLines: string[] = [];

        const mockFetch = async (input: string | URL | Request) => {
          const urlStr = input.toString();
          if (urlStr.includes("/oauth2/device")) {
            return new Response(
              JSON.stringify({
                device_code: FAKE_DEVICE_CODE,
                user_code: FAKE_USER_CODE,
                verification_uri: FAKE_URI,
                verification_uri_complete: FAKE_URI_COMPLETE,
                expires_in: 900,
                interval: 5,
              }),
              { status: 200 }
            );
          }
          if (urlStr.includes("/oauth2/token")) {
            return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
          }
          throw new Error(`Unexpected ${urlStr}`);
        };

        const code = await runCli(["auth", "simkl"], {
          loadConfig: () => config,
          fetch: mockFetch,
          sleep: async () => {},
          out: (line) => allCliOutputs.push(line),
          err: (line) => {
            errLines.push(line);
            allCliOutputs.push(line);
          },
        });

        expect(code).toBe(2);
        const combined = errLines.join("\n");
        expect(combined).toContain("wrong client_id or a V1 app: register a V2 app");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("own deadline reached stops, prints timeout message, and exits 2", async () => {
      const dir = mkdtempSync(join(tmpdir(), "it-simkl-cli-"));
      try {
        const config = makeMockConfig(dir, FAKE_CLIENT_ID);
        const errLines: string[] = [];
        let fakeNow = 1000;

        const mockFetch = async (input: string | URL | Request) => {
          const urlStr = input.toString();
          if (urlStr.includes("/oauth2/device")) {
            return new Response(
              JSON.stringify({
                device_code: FAKE_DEVICE_CODE,
                user_code: FAKE_USER_CODE,
                verification_uri: FAKE_URI,
                verification_uri_complete: FAKE_URI_COMPLETE,
                expires_in: 900, // 15 min; deadline capped to 10 min = 600 s
                interval: 5,
              }),
              { status: 200 }
            );
          }
          // If polled, return authorization_pending
          return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
        };

        const code = await runCli(["auth", "simkl"], {
          loadConfig: () => config,
          fetch: mockFetch,
          nowMs: () => fakeNow,
          sleep: async (ms) => {
            // Jump beyond the 600s deadline
            fakeNow += 601 * 1000;
          },
          out: (line) => allCliOutputs.push(line),
          err: (line) => {
            errLines.push(line);
            allCliOutputs.push(line);
          },
        });

        expect(code).toBe(2);
        const combined = errLines.join("\n");
        expect(combined).toContain("timed out");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Secrecy in CLI output", () => {
    test("device_code, access_token, and refresh_token never appear in stdout or stderr", () => {
      expect(allCliOutputs.length).toBeGreaterThan(10);
      for (const line of allCliOutputs) {
        expect(line).not.toContain(FAKE_ACCESS_TOKEN);
        expect(line).not.toContain(FAKE_REFRESH_TOKEN);
        expect(line).not.toContain(FAKE_DEVICE_CODE);
      }
    });
  });
});
