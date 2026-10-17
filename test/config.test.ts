import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { loadConfig, redact, redactString } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "it-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a synthetic TOML file into the per-test temp dir. */
function writeConfig(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/** A path that is guaranteed not to exist (never reads the real config). */
function missingPath(): string {
  return join(dir, "does-not-exist.toml");
}

const FAKE_TOKEN = "FAKE-TOKEN-123";

function captureError(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return String(err);
  }
  throw new Error("expected the call to throw");
}

describe("loadConfig defaults", () => {
  test("missing file yields defaults and XDG_DATA_HOME-based paths", () => {
    const xdg = join(dir, "xdgdata");
    const config = loadConfig({ path: missingPath(), env: { XDG_DATA_HOME: xdg } });

    expect(config.timezone).toBe("Europe/Bratislava");
    expect(config.server).toEqual({ bind: "127.0.0.1", port: 8787 });
    expect(config.storage.db_path).toBe(join(xdg, "inputtracker", "inputtracker.db"));
    expect(config.storage.backup_dir).toBe(join(xdg, "inputtracker", "backups"));
    expect(config.storage.backup_keep).toBe(14);
    expect(config.audiobookshelf.url).toBe("http://localhost:13378");
    expect(config.audiobookshelf.token).toBe("");
    expect(config.audiobookshelf.timeout_s).toBe(20);
    expect(config.simkl).toEqual({
      client_id: "",
      base_url: "https://api.simkl.com",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 20,
    });
    expect(config.youtube).toEqual({
      thumb_base_url: "https://i.ytimg.com/vi",
    });
    expect(config.activitywatch).toEqual({
      url: "http://127.0.0.1:5600",
      timeout_s: 20,
      device: "pc",
      include_music: false,
    });
    // ntfy_token "" is part of the (public-by-value) defaults; redact() masks
    // any `*token*` key, so no serialized form of the config reveals it.
    expect(config.notify).toEqual({
      desktop: true,
      ntfy_url: "",
      app_url: "",
      weekly_summary: false,
      ntfy_token: "",
    } as Config["notify"]);
  });

  test("missing file falls back to the home directory when XDG_DATA_HOME is unset", () => {
    const config = loadConfig({ path: missingPath(), env: {} });
    const base = join(homedir(), ".local", "share", "inputtracker");

    expect(config.storage.db_path).toBe(join(base, "inputtracker.db"));
    expect(config.storage.backup_dir).toBe(join(base, "backups"));
  });
});

describe("loadConfig file merging", () => {
  test("every key is overridable via a TOML file", () => {
    const path = writeConfig(
      "all.toml",
      [
        'timezone = "UTC"',
        "",
        "[server]",
        'bind = "0.0.0.0"',
        "port = 9999",
        "",
        "[storage]",
        'db_path = "/tmp/fake/inputtracker.db"',
        'backup_dir = "/tmp/fake/backups"',
        "backup_keep = 3",
        "",
        "[audiobookshelf]",
        'url = "http://abs.example:13378"',
        `token = "${FAKE_TOKEN}"`,
        "timeout_s = 5",
        "",
        "[simkl]",
        'client_id = "test-client-id"',
        'base_url = "https://simkl.example"',
        'poster_base_url = "https://posters.example"',
        "timeout_s = 15",
        "",
        "[youtube]",
        'thumb_base_url = "https://thumbs.example"',
        "",
        "[activitywatch]",
        'url = "http://aw.example:5600"',
        "timeout_s = 10",
        'device = "laptop-1"',
        "include_music = true",
        "",
        "[notify]",
        "desktop = false",
        'ntfy_url = "https://ntfy.example/topic"',
        "",
      ].join("\n")
    );

    const config = loadConfig({ path, env: {} });

    expect(config.timezone).toBe("UTC");
    expect(config.server.bind).toBe("0.0.0.0");
    expect(config.server.port).toBe(9999);
    expect(config.storage.db_path).toBe("/tmp/fake/inputtracker.db");
    expect(config.storage.backup_dir).toBe("/tmp/fake/backups");
    expect(config.storage.backup_keep).toBe(3);
    expect(config.audiobookshelf.url).toBe("http://abs.example:13378");
    expect(config.audiobookshelf.token).toBe(FAKE_TOKEN);
    expect(config.audiobookshelf.timeout_s).toBe(5);
    expect(config.simkl.client_id).toBe("test-client-id");
    expect(config.simkl.base_url).toBe("https://simkl.example");
    expect(config.simkl.poster_base_url).toBe("https://posters.example");
    expect(config.simkl.timeout_s).toBe(15);
    expect(config.youtube.thumb_base_url).toBe("https://thumbs.example");
    expect(config.activitywatch).toEqual({
      url: "http://aw.example:5600",
      timeout_s: 10,
      device: "laptop-1",
      include_music: true,
    });
    expect(config.notify.desktop).toBe(false);
    expect(config.notify.ntfy_url).toBe("https://ntfy.example/topic");
  });

  test("a partial file keeps defaults for the other keys", () => {
    const path = writeConfig("partial.toml", "[storage]\nbackup_keep = 2\n");
    const config = loadConfig({ path, env: { XDG_DATA_HOME: join(dir, "xdg") } });

    expect(config.storage.backup_keep).toBe(2);
    expect(config.storage.db_path).toBe(
      join(dir, "xdg", "inputtracker", "inputtracker.db")
    );
    expect(config.timezone).toBe("Europe/Bratislava");
    expect(config.server.port).toBe(8787);
    expect(config.notify.desktop).toBe(true);
  });
});

