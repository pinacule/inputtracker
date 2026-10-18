import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/core/config.ts";
import type { LookupSearchResult, WorkDetails } from "../src/core/contract.ts";
import { openDb } from "../src/core/db.ts";
import { createApp } from "../src/server/app.ts";
import { metaCoverCacheDir } from "../src/server/metadata/index.ts";

const FAKE_TMDB_KEY = "test-tmdb-key-2";
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function makeConfig(dbPath: string, overrides: Partial<Config> = {}): Config {
  return {
    timezone: "Europe/Bratislava",
    server: { bind: "127.0.0.1", port: 8787 },
    storage: {
      db_path: dbPath,
      backup_dir: join(dirname(dbPath), "backups"),
      backup_keep: 14,
    },
    audiobookshelf: {
      url: "http://abs.invalid:13378",
      token: "SYNTHETIC-ABS-TOKEN",
      timeout_s: 20,
    },
    simkl: {
      client_id: "",
      base_url: "https://api.simkl.invalid",
      poster_base_url: "https://simkl.invalid/posters",
      timeout_s: 20,
    },
    youtube: { thumb_base_url: "https://yt.invalid/vi" },
    covers: {
      external: true,
      openlibrary_url: "https://openlibrary.invalid",
      openlibrary_covers_url: "https://covers.openlibrary.invalid",
    },
    metadata: {
      enabled: true,
      anilist_url: "https://anilist.invalid/graphql",
      tvmaze_url: "https://tvmaze.invalid",
      cinemeta_url: "https://cinemeta.invalid",
      itunes_url: "https://itunes.invalid",
      openlibrary_url: "https://openlibrary.invalid",
      openlibrary_covers_url: "https://covers.openlibrary.invalid",
      tmdb_url: "https://tmdb.invalid/3",
      tmdb_image_url: "https://image.tmdb.invalid/t/p",
      tmdb_api_key: FAKE_TMDB_KEY,
    },
    notify: {
      desktop: false,
      ntfy_url: "",
      ntfy_token: "",
      app_url: "",
      weekly_summary: false,
    },
    toJSON: () => ({}),
    toString: () => "",
    ...overrides,
  } as Config;
}

