import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { Config } from "../src/core/config.ts";
import type { WorkArtImage, WorkDetails } from "../src/core/contract.ts";
import { openDb } from "../src/core/db.ts";
import { saveArchiveEntry } from "../src/server/archive.ts";
import { coverCacheDir, titleCoverId } from "../src/server/covers.ts";
import { buildAllLibraryWorks, editLibraryWork } from "../src/server/library.ts";
import { registerLookupRoutes } from "../src/server/lookup-routes.ts";
import { getMetaArtImage, getMetaArtList } from "../src/server/metadata/art.ts";
import { artSource } from "../src/server/metadata/art-types.ts";
import { metadataCacheDir, readArtSources, WORK_CACHE_TTL_MS, writeArtSources, writeBannerSource, writeCoverUrlCache } from "../src/server/metadata/cache.ts";
import { MAX_META_COVER_BYTES } from "../src/server/metadata/http.ts";
import { lookupWork, type MetadataDeps } from "../src/server/metadata/index.ts";
import { metaArtUrl } from "../src/server/metadata/types.ts";
import { artworkAlt, featuredArtIndex, localArtImages, localArtListUrl, nextArtIndex } from "../web/src/lib/work-art.ts";

const fakeFetch = (fn: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => fn(String(input), init)) as typeof fetch;
const png = (byte = 1) => new Response(new Uint8Array([137, 80, 78, 71, byte]), { headers: { "Content-Type": "image/png" } });
const noFetch = fakeFetch(() => { throw new Error("Unexpected request; network disabled in tests"); });
const snapshot: WorkDetails = {
  provider: "itunes", provider_id: "98001", category: "music", title: "Synthetic Song",
  original_title: null, year: 2020, cover_url: "/api/meta-cover/itunes/98001", creators: ["Synthetic Artist"],
  genres: [], description: null, seasons: [], runtime_minutes: null, pages: null, external_ids: { itunes: "98001" },
};

function configFor(dir: string): Config {
  return {
    timezone: "Europe/Bratislava",
    storage: { db_path: join(dir, "synthetic.db"), backup_dir: join(dir, "backups"), backup_keep: 1 },
    server: { bind: "127.0.0.1", port: 8787 },
    audiobookshelf: { url: "https://abs.invalid", token: "", timeout_s: 1 },
    simkl: { client_id: "", base_url: "https://simkl.invalid", poster_base_url: "https://posters.invalid", timeout_s: 1 },
    youtube: { thumb_base_url: "https://thumb.invalid" },
    metadata: {
      enabled: true, anilist_url: "https://anilist.invalid", tvmaze_url: "https://tvmaze.invalid",
      cinemeta_url: "https://cinemeta.invalid", itunes_url: "https://itunes.invalid",
      openlibrary_url: "https://ol.invalid", openlibrary_covers_url: "https://covers.invalid",
      tmdb_url: "https://tmdb.invalid/3", tmdb_image_url: "https://images.invalid", steam_url: "https://steam.invalid", steam_cdn_url: "https://steamcdn.invalid", wikipedia_url: "https://wikipedia.invalid", wikidata_url: "https://wikidata.invalid", tmdb_api_key: "synthetic-key",
    },
    notify: { desktop: false, ntfy_url: "", ntfy_token: "", app_url: "", weekly_summary: false },
    toJSON: () => ({}), toString: () => "{}",
  };
}

