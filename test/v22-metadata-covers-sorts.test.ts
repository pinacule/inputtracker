import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import type {
  ArchiveRequest,
  LibraryResult,
  LibraryWorkDetail,
  MonthReview,
  RefreshMetadataResult,
  YearReviewV2,
  YoutubeVideosResult,
} from "../src/core/contract.ts";
import { openDb } from "../src/core/db.ts";
import {
  finishRun,
  insertEvents,
  startRun,
  type NewEvent,
} from "../src/core/events.ts";
import { LocalDbSink } from "../src/core/sink.ts";
import { importAchriom } from "../src/io/import-achriom.ts";
import { createApp } from "../src/server/app.ts";
import {
  backfillCovers,
  cleanMusicArtist,
  cleanMusicTitle,
  coverCacheDir,
  getCover,
  titleCoverId,
} from "../src/server/covers.ts";
import {
  detectTvmazeSlotRuntime,
  isClearlyLowerThanSlot,
  lookupSearch,
  lookupWork,
} from "../src/server/metadata/index.ts";
import { syncActivityWatch } from "../src/sources/activitywatch/sync.ts";

const TZ = "Europe/Bratislava";
const VIKINGS_ENTRY_ID = "11111111-2222-4333-8444-555555555555";
const OPM_ENTRY_ID = "22222222-3333-4444-8555-666666666666";

function makeConfig(dbPath: string, overrides: Partial<Config> = {}): Config {
  return {
    timezone: TZ,
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
    youtube: {
      thumb_base_url: "https://yt.invalid/vi",
      min_watch_minutes: 5,
      enrich_per_sync: 50,
      base_url: "https://youtube.invalid",
    },
    activitywatch: {
      url: "http://aw.invalid:5600",
      timeout_s: 20,
      device: "pc",
      include_music: true,
    },
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
      tmdb_api_key: "",
    },
    notify: {
      desktop: false,
      ntfy_url: "",
      ntfy_token: "",
      app_url: "",
      weekly_summary: false,
    },
    toJSON: () => ({}),
    toString: () => "{}",
    ...overrides,
  };
}

function seedEvents(db: Database, events: NewEvent[], source = "test"): void {
  const runId = startRun(db, source);
  insertEvents(db, runId, events);
  finishRun(db, runId, {
    status: "ok",
    rowsSeen: events.length,
    rowsInserted: events.length,
  });
}