describe("loadConfig path resolution", () => {
  test("INPUTTRACKER_CONFIG selects the path", () => {
    const path = writeConfig("env.toml", 'timezone = "UTC"\n');

    const config = loadConfig({
      env: { INPUTTRACKER_CONFIG: path, XDG_DATA_HOME: join(dir, "xdg") },
    });

    expect(config.timezone).toBe("UTC");
  });

  test("opts.path beats INPUTTRACKER_CONFIG", () => {
    const envPath = writeConfig("env.toml", 'timezone = "UTC"\n');
    const optPath = writeConfig("opt.toml", 'timezone = "Asia/Tokyo"\n');

    const config = loadConfig({
      path: optPath,
      env: { INPUTTRACKER_CONFIG: envPath },
    });

    expect(config.timezone).toBe("Asia/Tokyo");
  });
});

describe("loadConfig errors", () => {
  test("malformed TOML throws and never echoes the token", () => {
    const path = writeConfig("bad.toml", `token = "${FAKE_TOKEN}\n[server\n`);

    expect(() => loadConfig({ path, env: {} })).toThrow();
    expect(captureError(() => loadConfig({ path, env: {} }))).not.toContain(FAKE_TOKEN);
  });

  test("wrong type (port as string) throws and never echoes the token", () => {
    const path = writeConfig(
      "badtype.toml",
      [
        'timezone = "UTC"',
        "[server]",
        'port = "8787"',
        "[audiobookshelf]",
        `token = "${FAKE_TOKEN}"`,
        "",
      ].join("\n")
    );

    expect(() => loadConfig({ path, env: {} })).toThrow(/server\.port/);
    expect(captureError(() => loadConfig({ path, env: {} }))).not.toContain(FAKE_TOKEN);
  });

  test("wrong type for simkl keys throws", () => {
    const badClient = writeConfig("badclient.toml", '[simkl]\nclient_id = 12345\n');
    expect(() => loadConfig({ path: badClient, env: {} })).toThrow(/simkl\.client_id/);

    const badUrl = writeConfig("badurl.toml", '[simkl]\nbase_url = 12345\n');
    expect(() => loadConfig({ path: badUrl, env: {} })).toThrow(/simkl\.base_url/);

    const badPoster = writeConfig("badposter.toml", '[simkl]\nposter_base_url = 12345\n');
    expect(() => loadConfig({ path: badPoster, env: {} })).toThrow(/simkl\.poster_base_url/);

    const badTimeout = writeConfig("badtimeout.toml", '[simkl]\ntimeout_s = "twenty"\n');
    expect(() => loadConfig({ path: badTimeout, env: {} })).toThrow(/simkl\.timeout_s/);

    const badTable = writeConfig("badtable.toml", 'simkl = "not-a-table"\n');
    expect(() => loadConfig({ path: badTable, env: {} })).toThrow(/simkl/);
  });

  test("wrong type for youtube keys throws", () => {
    const badThumb = writeConfig(
      "badthumb.toml",
      "[youtube]\nthumb_base_url = 12345\n"
    );
    expect(() => loadConfig({ path: badThumb, env: {} })).toThrow(
      /youtube\.thumb_base_url/
    );

    const badTable = writeConfig("badytable.toml", 'youtube = "not-a-table"\n');
    expect(() => loadConfig({ path: badTable, env: {} })).toThrow(/youtube/);
  });

  test("wrong type or invalid value for activitywatch keys throws", () => {
    const badUrl = writeConfig("badawurl.toml", "[activitywatch]\nurl = 12345\n");
    expect(() => loadConfig({ path: badUrl, env: {} })).toThrow(/activitywatch\.url/);

    const badTimeout = writeConfig(
      "badawtimeout.toml",
      '[activitywatch]\ntimeout_s = "twenty"\n'
    );
    expect(() => loadConfig({ path: badTimeout, env: {} })).toThrow(
      /activitywatch\.timeout_s/
    );

    const badMusic = writeConfig(
      "badawmusic.toml",
      '[activitywatch]\ninclude_music = "yes"\n'
    );
    expect(() => loadConfig({ path: badMusic, env: {} })).toThrow(
      /activitywatch\.include_music/
    );

    const badDeviceEmpty = writeConfig(
      "badawdevempty.toml",
      '[activitywatch]\ndevice = ""\n'
    );
    expect(() => loadConfig({ path: badDeviceEmpty, env: {} })).toThrow(
      /activitywatch\.device/
    );

    const badDeviceChars = writeConfig(
      "badawdevchars.toml",
      '[activitywatch]\ndevice = "PC_User!"\n'
    );
    expect(() => loadConfig({ path: badDeviceChars, env: {} })).toThrow(
      /activitywatch\.device/
    );

    const badDeviceLong = writeConfig(
      "badawdevlong.toml",
      `[activitywatch]\ndevice = "${"a".repeat(33)}"\n`
    );
    expect(() => loadConfig({ path: badDeviceLong, env: {} })).toThrow(
      /activitywatch\.device/
    );

    const badTable = writeConfig(
      "badawtable.toml",
      'activitywatch = "not-a-table"\n'
    );
    expect(() => loadConfig({ path: badTable, env: {} })).toThrow(/activitywatch/);
  });
});

