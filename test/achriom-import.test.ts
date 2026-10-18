import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "../src/cli/index.ts";
import type { Config } from "../src/core/config.ts";
import type {
  AchriomImportResult,
  LibraryResult,
  WorkDetails,
} from "../src/core/contract.ts";
import { openDb } from "../src/core/db.ts";
import type { EventRow } from "../src/core/schema.ts";
import { escapeCsvField } from "../src/io/csv.ts";
import {
  ACHRIOM_CSV_HEADERS,
  type AchriomFileName,
  achriomEntryId,
  achriomRowEntryId,
  achriomRowStableId,
  detectAchriomFile,
  importAchriom,
  mapAchriomRow,
  parseAchriomRating,
  parseAchriomStatus,
  parseAchriomWhen,
  selectConfidentLookupHit,
} from "../src/io/import-achriom.ts";
import { createZip } from "../src/io/zip.ts";
import { createApp } from "../src/server/app.ts";
import { metaCoverCacheDir } from "../src/server/metadata/index.ts";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function makeTestConfig(dbPath: string, overrides: Partial<Config> = {}): Config {
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
    toString: () => "",
    ...overrides,
  } as Config;
}

/** Build an exact Achriom CSV string using the real headers for `file`. */
function buildAchriomCsv(
  file: AchriomFileName,
  rows: ReadonlyArray<Record<string, string>>
): string {
  const headers = ACHRIOM_CSV_HEADERS[file];
  const lines: string[] = [headers.join(",")];
  for (const row of rows) {
    const fields = headers.map((col) => escapeCsvField(row[col] ?? ""));
    lines.push(fields.join(","));
  }
  return `${lines.join("\n")}\n`;
}