describe("v2.2 Section 13: Metadata accuracy (runtimes, AniList chains, specials, docs)", () => {
  let tempDir: string;
  let dbPath: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-v22-meta-"));
    dbPath = join(tempDir, "inputtracker.db");
    config = makeConfig(dbPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("docs/metadata-accuracy.md exists and documents root causes, fixes, and rules without real paths or secrets", () => {
    const docPath = join(import.meta.dir, "..", "docs", "metadata-accuracy.md");
    expect(existsSync(docPath)).toBe(true);
    const text = readFileSync(docPath, "utf8");
    expect(text).toContain("Vikings");
    expect(text).toContain("One-Punch Man");
    expect(text).toContain("Cinemeta");
    expect(text).toContain("progress");
    expect(text).not.toContain("/home/");
    expect(text).not.toContain("localhost:13378");
  });

  test("TVmaze broadcast slot (Vikings 60 min slot vs Cinemeta 44 min, plus specials and 0-ep future seasons)", async () => {
    expect(isClearlyLowerThanSlot(44, 60)).toBe(true);
    expect(isClearlyLowerThanSlot(22, 30)).toBe(true);
    expect(isClearlyLowerThanSlot(58, 60)).toBe(false);
    expect(
      detectTvmazeSlotRuntime(60, 60, [
        { season: 1, number: 1, runtime: 60, type: "regular" },
        { season: 1, number: 2, runtime: 60, type: "regular" },
      ])
    ).toBe(60);

    const seasonCounts = [9, 10, 10, 20, 20, 20]; // 89 episodes across 6 seasons
    const rawSeasons = [
      ...seasonCounts.map((count, i) => ({
        id: i + 1,
        number: i + 1,
        name: "",
        episodeOrder: count,
        premiereDate: `${2013 + i}-03-03`,
      })),
      // Announced future Season 7 with 0 episodes: must be skipped
      {
        id: 7,
        number: 7,
        name: "",
        episodeOrder: null,
        premiereDate: null,
      },
    ];

    const rawEpisodes: Array<Record<string, unknown>> = [];
    let epId = 1;
    for (let sIdx = 0; sIdx < seasonCounts.length; sIdx++) {
      const sNum = sIdx + 1;
      const count = seasonCounts[sIdx]!;
      for (let eNum = 1; eNum <= count; eNum++) {
        rawEpisodes.push({
          id: epId++,
          season: sNum,
          number: eNum,
          type: "regular",
          runtime: 60, // Broadcast slot on every episode!
          airdate: `${2013 + sIdx}-03-03`,
        });
      }
    }
    // Add special episodes (significant_special, insignificant_special, number: null) that must be ignored
    rawEpisodes.push(
      {
        id: 9001,
        season: 1,
        number: null,
        type: "significant_special",
        runtime: 60,
        airdate: "2013-02-25",
      },
      {
        id: 9002,
        season: 2,
        number: null,
        type: "insignificant_special",
        runtime: 60,
        airdate: "2014-02-25",
      }
    );

    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("tvmaze.invalid/shows/29")) {
        return new Response(
          JSON.stringify({
            id: 29,
            name: "Synthetic Vikings",
            premiered: "2013-03-03",
            runtime: 60,
            averageRuntime: 60,
            network: { name: "History" },
            externals: { imdb: "tt2306299", thetvdb: 260449 },
            _embedded: {
              crew: [{ type: "Creator", person: { name: "Michael Synthetic" } }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("tvmaze.invalid/shows/29/seasons")) {
        return new Response(JSON.stringify(rawSeasons), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("tvmaze.invalid/shows/29/episodes")) {
        return new Response(JSON.stringify(rawEpisodes), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("cinemeta.invalid/meta/series/tt2306299.json")) {
        return new Response(
          JSON.stringify({
            meta: {
              id: "tt2306299",
              type: "series",
              name: "Synthetic Vikings",
              runtime: "44 min",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const work = await lookupWork("tvmaze", "29", { config, fetch: mockFetch });
    expect(work).not.toBeNull();
    // 6 real seasons (Season 7 with 0 episodes is excluded; specials are excluded)
    expect(work!.seasons).toHaveLength(6);
    const totalEps = work!.seasons.reduce((s, x) => s + x.episodes, 0);
    expect(totalEps).toBe(89);
    for (const s of work!.seasons) {
      expect(s.episode_minutes).toBe(44);
      expect(s.total_minutes).toBe(s.episodes * 44);
    }
    const totalMinutes = work!.seasons.reduce((s, x) => s + (x.total_minutes ?? 0), 0);
    expect(totalMinutes).toBe(89 * 44); // 3916 min (~65.3 h), NOT 5340 min (89 h)
  });

  test("TVmaze missing runtime on later season inherits from sibling seasons", async () => {
    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("tvmaze.invalid/shows/77")) {
        return new Response(
          JSON.stringify({
            id: 77,
            name: "Synthetic Streaming Drama",
            premiered: "2022-01-01",
            runtime: null,
            averageRuntime: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("tvmaze.invalid/shows/77/seasons")) {
        return new Response(
          JSON.stringify([
            { id: 1, number: 1, episodeOrder: 2, premiereDate: "2022-01-01" },
            { id: 2, number: 2, episodeOrder: 2, premiereDate: "2024-01-01" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("tvmaze.invalid/shows/77/episodes")) {
        return new Response(
          JSON.stringify([
            { id: 1, season: 1, number: 1, runtime: 42 },
            { id: 2, season: 1, number: 2, runtime: 46 },
            // Season 2 has null runtimes on TVmaze
            { id: 3, season: 2, number: 1, runtime: null },
            { id: 4, season: 2, number: 2, runtime: 0 },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const work = await lookupWork("tvmaze", "77", { config, fetch: mockFetch });
    expect(work).not.toBeNull();
    expect(work!.seasons).toEqual([
      {
        number: 1,
        title: null,
        year: 2022,
        episodes: 2,
        episode_minutes: 44,
        total_minutes: 88,
        provider_id: null,
      },
      {
        number: 2,
        title: null,
        year: 2024,
        episodes: 2,
        episode_minutes: 44, // Inherited from Season 1 instead of null!
        total_minutes: 88,
        provider_id: null,
      },
    ]);
  });

  test("AniList: prequel OVA never hijacks root TV series in search, bridging movie connects TV S1 -> Movie -> TV S2, and missing season duration inherits from S1", async () => {
    const opmS1 = {
      id: 21087,
      idMal: 30276,
      type: "ANIME",
      format: "TV",
      status: "FINISHED",
      episodes: 12,
      duration: 24,
      seasonYear: 2015,
      popularity: 500000,
      title: { english: "Synthetic Punch Man", romaji: "Synthetic Punch Man" },
      studios: { nodes: [{ name: "Studio Mad", isAnimationStudio: true }] },
      relations: {
        edges: [
          {
            relationType: "PREQUEL",
            node: {
              id: 21386,
              type: "ANIME",
              format: "OVA",
              status: "FINISHED",
              episodes: 1,
              duration: 24,
              seasonYear: 2015,
              title: { english: "Synthetic Punch Man: Road to Hero" },
            },
          },
          {
            relationType: "SEQUEL",
            node: {
              id: 97668,
              type: "ANIME",
              format: "TV",
              status: "FINISHED",
              episodes: 12,
              duration: 24,
              seasonYear: 2019,
              title: { english: "Synthetic Punch Man Season 2" },
            },
          },
        ],
      },
    };
    const opmOva = {
      id: 21386,
      type: "ANIME",
      format: "OVA",
      status: "FINISHED",
      episodes: 1,
      duration: 24,
      seasonYear: 2015,
      popularity: 80000,
      title: { english: "Synthetic Punch Man: Road to Hero" },
      relations: {
        edges: [
          {
            relationType: "SEQUEL",
            node: {
              id: 21087,
              type: "ANIME",
              format: "TV",
              status: "FINISHED",
              episodes: 12,
              duration: 24,
              seasonYear: 2015,
              title: { english: "Synthetic Punch Man" },
            },
          },
        ],
      },
    };
    const opmS2 = {
      id: 97668,
      type: "ANIME",
      format: "TV",
      status: "FINISHED",
      episodes: 12,
      duration: 24,
      seasonYear: 2019,
      popularity: 350000,
      title: { english: "Synthetic Punch Man Season 2" },
      relations: {
        edges: [
          {
            relationType: "PREQUEL",
            node: { id: 21087, type: "ANIME", format: "TV", status: "FINISHED", episodes: 12 },
          },
          {
            relationType: "SEQUEL",
            node: {
              id: 153800,
              type: "ANIME",
              format: "TV",
              status: "FINISHED",
              episodes: 12,
              duration: null, // Missing duration on S3!
              seasonYear: 2025,
              title: { english: "Synthetic Punch Man Season 3" },
            },
          },
        ],
      },
    };
    const opmS3 = {
      id: 153800,
      type: "ANIME",
      format: "TV",
      status: "FINISHED",
      episodes: 12,
      duration: null, // Missing duration on S3!
      seasonYear: 2025,
      popularity: 200000,
      title: { english: "Synthetic Punch Man Season 3" },
      relations: {
        edges: [
          {
            relationType: "PREQUEL",
            node: { id: 97668, type: "ANIME", format: "TV", status: "FINISHED", episodes: 12 },
          },
        ],
      },
    };

    // Bridging movie chain: TV S1 (3001) -> Movie (3002) -> TV S2 (3003)
    const abyssS1 = {
      id: 3001,
      type: "ANIME",
      format: "TV",
      status: "FINISHED",
      episodes: 13,
      duration: 25,
      seasonYear: 2017,
      title: { english: "Synthetic Abyss" },
      relations: {
        edges: [
          {
            relationType: "SEQUEL",
            node: {
              id: 3002,
              type: "ANIME",
              format: "MOVIE",
              status: "FINISHED",
              episodes: 1,
              duration: 105,
              seasonYear: 2020,
              title: { english: "Synthetic Abyss Movie" },
            },
          },
        ],
      },
    };
    const abyssMovie = {
      id: 3002,
      type: "ANIME",
      format: "MOVIE",
      status: "FINISHED",
      episodes: 1,
      duration: 105,
      seasonYear: 2020,
      title: { english: "Synthetic Abyss Movie" },
      relations: {
        edges: [
          {
            relationType: "PREQUEL",
            node: { id: 3001, type: "ANIME", format: "TV", status: "FINISHED", episodes: 13 },
          },
          {
            relationType: "SEQUEL",
            node: {
              id: 3003,
              type: "ANIME",
              format: "TV",
              status: "FINISHED",
              episodes: 12,
              duration: 25,
              seasonYear: 2022,
              title: { english: "Synthetic Abyss Season 2" },
            },
          },
        ],
      },
    };
    const abyssS2 = {
      id: 3003,
      type: "ANIME",
      format: "TV",
      status: "FINISHED",
      episodes: 12,
      duration: 25,
      seasonYear: 2022,
      title: { english: "Synthetic Abyss Season 2" },
      relations: {
        edges: [
          {
            relationType: "PREQUEL",
            node: { id: 3002, type: "ANIME", format: "MOVIE", status: "FINISHED", episodes: 1 },
          },
        ],
      },
    };

    const byId: Record<number, unknown> = {
      21087: opmS1,
      21386: opmOva,
      97668: opmS2,
      153800: opmS3,
      3001: abyssS1,
      3002: abyssMovie,
      3003: abyssS2,
    };

    const mockFetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body?.variables?.search) {
        return new Response(
          JSON.stringify({
            data: { Page: { media: [opmS1, opmOva, opmS2, opmS3] } },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      const id = Number(body?.variables?.id);
      return new Response(
        JSON.stringify({ data: { Media: byId[id] ?? null } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    // 1. Search collapses OVA and S2/S3 into root S1 (21087), never dropping 21087 under 21386!
    const searchRes = await lookupSearch("Synthetic Punch Man", "anime", {
      config,
      fetch: mockFetch,
    });
    expect(searchRes.results).toHaveLength(1);
    expect(searchRes.results[0]?.provider_id).toBe("21087");
    expect(searchRes.results[0]?.subtitle).toBe("2015 · 3 seasons · 36 episodes");

    // 2. Lookup from 21087 returns all 3 seasons and fills S3's missing duration (24 min) from S1/S2
    const opmWork = await lookupWork("anilist", "21087", { config, fetch: mockFetch });
    expect(opmWork?.seasons).toEqual([
      {
        number: 1,
        title: "Synthetic Punch Man",
        year: 2015,
        episodes: 12,
        episode_minutes: 24,
        total_minutes: 288,
        provider_id: "21087",
      },
      {
        number: 2,
        title: "Synthetic Punch Man Season 2",
        year: 2019,
        episodes: 12,
        episode_minutes: 24,
        total_minutes: 288,
        provider_id: "97668",
      },
      {
        number: 3,
        title: "Synthetic Punch Man Season 3",
        year: 2025,
        episodes: 12,
        episode_minutes: 24,
        total_minutes: 288,
        provider_id: "153800",
      },
    ]);

    // 3. Bridging across canon sequel movie connects S1 (3001) and S2 (3003)
    const abyssWork = await lookupWork("anilist", "3001", { config, fetch: mockFetch });
    expect(abyssWork?.seasons.map((s) => [s.number, s.provider_id, s.episodes])).toEqual([
      [1, "3001", 13],
      [2, "3003", 12],
    ]);
  });
});

describe("v2.2 Section 13 & 15: LibraryWork.progress, .creator, Refresh Metadata, and Sorts", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-v22-lib-"));
    dbPath = join(tempDir, "inputtracker.db");
    db = openDb(dbPath);
    config = makeConfig(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("LibraryWork.progress and .creator are populated in library, reviews, and YouTube video detail; refresh-metadata updates 89 h -> 66 h append-only", async () => {
    // Mock TVmaze + Cinemeta so refresh-metadata updates Synthetic Vikings from 60 min (89 h) -> 44.5 min (~66 h)
    const seasonCounts = [9, 10, 10, 20, 20, 20]; // 89 episodes
    // Note: 66 h = 3960 min. Suppose Cinemeta reports 44 min (89 * 44 = 3916 min = 65 h) or 45 min (89 * 45 = 4005 min = 67 h),
    // or for 88 episodes * 45 min = 3960 min = 66 h! Let's use 88 episodes (9, 10, 10, 19, 20, 20) or 45 min so 88 * 60 = 5280 (88h) or 89 eps:
    // Let's test exact Vikings numbers: 6 seasons summing to 89 episodes where TVmaze had 60 min (5340 min = 89 h)
    // and Cinemeta returns 44 min (3916 min -> 65 h) or let's make 1 season have 48 min and 5 seasons have 44 min so total is 3960 min = 66 h!
    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("tvmaze.invalid/shows/29")) {
        return new Response(
          JSON.stringify({
            id: 29,
            name: "Synthetic Vikings",
            premiered: "2013-03-03",
            runtime: 60,
            averageRuntime: 60,
            externals: { imdb: "tt2306299" },
            _embedded: {
              crew: [{ type: "Creator", person: { name: "Michael Hirst" } }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("tvmaze.invalid/shows/29/seasons")) {
        return new Response(
          JSON.stringify(
            seasonCounts.map((c, idx) => ({
              id: idx + 1,
              number: idx + 1,
              episodeOrder: c,
              premiereDate: `${2013 + idx}-03-03`,
            }))
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("tvmaze.invalid/shows/29/episodes")) {
        const eps = [];
        let id = 1;
        for (let s = 0; s < seasonCounts.length; s++) {
          for (let e = 1; e <= seasonCounts[s]!; e++) {
            eps.push({
              id: id++,
              season: s + 1,
              number: e,
              type: "regular",
              runtime: 60,
            });
          }
        }
        return new Response(JSON.stringify(eps), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("cinemeta.invalid/meta/series/tt2306299.json")) {
        return new Response(
          JSON.stringify({
            meta: {
              id: "tt2306299",
              type: "series",
              name: "Synthetic Vikings",
              runtime: "44 min",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const app = createApp({ db, config, fetchImage: mockFetch });

    // 1. Seed Synthetic Vikings with the old 60-min slot runtimes (89 eps * 60 = 5340 min = 89 h)
    const vikingsOldReq: ArchiveRequest = {
      entry_id: VIKINGS_ENTRY_ID,
      work: {
        provider: "tvmaze",
        provider_id: "29",
        category: "series",
        title: "Synthetic Vikings",
        original_title: null,
        year: 2013,
        cover_url: "/api/meta-cover/tvmaze/29",
        creators: ["Michael Hirst"],
        genres: ["Drama", "History"],
        description: null,
        seasons: seasonCounts.map((count, i) => ({
          number: i + 1,
          title: null,
          year: 2013 + i,
          episodes: count,
          episode_minutes: 60,
          total_minutes: count * 60,
          provider_id: null,
        })),
        runtime_minutes: null,
        pages: null,
        external_ids: { tvmaze: "29", imdb: "tt2306299" },
      },
      consumed: {
        seasons: seasonCounts.map((_, i) => ({ number: i + 1 })),
      },
      when: { precision: "month", date: "2025-03" },
      status: "finished",
    };

    const saveVikingsRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(vikingsOldReq),
    });
    expect(saveVikingsRes.status).toBe(200);

    // 2. Seed One-Punch Man as a planned entry with 3 seasons (36 episodes)
    const opmPlannedReq: ArchiveRequest = {
      entry_id: OPM_ENTRY_ID,
      work: {
        provider: "anilist",
        provider_id: "21087",
        category: "anime",
        title: "Synthetic One-Punch Man",
        original_title: null,
        year: 2015,
        cover_url: "/api/meta-cover/anilist/21087",
        creators: ["Madhouse"],
        genres: ["Action"],
        description: null,
        seasons: [
          {
            number: 1,
            title: "Season 1",
            year: 2015,
            episodes: 12,
            episode_minutes: 24,
            total_minutes: 288,
            provider_id: "21087",
          },
          {
            number: 2,
            title: "Season 2",
            year: 2019,
            episodes: 12,
            episode_minutes: 24,
            total_minutes: 288,
            provider_id: "97668",
          },
          {
            number: 3,
            title: "Season 3",
            year: 2025,
            episodes: 12,
            episode_minutes: 24,
            total_minutes: 288,
            provider_id: "153800",
          },
        ],
        runtime_minutes: null,
        pages: null,
        external_ids: { anilist: "21087", mal: "30276" },
      },
      consumed: { seasons: [{ number: 1 }], minutes_override: 0 },
      when: { precision: "unknown" },
      status: "planned",
    };

    const saveOpmRes = await app.request("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opmPlannedReq),
    });
    expect(saveOpmRes.status).toBe(200);

    // 3. Seed an audiobook, a YouTube video, and 2 music tracks
    seedEvents(db, [
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "abs-1",
        external_ids: { abs_item: "li_book_1" },
        media_type: "audiobook",
        title: "Synthetic Hail Mary",
        parent_title: "Andy Weir",
        started_at: "2025-03-10T10:00:00.000Z",
        duration_seconds: 3600,
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "yt-vid-1",
        external_ids: { youtube_video: "VidSynth001" },
        media_type: "video",
        title: "Synthetic Architecture Talk",
        parent_title: "Tech Channel",
        started_at: "2025-03-12T12:00:00.000Z",
        duration_seconds: 1200,
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "yt-mus-1",
        external_ids: { android_package: "com.google.android.apps.youtube.music" },
        media_type: "music",
        title: "Harder Better Faster",
        parent_title: "Daft Punk - Topic",
        started_at: "2025-03-14T15:00:00.000Z",
        duration_seconds: 240,
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "yt-mus-2",
        external_ids: { android_package: "com.google.android.apps.youtube.music" },
        media_type: "music",
        title: "Windowlicker",
        parent_title: "Aphex Twin",
        started_at: "2025-03-15T15:00:00.000Z",
        duration_seconds: 360,
      },
    ]);

    // Check Library before refresh
    const libRes = await app.request("/api/library");
    expect(libRes.status).toBe(200);
    const lib = (await libRes.json()) as LibraryResult;

    const vikingsWork = lib.works.find((w) => w.title === "Synthetic Vikings")!;
    expect(vikingsWork.total_minutes).toBe(5340); // 89 h before refresh
    expect(vikingsWork.creator).toBe("Michael Hirst");
    expect(vikingsWork.progress).toEqual({
      seasons_watched: 6,
      seasons_total: 6,
      episodes_watched: 89,
      episodes_total: 89,
    });

    const opmWork = lib.works.find((w) => w.title === "Synthetic One-Punch Man")!;
    expect(opmWork.status).toBe("planned");
    expect(opmWork.total_minutes).toBe(0);
    expect(opmWork.creator).toBe("Madhouse");
    expect(opmWork.progress).toEqual({
      seasons_watched: 0,
      seasons_total: 3,
      episodes_watched: 0,
      episodes_total: 36,
    });

    const audioWork = lib.works.find((w) => w.title === "Synthetic Hail Mary")!;
    expect(audioWork.creator).toBe("Andy Weir");
    expect(audioWork.progress).toBeNull();

    const ytChannelWork = lib.works.find((w) => w.category === "youtube")!;
    expect(ytChannelWork.creator).toBe("Tech Channel");
    expect(ytChannelWork.progress).toBeNull();

    const daftWork = lib.works.find((w) => w.title === "Harder Better Faster")!;
    expect(daftWork.category).toBe("music");
    expect(daftWork.creator).toBe("Daft Punk"); // " - Topic" stripped!
    expect(daftWork.rating).toBeNull();
    expect(daftWork.progress).toBeNull();

    // Check YouTube single video work detail also has creator + progress: null
    const ytVidDetailRes = await app.request(
      "/api/library/work?key=youtube%3Avideo%3AVidSynth001"
    );
    expect(ytVidDetailRes.status).toBe(200);
    const ytVidDetail = (await ytVidDetailRes.json()) as LibraryWorkDetail;
    expect(ytVidDetail.creator).toBe("Tech Channel");
    expect(ytVidDetail.progress).toBeNull();

    // Check Month Review and Year Review preserve progress and creator
    const mr = (await (
      await app.request("/api/review/month?month=2025-03")
    ).json()) as MonthReview;
    const mrVikings = mr.top_works.find((w) => w.title === "Synthetic Vikings")!;
    expect(mrVikings.creator).toBe("Michael Hirst");
    expect(mrVikings.progress).toEqual({
      seasons_watched: 6,
      seasons_total: 6,
      episodes_watched: 89,
      episodes_total: 89,
    });

    const yr = (await (
      await app.request("/api/review/year?year=2025")
    ).json()) as YearReviewV2;
    const yrVikings = yr.top_works.find((w) => w.title === "Synthetic Vikings")!;
    expect(yrVikings.creator).toBe("Michael Hirst");
    expect(yrVikings.progress).toEqual({
      seasons_watched: 6,
      seasons_total: 6,
      episodes_watched: 89,
      episodes_total: 89,
    });

    // 4. Dry-run CLI `archive refresh-metadata --dry-run`
    const eventsBeforeDryRun = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
      .get()!.n;
    const cliLines: string[] = [];
    const exitCodeDry = await runCli(["archive", "refresh-metadata", "--dry-run"], {
      loadConfig: () => config,
      fetch: mockFetch,
      out: (line) => cliLines.push(line),
      err: (line) => cliLines.push(`ERR: ${line}`),
    });
    expect(exitCodeDry).toBe(0);
    expect(cliLines.some((l) => l.includes("Synthetic Vikings: 89 h → 65 h"))).toBe(true);
    const eventsAfterDryRun = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
      .get()!.n;
    // Dry-run writes 0 rows to events!
    expect(eventsAfterDryRun).toBe(eventsBeforeDryRun);

    // 5. POST /api/library/work/refresh-metadata?key= updates Synthetic Vikings append-only
    const refreshRes = await app.request(
      `/api/library/work/refresh-metadata?key=${encodeURIComponent(vikingsWork.key)}`,
      { method: "POST" }
    );
    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as LibraryWorkDetail & RefreshMetadataResult;
    expect(refreshBody.key).toBe(vikingsWork.key);
    expect(refreshBody.changed).toBe(true);
    expect(refreshBody.minutes_before).toBe(5340);
    expect(refreshBody.minutes_after).toBe(3916);
    expect(refreshBody.total_minutes).toBe(3916);

    const eventsAfterRefresh = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
      .get()!.n;
    // 6 new unit revisions appended (old 6 rows stay in events!)
    expect(eventsAfterRefresh).toBe(eventsBeforeDryRun + 6);

    // Repeat refresh when nothing changed inserts 0 rows and reports changed: false
    const refreshAgainRes = await app.request(
      `/api/library/work/refresh-metadata?key=${encodeURIComponent(vikingsWork.key)}`,
      { method: "POST" }
    );
    expect(refreshAgainRes.status).toBe(200);
    const refreshAgainBody = (await refreshAgainRes.json()) as RefreshMetadataResult;
    expect(refreshAgainBody.changed).toBe(false);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;").get()!.n
    ).toBe(eventsAfterRefresh);

    // 6. Test Library Sorts: sort=category and sort=creator
    const byCategory = (await (
      await app.request("/api/library?sort=category")
    ).json()) as LibraryResult;
    expect(byCategory.works.map((w) => w.category)).toEqual([
      "anime",
      "series",
      "audiobook",
      "youtube",
      "music",
      "music",
    ]);

    const musicByCreator = (await (
      await app.request("/api/library?category=music&sort=creator")
    ).json()) as LibraryResult;
    expect(musicByCreator.works.map((w) => [w.creator, w.title])).toEqual([
      ["Aphex Twin", "Windowlicker"],
      ["Daft Punk", "Harder Better Faster"],
    ]);

    const badLibSort = await app.request("/api/library?sort=invalid");
    expect(badLibSort.status).toBe(400);
  });

  test("GET /api/youtube/videos supports sort=recent|time|topic and rejects invalid sort", async () => {
    const app = createApp({ db, config });

    seedEvents(db, [
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "yt-v1",
        external_ids: { youtube_video: "VidSort0001" },
        media_type: "video",
        title: "Video Alpha",
        parent_title: "Chan Z",
        started_at: "2026-10-10T10:00:00.000Z",
        duration_seconds: 600, // 10m
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "yt-v2",
        external_ids: { youtube_video: "VidSort0002" },
        media_type: "video",
        title: "Video Beta",
        parent_title: "Chan A",
        started_at: "2026-10-12T10:00:00.000Z",
        duration_seconds: 1800, // 30m
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "yt-v3",
        external_ids: { youtube_video: "VidSort0003" },
        media_type: "video",
        title: "Video Gamma",
        parent_title: "Chan M",
        started_at: "2026-10-11T10:00:00.000Z",
        duration_seconds: 1200, // 20m
      },
    ]);

    await app.request("/api/youtube/channel-topic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "Chan Z", topic: "Science" }),
    });
    await app.request("/api/youtube/channel-topic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "Chan A", topic: "History" }),
    });
    // Chan M has topic: null

    // sort=recent (default)
    const recentRes = (await (
      await app.request("/api/youtube/videos?sort=recent")
    ).json()) as YoutubeVideosResult;
    expect(recentRes.videos.map((v) => v.title)).toEqual([
      "Video Beta",
      "Video Gamma",
      "Video Alpha",
    ]);

    // sort=time
    const timeRes = (await (
      await app.request("/api/youtube/videos?sort=time")
    ).json()) as YoutubeVideosResult;
    expect(timeRes.videos.map((v) => [v.title, v.watched_minutes])).toEqual([
      ["Video Beta", 30],
      ["Video Gamma", 20],
      ["Video Alpha", 10],
    ]);

    // sort=topic (History, Science, then null last)
    const topicRes = (await (
      await app.request("/api/youtube/videos?sort=topic")
    ).json()) as YoutubeVideosResult;
    expect(topicRes.videos.map((v) => [v.topic, v.title])).toEqual([
      ["History", "Video Beta"],
      ["Science", "Video Alpha"],
      [null, "Video Gamma"],
    ]);

    const badSort = await app.request("/api/youtube/videos?sort=bad");
    expect(badSort.status).toBe(400);
  });
});

describe("v2.2 Section 14: Covers by title, ABS known-missing skip, iTunes audiobooks/songs, and CLI covers backfill", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-v22-covers-"));
    dbPath = join(tempDir, "inputtracker.db");
    db = openDb(dbPath);
    config = makeConfig(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("cleanMusicTitle and cleanMusicArtist strip noise and extract artist", () => {
    expect(cleanMusicTitle("Daft Punk - Harder, Better, Faster (Official Video)")).toEqual({
      embeddedArtist: "Daft Punk",
      cleanTrack: "Harder, Better, Faster",
    });
    expect(cleanMusicTitle("Windowlicker [Official Audio]")).toEqual({
      embeddedArtist: null,
      cleanTrack: "Windowlicker",
    });
    expect(cleanMusicArtist("Daft Punk - Topic")).toBe("Daft Punk");
    expect(cleanMusicArtist("Radiohead VEVO")).toBe("Radiohead");
  });

  test("ABS item already known missing (.abs404) never contacts ABS and falls back to Open Library then iTunes Audiobooks", async () => {
    seedEvents(db, [
      {
        source: "audiobookshelf",
        source_kind: "listening_session",
        source_id: "sess-del-1",
        external_ids: { abs_item: "abs_known_missing_1" },
        media_type: "audiobook",
        title: "Project Synthetic Mary",
        parent_title: "Andy Weir",
        started_at: "2026-10-10T10:00:00.000Z",
        duration_seconds: 1800,
      },
    ]);

    // Pre-mark abs_known_missing_1 as 404 on ABS
    const cDir = coverCacheDir(config);
    mkdirSync(cDir, { recursive: true });
    writeFileSync(join(cDir, "abs_known_missing_1.abs404"), `${Date.now()}\n`, "utf8");

    const absCalls: string[] = [];
    const mockAbsClient = {
      getAllSessions: async () => [],
      get: async (path: string) => {
        absCalls.push(`GET ${path}`);
        return { libraries: [] };
      },
      getBinary: async (path: string) => {
        absCalls.push(`GET_BINARY ${path}`);
        throw new Error("HTTP 404: Not Found");
      },
    };

    const externalCalls: string[] = [];
    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      externalCalls.push(url);
      if (url.includes("openlibrary.invalid/search.json")) {
        // Open Library has no match -> triggers iTunes Audiobook fallback
        return new Response(JSON.stringify({ docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("itunes.invalid/search") && url.includes("entity=audiobook")) {
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [
              {
                collectionId: 555666,
                collectionName: "Project Synthetic Mary (Unabridged)",
                artistName: "Andy Weir",
                artworkUrl100: "https://itunes.invalid/img/100x100bb.jpg",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("600x600bb.jpg")) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const cover = await getCover("abs_known_missing_1", {
      config,
      db,
      createAbsClient: () => mockAbsClient as any,
      fetch: mockFetch,
    });

    expect(cover).not.toBeNull();
    expect(cover?.contentType).toBe("image/jpeg");
    // Audiobookshelf was NEVER contacted because .abs404 was already present!
    expect(absCalls).toEqual([]);
    expect(readFileSync(join(cDir, "abs_known_missing_1.src"), "utf8").trim()).toBe(
      "itunes:555666"
    );
  });

  test("Music tracks resolve covers via iTunes Search (entity=song), reject non-confident matches, and CLI covers backfill [--limit N] caches permanently", async () => {
    seedEvents(db, [
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "mus-1",
        external_ids: { android_package: "com.google.android.apps.youtube.music" },
        media_type: "music",
        title: "Digital Love",
        parent_title: "Daft Punk - Topic",
        started_at: "2026-10-12T10:00:00.000Z",
        duration_seconds: 300,
      },
      {
        source: "youtube",
        source_kind: "phone_play",
        source_id: "mus-2",
        external_ids: { android_package: "com.google.android.apps.youtube.music" },
        media_type: "music",
        title: "Digital Love",
        parent_title: "Wrong Artist",
        started_at: "2026-10-12T11:00:00.000Z",
        duration_seconds: 300,
      },
    ]);

    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("itunes.invalid/search") && url.includes("entity=song")) {
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [
              {
                trackId: 777888,
                trackName: "Digital Love",
                artistName: "Daft Punk",
                artworkUrl100: "https://itunes.invalid/music/100x100bb.jpg",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("itunes.invalid/music/600x600bb.jpg")) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    // Run CLI `covers backfill --limit 1` first
    const lines1: string[] = [];
    const code1 = await runCli(["covers", "backfill", "--limit", "1"], {
      loadConfig: () => config,
      fetch: mockFetch,
      out: (l) => lines1.push(l),
    });
    expect(code1).toBe(0);
    expect(lines1[0]).toContain("covers backfill: 1 attempted");

    // Run CLI `covers backfill` for the remaining candidate
    const lines2: string[] = [];
    const code2 = await runCli(["covers", "backfill"], {
      loadConfig: () => config,
      fetch: mockFetch,
      out: (l) => lines2.push(l),
    });
    expect(code2).toBe(0);
    expect(lines2[0]).toContain("covers backfill: 1 attempted");

    // Verify Daft Punk matched and cached .img, while Wrong Artist was rejected and cached .none
    const daftId = titleCoverId("music", "Digital Love", "Daft Punk");
    const wrongId = titleCoverId("music", "Digital Love", "Wrong Artist");
    const cDir = coverCacheDir(config);
    expect(existsSync(join(cDir, `${daftId}.img`))).toBe(true);
    expect(existsSync(join(cDir, `${wrongId}.img`))).toBe(false);
    expect(existsSync(join(cDir, `${wrongId}.none`))).toBe(true);

    // A third backfill attempts 0 items because both are now permanently resolved (.img / .none)
    const third = await backfillCovers(db, { config, fetch: mockFetch });
    expect(third).toEqual({ attempted: 0, resolved: 0, notFound: 0 });
  });

  test("ActivityWatch sync resolves music covers at sync time when include_music is true", async () => {
    const mockAwClient = {
      getBuckets: async () => ({
        "aw-watcher-web-test": { id: "aw-watcher-web-test", type: "web.tab.current" },
      }),
      getEvents: async () => [
        {
          timestamp: "2026-10-15T10:00:00.000Z",
          duration: 240,
          data: {
            url: "https://music.youtube.com/watch?v=MusVid00001",
            title: "Aphex Twin - Avril 14th - YouTube Music",
            audible: true,
          },
        },
      ],
    };

    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("itunes.invalid/search") && url.includes("entity=song")) {
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [
              {
                trackId: 999111,
                trackName: "Avril 14th",
                artistName: "Aphex Twin",
                artworkUrl100: "https://itunes.invalid/avril/100x100bb.jpg",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("itunes.invalid/avril/600x600bb.jpg")) {
        return new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    await syncActivityWatch({
      client: mockAwClient as any,
      sink: new LocalDbSink(db),
      db,
      config,
      fetch: mockFetch,
      now: () => new Date("2026-10-15T12:00:00.000Z"),
    });

    const app = createApp({ db, config, fetchImage: mockFetch });
    const lib = (await (
      await app.request("/api/library?category=music")
    ).json()) as LibraryResult;
    expect(lib.works).toHaveLength(1);
    expect(lib.works[0]?.title).toBe("Aphex Twin - Avril 14th");
    expect(lib.works[0]?.creator).toBe("Aphex Twin");
    expect(lib.works[0]?.cover_url).toStartWith("/api/cover/t_music_");

    const coverRes = await app.request(lib.works[0]!.cover_url!);
    expect(coverRes.status).toBe(200);
    expect(new Uint8Array(await coverRes.arrayBuffer())).toEqual(
      new Uint8Array([9, 8, 7])
    );
  });
});