describe("W18 local work art", () => {
  let dir: string;
  let config: Config;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "inputtracker-w18-")); config = configFor(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("route rejects invalid paths, provider/ID/index/query and non-GET without requests", async () => {
    let calls = 0;
    const app = new Hono();
    registerLookupRoutes(app, { config, fetch: fakeFetch(() => { calls++; return Response.json({}); }) });
    for (const path of [
      "/api/meta-art/unknown/123", "/api/meta-art/itunes/bad%20id", "/api/meta-art/itunes/bad%2Fid/0",
      "/api/meta-art/itunes/bad%2Eid/0", `/api/meta-art/itunes/${"a".repeat(65)}`,
      "/api/meta-art/itunes/123/-1", "/api/meta-art/itunes/123/8", "/api/meta-art/itunes/123/00",
      "/api/meta-art/itunes/123/1.5", "/api/meta-art/itunes/123/0/extra",
      "/api/meta-art/itunes", "/api/meta-art/itunes/123?url=https://bad.invalid", "/api/meta-art/itunes/123/0?x=1",
    ]) expect((await app.request(path)).status).toBe(400);
    expect((await app.request("/api/meta-art/itunes/123/0", { method: "POST" })).status).toBe(400);
    expect(calls).toBe(0);
  });

  test("empty and failed resolution is cached for the work TTL, with no empty images box", async () => {
    let calls = 0; let now = 1_000;
    const deps: MetadataDeps = { config, now: () => now, fetch: fakeFetch(() => { calls++; return Response.json({ results: [] }); }) };
    const app = new Hono(); registerLookupRoutes(app, { config, fetch: deps.fetch, nowMs: deps.now });
    const response = await app.request("/api/meta-art/itunes/98001");
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ images: [] });
    expect((await app.request("/api/meta-art/itunes/98001/0")).status).toBe(404);
    expect(calls).toBe(1);
    expect(readArtSources(config, "itunes", "98001", now)).toEqual([]);
    now += WORK_CACHE_TTL_MS;
    expect(await getMetaArtList("itunes", "98001", deps)).toEqual({ images: [] }); expect(calls).toBe(2);
    const failed = { config, fetch: fakeFetch(() => { calls++; throw new Error("Synthetic outage"); }) };
    expect(await getMetaArtList("tvmaze", "98002", failed)).toEqual({ images: [] });
    expect(await getMetaArtList("tvmaze", "98002", failed)).toEqual({ images: [] }); expect(calls).toBe(3);
  });

  test("concurrent list and byte requests share GETs; success survives disabled metadata and restart", async () => {
    let apiCalls = 0; let imageCalls = 0;
    const deps = { config, fetch: fakeFetch((url, init) => {
      expect(init?.method).toBe("GET");
      if (url.includes("itunes.invalid")) { apiCalls++; return Response.json({ results: [{ trackId: 98001, trackName: "Synthetic Song", artworkUrl100: "https://art.invalid/100x100bb.jpg" }] }); }
      expect(url).toBe("https://art.invalid/1200x1200bb.jpg"); imageCalls++; return png();
    }) };
    const results = await Promise.all(Array.from({ length: 6 }, () => getMetaArtList("itunes", "98001", deps)));
    expect(apiCalls).toBe(1); expect(imageCalls).toBe(0);
    expect(results[0]).toEqual({ images: [{ url: "/api/meta-art/itunes/98001/0", kind: "cover", width: null, height: null }] });
    const images = await Promise.all(Array.from({ length: 6 }, () => getMetaArtImage("itunes", "98001", 0, deps)));
    expect(imageCalls).toBe(1); expect(images.every((image) => image?.contentType === "image/png")).toBe(true);
    const offlineConfig = { ...config, metadata: { ...config.metadata!, enabled: false } };
    const offline = { config: offlineConfig, now: () => Date.now() + WORK_CACHE_TTL_MS, fetch: noFetch };
    expect(await getMetaArtList("itunes", "98001", offline)).toEqual(results[0]!);
    expect(await getMetaArtImage("itunes", "98001", 0, offline)).toEqual(images[0]!);
    const app = new Hono(); registerLookupRoutes(app, { config: offlineConfig, fetch: noFetch });
    const res = await app.request("/api/meta-art/itunes/98001/0");
    expect(res.status).toBe(200); expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toContain("must-revalidate");
  });

  test("reordered refreshed lists never serve old bytes for a new source at the same index", async () => {
    const a = artSource("https://art.invalid/a.png", "cover")!;
    const b = artSource("https://art.invalid/b.png", "cover")!;
    writeArtSources(config, "itunes", "98001", [a], 1_000);
    const deps = { config, now: () => 1_000, fetch: fakeFetch((url) => png(url.includes("/a.") ? 1 : 2)) };
    const first = await getMetaArtImage("itunes", "98001", 0, deps);
    writeArtSources(config, "itunes", "98001", [b, a], 1_000);
    const second = await getMetaArtImage("itunes", "98001", 0, deps);
    expect(first?.bytes.at(-1)).toBe(1); expect(second?.bytes.at(-1)).toBe(2);
    expect(await getMetaArtImage("itunes", "98001", 1, { ...deps, fetch: noFetch })).toEqual(first);
  });

  test("download caches do not cross storage directories", async () => {
    const secondConfig = configFor(join(dir, "second"));
    const source = artSource("https://art.invalid/a.png", "cover")!;
    for (const cfg of [config, secondConfig]) writeArtSources(cfg, "itunes", "98001", [source], 1_000);
    const [a, b] = await Promise.all([
      getMetaArtImage("itunes", "98001", 0, { config, now: () => 1_000, fetch: fakeFetch(() => png(1)) }),
      getMetaArtImage("itunes", "98001", 0, { config: secondConfig, now: () => 1_000, fetch: fakeFetch(() => png(2)) }),
    ]);
    expect(a?.bytes.at(-1)).toBe(1); expect(b?.bytes.at(-1)).toBe(2);
  });

  test("failed image retries only at the work TTL; disabled providers and unconfigured TMDB never fetch", async () => {
    let now = 1_000; let calls = 0;
    const source = artSource("https://art.invalid/a.png", "cover")!;
    writeArtSources(config, "itunes", "98001", [source], now);
    const deps = { config, now: () => now, fetch: fakeFetch(() => { calls++; return new Response(null, { status: 404 }); }) };
    expect(await getMetaArtImage("itunes", "98001", 0, deps)).toBeNull();
    now += WORK_CACHE_TTL_MS - 1;
    expect(await getMetaArtImage("itunes", "98001", 0, deps)).toBeNull(); expect(calls).toBe(1);
    now++;
    // Simulate refreshed source list; image absence TTL is independent from source resolution.
    writeArtSources(config, "itunes", "98001", [source], now);
    expect(await getMetaArtImage("itunes", "98001", 0, { ...deps, fetch: fakeFetch(() => { calls++; return png(); }) })).not.toBeNull();
    expect(calls).toBe(2);
    const disabled = { ...config, metadata: { ...config.metadata!, enabled: false } };
    expect(await getMetaArtList("itunes", "98002", { config: disabled, fetch: noFetch })).toEqual({ images: [] });
    const keyless = { ...config, metadata: { ...config.metadata!, tmdb_api_key: "" } };
    expect(await getMetaArtList("tmdb", "movie-98002", { config: keyless, fetch: noFetch })).toEqual({ images: [] });
  });

  test("non-raster, oversized, empty and missing images cache absence without shifting indices", async () => {
    for (const [index, response] of [
      new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
      new Response("html", { headers: { "Content-Type": "text/html" } }),
      new Response("x", { headers: { "Content-Type": "image/x-made-up" } }),
      new Response("x", { headers: { "Content-Type": "image/png", "Content-Length": String(MAX_META_COVER_BYTES + 1) } }),
      new Response(new Uint8Array(MAX_META_COVER_BYTES + 1), { headers: { "Content-Type": "image/png" } }),
      new Response(null, { headers: { "Content-Type": "image/png" } }),
      new Response(null, { status: 404 }),
    ].entries()) {
      let calls = 0; const id = String(98010 + index);
      writeArtSources(config, "itunes", id, [artSource(`https://art.invalid/${id}.png`, "cover")!, artSource("https://art.invalid/good.png", "cover")!], 1_000);
      const deps = { config, now: () => 1_000, fetch: fakeFetch(() => { calls++; return response; }) };
      expect(await getMetaArtImage("itunes", id, 0, deps)).toBeNull();
      expect(await getMetaArtImage("itunes", id, 0, deps)).toBeNull(); expect(calls).toBe(1);
      const list = await getMetaArtList("itunes", id, deps);
      expect(list.images.map((image) => image.url)).toEqual([`/api/meta-art/itunes/${id}/1`]);
    }
  });

  test("TMDB requests movie/TV images, votes before size, original sizes, max eight, both formats", async () => {
    const calls: URL[] = [];
    const deps = { config, fetch: fakeFetch((url, init) => {
      expect(init?.method).toBe("GET"); const parsed = new URL(url); calls.push(parsed);
      expect(parsed.searchParams.get("include_image_language")).toBe("en,null");
      return Response.json({
        backdrops: Array.from({ length: 10 }, (_, n) => ({ file_path: `/backdrop${n}.jpg`, vote_average: n, width: 3000 - n, height: 1200 })),
        posters: [{ file_path: "/poster.jpg", vote_average: 8, width: 2000, height: 3000 }, { file_path: "/poster2.jpg", vote_average: 7, width: 4000, height: 6000 }],
      });
    }) };
    for (const id of ["movie-98001", "tv-98001"]) {
      const list = await getMetaArtList("tmdb", id, deps);
      expect(list.images).toHaveLength(8); expect(list.images[0]?.kind).toBe("backdrop");
      const sources = readArtSources(config, "tmdb", id, Date.now())!;
      expect(sources[0]?.url).toBe("https://images.invalid/original/backdrop9.jpg");
      expect(sources.slice(6).map((source) => source.kind)).toEqual(["poster", "poster"]);
    }
    expect(calls.map((url) => url.pathname)).toEqual(["/3/movie/98001/images", "/3/tv/98001/images"]);
    expect(metaArtUrl("tmdb", "98001", "series")).toBe("/api/meta-art/tmdb/tv-98001");
    expect(metaArtUrl("tmdb", "98001", "film")).toBe("/api/meta-art/tmdb/movie-98001");
  });

  test("AniList lazy query is GET and extracts banner/extraLarge only", async () => {
    const deps = { config, fetch: fakeFetch((url, init) => {
      expect(init?.method).toBe("GET"); const parsed = new URL(url);
      expect(JSON.parse(parsed.searchParams.get("variables")!)).toEqual({ id: 98001 });
      expect(parsed.searchParams.get("query")).not.toContain("characters");
      return Response.json({ data: { Media: { bannerImage: "https://art.invalid/banner.jpg", coverImage: { extraLarge: "https://art.invalid/xl.jpg", large: "https://art.invalid/small.jpg" }, characters: { images: ["https://art.invalid/unwanted.jpg"] } } } });
    }) };
    expect((await getMetaArtList("anilist", "98001", deps)).images.map((image) => image.kind)).toEqual(["banner", "cover"]);
    expect(readArtSources(config, "anilist", "98001", Date.now())!.map((source) => source.url)).toEqual(["https://art.invalid/banner.jpg", "https://art.invalid/xl.jpg"]);
  });

  test("AniList public host reuses legacy banner/cover cache; no unsupported GET or new POST", async () => {
    const publicConfig = { ...config, metadata: { ...config.metadata!, anilist_url: "https://graphql.anilist.co" } };
    writeBannerSource(publicConfig, "anilist", "98001", "https://art.invalid/banner.jpg", Date.now());
    writeCoverUrlCache(publicConfig, "anilist", "98001", "https://art.invalid/xl.jpg");
    expect((await getMetaArtList("anilist", "98001", { config: publicConfig, fetch: noFetch })).images.map((image) => image.kind)).toEqual(["banner", "cover"]);
    expect(await getMetaArtList("anilist", "98002", { config: publicConfig, fetch: noFetch })).toEqual({ images: [] });
  });

  test("TVmaze extracts original background/banner/poster, sorts sizes, removes duplicates and unsafe URLs", async () => {
    const deps = { config, fetch: fakeFetch((url, init) => {
      expect(init?.method).toBe("GET"); expect(url).toBe("https://tvmaze.invalid/shows/98001/images");
      return Response.json([
        { type: "poster", resolutions: { original: { url: "https://art.invalid/poster.jpg", width: 600, height: 900 } } },
        { type: "background", resolutions: { original: { url: "https://art.invalid/back.jpg", width: 1600, height: 900 }, medium: { url: "https://art.invalid/medium.jpg" } } },
        { type: "background", resolutions: { original: { url: "https://art.invalid/bigger.jpg", width: 2400, height: 1350 } } },
        { type: "banner", resolutions: { original: { url: "https://art.invalid/banner.jpg", width: 2000, height: 500 } } },
        { type: "poster", resolutions: { original: { url: "https://art.invalid/poster.jpg" } } },
        { type: "typography", resolutions: { original: { url: "https://art.invalid/unwanted.jpg" } } },
        { type: "poster", resolutions: { original: { url: "file:///bad" } } },
        null,
      ]);
    }) };
    const list = await getMetaArtList("tvmaze", "98001", deps);
    expect(list.images).toHaveLength(4); expect(list.images[0]?.width).toBe(2400);
    expect(list.images.map((image) => image.kind)).toEqual(["backdrop", "backdrop", "banner", "poster"]);
    expect(JSON.stringify(list)).not.toContain("https://");
  });

  test("Cinemeta background/poster and iTunes audiobook artwork reuse existing lookups", async () => {
    const deps = { config, fetch: fakeFetch((url, init) => {
      expect(init?.method).toBe("GET");
      if (url.includes("cinemeta")) return Response.json({ meta: { id: "tt98001", name: "Synthetic Film", background: "https://art.invalid/back.jpg", poster: "https://art.invalid/poster.jpg" } });
      return Response.json({ results: [{ collectionId: 98001, collectionName: "Synthetic Audiobook", artworkUrl100: "https://art.invalid/100x100bb.jpg" }] });
    }) };
    expect((await getMetaArtList("cinemeta", "tt98001", deps)).images.map((image) => image.kind)).toEqual(["backdrop", "poster"]);
    expect((await getMetaArtList("itunes", "98001", deps)).images).toHaveLength(1);
    expect(readArtSources(config, "itunes", "98001", Date.now())![0]?.url).toBe("https://art.invalid/1200x1200bb.jpg");
  });

  test("Open Library same-work edition covers use largest size and default=false; skip invalid/blank IDs", async () => {
    const deps = { config, fetch: fakeFetch((url, init) => {
      expect(init?.method).toBe("GET"); expect(url).toBe("https://ol.invalid/works/OL98001W/editions.json?limit=50");
      return Response.json({ entries: [{ covers: [-1, 0, 98001, 98002, 98001, 2.5] }, { covers: [98003] }, {}] });
    }) };
    expect((await getMetaArtList("openlibrary", "OL98001W", deps)).images).toHaveLength(3);
    expect(readArtSources(config, "openlibrary", "OL98001W", Date.now())!.map((source) => source.url)).toEqual([98001, 98002, 98003].map((id) => `https://covers.invalid/b/id/${id}-L.jpg?default=false`));
  });

  test("provider work calls seed display cache but art is not added to returned snapshots", async () => {
    const work = await lookupWork("itunes", "98001", { config, fetch: fakeFetch(() => Response.json({ results: [{ trackId: 98001, trackName: "Synthetic Song", artworkUrl100: "https://art.invalid/100x100bb.jpg" }] })) });
    expect(work).not.toHaveProperty("remoteArt"); expect(work).not.toHaveProperty("art_url");
    expect((await getMetaArtList("itunes", "98001", { config, fetch: noFetch })).images).toHaveLength(1);
  });

  test("art endpoints never rewrite archive snapshots; manual/explicitly unlinked work hides gallery", async () => {
    const db = openDb(":memory:");
    try {
      saveArchiveEntry(db, { entry_id: "11111111-1111-4111-8111-111111111111", work: snapshot, consumed: { minutes_override: 5 }, when: { precision: "unknown" } }, "Europe/Bratislava");
      const before = db.query("SELECT raw FROM events").all();
      const linked = buildAllLibraryWorks(db, undefined, { config })[0]!;
      expect(linked.detail.art_url).toBe("/api/meta-art/itunes/98001");
      await getMetaArtList("itunes", "98001", { config, fetch: fakeFetch(() => Response.json({ results: [] })) });
      expect(db.query("SELECT raw FROM events").all()).toEqual(before);
      expect((await editLibraryWork(db, linked.work.key, { meta: null }, { config, fetch: noFetch })).art_url).toBeNull();
      saveArchiveEntry(db, { entry_id: "22222222-2222-4222-8222-222222222222", work: { provider: "manual", category: "book", title: "Synthetic Plain", year: null, creators: [], seasons: [], runtime_minutes: null, pages: null }, consumed: { minutes_override: 1 }, when: { precision: "unknown" } }, "Europe/Bratislava");
      expect(buildAllLibraryWorks(db, undefined, { config }).find((item) => item.work.title === "Synthetic Plain")?.detail.art_url).toBeNull();
    } finally { db.close(); }
  });

  test("music art reuses a cached confident title-cover iTunes ID, without network or changing snapshots", () => {
    const db = openDb(":memory:");
    try {
      saveArchiveEntry(db, { entry_id: "11111111-1111-4111-8111-111111111111", work: { provider: "manual", category: "music", title: "Synthetic Song", year: null, creators: ["Synthetic Artist"], seasons: [], runtime_minutes: null, pages: null }, consumed: { minutes_override: 5 }, when: { precision: "unknown" } }, "Europe/Bratislava");
      const id = titleCoverId("music", "Synthetic Song", "Synthetic Artist");
      mkdirSync(coverCacheDir(config), { recursive: true });
      writeFileSync(join(coverCacheDir(config), `${id}.src`), "itunes:98001");
      expect(buildAllLibraryWorks(db, undefined, { config })[0]?.detail.art_url).toBe("/api/meta-art/itunes/98001");
    } finally { db.close(); }
  });

  test("reclassifying TMDB work retains original movie/TV artwork identity", async () => {
    const db = openDb(":memory:");
    try {
      saveArchiveEntry(db, { entry_id: "11111111-1111-4111-8111-111111111111", work: { ...snapshot, provider: "tmdb", category: "film", provider_id: "98001", external_ids: { tmdb: "98001" }, title: "Synthetic Film", cover_url: "/api/meta-cover/tmdb/98001" }, consumed: { minutes_override: 5 }, when: { precision: "unknown" } }, "Europe/Bratislava");
      const key = buildAllLibraryWorks(db, undefined, { config })[0]!.work.key;
      const changed = await editLibraryWork(db, key, { category: "series" }, { config, fetch: noFetch });
      expect(changed.art_url).toBe("/api/meta-art/tmdb/movie-98001");
    } finally { db.close(); }
  });

  test("corrupt source cache and unsafe source URLs are rejected", () => {
    for (const url of ["file:///bad", "data:image/png,x", "javascript:alert(1)", "https://user:password@art.invalid/img", "//art.invalid/img"]) expect(artSource(url, "cover")).toBeNull();
    writeArtSources(config, "itunes", "98001", [], 1_000);
    const path = join(metadataCacheDir(config), "art_itunes_98001.json");
    const before = readFileSync(path, "utf8"); expect(before).toContain('"savedAt":1000');
    writeFileSync(path, JSON.stringify({ savedAt: 1_000, sources: [{ url: "file:///bad", kind: "cover" }] }));
    expect(readArtSources(config, "itunes", "98001", 1_000)).toBeNull();
  });
});

