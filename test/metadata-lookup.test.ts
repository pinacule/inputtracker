import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { type Config, loadConfig, redact, redactString } from "../src/core/config.ts";
import {
  cleanDescription,
  getMetaCover,
  isMetaProvider,
  isValidProviderId,
  Limiter,
  lookupSearch,
  lookupWork,
  MAX_ANILIST_HOPS,
  metaCoverCacheDir,
  metadataCacheDir,
  ProviderError,
  providersForCategory,
  rankLookupHits,
  SEARCH_CACHE_TTL_MS,
  upscaleItunesArtwork,
  WORK_CACHE_TTL_MS,
} from "../src/server/metadata/index.ts";

const FAKE_TMDB_KEY = "test-tmdb-key";

function makeConfig(dbPath: string, overrides: Partial<Config> = {}): Config {
  const base: Config = {
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
  };
  return base;
}

describe("[metadata] config loading and redaction", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-meta-cfg-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("defaults are populated when [metadata] is absent", () => {
    const cfg = loadConfig({
      path: join(tempDir, "missing.toml"),
      env: { XDG_DATA_HOME: join(tempDir, "xdg") },
    });
    expect(cfg.metadata).toEqual({
      enabled: true,
      anilist_url: "https://graphql.anilist.co",
      tvmaze_url: "https://api.tvmaze.com",
      cinemeta_url: "https://v3-cinemeta.strem.io",
      itunes_url: "https://itunes.apple.com",
      openlibrary_url: "https://openlibrary.org",
      openlibrary_covers_url: "https://covers.openlibrary.org",
      tmdb_url: "https://api.themoviedb.org/3",
      tmdb_image_url: "https://image.tmdb.org/t/p",
    } as Config["metadata"]);
    expect(cfg.metadata?.tmdb_api_key).toBe("");
  });

  test("reads all [metadata] keys and hides tmdb_api_key from every serializer and redact()", () => {
    const tomlPath = join(tempDir, "meta.toml");
    writeFileSync(
      tomlPath,
      [
        "[metadata]",
        "enabled = false",
        'anilist_url = "https://anilist.example/gql"',
        'tvmaze_url = "https://tvmaze.example"',
        'itunes_url = "https://itunes.example"',
        'openlibrary_url = "https://ol.example"',
        'openlibrary_covers_url = "https://covers.ol.example"',
        'tmdb_url = "https://tmdb.example/3"',
        'tmdb_image_url = "https://img.tmdb.example/t/p"',
        `tmdb_api_key = "${FAKE_TMDB_KEY}"`,
        "",
      ].join("\n"),
      "utf8"
    );

    const cfg = loadConfig({ path: tomlPath, env: {} });
    expect(cfg.metadata?.enabled).toBe(false);
    expect(cfg.metadata?.anilist_url).toBe("https://anilist.example/gql");
    expect(cfg.metadata?.tvmaze_url).toBe("https://tvmaze.example");
    expect(cfg.metadata?.itunes_url).toBe("https://itunes.example");
    expect(cfg.metadata?.openlibrary_url).toBe("https://ol.example");
    expect(cfg.metadata?.openlibrary_covers_url).toBe("https://covers.ol.example");
    expect(cfg.metadata?.tmdb_url).toBe("https://tmdb.example/3");
    expect(cfg.metadata?.tmdb_image_url).toBe("https://img.tmdb.example/t/p");
    expect(cfg.metadata?.tmdb_api_key).toBe(FAKE_TMDB_KEY);

    // Must never leak through String, JSON.stringify, util.inspect, redact, or redactString
    expect(String(cfg)).not.toContain(FAKE_TMDB_KEY);
    expect(JSON.stringify(cfg)).not.toContain(FAKE_TMDB_KEY);
    expect(inspect(cfg)).not.toContain(FAKE_TMDB_KEY);
    expect(redact(cfg)).not.toContain(FAKE_TMDB_KEY);
    expect(redact(`url?api_key=${FAKE_TMDB_KEY}`)).toBe("url?api_key=***");
    expect(redactString(`Bearer ${FAKE_TMDB_KEY}`, cfg)).toBe("Bearer ***");
    expect(redact({ tmdb_api_key: FAKE_TMDB_KEY })).not.toContain(FAKE_TMDB_KEY);
  });

  test("wrong types in [metadata] throw without leaking secrets", () => {
    const badEnabled = join(tempDir, "bad1.toml");
    writeFileSync(badEnabled, '[metadata]\nenabled = "yes"\n', "utf8");
    expect(() => loadConfig({ path: badEnabled, env: {} })).toThrow(/metadata\.enabled/);

    const badKey = join(tempDir, "bad2.toml");
    writeFileSync(badKey, "[metadata]\ntmdb_api_key = 12345\n", "utf8");
    expect(() => loadConfig({ path: badKey, env: {} })).toThrow(/metadata\.tmdb_api_key/);
  });
});