describe("Pure Achriom row → ArchiveRequest mapping", () => {
  test("detectAchriomFile identifies all 7 CSV files by exact headers", () => {
    for (const file of Object.keys(ACHRIOM_CSV_HEADERS) as AchriomFileName[]) {
      expect(detectAchriomFile(file, ACHRIOM_CSV_HEADERS[file])).toBe(file);
      expect(detectAchriomFile("custom-name.csv", ACHRIOM_CSV_HEADERS[file])).toBe(
        file
      );
    }
    expect(detectAchriomFile("export.csv", ["record_hash", "source", "title"])).toBeNull();
    expect(detectAchriomFile("random.csv", ["foo", "bar"])).toBeNull();
  });

  test("achriomRowEntryId produces deterministic UUID v5-style ids from stable id or normalized title+year", () => {
    const id1 = achriomRowEntryId("anime.csv", {
      title: "Synthetic Saga",
      season_year: "2019",
      anilist_id: "101348",
    });
    const id2 = achriomRowEntryId("anime.csv", {
      title: "Renamed Title",
      season_year: "2020",
      anilist_id: "101348",
    });
    expect(id1).toBe(id2);
    expect(id1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    // Fallback to normalized title + year when external IDs are absent
    expect(
      achriomRowStableId("books.csv", {
        title: "  Šťastný  Deň  ",
        publication_year: "1998",
        isbn: "",
      })
    ).toBe("title:stastny den:1998");

    // Different files with same stable id get distinct UUIDs
    expect(achriomEntryId("anime.csv", "title:test:2020")).not.toBe(
      achriomEntryId("movies.csv", "title:test:2020")
    );
  });

  test("parseAchriomRating converts 0..5 in halves to ×2 (0..10)", () => {
    expect(parseAchriomRating("")).toBeNull();
    expect(parseAchriomRating("   ")).toBeNull();
    expect(parseAchriomRating(undefined)).toBeNull();
    expect(parseAchriomRating("0.5")).toBe(1);
    expect(parseAchriomRating("2.5")).toBe(5);
    expect(parseAchriomRating("4")).toBe(8);
    expect(parseAchriomRating("4.5")).toBe(9);
    expect(parseAchriomRating("5")).toBe(10);
    expect(parseAchriomRating("0")).toBe(0);
    expect(() => parseAchriomRating("6")).toThrow(/user_rating/);
    expect(() => parseAchriomRating("-1")).toThrow(/user_rating/);
    expect(() => parseAchriomRating("abc")).toThrow(/user_rating/);
  });

  test("parseAchriomWhen uses finished_at / last_watched_at and ignores created_at", () => {
    expect(
      parseAchriomWhen("anime.csv", {
        started_at: "2022-01-01",
        finished_at: "",
        created_at: "2026-10-18T10:00:00Z",
      })
    ).toEqual({ precision: "unknown" });

    expect(
      parseAchriomWhen("anime.csv", {
        finished_at: "2024-03-15T20:11:00Z",
        created_at: "2026-10-18T10:00:00Z",
      })
    ).toEqual({ precision: "day", date: "2024-03-15" });

    expect(
      parseAchriomWhen("movies.csv", {
        first_watched_at: "2020-01-01",
        last_watched_at: "2023-11-04",
        created_at: "2026-10-18",
      })
    ).toEqual({ precision: "day", date: "2023-11-04" });
  });

  test("anime.csv: ignores airing status FINISHED, treats episodes_watched=0 on completed row as all episodes, and maps plan_to_watch to planned", () => {
    const completedRow: Record<string, string> = {
      title: "Synthetic Alchemist",
      title_english: "Synthetic Alchemist: Brotherhood",
      studios: "Studio Bones; Synthetic Production",
      format: "TV",
      status: "FINISHED",
      episodes: "64",
      episode_duration: "24",
      season: "SPRING",
      season_year: "2009",
      start_date: "2009-04-05",
      end_date: "2010-07-04",
      genres: "Action; Adventure; Drama",
      watch_status: "completed",
      user_rating: "4.5",
      user_notes: "Incredible pacing, great ending.",
      episodes_watched: "0",
      started_at: "",
      finished_at: "",
      cover_url: "https://cdn.achriom.invalid/covers/alchemist.jpg",
      anilist_id: "5114",
      mal_id: "5114",
      created_at: "2026-10-01T12:00:00Z",
    };

    const mapped = mapAchriomRow("anime.csv", completedRow, null);
    expect(mapped.kind).toBe("archive");
    if (mapped.kind === "archive") {
      expect(mapped.planned).toBe(false);
      expect(mapped.matched).toBe(false);
      expect(mapped.coverUrl).toBe("https://cdn.achriom.invalid/covers/alchemist.jpg");
      expect(mapped.request.status).toBe("finished");
      expect(mapped.request.rating).toBe(9);
      expect(mapped.request.note).toBe("Incredible pacing, great ending.");
      expect(mapped.request.when).toEqual({ precision: "unknown" });
      expect(mapped.request.consumed).toEqual({ seasons: [{ number: 1 }] });
      expect(mapped.request.work).toEqual({
        provider: "manual",
        category: "anime",
        title: "Synthetic Alchemist",
        year: 2009,
        creators: ["Studio Bones", "Synthetic Production"],
        seasons: [
          {
            number: 1,
            title: null,
            year: 2009,
            episodes: 64,
            episode_minutes: 24,
            total_minutes: 1536,
            provider_id: "5114",
          },
        ],
        runtime_minutes: null,
        pages: null,
      });
    }

    // plan_to_watch row even when AniList airing status is FINISHED
    const plannedRow: Record<string, string> = {
      ...completedRow,
      watch_status: "plan_to_watch",
      user_rating: "",
      user_notes: "",
    };
    const mappedPlanned = mapAchriomRow("anime.csv", plannedRow, null);
    expect(mappedPlanned.kind).toBe("archive");
    if (mappedPlanned.kind === "archive") {
      expect(mappedPlanned.planned).toBe(true);
      expect(mappedPlanned.request.status).toBe("planned");
      expect(mappedPlanned.request.consumed).toEqual({
        seasons: [{ number: 1 }],
        minutes_override: 0,
      });
    }
  });

  test("books.csv, movies.csv, shows.csv, albums.csv, podcasts.csv, games.csv pure mapping", () => {
    // 1. books.csv (finished, unread, abandoned)
    const finishedBook = mapAchriomRow("books.csv", {
      title: "Synthetic Dune",
      author: "Frank Synthetic",
      isbn: "9780441172719",
      publication_year: "1965",
      page_count: "412",
      reading_status: "finished",
      user_rating: "5",
      user_notes: "Spice must flow",
      finished_at: "2025-08-20",
      created_at: "2026-10-01",
    });
    expect(finishedBook.kind).toBe("archive");
    if (finishedBook.kind === "archive") {
      expect(finishedBook.request.status).toBe("finished");
      expect(finishedBook.request.rating).toBe(10);
      expect(finishedBook.request.note).toBe("Spice must flow");
      expect(finishedBook.request.when).toEqual({
        precision: "day",
        date: "2025-08-20",
      });
      expect(finishedBook.request.consumed).toEqual({ progress: 1 });
      expect(finishedBook.request.work.pages).toBe(412);
    }

    const unreadBook = mapAchriomRow("books.csv", {
      title: "Unread Synthetic Book",
      author: "Author X",
      publication_year: "2020",
      page_count: "300",
      reading_status: "unread",
    });
    expect(unreadBook.kind).toBe("archive");
    if (unreadBook.kind === "archive") {
      expect(unreadBook.planned).toBe(true);
      expect(unreadBook.request.status).toBe("planned");
      expect(unreadBook.request.consumed).toEqual({ progress: 0 });
    }

    const abandonedBook = mapAchriomRow("books.csv", {
      title: "Abandoned Synthetic Book",
      author: "Author Y",
      publication_year: "2021",
      page_count: "500",
      reading_status: "abandoned",
    });
    expect(abandonedBook.kind).toBe("archive");
    if (abandonedBook.kind === "archive") {
      expect(abandonedBook.planned).toBe(false);
      expect(abandonedBook.request.status).toBe("dropped");
      expect(abandonedBook.request.consumed).toEqual({
        progress: 0,
        minutes_override: 0,
      });
    }

    // 2. movies.csv (watched, abandoned)
    const watchedMovie = mapAchriomRow("movies.csv", {
      title: "Synthetic Runner 2049",
      director: "Denis Synthetic",
      release_date: "2017-10-06",
      runtime_minutes: "164",
      watch_status: "watched",
      user_rating: "4.5",
      last_watched_at: "2024-02-10",
      imdb_id: "tt1856101",
      tmdb_id: "335984",
    });
    expect(watchedMovie.kind).toBe("archive");
    if (watchedMovie.kind === "archive") {
      expect(watchedMovie.request.status).toBe("finished");
      expect(watchedMovie.request.rating).toBe(9);
      expect(watchedMovie.request.when).toEqual({
        precision: "day",
        date: "2024-02-10",
      });
      expect(watchedMovie.request.consumed).toEqual({ times: 1 });
      expect(watchedMovie.request.work.runtime_minutes).toBe(164);
    }

    const abandonedMovie = mapAchriomRow("movies.csv", {
      title: "Abandoned Film",
      release_date: "2019-01-01",
      runtime_minutes: "140",
      watch_status: "abandoned",
    });
    expect(abandonedMovie.kind).toBe("archive");
    if (abandonedMovie.kind === "archive") {
      expect(abandonedMovie.request.status).toBe("dropped");
      expect(abandonedMovie.request.consumed).toEqual({
        times: 1,
        progress: 0,
        minutes_override: 0,
      });
    }

    // 3. shows.csv with matched metadata seasons vs unwatched
    const matchedShowWork: WorkDetails = {
      provider: "tvmaze",
      provider_id: "169",
      category: "series",
      title: "Synthetic Wire",
      original_title: null,
      year: 2002,
      cover_url: "/api/meta-cover/tvmaze/169",
      creators: ["David Synthetic"],
      genres: ["Crime", "Drama"],
      description: "Baltimore crime drama.",
      seasons: [
        {
          number: 1,
          title: "Season 1",
          year: 2002,
          episodes: 13,
          episode_minutes: 60,
          total_minutes: 780,
          provider_id: null,
        },
        {
          number: 2,
          title: "Season 2",
          year: 2003,
          episodes: 12,
          episode_minutes: 60,
          total_minutes: 720,
          provider_id: null,
        },
      ],
      runtime_minutes: null,
      pages: null,
      external_ids: { tvmaze: "169", imdb: "tt0306414" },
    };

    const finishedShow = mapAchriomRow(
      "shows.csv",
      {
        title: "Synthetic Wire",
        creator: "David Synthetic",
        first_air_date: "2002-06-02",
        number_of_seasons: "",
        number_of_episodes: "",
        watch_status: "finished",
        user_rating: "5",
        tmdb_id: "1438",
      },
      matchedShowWork
    );
    expect(finishedShow.kind).toBe("archive");
    if (finishedShow.kind === "archive") {
      expect(finishedShow.matched).toBe(true);
      expect(finishedShow.request.status).toBe("finished");
      expect(finishedShow.request.consumed).toEqual({
        seasons: [{ number: 1 }, { number: 2 }],
      });
    }

    const unwatchedShow = mapAchriomRow(
      "shows.csv",
      {
        title: "Synthetic Wire",
        first_air_date: "2002-06-02",
        watch_status: "unwatched",
      },
      matchedShowWork
    );
    expect(unwatchedShow.kind).toBe("archive");
    if (unwatchedShow.kind === "archive") {
      expect(unwatchedShow.planned).toBe(true);
      expect(unwatchedShow.request.status).toBe("planned");
      expect(unwatchedShow.request.consumed).toEqual({
        seasons: [{ number: 1 }],
        minutes_override: 0,
      });
    }

    // 4. albums.csv -> category "music"
    const album = mapAchriomRow("albums.csv", {
      title: "Synthetic Computer",
      artist: "Synthetichead",
      release_date: "1997-05-21",
      duration_minutes: "53",
      listen_status: "listened",
      user_rating: "4.5",
      discogs_id: "12345",
    });
    expect(album.kind).toBe("archive");
    if (album.kind === "archive") {
      expect(album.request.work.category).toBe("music");
      expect(album.request.work.runtime_minutes).toBe(53);
      expect(album.request.rating).toBe(9);
    }

    // 5. podcasts.csv -> category "podcast"
    const podcast = mapAchriomRow("podcasts.csv", {
      title: "Synthetic History Podcast",
      publisher: "Dan Synthetic",
      listen_status: "finished",
      podcast_index_id: "99887",
    });
    expect(podcast.kind).toBe("archive");
    if (podcast.kind === "archive") {
      expect(podcast.request.work.category).toBe("podcast");
      expect(podcast.request.work.creators).toEqual(["Dan Synthetic"]);
    }

    // 6. games.csv -> skipped with reason
    const game = mapAchriomRow("games.csv", {
      title: "Synthetic Elysium",
      developer: "ZA/UM Synthetic",
      play_status: "completed",
      igdb_id: "26472",
    });
    expect(game).toEqual({
      kind: "skip",
      file: "games.csv",
      title: "Synthetic Elysium",
      reason: "games are not a tracked category",
    });
  });

  test("selectConfidentLookupHit matches exact title + compatible year and rejects wrong year or unrelated title", () => {
    const hits = [
      {
        provider: "tvmaze" as const,
        provider_id: "10",
        category: "series" as const,
        title: "Synthetic Office",
        subtitle: "2001 · BBC",
        year: 2001,
        cover_url: null,
      },
      {
        provider: "tvmaze" as const,
        provider_id: "20",
        category: "series" as const,
        title: "Synthetic Office",
        subtitle: "2005 · NBC",
        year: 2005,
        cover_url: null,
      },
    ];

    expect(
      selectConfidentLookupHit(hits, ["Synthetic Office"], 2005, "series")?.provider_id
    ).toBe("20");
    expect(
      selectConfidentLookupHit(hits, ["Synthetic Office"], 2018, "series")
    ).toBeNull();
    expect(
      selectConfidentLookupHit(hits, ["Completely Different Show"], 2005, "series")
    ).toBeNull();
  });
});

describe("Achriom full import runner, HTTP POST /api/import/achriom, and CLI", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let config: Config;
  let coverDownloads: number;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-achriom-test-"));
    dbPath = join(tempDir, "inputtracker.db");
    db = openDb(dbPath);
    config = makeTestConfig(dbPath);
    coverDownloads = 0;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createMockFetch(): typeof fetch {
    return (async (input: unknown, init?: RequestInit) => {
      const url = String(input);

      // 1. AniList GraphQL (2-season franchise: S1=101348, S2=136430)
      if (url.includes("anilist.invalid/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const id = body?.variables?.id;
        const s1 = {
          id: 101348,
          idMal: 37521,
          type: "ANIME",
          format: "TV",
          status: "FINISHED",
          episodes: 24,
          duration: 24,
          seasonYear: 2019,
          title: { english: "Synthetic Vinland", romaji: "Synthetic Vinland" },
          coverImage: { large: "https://anilist.invalid/img/101348.jpg" },
          studios: { nodes: [{ name: "Wit Synthetic", isAnimationStudio: true }] },
          relations: {
            edges: [
              {
                relationType: "SEQUEL",
                node: {
                  id: 136430,
                  idMal: 49387,
                  type: "ANIME",
                  format: "TV",
                  status: "FINISHED",
                  episodes: 24,
                  duration: 24,
                  seasonYear: 2023,
                  title: { english: "Synthetic Vinland Season 2" },
                },
              },
            ],
          },
        };
        const s2 = {
          id: 136430,
          idMal: 49387,
          type: "ANIME",
          format: "TV",
          status: "FINISHED",
          episodes: 24,
          duration: 24,
          seasonYear: 2023,
          title: { english: "Synthetic Vinland Season 2" },
          coverImage: { large: "https://anilist.invalid/img/136430.jpg" },
          studios: { nodes: [{ name: "MAPPA Synthetic", isAnimationStudio: true }] },
          relations: {
            edges: [
              {
                relationType: "PREQUEL",
                node: {
                  id: 101348,
                  idMal: 37521,
                  type: "ANIME",
                  format: "TV",
                  status: "FINISHED",
                  episodes: 24,
                  duration: 24,
                  seasonYear: 2019,
                  title: { english: "Synthetic Vinland" },
                },
              },
            ],
          },
        };
        if (id === 101348) {
          return new Response(JSON.stringify({ data: { Media: s1 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (id === 136430) {
          return new Response(JSON.stringify({ data: { Media: s2 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ data: { Media: null } }), { status: 404 });
      }

      // 2. Cinemeta movie lookup by imdb_id (tt9000001)
      if (url.includes("cinemeta.invalid/meta/movie/tt9000001.json")) {
        return new Response(
          JSON.stringify({
            meta: {
              id: "tt9000001",
              type: "movie",
              name: "Synthetic Arrival",
              year: "2016",
              runtime: "116 min",
              director: ["Denis Synthetic"],
              genres: ["Sci-Fi", "Drama"],
              poster: "https://cinemeta.invalid/poster/tt9000001.jpg",
              videos: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      // 3. TVmaze show search + work details for "Synthetic Severance" (2022)
      if (url.includes("tvmaze.invalid/search/shows")) {
        if (url.toLowerCase().includes("severance")) {
          return new Response(
            JSON.stringify([
              {
                score: 0.99,
                show: {
                  id: 500,
                  name: "Synthetic Severance",
                  premiered: "2022-02-18",
                  weight: 98,
                  image: { medium: "https://tvmaze.invalid/img/500.jpg" },
                  externals: { imdb: "tt11280740" },
                },
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("tvmaze.invalid/shows/500")) {
        return new Response(
          JSON.stringify({
            id: 500,
            name: "Synthetic Severance",
            premiered: "2022-02-18",
            averageRuntime: 50,
            genres: ["Drama", "Sci-Fi"],
            externals: { imdb: "tt11280740" },
            image: { medium: "https://tvmaze.invalid/img/500.jpg" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("tvmaze.invalid/shows/500/seasons")) {
        return new Response(
          JSON.stringify([
            { id: 1, number: 1, name: "Season 1", episodeOrder: 9, premiereDate: "2022-02-18" },
            { id: 2, number: 2, name: "Season 2", episodeOrder: 10, premiereDate: "2025-01-17" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("tvmaze.invalid/shows/500/episodes")) {
        return new Response(
          JSON.stringify([
            ...Array.from({ length: 9 }, (_, i) => ({
              id: 100 + i,
              season: 1,
              number: i + 1,
              runtime: 50,
              airdate: "2022-02-18",
            })),
            ...Array.from({ length: 10 }, (_, i) => ({
              id: 200 + i,
              season: 2,
              number: i + 1,
              runtime: 50,
              airdate: "2025-01-17",
            })),
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      // 4. Open Library search + work details for "Synthetic Hail Mary"
      if (url.includes("openlibrary.invalid/search.json")) {
        if (url.toLowerCase().includes("hail+mary") || url.toLowerCase().includes("hail%20mary")) {
          return new Response(
            JSON.stringify({
              numFound: 1,
              docs: [
                {
                  key: "/works/OL77777W",
                  title: "Synthetic Hail Mary",
                  author_name: ["Andy Synthetic"],
                  first_publish_year: 2021,
                  number_of_pages_median: 476,
                  cover_i: 99999,
                  isbn: ["9780593135204"],
                  edition_count: 45,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ numFound: 0, docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("openlibrary.invalid/works/OL77777W.json")) {
        return new Response(
          JSON.stringify({
            key: "/works/OL77777W",
            title: "Synthetic Hail Mary",
            covers: [99999],
            subjects: ["Sci-Fi"],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      // 5. CDN cover for unmatched ManualWork
      if (url.includes("cdn.achriom.invalid/covers/")) {
        coverDownloads += 1;
        return new Response(PNG_BYTES, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }

      // Other search endpoints return empty results
      if (url.includes("cinemeta.invalid/catalog/")) {
        return new Response(JSON.stringify({ metas: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("itunes.invalid/search")) {
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;
  }

  function buildSampleArchiveZip(options: { movieRuntime?: string; bookRating?: string } = {}): Uint8Array {
    const animeCsv = buildAchriomCsv("anime.csv", [
      {
        title: "Synthetic Vinland",
        title_english: "Synthetic Vinland",
        studios: "Wit Synthetic",
        format: "TV",
        status: "FINISHED",
        episodes: "24",
        episode_duration: "24",
        season_year: "2019",
        watch_status: "completed",
        user_rating: "4.5",
        user_notes: "Great first season",
        episodes_watched: "0",
        anilist_id: "101348",
        mal_id: "37521",
        created_at: "2026-10-01T10:00:00Z",
      },
      {
        title: "Synthetic Vinland Season 2",
        title_english: "Synthetic Vinland Season 2",
        studios: "MAPPA Synthetic",
        format: "TV",
        status: "FINISHED",
        episodes: "24",
        episode_duration: "24",
        season_year: "2023",
        watch_status: "completed",
        user_rating: "4.5",
        user_notes: "Great first season",
        episodes_watched: "0",
        anilist_id: "136430",
        mal_id: "49387",
        created_at: "2026-10-01T10:00:00Z",
      },
    ]);

    const booksCsv = buildAchriomCsv("books.csv", [
      {
        title: "Synthetic Hail Mary",
        author: "Andy Synthetic",
        isbn: "9780593135204",
        publication_year: "2021",
        page_count: "400", // 400 * 1.5 = 600 min
        reading_status: "finished",
        user_rating: options.bookRating ?? "5",
        user_notes: "Amaze!",
        finished_at: "2025-05-10",
        created_at: "2026-10-01T10:00:00Z",
      },
      {
        title: "Unmatched Indie Book",
        author: "Indie Author",
        isbn: "",
        publication_year: "2020",
        page_count: "200", // 200 * 1.5 = 300 min
        reading_status: "finished",
        user_rating: "3.5",
        cover_url: "https://cdn.achriom.invalid/covers/indie-book.png",
        created_at: "2026-10-01T10:00:00Z",
      },
    ]);

    const moviesCsv = buildAchriomCsv("movies.csv", [
      {
        title: "Synthetic Arrival",
        director: "Denis Synthetic",
        release_date: "2016-11-11",
        runtime_minutes: options.movieRuntime ?? "116",
        watch_status: "watched",
        user_rating: "4",
        last_watched_at: "2024-09-01",
        imdb_id: "tt9000001",
        tmdb_id: "329865",
        created_at: "2026-10-01T10:00:00Z",
      },
    ]);

    const showsCsv = buildAchriomCsv("shows.csv", [
      {
        title: "Synthetic Severance",
        creator: "Dan Synthetic",
        first_air_date: "2022-02-18",
        number_of_seasons: "",
        number_of_episodes: "",
        watch_status: "watched",
        user_rating: "4.5",
        tmdb_id: "95396",
        created_at: "2026-10-01T10:00:00Z",
      },
    ]);

    // Header-only empty files for albums, podcasts, games (plus 1 game row to test skip)
    const albumsCsv = buildAchriomCsv("albums.csv", []);
    const podcastsCsv = buildAchriomCsv("podcasts.csv", []);
    const gamesCsv = buildAchriomCsv("games.csv", [
      {
        title: "Synthetic Hades",
        developer: "Supergiant Synthetic",
        play_status: "completed",
        igdb_id: "113112",
      },
    ]);

    return createZip([
      { name: "anime.csv", data: animeCsv, method: 8 },
      { name: "books.csv", data: booksCsv, method: 8 },
      { name: "movies.csv", data: moviesCsv, method: 8 },
      { name: "shows.csv", data: showsCsv, method: 0 },
      { name: "albums.csv", data: albumsCsv, method: 0 },
      { name: "podcasts.csv", data: podcastsCsv, method: 0 },
      { name: "games.csv", data: gamesCsv, method: 8 },
    ]);
  }

  test("dry run previews exact counts and minutes without writing to DB; full import writes entries, repeat import writes 0 rows, changed row writes a new revision", async () => {
    const mockFetch = createMockFetch();
    const app = createApp({ db, config, fetchImage: mockFetch });
    const zipBytes = buildSampleArchiveZip();

    // Expected minutes:
    // - Anime S1: 24 * 24 = 576
    // - Anime S2: 24 * 24 = 576
    // - Book 1 (Hail Mary): 400 * 1.5 = 600
    // - Book 2 (Indie): 200 * 1.5 = 300
    // - Movie (Arrival): 116
    // - Show (Severance): S1 (9 * 50 = 450) + S2 (10 * 50 = 500) = 950
    // Total = 576 + 576 + 600 + 300 + 116 + 950 = 3118 min

    // 1. Dry-run via HTTP POST /api/import/achriom?dry_run=1
    const dryForm = new FormData();
    dryForm.append(
      "file",
      new File([zipBytes], "achriom-library-2026-10-18.zip", {
        type: "application/zip",
      })
    );
    const dryRes = await app.request("/api/import/achriom?dry_run=1", {
      method: "POST",
      body: dryForm,
    });
    expect(dryRes.status).toBe(200);
    const dryBody = (await dryRes.json()) as AchriomImportResult;
    expect(dryBody).toEqual({
      dry_run: true,
      rows: {
        "anime.csv": 2,
        "books.csv": 2,
        "movies.csv": 1,
        "shows.csv": 1,
        "albums.csv": 0,
        "podcasts.csv": 0,
        "games.csv": 1,
      },
      created: 6,
      unchanged: 0,
      updated: 0,
      planned: 0,
      matched: 5, // 2 anime + 1 book + 1 movie + 1 show matched; 1 indie book unmatched
      skipped: [
        {
          file: "games.csv",
          title: "Synthetic Hades",
          reason: "games are not a tracked category",
        },
      ],
      total_minutes: 3118,
    });

    // Verify 0 rows written to DB or manual cover cache during dry run
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;").get()!.n
    ).toBe(0);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM annotations;").get()!.n
    ).toBe(0);
    expect(coverDownloads).toBe(0);

    // 2. Real import via HTTP POST /api/import/achriom
    const importForm = new FormData();
    importForm.append(
      "file",
      new File([zipBytes], "achriom-library-2026-10-18.zip", {
        type: "application/zip",
      })
    );
    const importRes = await app.request("/api/import/achriom", {
      method: "POST",
      body: importForm,
    });
    expect(importRes.status).toBe(200);
    const importBody = (await importRes.json()) as AchriomImportResult;
    expect(importBody).toEqual({
      ...dryBody,
      dry_run: false,
    });

    // Unmatched manual book cover was fetched once into the permanent cover cache
    expect(coverDownloads).toBe(1);
    const indieEntryId = achriomRowEntryId("books.csv", {
      title: "Unmatched Indie Book",
      publication_year: "2020",
    });
    expect(
      existsSync(join(metaCoverCacheDir(config), `manual_${indieEntryId}.img`))
    ).toBe(true);

    const eventsAfterFirst = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;")
      .get()!.n;
    const annotationsAfterFirst = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM annotations;")
      .get()!.n;
    // 6 entries, where Severance has 2 seasons -> 7 event units total
    expect(eventsAfterFirst).toBe(7);
    expect(annotationsAfterFirst).toBe(5);

    // Library shows all works joined properly (Vinland S1 + S2 joined into 1 anime work with 1152 min!)
    const libRes = await app.request("/api/library");
    expect(libRes.status).toBe(200);
    const lib = (await libRes.json()) as LibraryResult;
    expect(lib.total_minutes).toBe(3118);
    expect(lib.works).toHaveLength(5);
    const animeWork = lib.works.find((w) => w.category === "anime");
    expect(animeWork?.title).toBe("Synthetic Vinland");
    expect(animeWork?.total_minutes).toBe(1152);
    expect(animeWork?.status).toBe("finished");
    expect(animeWork?.rating).toBe(9);

    // 3. Repeat import of the identical zip -> 0 rows written anywhere!
    const repeatForm = new FormData();
    repeatForm.append(
      "file",
      new File([zipBytes], "achriom-library-2026-10-18.zip", {
        type: "application/zip",
      })
    );
    const repeatRes = await app.request("/api/import/achriom", {
      method: "POST",
      body: repeatForm,
    });
    expect(repeatRes.status).toBe(200);
    const repeatBody = (await repeatRes.json()) as AchriomImportResult;
    expect(repeatBody.created).toBe(0);
    expect(repeatBody.updated).toBe(0);
    expect(repeatBody.unchanged).toBe(6);
    expect(repeatBody.total_minutes).toBe(3118);

    // Zero new rows in events or annotations, and manual cover was not re-downloaded
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;").get()!.n
    ).toBe(eventsAfterFirst);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM annotations;").get()!.n
    ).toBe(annotationsAfterFirst);
    expect(coverDownloads).toBe(1);

    // 4. Changed row -> new revision of the same entry!
    // Change movie runtime from 116 to 125 (director's cut)
    const modifiedZip = buildSampleArchiveZip({ movieRuntime: "125" });
    const movieEntryId = achriomRowEntryId("movies.csv", {
      title: "Synthetic Arrival",
      imdb_id: "tt9000001",
    });

    const modForm = new FormData();
    modForm.append(
      "file",
      new File([modifiedZip], "achriom-library-2026-10-18.zip", {
        type: "application/zip",
      })
    );
    const modRes = await app.request("/api/import/achriom", {
      method: "POST",
      body: modForm,
    });
    expect(modRes.status).toBe(200);
    const modBody = (await modRes.json()) as AchriomImportResult;
    expect(modBody.created).toBe(0);
    expect(modBody.updated).toBe(1);
    expect(modBody.unchanged).toBe(5);
    expect(modBody.total_minutes).toBe(3127); // 3118 - 116 + 125

    // Verify `events` has both revisions of `archive:<movieEntryId>:v1` (append-only)
    // and `events_latest` has only the new 125-minute revision
    const movieHistoryRows = db
      .query<EventRow, [string]>(
        "SELECT * FROM events WHERE source_id = ? ORDER BY id ASC;"
      )
      .all(`archive:${movieEntryId}:v1`);
    expect(movieHistoryRows).toHaveLength(2);
    expect(movieHistoryRows[0]?.duration_seconds).toBe(116 * 60);
    expect(movieHistoryRows[1]?.duration_seconds).toBe(125 * 60);

    const movieLatest = db
      .query<EventRow, [string]>(
        "SELECT * FROM events_latest WHERE source_id = ?;"
      )
      .all(`archive:${movieEntryId}:v1`);
    expect(movieLatest).toHaveLength(1);
    expect(movieLatest[0]?.duration_seconds).toBe(125 * 60);
  });

  test("POST /api/import/achriom accepts a single CSV upload and validates errors and size limits", async () => {
    const mockFetch = createMockFetch();
    const app = createApp({ db, config, fetchImage: mockFetch });

    const singleBooksCsv = buildAchriomCsv("books.csv", [
      {
        title: "Synthetic Hail Mary",
        author: "Andy Synthetic",
        isbn: "9780593135204",
        publication_year: "2021",
        page_count: "400",
        reading_status: "finished",
        user_rating: "4.5",
      },
    ]);

    const form = new FormData();
    form.append("file", new File([singleBooksCsv], "books.csv", { type: "text/csv" }));
    const res = await app.request("/api/import/achriom", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AchriomImportResult;
    expect(body).toEqual({
      dry_run: false,
      rows: { "books.csv": 1 },
      created: 1,
      unchanged: 0,
      updated: 0,
      planned: 0,
      matched: 1,
      skipped: [],
      total_minutes: 600,
    });

    // Validation errors -> 400
    const badQuery = await app.request("/api/import/achriom?unknown=1", {
      method: "POST",
      body: form,
    });
    expect(badQuery.status).toBe(400);

    const badDryRun = await app.request("/api/import/achriom?dry_run=maybe", {
      method: "POST",
      body: form,
    });
    expect(badDryRun.status).toBe(400);

    const emptyForm = new FormData();
    const missingFile = await app.request("/api/import/achriom", {
      method: "POST",
      body: emptyForm,
    });
    expect(missingFile.status).toBe(400);

    const badCsvForm = new FormData();
    badCsvForm.append("file", new File(["foo,bar\n1,2\n"], "random.csv"));
    const badCsvRes = await app.request("/api/import/achriom", {
      method: "POST",
      body: badCsvForm,
    });
    expect(badCsvRes.status).toBe(400);

    // Oversized Content-Length -> 413
    const oversizedRes = await app.request("/api/import/achriom", {
      method: "POST",
      headers: { "Content-Length": String(20 * 1024 * 1024) },
      body: form,
    });
    expect(oversizedRes.status).toBe(413);
  });

  test("CLI: `it import achriom <path> [--dry-run]` imports zip or csv and prints summary", async () => {
    const mockFetch = createMockFetch();
    const zipPath = join(tempDir, "achriom-library-2026-10-18.zip");
    writeFileSync(zipPath, buildSampleArchiveZip());

    const captured = { out: "", err: "" };
    const cliDeps = {
      loadConfig: () => config,
      fetch: mockFetch,
      out: (line: string) => {
        captured.out += `${line}\n`;
      },
      err: (line: string) => {
        captured.err += `${line}\n`;
      },
    };

    // 1. Dry run via CLI
    const dryCode = await runCli(
      ["import", "achriom", zipPath, "--dry-run"],
      cliDeps
    );
    expect(dryCode).toBe(0);
    expect(captured.err).toBe("");
    expect(captured.out).toContain("achriom (dry-run):");
    expect(captured.out).toContain("6 created, 0 updated, 0 unchanged");
    expect(captured.out).toContain("5 matched, 1 skipped, 3118 min");

    // 2. Real import via CLI
    captured.out = "";
    const runCode = await runCli(["import", "achriom", zipPath], cliDeps);
    expect(runCode).toBe(0);
    expect(captured.err).toBe("");
    expect(captured.out).toContain("achriom: 7 rows");
    expect(captured.out).toContain("6 created, 0 updated, 0 unchanged");
    expect(captured.out).toContain("3118 min");

    // 3. Repeat import via CLI
    captured.out = "";
    const repeatCode = await runCli(["import", "achriom", zipPath], cliDeps);
    expect(repeatCode).toBe(0);
    expect(captured.out).toContain("0 created, 0 updated, 6 unchanged");

    // 4. Missing path argument -> exit 1
    captured.err = "";
    const missingCode = await runCli(["import", "achriom"], cliDeps);
    expect(missingCode).toBe(1);
    expect(captured.err).toContain("Missing <path>.");
  });
});

// enable after W04 merges
describe.skip("Achriom planned/dropped status in Library API", () => {
  test("planned and dropped rows saved through POST /api/import/achriom appear in Library with status planned/dropped and 0 minutes", async () => {
    const db = openDb(":memory:");
    const config = makeTestConfig(":memory:");
    const app = createApp({
      db,
      config,
      fetchImage: (async () =>
        new Response(JSON.stringify({ docs: [], metas: [], results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    const csv = buildAchriomCsv("books.csv", [
      {
        title: "Planned Synthetic Book",
        author: "Author One",
        publication_year: "2024",
        page_count: "350",
        reading_status: "unread",
      },
      {
        title: "Dropped Synthetic Book",
        author: "Author Two",
        publication_year: "2023",
        page_count: "420",
        reading_status: "abandoned",
      },
    ]);

    const form = new FormData();
    form.append("file", new File([csv], "books.csv", { type: "text/csv" }));
    const res = await app.request("/api/import/achriom", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AchriomImportResult;
    expect(body.planned).toBe(1);
    expect(body.created).toBe(2);
    expect(body.total_minutes).toBe(0);

    const libRes = await app.request("/api/library?category=book");
    const lib = (await libRes.json()) as LibraryResult;
    const plannedWork = lib.works.find((w) => w.title === "Planned Synthetic Book");
    const droppedWork = lib.works.find((w) => w.title === "Dropped Synthetic Book");
    expect(plannedWork?.status).toBe("planned");
    expect(plannedWork?.total_minutes).toBe(0);
    expect(droppedWork?.status).toBe("dropped");
    expect(droppedWork?.total_minutes).toBe(0);
    db.close();
  });
});