describe("Lookup HTTP routes via createApp", () => {
  let db: Database;
  let tempDir: string;
  let dbPath: string;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "it-lookup-routes-"));
    dbPath = join(tempDir, "inputtracker.db");
    config = makeConfig(dbPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("GET /api/lookup/search validates query parameters strictly", async () => {
    let fetchCalls = 0;
    const app = createApp({
      db,
      config,
      fetchImage: (async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    // Missing q
    const r1 = await app.request("/api/lookup/search");
    expect(r1.status).toBe(400);

    // Empty / whitespace q
    const r2 = await app.request("/api/lookup/search?q=%20%20");
    expect(r2.status).toBe(400);

    // Too long q (> 200 chars)
    const r3 = await app.request(`/api/lookup/search?q=${"a".repeat(201)}`);
    expect(r3.status).toBe(400);

    // Invalid category
    const r4 = await app.request("/api/lookup/search?q=vinland&category=not-a-category");
    expect(r4.status).toBe(400);

    // Unknown query param
    const r5 = await app.request("/api/lookup/search?q=vinland&extra=1");
    expect(r5.status).toBe(400);

    expect(fetchCalls).toBe(0);
  });

  test("GET /api/lookup/search returns ranked results and failed_providers", async () => {
    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("anilist.invalid")) {
        return new Response(
          JSON.stringify({
            data: {
              Page: {
                media: [
                  {
                    id: 101348,
                    type: "ANIME",
                    format: "TV",
                    episodes: 24,
                    seasonYear: 2019,
                    popularity: 350000,
                    title: { english: "Vinland Saga", romaji: "Vinland Saga" },
                    coverImage: { large: "https://anilist.invalid/cover/101348.jpg" },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const app = createApp({ db, config, fetchImage: mockFetch });
    const res = await app.request("/api/lookup/search?q=Vinland%20Saga&category=anime");
    expect(res.status).toBe(200);
    const body = (await res.json()) as LookupSearchResult;
    expect(body.query).toBe("Vinland Saga");
    expect(body.category).toBe("anime");
    expect(body.failed_providers).toEqual([]);
    expect(body.results).toEqual([
      {
        provider: "anilist",
        provider_id: "101348",
        category: "anime",
        title: "Vinland Saga",
        subtitle: "2019 · 24 episodes",
        year: 2019,
        cover_url: "/api/meta-cover/anilist/101348",
      },
    ]);
  });

  test("GET /api/lookup/work/:provider/:id rejects invalid provider/id and maps 200, 404, 502", async () => {
    let fetchCalls = 0;
    const mockFetch = (async (input: unknown) => {
      fetchCalls += 1;
      const url = String(input);
      if (url.includes("itunes.invalid/lookup?id=404000")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("itunes.invalid/lookup?id=500000")) {
        throw new Error(`Upstream failure with key ${FAKE_TMDB_KEY}`);
      }
      if (url.includes("itunes.invalid/lookup?id=1001")) {
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [
              {
                trackId: 1001,
                trackName: "Synthetic Arrival",
                artistName: "Denis Test",
                releaseDate: "2016-11-11T00:00:00Z",
                trackTimeMillis: 6_960_000,
                primaryGenreName: "Sci-Fi",
                longDescription: "Linguist works with the military to communicate with alien lifeforms.",
                artworkUrl100: "https://itunes.invalid/img/100x100bb.jpg",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const app = createApp({ db, config, fetchImage: mockFetch });

    // Invalid provider or id -> 400 without calling fetch
    for (const badPath of [
      "/api/lookup/work/unknown/123",
      "/api/lookup/work/itunes/..%2Fetc",
      "/api/lookup/work/itunes/bad$id",
      `/api/lookup/work/itunes/${"x".repeat(65)}`,
      "/api/lookup/work/itunes/123/extra",
      "/api/lookup/work/itunes/123?unexpected=1",
    ]) {
      const badRes = await app.request(badPath);
      expect(badRes.status).toBe(400);
    }
    expect(fetchCalls).toBe(0);

    // 404 when work does not exist
    const notFound = await app.request("/api/lookup/work/itunes/404000");
    expect(notFound.status).toBe(404);

    // 502 when upstream fails, and secret is redacted in error message
    const upstreamFail = await app.request("/api/lookup/work/itunes/500000");
    expect(upstreamFail.status).toBe(502);
    const errJson = (await upstreamFail.json()) as { error: string };
    expect(errJson.error).not.toContain(FAKE_TMDB_KEY);
    expect(errJson.error).toContain("***");

    // 200 happy path
    const okRes = await app.request("/api/lookup/work/itunes/1001");
    expect(okRes.status).toBe(200);
    const work = (await okRes.json()) as WorkDetails;
    expect(work.title).toBe("Synthetic Arrival");
    expect(work.runtime_minutes).toBe(116);
    expect(work.cover_url).toBe("/api/meta-cover/itunes/1001");
  });

  test("GET /api/meta-cover/:provider/:id validates params, enforces image type & 5 MB cap, and caches permanently", async () => {
    let fetchCalls = 0;
    const mockFetch = (async (input: unknown) => {
      fetchCalls += 1;
      const url = String(input);
      if (url.includes("/b/id/8888-M.jpg")) {
        return new Response(PNG_BYTES, {
          status: 200,
          headers: { "content-type": "image/png; charset=binary" },
        });
      }
      if (url.includes("/b/id/9991-M.jpg")) {
        return new Response("<html>not an image</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.includes("/b/id/9992-M.jpg")) {
        const huge = new Uint8Array(5 * 1024 * 1024 + 10);
        return new Response(huge, {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const app = createApp({ db, config, fetchImage: mockFetch });

    // Bad paths -> 400, zero network calls
    for (const bad of [
      "/api/meta-cover/unknown/123",
      "/api/meta-cover/openlibrary/..%2Fpasswd",
      "/api/meta-cover/openlibrary/bad$id",
      `/api/meta-cover/openlibrary/${"a".repeat(65)}`,
      "/api/meta-cover/openlibrary/123/extra",
      "/api/meta-cover/openlibrary/123?foo=bar",
    ]) {
      const res = await app.request(bad);
      expect(res.status).toBe(400);
    }
    expect(fetchCalls).toBe(0);

    // Non-image content-type -> 404 and not cached
    const htmlRes = await app.request("/api/meta-cover/openlibrary/9991");
    expect(htmlRes.status).toBe(404);
    expect(existsSync(join(metaCoverCacheDir(config), "openlibrary_9991.img"))).toBe(false);

    // > 5 MB -> 404 and not cached
    const hugeRes = await app.request("/api/meta-cover/openlibrary/9992");
    expect(hugeRes.status).toBe(404);
    expect(existsSync(join(metaCoverCacheDir(config), "openlibrary_9992.img"))).toBe(false);

    // Valid image -> 200, cached on disk, second request hits disk without fetching
    const callsBeforeValid = fetchCalls;
    const validRes1 = await app.request("/api/meta-cover/openlibrary/8888");
    expect(validRes1.status).toBe(200);
    expect(validRes1.headers.get("content-type")).toBe("image/png");
    expect(validRes1.headers.get("cache-control")).toContain("max-age=");
    expect(new Uint8Array(await validRes1.arrayBuffer())).toEqual(PNG_BYTES);
    expect(fetchCalls).toBe(callsBeforeValid + 1);

    // Second request is a cache hit: the fake is not called again.
    const validRes2 = await app.request("/api/meta-cover/openlibrary/8888");
    expect(validRes2.status).toBe(200);
    expect(new Uint8Array(await validRes2.arrayBuffer())).toEqual(PNG_BYTES);
    expect(fetchCalls).toBe(callsBeforeValid + 1);
  });

  test("GET /api/meta-cover/:provider/:id coalesces concurrent requests and serves cached covers even when metadata.enabled = false", async () => {
    let imageDownloads = 0;
    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/shows/777")) {
        return new Response(
          JSON.stringify({
            id: 777,
            name: "Concurrent Show",
            image: { medium: "https://tvmaze.invalid/img/777.png" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/img/777.png")) {
        imageDownloads += 1;
        await new Promise((r) => setTimeout(r, 25));
        return new Response(PNG_BYTES, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const app = createApp({ db, config, fetchImage: mockFetch });

    const [r1, r2, r3] = await Promise.all([
      app.request("/api/meta-cover/tvmaze/777"),
      app.request("/api/meta-cover/tvmaze/777"),
      app.request("/api/meta-cover/tvmaze/777"),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(imageDownloads).toBe(1);

    // Disable metadata in config: cached cover must still be served!
    const disabledConfig = makeConfig(dbPath, {
      metadata: {
        ...config.metadata!,
        enabled: false,
      },
    });
    const disabledApp = createApp({
      db,
      config: disabledConfig,
      fetchImage: (async () => {
        throw new Error("network must not be called when disabled");
      }) as unknown as typeof fetch,
    });

    const cachedCoverRes = await disabledApp.request("/api/meta-cover/tvmaze/777");
    expect(cachedCoverRes.status).toBe(200);
    expect(new Uint8Array(await cachedCoverRes.arrayBuffer())).toEqual(PNG_BYTES);

    // Uncached cover when disabled returns 404 without network
    const uncachedCoverRes = await disabledApp.request("/api/meta-cover/tvmaze/888");
    expect(uncachedCoverRes.status).toBe(404);

    // Search when disabled returns empty results without network
    const searchWhenDisabled = await disabledApp.request("/api/lookup/search?q=test");
    expect(searchWhenDisabled.status).toBe(200);
    const searchBody = (await searchWhenDisabled.json()) as LookupSearchResult;
    expect(searchBody.results).toEqual([]);
    expect(searchBody.failed_providers).toEqual([]);
  });
});