describe("Provider mappings and AniList season chain", () => {
  let tempDir: string;
  let dbPath: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-meta-providers-"));
    dbPath = join(tempDir, "inputtracker.db");
    config = makeConfig(dbPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("AniList: Vinland Saga returns 2 seasons of 24 episodes whether looked up from S1 or S2", async () => {
    const season1Node = {
      id: 101348,
      idMal: 37521,
      type: "ANIME",
      format: "TV",
      episodes: 24,
      duration: 24,
      seasonYear: 2019,
      startDate: { year: 2019 },
      popularity: 420000,
      genres: ["Action", "Adventure", "Drama"],
      description:
        "<p>Young <b>Thorfinn</b> grows up on the cold shores of Iceland.<br><br>~!Hidden spoiler text!~</p>",
      title: {
        english: "Vinland Saga",
        romaji: "Vinland Saga",
        native: "ヴィンランド・サガ",
      },
      coverImage: {
        large: "https://anilist.invalid/img/vinland-s1.jpg",
      },
      studios: {
        nodes: [
          { name: "Wit Studio", isAnimationStudio: true },
          { name: "Twin Engine", isAnimationStudio: false },
        ],
      },
      relations: {
        edges: [
          {
            relationType: "ADAPTATION",
            node: { id: 30642, type: "MANGA", format: "MANGA", title: { english: "Vinland Saga" } },
          },
          {
            relationType: "SIDE_STORY",
            node: { id: 999991, type: "ANIME", format: "SPECIAL", episodes: 1, duration: 2 },
          },
          {
            relationType: "SEQUEL",
            node: {
              id: 136430,
              idMal: 49387,
              type: "ANIME",
              format: "TV",
              episodes: 24,
              duration: 24,
              seasonYear: 2023,
              title: {
                english: "Vinland Saga Season 2",
                romaji: "Vinland Saga SEASON 2",
                native: "ヴィンランド・サガ SEASON2",
              },
            },
          },
        ],
      },
    };

    const season2Node = {
      id: 136430,
      idMal: 49387,
      type: "ANIME",
      format: "TV",
      episodes: 24,
      duration: 24,
      seasonYear: 2023,
      startDate: { year: 2023 },
      popularity: 280000,
      genres: ["Action", "Adventure", "Drama"],
      description: "A new millennium begins in the southern part of the Jutland peninsula.",
      title: {
        english: "Vinland Saga Season 2",
        romaji: "Vinland Saga SEASON 2",
        native: "ヴィンランド・サガ SEASON2",
      },
      coverImage: {
        large: "https://anilist.invalid/img/vinland-s2.jpg",
      },
      studios: {
        nodes: [{ name: "MAPPA", isAnimationStudio: true }],
      },
      relations: {
        edges: [
          {
            relationType: "PREQUEL",
            node: {
              id: 101348,
              idMal: 37521,
              type: "ANIME",
              format: "TV",
              episodes: 24,
              duration: 24,
              seasonYear: 2019,
              title: { english: "Vinland Saga", romaji: "Vinland Saga" },
            },
          },
        ],
      },
    };

    let gqlCalls = 0;
    const mockFetch = (async (_input: unknown, init?: RequestInit) => {
      gqlCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const id = body?.variables?.id;
      if (id === 101348) {
        return new Response(JSON.stringify({ data: { Media: season1Node } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (id === 136430) {
        return new Response(JSON.stringify({ data: { Media: season2Node } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { Media: null } }), { status: 404 });
    }) as typeof fetch;

    // 1. Lookup starting from Season 1 (101348)
    const workFromS1 = await lookupWork("anilist", "101348", { config, fetch: mockFetch });
    expect(workFromS1).not.toBeNull();
    expect(workFromS1?.provider).toBe("anilist");
    expect(workFromS1?.provider_id).toBe("101348");
    expect(workFromS1?.category).toBe("anime");
    expect(workFromS1?.title).toBe("Vinland Saga");
    expect(workFromS1?.original_title).toBe("ヴィンランド・サガ");
    expect(workFromS1?.year).toBe(2019);
    expect(workFromS1?.cover_url).toBe("/api/meta-cover/anilist/101348");
    expect(workFromS1?.creators).toEqual(["Wit Studio"]);
    expect(workFromS1?.genres).toEqual(["Action", "Adventure", "Drama"]);
    expect(workFromS1?.description).toBe("Young Thorfinn grows up on the cold shores of Iceland.");
    expect(workFromS1?.runtime_minutes).toBeNull();
    expect(workFromS1?.pages).toBeNull();
    expect(workFromS1?.external_ids).toEqual({ anilist: "101348", mal: "37521" });
    expect(workFromS1?.seasons).toEqual([
      {
        number: 1,
        title: "Vinland Saga",
        year: 2019,
        episodes: 24,
        episode_minutes: 24,
        total_minutes: 576,
        provider_id: "101348",
      },
      {
        number: 2,
        title: "Vinland Saga Season 2",
        year: 2023,
        episodes: 24,
        episode_minutes: 24,
        total_minutes: 576,
        provider_id: "136430",
      },
    ]);

    // 2. Lookup starting from Season 2 (136430): walks PREQUEL back to S1, then SEQUEL forward
    gqlCalls = 0;
    const workFromS2 = await lookupWork("anilist", "136430", { config, fetch: mockFetch });
    expect(workFromS2).not.toBeNull();
    expect(workFromS2?.seasons).toHaveLength(2);
    expect(workFromS2?.seasons[0]?.number).toBe(1);
    expect(workFromS2?.seasons[0]?.provider_id).toBe("101348");
    expect(workFromS2?.seasons[0]?.episodes).toBe(24);
    expect(workFromS2?.seasons[1]?.number).toBe(2);
    expect(workFromS2?.seasons[1]?.provider_id).toBe("136430");
    expect(workFromS2?.seasons[1]?.episodes).toBe(24);
    // Only 2 GraphQL calls (136430 then 101348; 136430 is reused from nodeCache on forward pass)
    expect(gqlCalls).toBe(2);
  });

  test("AniList: format MOVIE returns runtime_minutes and empty seasons", async () => {
    const movieNode = {
      id: 21519,
      idMal: 32281,
      type: "ANIME",
      format: "MOVIE",
      episodes: 1,
      duration: 106,
      seasonYear: 2016,
      genres: ["Drama", "Romance", "Supernatural"],
      description: "Two teenagers share a profound, magical connection.",
      title: {
        english: "Your Name.",
        romaji: "Kimi no Na wa.",
        native: "君の名は。",
      },
      coverImage: { large: "https://anilist.invalid/img/your-name.jpg" },
      studios: { nodes: [{ name: "CoMix Wave Films", isAnimationStudio: true }] },
      relations: { edges: [] },
    };

    const mockFetch = (async () =>
      new Response(JSON.stringify({ data: { Media: movieNode } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const work = await lookupWork("anilist", "21519", { config, fetch: mockFetch });
    expect(work).not.toBeNull();
    expect(work?.category).toBe("anime");
    expect(work?.title).toBe("Your Name.");
    expect(work?.seasons).toEqual([]);
    expect(work?.runtime_minutes).toBe(106);
    expect(work?.external_ids).toEqual({ anilist: "21519", mal: "32281" });
  });

  test("AniList: stops after MAX_ANILIST_HOPS (15 hops) and avoids cycles", async () => {
    const mockFetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const id = Number(body?.variables?.id ?? 1);
      const nextId = id + 1;
      return new Response(
        JSON.stringify({
          data: {
            Media: {
              id,
              type: "ANIME",
              format: "TV",
              episodes: 12,
              duration: 24,
              seasonYear: 2000 + id,
              title: { english: `Long Franchise S${id}` },
              relations: {
                edges: [
                  // Include a cycle back to id - 1 as SEQUEL to verify cycle protection, plus nextId
                  ...(id > 1
                    ? [
                        {
                          relationType: "SEQUEL",
                          node: { id: id - 1, type: "ANIME", format: "TV" },
                        },
                      ]
                    : []),
                  {
                    relationType: "SEQUEL",
                    node: {
                      id: nextId,
                      type: "ANIME",
                      format: "TV",
                      episodes: 12,
                      duration: 24,
                      title: { english: `Long Franchise S${nextId}` },
                    },
                  },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const work = await lookupWork("anilist", "1", { config, fetch: mockFetch });
    expect(work).not.toBeNull();
    // 1 initial season + 15 sequel hops = 16 seasons max
    expect(work?.seasons.length).toBe(1 + MAX_ANILIST_HOPS);
    expect(work?.seasons[0]?.number).toBe(1);
    expect(work?.seasons[MAX_ANILIST_HOPS]?.number).toBe(16);
  });

  test("TVmaze: maps search and sums per-episode runtimes for seasons", async () => {
    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/search/shows")) {
        return new Response(
          JSON.stringify([
            {
              score: 0.95,
              show: {
                id: 169,
                name: "Synthetic Bad",
                premiered: "2008-01-20",
                weight: 99,
                network: { name: "AMC" },
                image: { medium: "https://tvmaze.invalid/img/169.jpg" },
              },
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/shows/169")) {
        return new Response(
          JSON.stringify({
            id: 169,
            name: "Synthetic Bad",
            premiered: "2008-01-20",
            runtime: 60,
            averageRuntime: 48,
            genres: ["Drama", "Crime"],
            summary: "<p>A chemistry teacher turns to a life of crime.</p>",
            network: { name: "AMC" },
            externals: { imdb: "tt0903747", thetvdb: 81189 },
            image: { medium: "https://tvmaze.invalid/img/169.jpg" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/shows/169/seasons")) {
        return new Response(
          JSON.stringify([
            { id: 1, number: 1, name: "", episodeOrder: 3, premiereDate: "2008-01-20" },
            { id: 2, number: 2, name: "Season Two", episodeOrder: 2, premiereDate: "2009-03-08" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/shows/169/episodes")) {
        return new Response(
          JSON.stringify([
            { id: 101, season: 1, number: 1, runtime: 58, airdate: "2008-01-20" },
            { id: 102, season: 1, number: 2, runtime: 48, airdate: "2008-01-27" },
            { id: 103, season: 1, number: 3, runtime: 48, airdate: "2008-02-10" },
            { id: 201, season: 2, number: 1, runtime: 47, airdate: "2009-03-08" },
            { id: 202, season: 2, number: 2, runtime: 47, airdate: "2009-03-15" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const searchRes = await lookupSearch("Synthetic Bad", "series", {
      config,
      fetch: mockFetch,
    });
    expect(searchRes.failed_providers).toEqual([]);
    expect(searchRes.results).toHaveLength(1);
    expect(searchRes.results[0]).toEqual({
      provider: "tvmaze",
      provider_id: "169",
      category: "series",
      title: "Synthetic Bad",
      subtitle: "2008 · AMC",
      year: 2008,
      cover_url: "/api/meta-cover/tvmaze/169",
    });

    const work = await lookupWork("tvmaze", "169", { config, fetch: mockFetch });
    expect(work).not.toBeNull();
    expect(work?.title).toBe("Synthetic Bad");
    expect(work?.external_ids).toEqual({
      tvmaze: "169",
      imdb: "tt0903747",
      thetvdb: "81189",
    });
    expect(work?.description).toBe("A chemistry teacher turns to a life of crime.");
    expect(work?.seasons).toEqual([
      {
        number: 1,
        title: null,
        year: 2008,
        episodes: 3,
        episode_minutes: 51,
        total_minutes: 154, // 58 + 48 + 48
        provider_id: null,
      },
      {
        number: 2,
        title: "Season Two",
        year: 2009,
        episodes: 2,
        episode_minutes: 47,
        total_minutes: 94, // 47 + 47
        provider_id: null,
      },
    ]);
  });

  test("iTunes Search: converts trackTimeMillis to minutes and upscales artworkUrl100 to 600x600", async () => {
    expect(
      upscaleItunesArtwork(
        "https://is1-ssl.mzstatic.com/image/thumb/Video113/v4/aa/bb/100x100bb.jpg"
      )
    ).toBe("https://is1-ssl.mzstatic.com/image/thumb/Video113/v4/aa/bb/600x600bb.jpg");

    const itunesPayload = {
      resultCount: 1,
      results: [
        {
          wrapperType: "track",
          kind: "feature-movie",
          trackId: 1485258363,
          trackName: "Synthetic Parasite",
          artistName: "Director Kim",
          releaseDate: "2019-05-30T07:00:00Z",
          trackTimeMillis: 7_920_000, // 132 minutes
          primaryGenreName: "Thriller",
          longDescription: "A satirical thriller about two families.",
          artworkUrl100:
            "https://itunes.invalid/image/thumb/Video113/v4/100x100bb.jpg",
        },
      ],
    };

    const fetchedUrls: string[] = [];
    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("/search") || url.includes("/lookup")) {
        return new Response(JSON.stringify(itunesPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("600x600bb.jpg")) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const searchRes = await lookupSearch("Synthetic Parasite", "film", {
      config,
      fetch: mockFetch,
    });
    expect(searchRes.results).toHaveLength(1);
    expect(searchRes.results[0]).toEqual({
      provider: "itunes",
      provider_id: "1485258363",
      category: "film",
      title: "Synthetic Parasite",
      subtitle: "Director Kim · 2019 · 132 min",
      year: 2019,
      cover_url: "/api/meta-cover/itunes/1485258363",
    });

    const work = await lookupWork("itunes", "1485258363", { config, fetch: mockFetch });
    expect(work).not.toBeNull();
    expect(work?.runtime_minutes).toBe(132);
    expect(work?.creators).toEqual(["Director Kim"]);
    expect(work?.genres).toEqual(["Thriller"]);
    expect(work?.seasons).toEqual([]);
    expect(work?.external_ids).toEqual({ itunes: "1485258363" });

    // Fetching the cover uses the upscaled 600x600 URL
    const cover = await getMetaCover("itunes", "1485258363", { config, fetch: mockFetch });
    expect(cover).not.toBeNull();
    expect(fetchedUrls.some((u) => u.includes("600x600bb.jpg"))).toBe(true);
  });

  test("Open Library: maps books and audiobooks, editions pages fallback, and ISBN", async () => {
    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/search.json")) {
        return new Response(
          JSON.stringify({
            numFound: 1,
            docs: [
              {
                key: "/works/OL27448W",
                title: "A Wizard of Synthetic Sea",
                author_name: ["Ursula Test"],
                first_publish_year: 1968,
                number_of_pages_median: 183,
                cover_i: 82345,
                isbn: ["0553383043", "9780553383041"],
                edition_count: 120,
                subject: ["Fantasy", "Magic"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/works/OL27448W.json")) {
        return new Response(
          JSON.stringify({
            key: "/works/OL27448W",
            title: "A Wizard of Synthetic Sea",
            description: {
              type: "/type/text",
              value: "A young mage learns true names in an archipelago.",
            },
            covers: [82345],
            subjects: ["Fantasy", "Magic"],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/works/OL99999W.json")) {
        return new Response(
          JSON.stringify({
            key: "/works/OL99999W",
            title: "Cold Work Lookup Book",
            description: "Direct work lookup without prior search.",
            covers: [55555],
            subjects: ["Sci-Fi"],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/works/OL99999W/editions.json")) {
        return new Response(
          JSON.stringify({
            entries: [
              { number_of_pages: 300, isbn_13: ["9781111111111"], publish_date: "2001" },
              { number_of_pages: 320 },
              { number_of_pages: 340 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    // 1. Search as book
    const bookSearch = await lookupSearch("Wizard", "book", { config, fetch: mockFetch });
    expect(bookSearch.results).toHaveLength(1);
    expect(bookSearch.results[0]).toEqual({
      provider: "openlibrary",
      provider_id: "OL27448W",
      category: "book",
      title: "A Wizard of Synthetic Sea",
      subtitle: "Ursula Test · 1968 · 183 pages",
      year: 1968,
      cover_url: "/api/meta-cover/openlibrary/OL27448W",
    });

    // 2. Search as audiobook
    const audioSearch = await lookupSearch("Wizard", "audiobook", { config, fetch: mockFetch });
    expect(audioSearch.results).toHaveLength(1);
    expect(audioSearch.results[0]?.category).toBe("audiobook");
    expect(audioSearch.results[0]?.subtitle).toBe("Ursula Test · 1968");

    // 3. Work details for OL27448W
    const work = await lookupWork("openlibrary", "OL27448W", { config, fetch: mockFetch }, "book");
    expect(work).not.toBeNull();
    expect(work?.category).toBe("book");
    expect(work?.pages).toBe(183);
    expect(work?.creators).toEqual(["Ursula Test"]);
    expect(work?.description).toBe("A young mage learns true names in an archipelago.");
    expect(work?.external_ids).toEqual({
      openlibrary: "OL27448W",
      isbn: "9780553383041",
    });

    // 4. Cold work lookup using `/works/OL99999W/editions.json` for median pages and ISBN
    const coldWork = await lookupWork("openlibrary", "OL99999W", { config, fetch: mockFetch });
    expect(coldWork).not.toBeNull();
    expect(coldWork?.pages).toBe(320);
    expect(coldWork?.year).toBe(2001);
    expect(coldWork?.external_ids).toEqual({
      openlibrary: "OL99999W",
      isbn: "9781111111111",
    });
  });

  test("TMDB: enabled only when tmdb_api_key is set, ranked ahead of Cinemeta/iTunes/TVmaze", async () => {
    expect(providersForCategory("film", config)).toEqual(["cinemeta", "itunes"]);
    expect(providersForCategory("series", config)).toEqual(["tvmaze", "cinemeta"]);

    const tmdbConfig = makeConfig(dbPath, {
      metadata: {
        ...config.metadata!,
        tmdb_api_key: FAKE_TMDB_KEY,
      },
    });

    expect(providersForCategory("film", tmdbConfig)).toEqual(["tmdb", "cinemeta", "itunes"]);
    expect(providersForCategory("series", tmdbConfig)).toEqual(["tmdb", "tvmaze", "cinemeta"]);

    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("tmdb.invalid/3/search/movie")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 550,
                title: "Synthetic Dune",
                original_title: "Synthetic Dune",
                release_date: "2021-10-22",
                poster_path: "/dune.jpg",
                popularity: 95.5,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("itunes.invalid/search")) {
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [
              {
                trackId: 9001,
                trackName: "Synthetic Dune",
                artistName: "Denis Test",
                releaseDate: "2021-10-22T00:00:00Z",
                trackTimeMillis: 9_300_000,
                artworkUrl100: "https://itunes.invalid/100x100bb.jpg",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("tmdb.invalid/3/movie/550")) {
        return new Response(
          JSON.stringify({
            id: 550,
            title: "Synthetic Dune",
            release_date: "2021-10-22",
            runtime: 155,
            poster_path: "/dune.jpg",
            overview: "A noble family becomes embroiled in a war for control of the desert planet.",
            imdb_id: "tt1160419",
            genres: [{ id: 878, name: "Science Fiction" }],
            credits: {
              crew: [{ job: "Director", name: "Denis Test" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const searchRes = await lookupSearch("Synthetic Dune", "film", {
      config: tmdbConfig,
      fetch: mockFetch,
    });
    expect(searchRes.failed_providers).toEqual([]);
    expect(searchRes.results).toHaveLength(2);
    // TMDB hit comes ahead of iTunes hit
    expect(searchRes.results[0]?.provider).toBe("tmdb");
    expect(searchRes.results[0]?.provider_id).toBe("550");
    expect(searchRes.results[1]?.provider).toBe("itunes");

    const work = await lookupWork("tmdb", "550", { config: tmdbConfig, fetch: mockFetch });
    expect(work).not.toBeNull();
    expect(work?.runtime_minutes).toBe(155);
    expect(work?.creators).toEqual(["Denis Test"]);
    expect(work?.external_ids).toEqual({ tmdb: "550", imdb: "tt1160419" });
  });

  test("TMDB: maps TV series search and work details (filtering out season 0 specials)", async () => {
    const tmdbConfig = makeConfig(dbPath, {
      metadata: {
        ...config.metadata!,
        tmdb_api_key: FAKE_TMDB_KEY,
      },
    });

    const methods: Array<{ url: string; method: string }> = [];
    const mockFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      methods.push({ url, method: init?.method ?? "GET" });
      if (url.includes("tmdb.invalid/3/search/tv")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 1399,
                name: "Synthetic Thrones",
                original_name: "Synthetic Thrones",
                first_air_date: "2011-04-17",
                poster_path: "/thrones.jpg",
                popularity: 180.2,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("tvmaze.invalid/search/shows")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("tmdb.invalid/3/tv/1399")) {
        return new Response(
          JSON.stringify({
            id: 1399,
            name: "Synthetic Thrones",
            first_air_date: "2011-04-17",
            episode_run_time: [55],
            poster_path: "/thrones.jpg",
            overview: "Nine noble families fight for control over the mythical lands.",
            genres: [{ id: 18, name: "Drama" }, { id: 10765, name: "Sci-Fi & Fantasy" }],
            created_by: [{ name: "Creator A" }, { name: "Creator B" }],
            external_ids: { imdb_id: "tt0944947", tvdb_id: 121361 },
            seasons: [
              { season_number: 0, name: "Specials", episode_count: 10, air_date: "2011-01-01" },
              { season_number: 1, name: "Season 1", episode_count: 10, air_date: "2011-04-17" },
              { season_number: 2, name: "Season 2", episode_count: 10, air_date: "2012-04-01" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const searchRes = await lookupSearch("Synthetic Thrones", "series", {
      config: tmdbConfig,
      fetch: mockFetch,
    });
    expect(searchRes.results).toHaveLength(1);
    expect(searchRes.results[0]?.provider).toBe("tmdb");
    expect(searchRes.results[0]?.category).toBe("series");

    const work = await lookupWork("tmdb", "1399", { config: tmdbConfig, fetch: mockFetch });
    expect(work).not.toBeNull();
    expect(work?.category).toBe("series");
    expect(work?.creators).toEqual(["Creator A", "Creator B"]);
    expect(work?.external_ids).toEqual({
      tmdb: "1399",
      imdb: "tt0944947",
      thetvdb: "121361",
    });
    expect(work?.seasons).toEqual([
      {
        number: 1,
        title: "Season 1",
        year: 2011,
        episodes: 10,
        episode_minutes: 55,
        total_minutes: 550,
        provider_id: null,
      },
      {
        number: 2,
        title: "Season 2",
        year: 2012,
        episodes: 10,
        episode_minutes: 55,
        total_minutes: 550,
        provider_id: null,
      },
    ]);
    expect(methods.every((m) => m.method === "GET")).toBe(true);
  });

  test("Cinemeta: searches films when iTunes returns 0 hits, maps movie & series details, skips season 0 specials, and caches cover", async () => {
    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("cinemeta.invalid/catalog/movie/top/search=dune.json")) {
        return new Response(
          JSON.stringify({
            metas: [
              {
                id: "tt1160419",
                type: "movie",
                name: "Dune",
                releaseInfo: "2021",
                poster: "https://cinemeta.invalid/poster/tt1160419.jpg",
              },
              {
                id: "tt15239678",
                type: "movie",
                name: "Dune: Part Two",
                releaseInfo: "2024",
                poster: "https://cinemeta.invalid/poster/tt15239678.jpg",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("itunes.invalid/search")) {
        // Real iTunes behaviour observed in Oct 2026: resultCount 0 for media=movie
        return new Response(JSON.stringify({ resultCount: 0, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("cinemeta.invalid/meta/movie/tt15239678.json")) {
        return new Response(
          JSON.stringify({
            meta: {
              id: "tt15239678",
              type: "movie",
              name: "Dune: Part Two",
              year: "2024",
              runtime: "167 min",
              director: ["Denis Villeneuve"],
              cast: ["Actor One", "Actor Two"],
              genres: ["Action", "Adventure", "Drama"],
              description: "Paul Atreides unites with Chani and the Fremen.",
              poster: "https://cinemeta.invalid/poster/tt15239678.jpg",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("cinemeta.invalid/meta/series/tt0903747.json")) {
        return new Response(
          JSON.stringify({
            meta: {
              id: "tt0903747",
              type: "series",
              name: "Synthetic Bad",
              year: "2008–2013",
              runtime: "47 min",
              director: ["Vince Test"],
              genres: ["Crime", "Drama"],
              description: "High school chemistry teacher turns to manufacturing.",
              poster: "https://cinemeta.invalid/poster/tt0903747.jpg",
              videos: [
                { season: 0, episode: 1, name: "Minisode 1", released: "2009-02-17T00:00:00.000Z" },
                { season: 1, episode: 1, name: "Pilot", released: "2008-01-20T00:00:00.000Z" },
                { season: 1, episode: 2, name: "Cat's in the Bag", released: "2008-01-27T00:00:00.000Z" },
                { season: 2, number: 1, name: "Seven Thirty-Seven", released: "2009-03-08T00:00:00.000Z" },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("cinemeta.invalid/poster/tt15239678.jpg")) {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const searchRes = await lookupSearch("dune", "film", { config, fetch: mockFetch });
    expect(searchRes.failed_providers).toEqual([]);
    expect(searchRes.results).toHaveLength(2);
    expect(searchRes.results[0]).toEqual({
      provider: "cinemeta",
      provider_id: "tt1160419",
      category: "film",
      title: "Dune",
      subtitle: "2021",
      year: 2021,
      cover_url: "/api/meta-cover/cinemeta/tt1160419",
    });

    const movieWork = await lookupWork("cinemeta", "tt15239678", { config, fetch: mockFetch });
    expect(movieWork).not.toBeNull();
    expect(movieWork?.provider).toBe("cinemeta");
    expect(movieWork?.provider_id).toBe("tt15239678");
    expect(movieWork?.category).toBe("film");
    expect(movieWork?.title).toBe("Dune: Part Two");
    expect(movieWork?.year).toBe(2024);
    expect(movieWork?.runtime_minutes).toBe(167);
    expect(movieWork?.creators).toEqual(["Denis Villeneuve"]);
    expect(movieWork?.genres).toEqual(["Action", "Adventure", "Drama"]);
    expect(movieWork?.seasons).toEqual([]);
    expect(movieWork?.external_ids).toEqual({ imdb: "tt15239678" });

    const seriesWork = await lookupWork(
      "cinemeta",
      "tt0903747",
      { config, fetch: mockFetch },
      "series"
    );
    expect(seriesWork).not.toBeNull();
    expect(seriesWork?.category).toBe("series");
    expect(seriesWork?.runtime_minutes).toBeNull();
    expect(seriesWork?.external_ids).toEqual({ imdb: "tt0903747" });
    // Season 0 is skipped; seasons 1 and 2 derived from videos with 47 min per episode
    expect(seriesWork?.seasons).toEqual([
      {
        number: 1,
        title: null,
        year: 2008,
        episodes: 2,
        episode_minutes: 47,
        total_minutes: 94,
        provider_id: null,
      },
      {
        number: 2,
        title: null,
        year: 2009,
        episodes: 1,
        episode_minutes: 47,
        total_minutes: 47,
        provider_id: null,
      },
    ]);

    const cover = await getMetaCover("cinemeta", "tt15239678", { config, fetch: mockFetch });
    expect(cover).not.toBeNull();
    expect(cover?.contentType).toBe("image/png");
  });

  test("Series search deduplicates a show found on both TVmaze and Cinemeta via IMDb id", async () => {
    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("tvmaze.invalid/search/shows")) {
        return new Response(
          JSON.stringify([
            {
              score: 0.99,
              show: {
                id: 169,
                name: "Breaking Bad",
                premiered: "2008-01-20",
                weight: 99,
                network: { name: "AMC" },
                externals: { imdb: "tt0903747", thetvdb: 81189 },
                image: { medium: "https://tvmaze.invalid/img/169.jpg" },
              },
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("cinemeta.invalid/catalog/series/top/search=")) {
        return new Response(
          JSON.stringify({
            metas: [
              {
                id: "tt0903747",
                type: "series",
                name: "Breaking Bad",
                releaseInfo: "2008–2013",
                poster: "https://cinemeta.invalid/poster/tt0903747.jpg",
              },
              {
                id: "tt3032476",
                type: "series",
                name: "Better Call Saul",
                releaseInfo: "2015–2022",
                poster: "https://cinemeta.invalid/poster/tt3032476.jpg",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const res = await lookupSearch("Breaking Bad", "series", { config, fetch: mockFetch });
    expect(res.failed_providers).toEqual([]);
    // Breaking Bad appears once (from TVmaze), and Better Call Saul (only on Cinemeta) is kept
    expect(res.results.map((r) => `${r.provider}:${r.provider_id}`)).toEqual([
      "tvmaze:169",
      "cinemeta:tt3032476",
    ]);
  });

  test("AniList search collapses sequel seasons and side stories into one franchise hit with season/episode count, excluding unreleased seasons", async () => {
    const mockFetch = (async () => {
      return new Response(
        JSON.stringify({
          data: {
            Page: {
              media: [
                {
                  id: 101348,
                  type: "ANIME",
                  format: "TV",
                  status: "FINISHED",
                  episodes: 24,
                  seasonYear: 2019,
                  popularity: 420000,
                  title: { english: "Vinland Saga", romaji: "Vinland Saga" },
                  coverImage: { large: "https://anilist.invalid/s1.jpg" },
                  relations: {
                    edges: [
                      {
                        relationType: "SEQUEL",
                        node: {
                          id: 136430,
                          type: "ANIME",
                          format: "TV",
                          status: "FINISHED",
                          episodes: 24,
                          seasonYear: 2023,
                        },
                      },
                      {
                        relationType: "SIDE_STORY",
                        node: {
                          id: 140001,
                          type: "ANIME",
                          format: "ONA",
                          status: "FINISHED",
                          episodes: 1,
                          seasonYear: 2019,
                        },
                      },
                    ],
                  },
                },
                {
                  id: 136430,
                  type: "ANIME",
                  format: "TV",
                  status: "FINISHED",
                  episodes: 24,
                  seasonYear: 2023,
                  popularity: 280000,
                  title: { english: "Vinland Saga Season 2", romaji: "Vinland Saga SEASON 2" },
                  coverImage: { large: "https://anilist.invalid/s2.jpg" },
                  relations: {
                    edges: [
                      {
                        relationType: "PREQUEL",
                        node: {
                          id: 101348,
                          type: "ANIME",
                          format: "TV",
                          status: "FINISHED",
                          episodes: 24,
                          seasonYear: 2019,
                        },
                      },
                      {
                        relationType: "SEQUEL",
                        node: {
                          id: 199999,
                          type: "ANIME",
                          format: "TV",
                          status: "NOT_YET_RELEASED",
                          episodes: 24,
                          seasonYear: 2027,
                        },
                      },
                    ],
                  },
                },
                {
                  id: 140001,
                  type: "ANIME",
                  format: "ONA",
                  status: "FINISHED",
                  episodes: 1,
                  seasonYear: 2019,
                  popularity: 15000,
                  title: { english: "Vinland Saga Twin-Headed Dragon" },
                  relations: {
                    edges: [
                      {
                        relationType: "PARENT",
                        node: { id: 101348, type: "ANIME", format: "TV" },
                      },
                    ],
                  },
                },
                {
                  id: 140002,
                  type: "ANIME",
                  format: "SPECIAL",
                  status: "FINISHED",
                  episodes: 1,
                  seasonYear: 2023,
                  popularity: 8000,
                  title: { english: "Vinland Saga Season 2 Recap" },
                  relations: {
                    edges: [
                      {
                        relationType: "PARENT",
                        node: { id: 136430, type: "ANIME", format: "TV" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const res = await lookupSearch("vinland saga", "anime", {
      config,
      fetch: mockFetch,
      now: () => Date.parse("2026-10-18T12:00:00.000Z"),
    });

    expect(res.failed_providers).toEqual([]);
    // All 4 rows collapse into the single root entry, and the unreleased S3 does not count
    expect(res.results).toEqual([
      {
        provider: "anilist",
        provider_id: "101348",
        category: "anime",
        title: "Vinland Saga",
        subtitle: "2019 · 2 seasons · 48 episodes",
        year: 2019,
        cover_url: "/api/meta-cover/anilist/101348",
      },
    ]);
  });
});

describe("Ranking, timeouts, failed_providers, and disk caching", () => {
  let tempDir: string;
  let dbPath: string;
  let config: Config;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "it-meta-cache-"));
    dbPath = join(tempDir, "inputtracker.db");
    config = makeConfig(dbPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("rankLookupHits orders exact title match first, then popularity, then year, capped at 20", () => {
    const candidates = [
      {
        hit: {
          provider: "anilist" as const,
          provider_id: "1",
          category: "anime" as const,
          title: "Vinland Saga: The Official Guide",
          subtitle: "2020",
          year: 2020,
          cover_url: null,
        },
        popularity: 999999,
      },
      {
        hit: {
          provider: "openlibrary" as const,
          provider_id: "OL1W",
          category: "book" as const,
          title: "Vinland Saga",
          subtitle: "2005",
          year: 2005,
          cover_url: null,
        },
        popularity: 50,
      },
      {
        hit: {
          provider: "anilist" as const,
          provider_id: "101348",
          category: "anime" as const,
          title: "Vinland Saga",
          subtitle: "2019 · 24 episodes",
          year: 2019,
          cover_url: null,
        },
        popularity: 400000,
      },
    ];

    const ranked = rankLookupHits("vinland saga", candidates);
    expect(ranked.map((r) => `${r.provider}:${r.provider_id}`)).toEqual([
      "anilist:101348", // Exact match, higher popularity
      "openlibrary:OL1W", // Exact match, lower popularity
      "anilist:1", // Prefix match
    ]);

    // Cap at 20
    const many = Array.from({ length: 30 }, (_, idx) => ({
      hit: {
        provider: "openlibrary" as const,
        provider_id: `OL${idx}W`,
        category: "book" as const,
        title: `Synthetic Book ${idx}`,
        subtitle: null,
        year: 2000 + idx,
        cover_url: null,
      },
      popularity: idx,
    }));
    expect(rankLookupHits("Synthetic Book", many)).toHaveLength(20);
  });

  test("a provider timing out or returning 5xx lands in failed_providers while others succeed", async () => {
    const mockFetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("anilist.invalid")) {
        // Simulate timeout
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Timed out", "TimeoutError"));
          });
        });
      }
      if (url.includes("tvmaze.invalid")) {
        // Simulate 503
        return new Response("Service Unavailable", { status: 503 });
      }
      if (url.includes("itunes.invalid")) {
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [
              {
                trackId: 777,
                trackName: "Synthetic Odyssey",
                releaseDate: "2020-01-01T00:00:00Z",
                trackTimeMillis: 6_000_000,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("openlibrary.invalid")) {
        return new Response(JSON.stringify({ docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const res = await lookupSearch("Synthetic Odyssey", "any", {
      config,
      fetch: mockFetch,
      timeoutMs: 30,
    });

    expect(res.failed_providers).toEqual(["anilist", "tvmaze"]);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.provider).toBe("itunes");
    expect(res.results[0]?.title).toBe("Synthetic Odyssey");
  });

  test("7-day search cache and 30-day work details cache expire on schedule; covers stay forever", async () => {
    let currentTime = 1_700_000_000_000;
    const now = () => currentTime;

    let searchCalls = 0;
    let workCalls = 0;
    let imageCalls = 0;

    const mockFetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("itunes.invalid/search")) {
        searchCalls += 1;
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [
              {
                trackId: 12345,
                trackName: "Cached Film",
                releaseDate: "2022-05-01T00:00:00Z",
                trackTimeMillis: 7_200_000,
                artworkUrl100: "https://itunes.invalid/img/100x100bb.jpg",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/lookup")) {
        workCalls += 1;
        return new Response(
          JSON.stringify({
            resultCount: 1,
            results: [
              {
                trackId: 12345,
                trackName: "Cached Film",
                releaseDate: "2022-05-01T00:00:00Z",
                trackTimeMillis: 7_200_000,
                artworkUrl100: "https://itunes.invalid/img/100x100bb.jpg",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("600x600bb.jpg")) {
        imageCalls += 1;
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x01]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    // 1. Initial search -> hits network
    await lookupSearch("Cached Film", "film", { config, fetch: mockFetch, now });
    expect(searchCalls).toBe(1);
    expect(existsSync(metadataCacheDir(config))).toBe(true);

    // 6 days later -> served from disk cache
    currentTime += 6 * 24 * 3600 * 1000;
    await lookupSearch("Cached Film", "film", { config, fetch: mockFetch, now });
    expect(searchCalls).toBe(1);

    // 8 days after original -> cache expired (> 7 days), fetches again
    currentTime += 2 * 24 * 3600 * 1000;
    await lookupSearch("Cached Film", "film", { config, fetch: mockFetch, now });
    expect(searchCalls).toBe(2);

    // 2. Work details -> cached for 30 days
    await lookupWork("itunes", "12345", { config, fetch: mockFetch, now });
    expect(workCalls).toBe(1);

    currentTime += 29 * 24 * 3600 * 1000;
    await lookupWork("itunes", "12345", { config, fetch: mockFetch, now });
    expect(workCalls).toBe(1);

    currentTime += 2 * 24 * 3600 * 1000; // 31 days total
    await lookupWork("itunes", "12345", { config, fetch: mockFetch, now });
    expect(workCalls).toBe(2);

    // 3. Cover image -> downloaded once and kept forever (even 5 years later or when provider fails)
    const cover1 = await getMetaCover("itunes", "12345", { config, fetch: mockFetch, now });
    expect(cover1).not.toBeNull();
    expect(imageCalls).toBe(1);
    expect(existsSync(join(metaCoverCacheDir(config), "itunes_12345.img"))).toBe(true);

    currentTime += 365 * 5 * 24 * 3600 * 1000;
    const failingFetch = (async () => {
      throw new Error("provider vanished");
    }) as unknown as typeof fetch;
    const cover2 = await getMetaCover("itunes", "12345", { config, fetch: failingFetch, now });
    expect(cover2).not.toBeNull();
    expect(Array.from(cover2?.bytes ?? [])).toEqual([0xff, 0xd8, 0xff, 0x01]);
    expect(imageCalls).toBe(1);
  });

  test("cleanDescription strips HTML, decodes entities, and truncates to 600 chars", () => {
    expect(cleanDescription("<p>Hello &amp; <b>world</b>!<br>Line&#39;s 2</p>")).toBe(
      "Hello & world! Line's 2"
    );
    const long = "a".repeat(700);
    const cleaned = cleanDescription(long);
    expect(cleaned).not.toBeNull();
    expect(cleaned!.length).toBeLessThanOrEqual(600);
    expect(cleaned!.endsWith("…")).toBe(true);
  });

  test("isMetaProvider and isValidProviderId reject unsafe strings", () => {
    expect(isMetaProvider("anilist")).toBe(true);
    expect(isMetaProvider("tvmaze")).toBe(true);
    expect(isMetaProvider("itunes")).toBe(true);
    expect(isMetaProvider("openlibrary")).toBe(true);
    expect(isMetaProvider("tmdb")).toBe(true);
    expect(isMetaProvider("mal")).toBe(false);
    expect(isMetaProvider("../etc")).toBe(false);

    expect(isValidProviderId("101348")).toBe(true);
    expect(isValidProviderId("OL27448W")).toBe(true);
    expect(isValidProviderId("movie-550_a")).toBe(true);
    expect(isValidProviderId("")).toBe(false);
    expect(isValidProviderId("a".repeat(65))).toBe(false);
    expect(isValidProviderId("../etc/passwd")).toBe(false);
    expect(isValidProviderId("123/456")).toBe(false);
    expect(isValidProviderId("123?foo=bar")).toBe(false);
  });
});
