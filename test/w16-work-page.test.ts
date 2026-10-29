import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type { Config } from "../src/core/config.ts";
import type { LibraryWork, WorkDetails } from "../src/core/contract.ts";
import { openDb } from "../src/core/db.ts";
import { insertEvents, startRun } from "../src/core/events.ts";
import { saveArchiveEntry } from "../src/server/archive.ts";
import { buildAllLibraryWorks, editLibraryWork, getLibraryWorkDetail, refreshLibraryWorkMetadata } from "../src/server/library.ts";
import { registerLookupRoutes } from "../src/server/lookup-routes.ts";
import { writeBannerSource, writeWorkCache } from "../src/server/metadata/cache.ts";
import { getMetaBanner, lookupSearch, lookupWork } from "../src/server/metadata/index.ts";
import { normalizeCommunityScore } from "../src/server/metadata/types.ts";
import { rankLibraryWorks } from "../src/server/work-presentation.ts";
import { localWorkImage, workBannerImage, workRankLines } from "../web/src/lib/work-presentation.ts";
import { performWorkEdit, subscribeWorkEdits } from "../web/src/lib/work-edits.ts";

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
      tmdb_url: "https://tmdb.invalid", tmdb_image_url: "https://images.invalid", steam_url: "https://steam.invalid", steam_cdn_url: "https://steamcdn.invalid", tmdb_api_key: "synthetic-key",
    },
    notify: { desktop: false, ntfy_url: "", ntfy_token: "", app_url: "", weekly_summary: false },
    toJSON: () => ({}), toString: () => "{}",
  };
}

const fakeFetch = (fn: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => fn(String(input), init)) as typeof fetch;
const json = (data: unknown) => Response.json(data);
const image = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
const failFetch = fakeFetch(() => { throw new Error("No network allowed"); });