describe("redaction", () => {
  test("the token never leaks but stays accessible", () => {
    const path = writeConfig(
      "secret.toml",
      `[audiobookshelf]\ntoken = "${FAKE_TOKEN}"\n[simkl]\nclient_id = "public-client-id"\n`
    );
    const config = loadConfig({ path, env: {} });

    // Accessible through the (non-enumerable) property.
    expect(config.audiobookshelf.token).toBe(FAKE_TOKEN);

    // Never leaks through any common serialization path.
    expect(String(config)).not.toContain(FAKE_TOKEN);
    expect(`${config}`).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(config)).not.toContain(FAKE_TOKEN);
    expect(redact(config)).not.toContain(FAKE_TOKEN);
    expect(inspect(config)).not.toContain(FAKE_TOKEN);

    // client_id is public, so it is preserved and not masked.
    expect(config.simkl.client_id).toBe("public-client-id");
    expect(JSON.stringify(config)).toContain("public-client-id");

    // The redacted shape keeps the non-secret keys.
    expect(JSON.parse(JSON.stringify(config))).toMatchObject({
      timezone: "Europe/Bratislava",
      audiobookshelf: { url: "http://localhost:13378", timeout_s: 20 },
      simkl: { client_id: "public-client-id", base_url: "https://api.simkl.com", poster_base_url: "https://simkl.in/posters", timeout_s: 20 },
    });
  });

  test("redactString masks free text", () => {
    const path = writeConfig(
      "secret.toml",
      `[audiobookshelf]\ntoken = "${FAKE_TOKEN}"\n`
    );
    const config = loadConfig({ path, env: {} });

    expect(redactString(`token=${FAKE_TOKEN}`, config)).toBe("token=***");
    expect(redactString("nothing secret", config)).toBe("nothing secret");
    expect(redactString(FAKE_TOKEN, config)).toBe("***");
  });

  test("redact masks token-like keys and free text in plain values", () => {
    const path = writeConfig(
      "secret.toml",
      `[audiobookshelf]\ntoken = "${FAKE_TOKEN}"\n`
    );
    loadConfig({ path, env: {} });

    expect(redact({ token: FAKE_TOKEN })).not.toContain(FAKE_TOKEN);
    expect(redact({ error: `failed with ${FAKE_TOKEN}` })).not.toContain(FAKE_TOKEN);
    expect(redact(`auth=${FAKE_TOKEN}`)).not.toContain(FAKE_TOKEN);
  });
});