describe("W18 browser gallery helpers", () => {
  const image = (url: string, kind: WorkArtImage["kind"], width: number | null = null, height: number | null = null): WorkArtImage => ({ url, kind, width, height });
  test("browser accepts only local provider/list/index URLs, including failed-index gaps", () => {
    const url = "/api/meta-art/anilist/98001";
    for (const bad of ["https://art.invalid/list", "//art.invalid/list", "/api/meta-art/bad/1", "/api/meta-art/anilist/../x", `${url}?x=1`, null]) expect(localArtListUrl(bad)).toBeNull();
    expect(localArtListUrl(url)).toBe(url);
    expect(localArtImages([image(`${url}/0`, "cover"), image(`${url}/7`, "cover"), image(`${url}/8`, "cover"), image(`${url}/0/extra`, "cover"), image("https://art.invalid/img.jpg", "cover")], url).map((item) => item.url)).toEqual([`${url}/0`, `${url}/7`]);
  });
  test("feature wide art otherwise biggest; navigation wraps; meaningful title alt; empty case", () => {
    const images = [image("a", "cover", 1000, 1400), image("b", "cover", 2000, 3000), image("c", "backdrop", 1200, 800)];
    expect(featuredArtIndex(images)).toBe(2); expect(featuredArtIndex(images.slice(0, 2))).toBe(1);
    expect(featuredArtIndex([])).toBe(0); expect(localArtImages([], "/api/meta-art/itunes/98001")).toEqual([]);
    expect(nextArtIndex(0, 3, -1)).toBe(2); expect(nextArtIndex(2, 3, 1)).toBe(0); expect(nextArtIndex(0, 0, 1)).toBe(0);
    expect(artworkAlt("Synthetic Sky", images[2]!, 2)).toBe("Synthetic Sky — backdrop 3");
  });
});
