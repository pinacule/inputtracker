import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { createApp } from "../src/server/app.ts";
import { shouldCacheApi } from "../web/src/lib/pwa.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const PUBLIC_DIR = join(REPO_ROOT, "web", "public");
const SW_PATH = join(PUBLIC_DIR, "sw.js");
const MANIFEST_PATH = join(PUBLIC_DIR, "manifest.webmanifest");
const BUILD_TIMEOUT_MS = 60_000;

// --- Synthetic, PC-independent config for `createApp` -----------------------

function mockConfig(): Config {
  const cfg: Config = {
    timezone: "Europe/Bratislava",
    server: { bind: "127.0.0.1", port: 8787 },
    storage: {
      db_path: ":memory:",
      backup_dir: "/tmp/backups",
      backup_keep: 14,
    },
    audiobookshelf: { url: "", token: "", timeout_s: 20 },
    simkl: { client_id: "", base_url: "https://api.simkl.test", poster_base_url: "https://simkl.in/posters", timeout_s: 20 },
    notify: { desktop: false, ntfy_url: "" },
    toJSON: () => ({ ...cfg }),
    toString: () => JSON.stringify(cfg),
  };
  return cfg;
}

// --- Manifest + icon helpers ------------------------------------------------

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface Manifest {
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  icons?: ManifestIcon[];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Asserts the PNG signature and returns the IHDR width/height. */
function readPngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    expect(bytes[i]).toBe(PNG_SIGNATURE[i]);
  }
  expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

describe("web app manifest and icons", () => {
  test("manifest declares the required PWA fields", () => {
    const manifest = readManifest();

    expect(manifest.name).toBe("InputTracker");
    expect(manifest.short_name).toBe("InputTracker");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(Array.isArray(manifest.icons)).toBe(true);
  });

  test("manifest lists an SVG icon plus maskable 192/512 PNG icons", () => {
    const icons = readManifest().icons ?? [];

    const svg = icons.find((icon) => icon.src === "/icon.svg");
    expect(svg).toBeDefined();
    expect(svg?.sizes).toBe("any");
    expect(svg?.type).toBe("image/svg+xml");

    for (const size of [192, 512] as const) {
      const png = icons.find((icon) => icon.src === `/icon-${size}.png`);
      expect(png).toBeDefined();
      expect(png?.sizes).toBe(`${size}x${size}`);
      expect(png?.type).toBe("image/png");
      expect(String(png?.purpose)).toContain("maskable");
    }
  });

  test("committed PNG icons are valid RGBA PNGs of the right size", () => {
    for (const size of [192, 512] as const) {
      const file = join(PUBLIC_DIR, `icon-${size}.png`);
      expect(existsSync(file)).toBe(true);
      const { width, height } = readPngSize(file);
      expect(width).toBe(size);
      expect(height).toBe(size);
    }
  });
});

// --- Fake service-worker sandbox -------------------------------------------

interface MockRequest {
  url: string;
  method: string;
  mode: string;
}

interface MockCache {
  put(request: MockRequest | string, response: Response): Promise<void>;
  match(request: MockRequest | string): Promise<Response | undefined>;
}