const FAKE_INGEST_TOKEN = "INGEST-FAKE-TOKEN-0123456789abcdefgh"; // 37 chars

describe("ingest config", () => {
  test("missing [ingest] yields an empty token (ingest disabled)", () => {
    const config = loadConfig({ path: missingPath(), env: {} });
    expect(config.ingest?.token).toBe("");
    // Serialized output shows `ingest` as an empty object (no token key).
    expect((JSON.parse(JSON.stringify(config)) as { ingest: object }).ingest).toEqual({});
  });

  test("the token is readable but never leaks through serialization", () => {
    const path = writeConfig(
      "ingest.toml",
      `[ingest]\ntoken = "${FAKE_INGEST_TOKEN}"\n`
    );
    const config = loadConfig({ path, env: {} });

    // Accessible for the endpoint, non-enumerable for every serializer.
    expect(config.ingest?.token).toBe(FAKE_INGEST_TOKEN);
    expect(String(config)).not.toContain(FAKE_INGEST_TOKEN);
    expect(`${config}`).not.toContain(FAKE_INGEST_TOKEN);
    expect(JSON.stringify(config)).not.toContain(FAKE_INGEST_TOKEN);
    expect(inspect(config)).not.toContain(FAKE_INGEST_TOKEN);
    expect(redact(config)).not.toContain(FAKE_INGEST_TOKEN);
    expect(redactString(`Bearer ${FAKE_INGEST_TOKEN}`, config)).toBe("Bearer ***");
    // Free-text masking without the config object (the route never logs anyway).
    expect(redact(`token=${FAKE_INGEST_TOKEN}`)).not.toContain(FAKE_INGEST_TOKEN);
  });

  test("a non-empty token shorter than 32 characters is a config error", () => {
    const path = writeConfig(
      "short.toml",
      '[ingest]\ntoken = "too-short-token"\n'
    );
    expect(() => loadConfig({ path, env: {} })).toThrow(/ingest\.token/);
    // The error never quotes the token value itself.
    expect(captureError(() => loadConfig({ path, env: {} }))).not.toContain(
      "too-short-token"
    );
  });

  test("a 32-character token is accepted", () => {
    const token = "a".repeat(32);
    const path = writeConfig("ok32.toml", `[ingest]\ntoken = "${token}"\n`);
    const config = loadConfig({ path, env: {} });
    expect(config.ingest?.token).toBe(token);
  });

  test("wrong types for ingest keys throw", () => {
    const bad = writeConfig("badingest.toml", "[ingest]\ntoken = 12345\n");
    expect(() => loadConfig({ path: bad, env: {} })).toThrow(/ingest\.token/);
    const badTable = writeConfig("badingesttable.toml", 'ingest = "nope"\n');
    expect(() => loadConfig({ path: badTable, env: {} })).toThrow(/ingest/);
  });
});