describe("W16 library presentation and rank", () => {
  test("competition ties, category shares, zero time, zero ratings and planned exclusion", () => {
    const ranks = rankLibraryWorks([peer("A", 60, 9), peer("B", 60, 9), peer("C", 30, 8), peer("D", 0, 0), peer("E", 0), peer("P", 900, 10, { status: "planned" }), peer("F", 90, 10, { category: "film" })]);
    expect(ranks.get("A")).toEqual({ time: 1, time_share_percent: 40, rating: 1 });
    expect(ranks.get("B")).toEqual(ranks.get("A"));
    expect(ranks.get("C")).toEqual({ time: 3, time_share_percent: 20, rating: 3 });
    expect(ranks.get("D")).toEqual({ time: null, time_share_percent: 0, rating: 4 });
    expect(ranks.get("E")?.rating).toBeNull(); expect(ranks.has("P")).toBe(false);
    expect(ranks.get("F")).toEqual({ time: 1, time_share_percent: 100, rating: 1 });
    expect(rankLibraryWorks([peer("Z", 0)]).get("Z")?.time_share_percent).toBe(0);
  });

  test("archive and ABS fallbacks are plain text and network-free; edits affect rankings", async () => {
    const db = openDb(":memory:");
    try {
      saveArchiveEntry(db, { entry_id: "11111111-1111-4111-8111-111111111111", work: snapshot({ community_score: { source: "AniList", value_10: 7.9, votes: null }, banner_url: "/api/meta-banner/anilist/91001" }), consumed: { minutes_override: 60 }, when: { precision: "unknown" }, rating: 9 }, "Europe/Bratislava");
      saveArchiveEntry(db, { entry_id: "22222222-2222-4222-8222-222222222222", work: snapshot({ provider_id: "91002", external_ids: { anilist: "91002" }, title: "Synthetic Other" }), consumed: { minutes_override: 120 }, when: { precision: "unknown" }, rating: 10 }, "Europe/Bratislava");
      const run = startRun(db, "synthetic");
      insertEvents(db, run, [{ source: "audiobookshelf", source_kind: "listening_session", source_id: "synthetic-session", media_type: "audiobook", title: "Synthetic Book", external_ids: { abs_item: "synthetic-book" }, duration_seconds: 600, started_at: "2026-10-17T08:15:00.000Z", raw: { mediaMetadata: { authors: [{ id: "fake-author", name: "Synthetic Author" }], narrators: ["Synthetic Narrator"], genres: ["Fantasy", "Fantasy", ""], publishedYear: "2021", description: "<p>A book &amp; a journey.</p>" } } }]);
      let works = buildAllLibraryWorks(db);
      const first = works.find((item) => item.work.title === "Synthetic Sky")!;
      expect(first.detail.description).toBe("A synthetic journey."); expect(first.detail.genres).toEqual(["Adventure"]);
      expect(first.detail.community_score?.value_10).toBe(7.9); expect(first.detail.banner_url).toBe("/api/meta-banner/anilist/91001");
      expect(first.detail.rank?.time).toBe(2); expect(first.detail.rank?.rating).toBe(2);
      const book = works.find((item) => item.work.title === "Synthetic Book")!.detail;
      expect(book.description).toBe("A book & a journey."); expect(book.genres).toEqual(["Fantasy"]);
      expect(book.creators).toEqual(["Synthetic Author"]); expect(book.creator).toBe("Synthetic Author");
      expect(book.narrators).toEqual(["Synthetic Narrator"]); expect(book.year).toBe(2021);
      const other = works.find((item) => item.work.title === "Synthetic Other")!;
      await editLibraryWork(db, other.work.key, { hidden: true });
      expect(getLibraryWorkDetail(db, first.work.key)?.rank).toEqual({ time: 1, time_share_percent: 100, rating: 1 });
      await editLibraryWork(db, other.work.key, { hidden: false, status: "planned" });
      works = buildAllLibraryWorks(db);
      expect(works.find((item) => item.work.key === other.work.key)?.detail.rank).toBeNull();
      expect(getLibraryWorkDetail(db, first.work.key)?.rank?.time_share_percent).toBe(100);
    } finally { db.close(); }
  });

  test("old snapshots gain cached scores, explicit linked metadata wins, absent metadata stays empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "it-w16-")); const config = configFor(dir); const db = openDb(":memory:");
    try {
      saveArchiveEntry(db, { entry_id: "11111111-1111-4111-8111-111111111111", work: snapshot(), consumed: { minutes_override: 60 }, when: { precision: "unknown" } }, "Europe/Bratislava");
      writeWorkCache(config, "anilist", "91001", snapshot({ community_score: { source: "AniList", value_10: 8, votes: null }, banner_url: "/api/meta-banner/anilist/91001" }), null, Date.now());
      const first = buildAllLibraryWorks(db, undefined, { config })[0]!;
      expect(first.detail.community_score?.value_10).toBe(8); expect(first.detail.banner_url).toBe("/api/meta-banner/anilist/91001");
      writeWorkCache(config, "anilist", "91002", snapshot({ provider_id: "91002", description: "The linked description.", genres: ["Drama"], creators: ["Linked Studio"], community_score: { source: "AniList", value_10: 9, votes: null }, banner_url: "/api/meta-banner/anilist/91002" }), null, Date.now());
      const updated = await editLibraryWork(db, first.work.key, { meta: { provider: "anilist", provider_id: "91002" } }, { config, fetch: failFetch });
      expect(updated.description).toBe("The linked description."); expect(updated.genres).toEqual(["Drama"]); expect(updated.community_score?.value_10).toBe(9);
      expect(updated.banner_url).toBe("/api/meta-banner/anilist/91002");
      saveArchiveEntry(db, { entry_id: "22222222-2222-4222-8222-222222222222", work: { provider: "manual", category: "book", title: "Synthetic Plain", year: null, creators: [], seasons: [], runtime_minutes: null, pages: null }, consumed: { minutes_override: 1 }, when: { precision: "unknown" } }, "Europe/Bratislava");
      const plain = buildAllLibraryWorks(db).find((item) => item.work.title === "Synthetic Plain")!.detail;
      expect(plain.description).toBeNull(); expect(plain.genres).toEqual([]); expect(plain.community_score).toBeNull(); expect(plain.banner_url).toBeNull();
      expect(workRankLines({ ...plain, rank: { time: 1, rating: null, time_share_percent: 0.2 } })[0]).toContain("<1%");
      expect(workRankLines({ ...plain, status: "planned" })).toEqual([]);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("browser image candidates are local only", () => {
    for (const url of ["https://art.invalid/sky.png", "//art.invalid/sky.png", "data:image/png;base64,x", "/api/meta-banner/anilist/../secret", null]) expect(localWorkImage(url)).toBeNull();
    expect(localWorkImage("/api/meta-banner/anilist/91001")).toBe("/api/meta-banner/anilist/91001");
    expect(localWorkImage("/api/cover/synthetic-book")).toBe("/api/cover/synthetic-book");
    const detail = { banner_url: "/api/meta-banner/anilist/91001", cover_url: "/api/meta-cover/anilist/91001" };
    expect(workBannerImage(detail, [])).toBe(detail.banner_url);
    expect(workBannerImage(detail, [detail.banner_url])).toBe(detail.cover_url);
    expect(workBannerImage(detail, [detail.banner_url, detail.cover_url])).toBeNull();
    expect(workBannerImage({ ...detail, banner_url: null }, [])).toBe(detail.cover_url);
    expect(workBannerImage({ banner_url: "https://art.invalid/sky.png", cover_url: null }, [])).toBeNull();
  });

  test("newest archive revision wins by append order and explicit nulls do not resurrect cached scores or banners", () => {
    const dir = mkdtempSync(join(tmpdir(), "it-w16-")); const config = configFor(dir); const db = openDb(":memory:");
    try {
      const entry = { entry_id: "11111111-1111-4111-8111-111111111111", consumed: { minutes_override: 60 }, when: { precision: "unknown" } };
      const old = snapshot({ description: "Older description.", banner_url: "/api/meta-banner/anilist/91001", community_score: { source: "AniList", value_10: 8, votes: null } });
      saveArchiveEntry(db, { ...entry, work: old }, "Europe/Bratislava", { nowIso: "2026-10-19T08:15:00.000Z" });
      writeWorkCache(config, "anilist", "91001", old, null, Date.now());
      saveArchiveEntry(db, { ...entry, work: snapshot({ description: "Newest description.", genres: ["Drama"], community_score: null, banner_url: null }) }, "Europe/Bratislava", { nowIso: "2026-10-20T08:15:00.000Z" });
      const detail = buildAllLibraryWorks(db, undefined, { config })[0]!.detail;
      expect(detail.description).toBe("Newest description."); expect(detail.genres).toEqual(["Drama"]);
      expect(detail.community_score).toBeNull(); expect(detail.banner_url).toBeNull();
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n).toBe(2);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("edit and undo notify after server writes so the work page can reload fresh ranks", async () => {
    const originalFetch = globalThis.fetch;
    let storedRating = 7;
    const seen: number[] = [];
    const unsubscribe = subscribeWorkEdits(() => seen.push(storedRating));
    globalThis.fetch = fakeFetch((url, init) => {
      expect(url).toContain("/api/library/work/edit?key="); expect(init?.method).toBe("POST");
      storedRating = JSON.parse(String(init?.body)).rating as number;
      return json({ rating: storedRating });
    });
    try {
      const result = await performWorkEdit("synthetic-w16-undo", { rating: 9 }, { rating: 7 });
      expect(seen).toEqual([7, 9]);
      await result.undo();
      expect(seen).toEqual([7, 9, 9, 7]);
    } finally { globalThis.fetch = originalFetch; unsubscribe(); }
  });
});

describe("W16 AniList narrative sequel boundaries", () => {
  let dir: string; let config: Config;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "it-w16-")); config = configFor(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const node = (id: number, title: string, format = "TV") => ({ id, type: "ANIME", format, status: "FINISHED", title: { english: title }, episodes: id === 91003 ? 293 : 12, duration: 24, seasonYear: 2020 });
  function chain() {
    const root = node(91001, "Synthetic Ninja"); const sequel = node(91002, "Synthetic Ninja Storm"); const next = node(91003, "Synthetic Heir: Synthetic Ninja Next Generations");
    return [
      { ...root, relations: { edges: [{ relationType: "SEQUEL", node: sequel }] } },
      { ...sequel, relations: { edges: [{ relationType: "PREQUEL", node: root }, { relationType: "SEQUEL", node: next }] } },
      { ...next, relations: { edges: [{ relationType: "PREQUEL", node: sequel }] } },
    ];
  }

  test.each(["91001", "91002", "91003"])("lookup from %s keeps the shared-root continuation, not the next-generation series", async (id) => {
    const nodes = chain(); const seen: number[] = [];
    const fetch = fakeFetch((_url, init) => { const requested = JSON.parse(String(init?.body)).variables.id as number; seen.push(requested); return json({ data: { Media: nodes.find((item) => item.id === requested) } }); });
    const work = await lookupWork("anilist", id, { config, fetch });
    expect(work?.seasons.map((season) => season.provider_id)).toEqual(id === "91003" ? ["91003"] : ["91001", "91002"]);
    if (id !== "91003") expect(seen).not.toContain(91003);
  });

  test("search retains a separately titled sequel and does not count its episodes", async () => {
    const result = await lookupSearch("Synthetic Ninja", "anime", { config, fetch: fakeFetch(() => json({ data: { Page: { media: chain() } } })) });
    expect(result.results.map((item) => item.provider_id)).toEqual(["91001", "91003"]);
    expect(result.results[0]?.subtitle).toContain("2 seasons · 24 episodes");
  });

  test("different display titles still share a normalized root through romaji aliases", async () => {
    const first = { ...node(91001, "Synthetic Sky!"), title: { english: "Synthetic Sky!", romaji: "Kakuu Sora" } };
    const second = { ...node(91002, "The Invented Journey"), title: { english: "The Invented Journey", romaji: "KAKUU SORA: Season 2" } };
    const media = [
      { ...first, relations: { edges: [{ relationType: "SEQUEL", node: second }] } },
      { ...second, relations: { edges: [{ relationType: "PREQUEL", node: first }] } },
    ];
    const fetch = fakeFetch((_url, init) => json({ data: { Media: media.find((item) => item.id === JSON.parse(String(init?.body)).variables.id) } }));
    expect((await lookupWork("anilist", "91002", { config, fetch }))?.seasons.map((season) => season.provider_id)).toEqual(["91001", "91002"]);
  });

  test("SPIN_OFF relations never become seasons, even with a matching title prefix", async () => {
    const root = node(91001, "Synthetic Sky"); const spinoff = node(91002, "Synthetic Sky Side Story");
    const media = [{ ...root, relations: { edges: [{ relationType: "SPIN_OFF", node: spinoff }] } }, spinoff];
    const fetch = fakeFetch((_url, init) => { const vars = JSON.parse(String(init?.body)).variables; return json({ data: vars.search ? { Page: { media } } : { Media: media[0] } }); });
    expect((await lookupSearch("Synthetic Sky", "anime", { config, fetch })).results).toHaveLength(2);
    expect((await lookupWork("anilist", "91001", { config, fetch }))?.seasons).toHaveLength(1);
  });

  test("same-root TV seasons can still bridge a sequel film", async () => {
    const first = node(91001, "Synthetic Abyss"); const film = node(91004, "Synthetic Abyss Deep", "MOVIE"); const second = node(91002, "Synthetic Abyss Golden City");
    const media = [
      { ...first, relations: { edges: [{ relationType: "SEQUEL", node: film }] } },
      { ...film, relations: { edges: [{ relationType: "PREQUEL", node: first }, { relationType: "SEQUEL", node: second }] } },
      { ...second, relations: { edges: [{ relationType: "PREQUEL", node: film }] } },
    ];
    const fetch = fakeFetch((_url, init) => json({ data: { Media: media.find((item) => item.id === JSON.parse(String(init?.body)).variables.id) } }));
    for (const id of ["91001", "91002"]) expect((await lookupWork("anilist", id, { config, fetch }))?.seasons.map((season) => season.provider_id)).toEqual(["91001", "91002"]);
  });

  test("refresh repairs an old three-season snapshot append-only and is repeatable", async () => {
    const db = openDb(":memory:");
    try {
      const nodes = chain();
      const oldWork = snapshot({ title: "Synthetic Ninja", seasons: nodes.map((item, i) => ({ number: i + 1, title: item.title.english, year: 2020, episodes: item.episodes, episode_minutes: 24, total_minutes: item.episodes * 24, provider_id: String(item.id) })) });
      saveArchiveEntry(db, { entry_id: "11111111-1111-4111-8111-111111111111", work: oldWork, consumed: { seasons: [{ number: 1 }, { number: 2 }] }, when: { precision: "year", date: "2020" } }, "Europe/Bratislava");
      const key = buildAllLibraryWorks(db)[0]!.work.key;
      const fetch = fakeFetch((_url, init) => json({ data: { Media: { ...nodes.find((item) => item.id === JSON.parse(String(init?.body)).variables.id), averageScore: 79 } } }));
      const options = { config, fetch, nowIso: "2026-10-20T08:15:00.000Z" };
      const result = await refreshLibraryWorkMetadata(db, key, options);
      expect(result.seasons).toHaveLength(2); expect(result.progress?.episodes_total).toBe(24); expect(result.community_score?.value_10).toBe(7.9);
      expect(result.changed).toBe(true);
      const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n;
      expect(count).toBe(4);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events_latest").get()!.n).toBe(2);
      expect((await refreshLibraryWorkMetadata(db, key, options)).changed).toBe(false);
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n).toBe(count);
    } finally { db.close(); }
  });
});

function snapshot(extra: Partial<WorkDetails> = {}): WorkDetails {
  return { provider: "anilist", provider_id: "91001", category: "anime", title: "Synthetic Sky",
    original_title: null, year: 2020, cover_url: null, creators: ["Synthetic Studio"], genres: ["Adventure"],
    description: "A synthetic journey.", seasons: [], runtime_minutes: null, pages: null,
    external_ids: { anilist: "91001" }, ...extra };
}
function peer(key: string, minutes: number, rating: number | null = null, extra: Partial<LibraryWork> = {}): LibraryWork {
  return { key, category: "anime", title: key, total_minutes: minutes, rating, cover_url: null, units: 1,
    first_at: null, last_at: null, status: "finished", sources: ["manual"], edited: false, channel: null,
    topic: null, creator: null, progress: null, ...extra };
}

describe("W16 provider scores and backgrounds", () => {
  let dir: string;
  let config: Config;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "it-w16-")); config = configFor(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test.each([
    ["AniList", 79, 100, 7.9], ["TMDB", 8.74, 10, 8.7], ["TVmaze", 7.2, 10, 7.2],
    ["IMDb", "8.7", 10, 8.7], ["Open Library", 4.25, 5, 8.5], ["iTunes", 4.5, 5, 9],
  ] as const)("normalizes %s to ten", (source, value, scale, expected) => {
    expect(normalizeCommunityScore(source, value, scale)?.value_10).toBe(expected);
  });

  test("rejects malformed, missing, out-of-range and zero-vote scores", () => {
    for (const value of [undefined, null, "", "8.7bad", NaN, Infinity, -1, 0, 11, {}, true]) {
      expect(normalizeCommunityScore("IMDb", value, 10)).toBeNull();
    }
    expect(normalizeCommunityScore("TMDB", 8, 10, 0)).toBeNull();
    expect(normalizeCommunityScore("TMDB", 8, 10, 12)?.votes).toBe(12);
    expect(normalizeCommunityScore("iTunes", 4, 5, -1)?.votes).toBeNull();
  });

  test("all provider modules extract real score fields and cache without subsequent requests", async () => {
    let calls = 0;
    const fetch = fakeFetch((url, init) => {
      calls++;
      if (url.includes("anilist")) {
        expect(init?.method).toBe("POST");
        const query = JSON.parse(String(init?.body)).query as string;
        expect(query).toContain("averageScore"); expect(query).toContain("bannerImage");
        return json({ data: { Media: { id: 91001, format: "MOVIE", title: { english: "Synthetic Sky" }, averageScore: 79, bannerImage: "https://art.invalid/sky.png" } } });
      }
      expect(init?.method ?? "GET").toBe("GET");
      if (url.includes("tmdb")) return json({ id: 92001, title: "Synthetic Film", vote_average: 8.7, vote_count: 321, backdrop_path: "/sky.png" });
      if (url.endsWith("/images")) return json([{ type: "poster", resolutions: { original: { url: "https://art.invalid/wrong.png" } } }, { type: "background", resolutions: { original: { url: "https://art.invalid/tv.png" } } }]);
      if (url.includes("tvmaze")) return url.endsWith("/seasons") || url.endsWith("/episodes") ? json([]) : json({ id: 93001, name: "Synthetic Show", rating: { average: 7.2 } });
      if (url.includes("cinemeta")) return json({ meta: { id: "tt94001", name: "Synthetic Film", type: "movie", imdbRating: "8.7", background: "https://art.invalid/cine.png" } });
      if (url.includes("itunes")) return json({ results: [{ trackId: 95001, trackName: "Synthetic Film", averageUserRating: 4.5, userRatingCount: 13 }] });
      if (url.endsWith("/ratings.json")) return json({ summary: { average: 4.25, count: 40 } });
      return json({ title: "Synthetic Book", number_of_pages: 100, isbn: ["9780000000001"] });
    });
    for (const [provider, id, source, value, votes, hasBanner] of [
      ["anilist", "91001", "AniList", 7.9, null, true], ["tmdb", "92001", "TMDB", 8.7, 321, true],
      ["tvmaze", "93001", "TVmaze", 7.2, null, true], ["cinemeta", "tt94001", "IMDb", 8.7, null, true],
      ["itunes", "95001", "iTunes", 9, 13, false], ["openlibrary", "OL96001W", "Open Library", 8.5, 40, false],
    ] as const) {
      const work = await lookupWork(provider, id, { config, fetch });
      expect(work?.community_score).toEqual({ source, value_10: value, votes });
      expect(work?.banner_url).toBe(hasBanner ? `/api/meta-banner/${provider}/${id}` : null);
      const before = calls;
      expect(await lookupWork(provider, id, { config, fetch: failFetch })).toEqual(work);
      expect(calls).toBe(before);
    }
    let bannerRequests = 0;
    const bannerFetch = fakeFetch((url) => { expect(url).toMatch(/^https:\/\/(?:art|images)\.invalid\//); bannerRequests++; return image(); });
    for (const [provider, id] of [["anilist", "91001"], ["tmdb", "92001"], ["tvmaze", "93001"], ["cinemeta", "tt94001"]] as const) {
      expect((await getMetaBanner(provider, id, { config, fetch: bannerFetch }))?.contentType).toBe("image/png");
    }
    expect(bannerRequests).toBe(4);
  });

  test("optional Open Library ratings failures leave usable metadata", async () => {
    const work = await lookupWork("openlibrary", "OL96002W", { config, fetch: fakeFetch((url) => url.endsWith("/ratings.json")
      ? new Response(null, { status: 503 }) : json({ title: "Synthetic Book", number_of_pages: 100, isbn: ["9780000000001"] })) });
    expect(work?.title).toBe("Synthetic Book"); expect(work?.community_score).toBeNull();
  });

  test("banner route validates paths and query parameters before any fetch", async () => {
    let calls = 0;
    const app = new Hono();
    registerLookupRoutes(app, { config, fetch: fakeFetch(() => { calls++; return image(); }) });
    for (const path of ["unknown/1", "anilist/bad.id", "anilist/%2e%2e%2fsecret", "anilist", "anilist/1/extra", "anilist/1?x=1", `anilist/${"a".repeat(65)}`]) {
      expect((await app.request(`/api/meta-banner/${path}`)).status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  test("banner downloads share in-flight requests and survive disabled providers permanently", async () => {
    writeBannerSource(config, "anilist", "91001", "https://art.invalid/sky.png", Date.now());
    let calls = 0;
    const fetch = fakeFetch(async (_url, init) => { calls++; expect(init?.method).toBe("GET"); await Promise.resolve(); return image(); });
    const app = new Hono(); registerLookupRoutes(app, { config, fetch });
    const responses = await Promise.all([app.request("/api/meta-banner/anilist/91001"), app.request("/api/meta-banner/anilist/91001")]);
    for (const response of responses) { expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toContain("immutable"); expect(response.headers.get("Content-Type")).toBe("image/png"); }
    expect(calls).toBe(1);
    config.metadata!.enabled = false;
    expect((await getMetaBanner("anilist", "91001", { config, fetch: failFetch }))?.bytes.length).toBe(4);
  });

  test("legacy caches resolve absent banners only once", async () => {
    writeWorkCache(config, "itunes", "95001", snapshot({ provider: "itunes", provider_id: "95001" }), null, Date.now());
    let calls = 0;
    const fetch = fakeFetch(() => { calls++; return json({ results: [{ trackId: 95001, trackName: "Synthetic Film" }] }); });
    const app = new Hono(); registerLookupRoutes(app, { config, fetch });
    expect((await app.request("/api/meta-banner/itunes/95001")).status).toBe(404);
    expect((await app.request("/api/meta-banner/itunes/95001")).status).toBe(404);
    expect(calls).toBe(1);
  });

  test.each(["text/html", "image/svg+xml", "image/png"])("rejects invalid or empty %s images and caches the fallback", async (contentType) => {
    writeBannerSource(config, "anilist", "91001", "https://art.invalid/sky.png", Date.now());
    let calls = 0;
    const fetch = fakeFetch(() => { calls++; return new Response(contentType === "image/png" ? null : "not an image", { headers: { "Content-Type": contentType } }); });
    expect(await getMetaBanner("anilist", "91001", { config, fetch })).toBeNull();
    expect(await getMetaBanner("anilist", "91001", { config, fetch })).toBeNull(); expect(calls).toBe(1);
  });

  test("HTTP failures and oversized downloads become cached absence, retried after the work TTL", async () => {
    const now = Date.now(); let clock = now; let calls = 0;
    writeBannerSource(config, "anilist", "91001", "https://art.invalid/sky.png", now);
    const deps = { config, now: () => clock, fetch: fakeFetch(() => { calls++; return new Response(null, { status: 503 }); }) };
    expect(await getMetaBanner("anilist", "91001", deps)).toBeNull();
    expect(await getMetaBanner("anilist", "91001", deps)).toBeNull(); expect(calls).toBe(1);
    clock += 30 * 24 * 60 * 60 * 1000;
    expect(await getMetaBanner("anilist", "91001", deps)).toBeNull(); expect(calls).toBe(2);
    writeBannerSource(config, "anilist", "91002", "https://art.invalid/large.png", now);
    expect(await getMetaBanner("anilist", "91002", { config, fetch: fakeFetch(() => new Response("x", {
      headers: { "Content-Type": "image/png", "Content-Length": String(6 * 1024 * 1024) },
    })) })).toBeNull();
  });
});