interface MockCaches {
  open(name: string): Promise<MockCache>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

function requestKey(request: MockRequest | string): string {
  return typeof request === "string" ? request : request.url;
}

function createMockCaches(): {
  caches: MockCaches;
  stores: Map<string, Map<string, Response>>;
} {
  const stores = new Map<string, Map<string, Response>>();
  const caches: MockCaches = {
    async open(name) {
      let store = stores.get(name);
      if (!store) {
        store = new Map<string, Response>();
        stores.set(name, store);
      }
      const current = store;
      return {
        async put(request, response) {
          current.set(requestKey(request), response);
        },
        async match(request) {
          return current.get(requestKey(request));
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  return { caches, stores };
}

type FetchLike = (
  input: string | MockRequest,
  init?: RequestInit
) => Promise<Response>;

type Listeners = Record<string, (event: unknown) => void>;

/**
 * Loads `sw.js` into a sandbox with stubbed `self`, `caches`, `fetch`, `URL`
 * and `Response`, and returns the captured event listeners.
 */
function loadServiceWorker(fetchImpl: FetchLike, cachesImpl: MockCaches): Listeners {
  const listeners: Listeners = {};
  const selfStub = {
    location: { origin: "https://inputtracker.test" },
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners[type] = listener;
    },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };

  const code = readFileSync(SW_PATH, "utf8");
  const factory = new Function(
    "self",
    "caches",
    "fetch",
    "URL",
    "Response",
    code
  ) as (
    self: unknown,
    caches: unknown,
    fetch: unknown,
    url: unknown,
    response: unknown
  ) => void;
  factory(selfStub, cachesImpl, fetchImpl, URL, Response);
  return listeners;
}

function fetchEvent(request: MockRequest): {
  event: unknown;
  called: () => boolean;
} {
  let called = false;
  const event = {
    request,
    respondWith: () => {
      called = true;
    },
  };
  return { event, called: () => called };
}

describe("service worker caching", () => {
  test("cacheable GET /api is network-first and falls back to the cache offline", async () => {
    const { caches } = createMockCaches();
    const request: MockRequest = {
      url: "https://inputtracker.test/api/calendar?month=2026-10",
      method: "GET",
      mode: "cors",
    };
    const payload = { month: "2026-10", days: [] as unknown[] };

    const online = loadServiceWorker(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      caches
    );

    let onlineResponse: Promise<Response> | undefined;
    online.fetch?.({
      request,
      respondWith: (p: Promise<Response>) => {
        onlineResponse = p;
      },
    });
    expect(onlineResponse).toBeDefined();
    const first = await onlineResponse!;
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(payload);

    // Network is gone: the last good response is served from the cache.
    const offline = loadServiceWorker(async () => {
      throw new Error("offline");
    }, caches);

    let offlineResponse: Promise<Response> | undefined;
    offline.fetch?.({
      request,
      respondWith: (p: Promise<Response>) => {
        offlineResponse = p;
      },
    });
    expect(offlineResponse).toBeDefined();
    const second = await offlineResponse!;
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(payload);
  });

  test("same-origin static GETs use stale-while-revalidate", async () => {
    const { caches } = createMockCaches();
    const request: MockRequest = {
      url: "https://inputtracker.test/assets/app.js",
      method: "GET",
      mode: "cors",
    };

    const firstWorker = loadServiceWorker(
      async () => new Response("asset-v1", { status: 200 }),
      caches
    );
    let firstResponse: Promise<Response> | undefined;
    firstWorker.fetch?.({
      request,
      respondWith: (p: Promise<Response>) => {
        firstResponse = p;
      },
    });
    expect(await (await firstResponse!).text()).toBe("asset-v1");

    const offlineWorker = loadServiceWorker(async () => {
      throw new Error("offline");
    }, caches);
    let cachedResponse: Promise<Response> | undefined;
    offlineWorker.fetch?.({
      request,
      respondWith: (p: Promise<Response>) => {
        cachedResponse = p;
      },
    });
    expect(await (await cachedResponse!).text()).toBe("asset-v1");
  });

  test("navigation falls back to the cached app shell when offline", async () => {
    const { caches } = createMockCaches();

    const online = loadServiceWorker(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/" || url.startsWith("https://inputtracker.test/")) {
        return new Response("<html>app shell</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response("", { status: 404 });
    }, caches);

    let installPromise: Promise<unknown> | undefined;
    online.install?.({
      waitUntil: (p: Promise<unknown>) => {
        installPromise = p;
      },
    });
    await installPromise;

    const offline = loadServiceWorker(async () => {
      throw new Error("offline");
    }, caches);
    let navResponse: Promise<Response> | undefined;
    offline.fetch?.({
      request: {
        url: "https://inputtracker.test/calendar",
        method: "GET",
        mode: "navigate",
      },
      respondWith: (p: Promise<Response>) => {
        navResponse = p;
      },
    });
    const response = await navResponse!;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("app shell");
  });

  test("non-GET requests are never intercepted or cached", () => {
    const { caches, stores } = createMockCaches();
    const listeners = loadServiceWorker(
      async () => new Response("{}", { status: 200 }),
      caches
    );

    const evt = fetchEvent({
      url: "https://inputtracker.test/api/events",
      method: "POST",
      mode: "cors",
    });
    listeners.fetch?.(evt.event);
    expect(evt.called()).toBe(false);
    expect(stores.size).toBe(0);
  });

  test("export and sync GET endpoints are not intercepted", () => {
    const { caches } = createMockCaches();
    const listeners = loadServiceWorker(
      async () => new Response("{}", { status: 200 }),
      caches
    );

    for (const path of [
      "/api/export.json",
      "/api/export.csv",
      "/api/sync/status",
      "/api/import",
    ]) {
      const evt = fetchEvent({
        url: `https://inputtracker.test${path}`,
        method: "GET",
        mode: "cors",
      });
      listeners.fetch?.(evt.event);
      expect(evt.called()).toBe(false);
    }
  });

  test("activate deletes old versioned caches but keeps unrelated ones", async () => {
    const { caches, stores } = createMockCaches();
    await caches.open("inputtracker-v0");
    await caches.open("unrelated-cache");

    const listeners = loadServiceWorker(
      async () => new Response("", { status: 200 }),
      caches
    );
    let activatePromise: Promise<unknown> | undefined;
    listeners.activate?.({
      waitUntil: (p: Promise<unknown>) => {
        activatePromise = p;
      },
    });
    await activatePromise;

    expect(stores.has("inputtracker-v0")).toBe(false);
    expect(stores.has("unrelated-cache")).toBe(true);
  });
});

// --- shouldCacheApi (mirrors the worker's rule) -----------------------------

describe("shouldCacheApi", () => {
  test("allows ordinary GET /api requests", () => {
    expect(shouldCacheApi("/api/calendar?month=2026-10", "GET")).toBe(true);
    expect(shouldCacheApi("https://inputtracker.test/api/health", "get")).toBe(
      true
    );
  });

  test("rejects non-GET, non-api and export/import/sync paths", () => {
    expect(shouldCacheApi("/api/events", "POST")).toBe(false);
    expect(shouldCacheApi("/assets/app.js", "GET")).toBe(false);
    expect(shouldCacheApi("/api/export.json", "GET")).toBe(false);
    expect(shouldCacheApi("/api/export.csv", "GET")).toBe(false);
    expect(shouldCacheApi("/api/sync/status", "GET")).toBe(false);
    expect(shouldCacheApi("/api/import", "POST")).toBe(false);
  });
});

// --- Server static serving of the PWA files ---------------------------------

describe("static serving of PWA files", () => {
  test("serves sw.js and manifest with real files, never the SPA fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inputtracker-pwa-"));
    try {
      writeFileSync(join(dir, "index.html"), "<html><body>SPA App</body></html>");
      writeFileSync(
        join(dir, "sw.js"),
        "self.addEventListener('fetch', function () {});"
      );
      writeFileSync(
        join(dir, "manifest.webmanifest"),
        JSON.stringify({ name: "InputTracker PWA" })
      );
      writeFileSync(
        join(dir, "icon-192.png"),
        readFileSync(join(PUBLIC_DIR, "icon-192.png"))
      );

      const app = createApp({
        db: openDb(":memory:"),
        config: mockConfig(),
        webDist: dir,
      });

      const sw = await app.request("/sw.js");
      expect(sw.status).toBe(200);
      expect(sw.headers.get("content-type")).toContain("javascript");
      expect(sw.headers.get("cache-control")).toBe("no-cache");
      const swBody = await sw.text();
      expect(swBody).toContain("addEventListener");
      expect(swBody).not.toContain("SPA App");

      const manifest = await app.request("/manifest.webmanifest");
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get("content-type")).toContain(
        "application/manifest+json"
      );
      const manifestBody = await manifest.text();
      expect(manifestBody).not.toContain("SPA App");
      expect((JSON.parse(manifestBody) as { name: string }).name).toBe(
        "InputTracker PWA"
      );

      const icon = await app.request("/icon-192.png");
      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toContain("image/png");

      // Unknown paths still fall back to the SPA shell.
      const spa = await app.request("/calendar");
      expect(await spa.text()).toContain("SPA App");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- Production build -------------------------------------------------------

describe("production build", () => {
  test(
    "bun run build:web succeeds and dist contains the PWA files",
    () => {
      const result = Bun.spawnSync(["bun", "run", "build:web"], {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) {
        console.error(String(result.stderr));
        console.error(String(result.stdout));
      }
      expect(result.exitCode).toBe(0);

      const dist = join(REPO_ROOT, "web", "dist");
      for (const file of [
        "index.html",
        "sw.js",
        "manifest.webmanifest",
        "icon.svg",
        "icon-192.png",
        "icon-512.png",
      ]) {
        expect(existsSync(join(dist, file))).toBe(true);
      }
    },
    BUILD_TIMEOUT_MS
  );
});
