import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { finishRun, insertEvents, startRun } from "../src/core/events.ts";
import { cleanTitle, coverCacheDir, getCover } from "../src/server/covers.ts";
import { authorMatches, Limiter } from "../src/server/openlibrary.ts";
import { SourceUnavailable } from "../src/sources/audiobookshelf/client.ts";

const FAKE_TOKEN = "SYNTHETIC-TOKEN-4242";

function mockConfig(dbPath: string, overrides: Partial<Config> = {}): Config {
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
      token: FAKE_TOKEN,
      timeout_s: 20,
    },
    simkl: {
      client_id: "",
      base_url: "https://api.simkl.com",
      poster_base_url: "https://simkl.in/posters",
      timeout_s: 20,
    },
    youtube: { thumb_base_url: "https://i.ytimg.com/vi" },
    covers: {
      external: true,
      openlibrary_url: "https://openlibrary.org",
      openlibrary_covers_url: "https://covers.openlibrary.org",
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

function seedSession(
  db: Database,
  itemId: string,
  meta: {
    title: string;
    author: string;
    seriesName?: string;
  }
): void {
  const runId = startRun(db, "seed-session");
  insertEvents(db, runId, [
    {
      source: "audiobookshelf",
      source_kind: "listening_session",
      source_id: `sess-${itemId}`,
      external_ids: { abs_item: itemId },
      media_type: "audiobook",
      title: meta.title,
      parent_title: meta.author,
      started_at: "2026-10-17T08:00:00.000Z",
      ended_at: "2026-10-17T09:00:00.000Z",
      duration_seconds: 3600,
      raw: JSON.stringify({
        displayTitle: meta.title,
        displayAuthor: meta.author,
        libraryItemId: itemId,
        mediaMetadata: {
          title: meta.title,
          authorName: meta.author,
          seriesName: meta.seriesName,
        },
      }),
    },
  ]);
  finishRun(db, runId, { status: "ok", rowsSeen: 1, rowsInserted: 1 });
}

describe("Covers fallback chain", () => {
  let db: Database;
  let tempDir: string;
  let dbPath: string;
  let config: Config;

  beforeEach(() => {
    db = openDb(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "it-cover-fallback-"));
    dbPath = join(tempDir, "inputtracker.db");
    config = mockConfig(dbPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("cleanTitle helper strips suffixes and prefixes correctly", () => {
    expect(cleanTitle("Words of Radiance (Unabridged)")).toBe("Words of Radiance");
    expect(cleanTitle("Words of Radiance (Abridged)")).toBe("Words of Radiance");
    expect(cleanTitle("Words of Radiance (1 of 5)")).toBe("Words of Radiance");
    expect(cleanTitle("Words of Radiance [2 of 10]")).toBe("Words of Radiance");
    expect(cleanTitle("Words of Radiance (Part 1)")).toBe("Words of Radiance");
    expect(cleanTitle("Words of Radiance (Book 2)")).toBe("Words of Radiance");
    expect(
      cleanTitle(
        "The Stormlight Archive 2: Words of Radiance (Unabridged)",
        "The Stormlight Archive"
      )
    ).toBe("Words of Radiance");
    expect(
      cleanTitle(
        "The Stormlight Archive, Book 2: Words of Radiance",
        "The Stormlight Archive"
      )
    ).toBe("Words of Radiance");
    expect(cleanTitle("Mistborn 1: The Final Empire")).toBe("The Final Empire");
    expect(cleanTitle("Normal Standalone Title")).toBe("Normal Standalone Title");
  });

  test("step 1 hit (no further calls)", async () => {
    const absCalls: string[] = [];
    let fetchCalled = false;

    const mockClient = {
      getAllSessions: async () => [],
      get: async (path: string) => {
        absCalls.push(`get ${path}`);
        throw new Error("unexpected get");
      },
      getBinary: async (path: string) => {
        absCalls.push(`getBinary ${path}`);
        return {
          bytes: new Uint8Array([1, 2, 3]),
          contentType: "image/jpeg",
        };
      },
    };

    const mockFetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

    const cover = await getCover("item-step1", {
      config,
      db,
      createAbsClient: () => mockClient as any,
      fetch: mockFetch as any,
    });

    expect(cover).not.toBeNull();
    expect(cover?.contentType).toBe("image/jpeg");
    expect(Array.from(cover?.bytes ?? [])).toEqual([1, 2, 3]);

    expect(absCalls).toEqual(["getBinary /api/items/item-step1/cover"]);
    expect(fetchCalled).toBe(false);

    const cacheDir = coverCacheDir(config);
    expect(existsSync(join(cacheDir, "item-step1.img"))).toBe(true);
    expect(existsSync(join(cacheDir, "item-step1.type"))).toBe(true);
    expect(readFileSync(join(cacheDir, "item-step1.src"), "utf8").trim()).toBe("abs");
  });

  test("item 404 → relinked by exact title+author", async () => {
    seedSession(db, "item-deleted-1", {
      title: "The Way of Kings",
      author: "Brandon Sanderson",
    });

    const absCalls: string[] = [];
    const mockClient = {
      getAllSessions: async () => [],
      get: async (path: string) => {
        absCalls.push(`get ${path}`);
        if (path === "/api/libraries") {
          return [{ id: "lib-audiobooks", mediaType: "book" }];
        }
        if (path === "/api/libraries/lib-audiobooks/search") {
          return {
            book: [
              {
                libraryItem: {
                  id: "item-relinked-1",
                  media: {
                    metadata: {
                      title: "The Way of Kings",
                      authorName: "Brandon Sanderson",
                    },
                  },
                },
              },
            ],
          };
        }
        throw new Error(`unknown path: ${path}`);
      },
      getBinary: async (path: string) => {
        absCalls.push(`getBinary ${path}`);
        if (path === "/api/items/item-deleted-1/cover") {
          throw new Error("HTTP 404: Not Found");
        }
        if (path === "/api/items/item-relinked-1/cover") {
          return {
            bytes: new Uint8Array([10, 20, 30]),
            contentType: "image/png",
          };
        }
        throw new Error(`unknown binary path: ${path}`);
      },
    };

    let fetchCalled = false;
    const mockFetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

    const cover = await getCover("item-deleted-1", {
      config,
      db,
      createAbsClient: () => mockClient as any,
      fetch: mockFetch as any,
    });

    expect(cover).not.toBeNull();
    expect(cover?.contentType).toBe("image/png");
    expect(Array.from(cover?.bytes ?? [])).toEqual([10, 20, 30]);

    expect(absCalls).toEqual([
      "getBinary /api/items/item-deleted-1/cover",
      "get /api/libraries",
      "get /api/libraries/lib-audiobooks/search",
      "getBinary /api/items/item-relinked-1/cover",
    ]);
    expect(fetchCalled).toBe(false);

    const cacheDir = coverCacheDir(config);
    expect(existsSync(join(cacheDir, "item-deleted-1.img"))).toBe(true);
    expect(existsSync(join(cacheDir, "item-deleted-1.type"))).toBe(true);
    expect(readFileSync(join(cacheDir, "item-deleted-1.src"), "utf8").trim()).toBe(
      "abs-relinked:item-relinked-1"
    );
  });

  test("relink rejected on author mismatch", async () => {
    seedSession(db, "item-diff-author", {
      title: "Shadows of Self",
      author: "Brandon Sanderson",
    });

    const absCalls: string[] = [];
    const mockClient = {
      getAllSessions: async () => [],
      get: async (path: string) => {
        absCalls.push(`get ${path}`);
        if (path === "/api/libraries") {
          return [{ id: "lib-books", mediaType: "book" }];
        }
        if (path === "/api/libraries/lib-books/search") {
          return {
            book: [
              {
                libraryItem: {
                  id: "item-diff-author-abs",
                  media: {
                    metadata: {
                      title: "Shadows of Self",
                      authorName: "Completely Different Author",
                    },
                  },
                },
              },
            ],
          };
        }
        throw new Error(`unknown path: ${path}`);
      },
      getBinary: async (path: string) => {
        absCalls.push(`getBinary ${path}`);
        if (path === "/api/items/item-diff-author/cover") {
          throw new Error("HTTP 404: Not Found");
        }
        throw new Error(`should not call getBinary for ${path}`);
      },
    };

    const mockFetch = async () => {
      // Open Library returns no docs
      return new Response(JSON.stringify({ docs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const cover = await getCover("item-diff-author", {
      config,
      db,
      createAbsClient: () => mockClient as any,
      fetch: mockFetch as any,
    });

    expect(cover).toBeNull();
    // Candidate item-diff-author-abs cover was never fetched because author mismatched!
    expect(absCalls).not.toContain("getBinary /api/items/item-diff-author-abs/cover");

    const cacheDir = coverCacheDir(config);
    expect(existsSync(join(cacheDir, "item-diff-author.img"))).toBe(false);
    expect(existsSync(join(cacheDir, "item-diff-author.none"))).toBe(true);
  });

  test("series-prefix/suffix second try", async () => {
    seedSession(db, "item-series-try2", {
      title: "The Stormlight Archive 2: Words of Radiance (Unabridged)",
      author: "Brandon Sanderson",
      seriesName: "The Stormlight Archive",
    });

    const searchQueries: string[] = [];
    const mockClient = {
      getAllSessions: async () => [],
      get: async (path: string, query?: any) => {
        if (path === "/api/libraries") {
          return [{ id: "lib-main", mediaType: "book" }];
        }
        if (path === "/api/libraries/lib-main/search") {
          searchQueries.push(String(query?.q));
          if (query?.q === "Words of Radiance") {
            return {
              book: [
                {
                  libraryItem: {
                    id: "new-clean-id",
                    media: {
                      metadata: {
                        title: "Words of Radiance",
                        authorName: "Brandon Sanderson",
                      },
                    },
                  },
                },
              ],
            };
          }
          return { book: [] };
        }
        throw new Error(`unknown path ${path}`);
      },
      getBinary: async (path: string) => {
        if (path === "/api/items/item-series-try2/cover") {
          throw new Error("HTTP 404: Not Found");
        }
        if (path === "/api/items/new-clean-id/cover") {
          return {
            bytes: new Uint8Array([55, 66]),
            contentType: "image/jpeg",
          };
        }
        throw new Error(`unexpected getBinary ${path}`);
      },
    };

    const cover = await getCover("item-series-try2", {
      config,
      db,
      createAbsClient: () => mockClient as any,
      fetch: (async () => new Response("{}", { status: 200 })) as any,
    });

    expect(cover).not.toBeNull();
    expect(searchQueries).toEqual([
      "The Stormlight Archive 2: Words of Radiance (Unabridged)",
      "Words of Radiance",
    ]);

    const cacheDir = coverCacheDir(config);
    expect(readFileSync(join(cacheDir, "item-series-try2.src"), "utf8").trim()).toBe(
      "abs-relinked:new-clean-id"
    );
  });

  test("Open Library hit", async () => {
    seedSession(db, "item-openlib-hit", {
      title: "The Final Empire",
      author: "Brandon Sanderson",
    });

    const mockClient = {
      getAllSessions: async () => [],
      get: async () => ({ book: [] }),
      getBinary: async () => {
        throw new Error("HTTP 404: Not Found");
      },
    };

    const fetchedUrls: string[] = [];
    const mockFetch = async (input: any) => {
      const urlStr = String(input);
      fetchedUrls.push(urlStr);

      if (urlStr.includes("search.json")) {
        return new Response(
          JSON.stringify({
            docs: [
              {
                key: "/works/OL123",
                title: "The Final Empire",
                author_name: ["Brandon Sanderson"],
                cover_i: 889900,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (urlStr.includes("/b/id/889900-M.jpg")) {
        return new Response(new Uint8Array([7, 8, 9]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }

      return new Response("Not found", { status: 404 });
    };

    const cover = await getCover("item-openlib-hit", {
      config,
      db,
      createAbsClient: () => mockClient as any,
      fetch: mockFetch as any,
    });

    expect(cover).not.toBeNull();
    expect(cover?.contentType).toBe("image/jpeg");
    expect(Array.from(cover?.bytes ?? [])).toEqual([7, 8, 9]);

    expect(fetchedUrls.some((u) => u.includes("search.json"))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes("/b/id/889900-M.jpg"))).toBe(true);

    const cacheDir = coverCacheDir(config);
    expect(readFileSync(join(cacheDir, "item-openlib-hit.src"), "utf8").trim()).toBe(
      "openlibrary:889900"
    );
  });

  test("external = false skips Open Library", async () => {
    seedSession(db, "item-no-ext", {
      title: "Offline Book",
      author: "Quiet Author",
    });

    const mockClient = {
      getAllSessions: async () => [],
      get: async () => ({ book: [] }),
      getBinary: async () => {
        throw new Error("HTTP 404: Not Found");
      },
    };

    let fetchCalls = 0;
    const mockFetch = async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    };

    const cfgNoExt = mockConfig(dbPath, {
      covers: {
        external: false,
        openlibrary_url: "https://openlibrary.org",
        openlibrary_covers_url: "https://covers.openlibrary.org",
      },
    });

    const cover = await getCover("item-no-ext", {
      config: cfgNoExt,
      db,
      createAbsClient: () => mockClient as any,
      fetch: mockFetch as any,
    });

    expect(cover).toBeNull();
    expect(fetchCalls).toBe(0);

    const cacheDir = coverCacheDir(config);
    expect(existsSync(join(cacheDir, "item-no-ext.none"))).toBe(true);
  });

  test(".none cached and retried after 7 days (inject now)", async () => {
    seedSession(db, "item-retry-7d", {
      title: "Vanished Book",
      author: "Ghost",
    });

    let clientCalls = 0;
    const mockClient = {
      getAllSessions: async () => [],
      get: async () => {
        clientCalls++;
        return { book: [] };
      },
      getBinary: async () => {
        clientCalls++;
        throw new Error("HTTP 404: Not Found");
      },
    };

    const mockFetch = async () => {
      return new Response(JSON.stringify({ docs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    let currentTime = 100_000_000;
    const nowFn = () => currentTime;

    // 1. First attempt: nothing found -> caches .none with currentTime
    const cover1 = await getCover("item-retry-7d", {
      config,
      db,
      createAbsClient: () => mockClient as any,
      fetch: mockFetch as any,
      now: nowFn,
    });
    expect(cover1).toBeNull();
    const firstCallCount = clientCalls;
    expect(firstCallCount).toBeGreaterThan(0);

    const cacheDir = coverCacheDir(config);
    const nonePath = join(cacheDir, "item-retry-7d.none");
    expect(existsSync(nonePath)).toBe(true);
    expect(readFileSync(nonePath, "utf8").trim()).toBe("100000000");

    // 2. Second attempt 6 days later: still within 7 days, immediate null, no new calls
    currentTime += 6 * 24 * 3600 * 1000;
    const cover2 = await getCover("item-retry-7d", {
      config,
      db,
      createAbsClient: () => mockClient as any,
      fetch: mockFetch as any,
      now: nowFn,
    });
    expect(cover2).toBeNull();
    expect(clientCalls).toBe(firstCallCount);

    // 3. Third attempt 8 days after original: > 7 days, retries lookup
    currentTime = 100_000_000 + 8 * 24 * 3600 * 1000;
    const cover3 = await getCover("item-retry-7d", {
      config,
      db,
      createAbsClient: () => mockClient as any,
      fetch: mockFetch as any,
      now: nowFn,
    });
    expect(cover3).toBeNull();
    expect(clientCalls).toBeGreaterThan(firstCallCount);
  });

  test("5xx/timeout not cached", async () => {
    seedSession(db, "item-5xx-test", {
      title: "Broken Server",
      author: "Glitch",
    });

    // Subtest A: ABS throws SourceUnavailable 500
    const mockClient500 = {
      getAllSessions: async () => [],
      get: async () => {
        throw new SourceUnavailable("HTTP 500: Server Error");
      },
      getBinary: async () => {
        throw new SourceUnavailable("HTTP 500: Server Error");
      },
    };

    const cover500 = await getCover("item-5xx-test", {
      config,
      db,
      createAbsClient: () => mockClient500 as any,
      fetch: (async () => new Response("{}", { status: 200 })) as any,
    });
    expect(cover500).toBeNull();

    const cacheDir = coverCacheDir(config);
    expect(existsSync(join(cacheDir, "item-5xx-test.none"))).toBe(false);

    // Subtest B: Open Library returns 502
    seedSession(db, "item-ol-502", {
      title: "OL 502 Book",
      author: "Author 502",
    });

    const mockClient404 = {
      getAllSessions: async () => [],
      get: async () => ({ book: [] }),
      getBinary: async () => {
        throw new Error("HTTP 404: Not Found");
      },
    };

    const mockFetch502 = async () => {
      return new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" });
    };

    const coverOl502 = await getCover("item-ol-502", {
      config,
      db,
      createAbsClient: () => mockClient404 as any,
      fetch: mockFetch502 as any,
    });
    expect(coverOl502).toBeNull();
    expect(existsSync(join(cacheDir, "item-ol-502.none"))).toBe(false);
  });

  test("rejected ABS token (401/403) on the item cover stops the chain and caches nothing", async () => {
    for (const status of [401, 403]) {
      const itemId = `item-auth-${status}`;
      seedSession(db, itemId, { title: "Token Trouble", author: "Gatekeeper" });
      let externalCalls = 0;
      const cover = await getCover(itemId, {
        config,
        db,
        createAbsClient: () =>
          ({
            getAllSessions: async () => [],
            get: async () => {
              throw new Error(`HTTP ${status}: Unauthorized`);
            },
            getBinary: async () => {
              throw new Error(`HTTP ${status}: Unauthorized`);
            },
          }) as any,
        fetch: (async () => {
          externalCalls += 1;
          return new Response("{}", { status: 200 });
        }) as any,
      });
      expect(cover).toBeNull();
      expect(externalCalls).toBe(0);
      const cacheDir = coverCacheDir(config);
      expect(existsSync(join(cacheDir, `${itemId}.none`))).toBe(false);
      expect(existsSync(join(cacheDir, `${itemId}.img`))).toBe(false);
    }
  });

  test("401 on /api/libraries only skips the relink step", async () => {
    seedSession(db, "item-nolib", { title: "Library Locked", author: "Keeper" });
    let olCalls = 0;
    const cover = await getCover("item-nolib", {
      config,
      db,
      createAbsClient: () =>
        ({
          getAllSessions: async () => [],
          get: async () => {
            throw new Error("HTTP 401: Unauthorized");
          },
          getBinary: async () => {
            throw new Error("HTTP 404: Not Found");
          },
        }) as any,
      fetch: (async () => {
        olCalls += 1;
        return new Response(JSON.stringify({ docs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as any,
    });
    expect(cover).toBeNull();
    expect(olCalls).toBeGreaterThan(0);
    expect(existsSync(join(coverCacheDir(config), "item-nolib.none"))).toBe(true);
  });

  test("Open Library needs a known, matching author", async () => {
    const olDocs = (docs: unknown[]) =>
      (async (input: any) => {
        if (String(input).includes("search.json")) {
          return new Response(JSON.stringify({ docs }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(new Uint8Array([9]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }) as any;
    const abs404 = () =>
      ({
        getAllSessions: async () => [],
        get: async () => ({ book: [] }),
        getBinary: async () => {
          throw new Error("HTTP 404: Not Found");
        },
      }) as any;

    // No author in the session: a bare title is too generic, Open Library is not asked.
    seedSession(db, "item-no-author", { title: "Focus Point", author: "" });
    let calls = 0;
    const noAuthor = await getCover("item-no-author", {
      config,
      db,
      createAbsClient: abs404,
      fetch: (async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      }) as any,
    });
    expect(noAuthor).toBeNull();
    expect(calls).toBe(0);

    // Same title, different author: rejected.
    seedSession(db, "item-other-author", { title: "Shared Title", author: "Ana Novak" });
    const other = await getCover("item-other-author", {
      config,
      db,
      createAbsClient: abs404,
      fetch: olDocs([{ title: "Shared Title", author_name: ["Peter Horvat"], cover_i: 77 }]),
    });
    expect(other).toBeNull();

    // "Surname, Given" style on Open Library still matches.
    seedSession(db, "item-surname", { title: "Shared Title", author: "Ana Novak" });
    const match = await getCover("item-surname", {
      config,
      db,
      createAbsClient: abs404,
      fetch: olDocs([{ title: "Shared Title", author_name: ["Novak, Ana"], cover_i: 78 }]),
    });
    expect(match).not.toBeNull();
  });

  test("authorMatches compares the first author's surname", () => {
    expect(authorMatches("Ana Novak", ["Ana Novak"])).toBe(true);
    expect(authorMatches("Ana Novák", ["A. Novak"])).toBe(true);
    expect(authorMatches("Ana Novak, Peter Horvat", ["Novak, Ana", "P. Horvat"])).toBe(true);
    expect(authorMatches("Ana Novak & Peter Horvat", ["Ana Novak"])).toBe(true);
    expect(authorMatches("Ana Novak", ["Peter Horvat"])).toBe(false);
    expect(authorMatches("", ["Ana Novak"])).toBe(false);
    expect(authorMatches(undefined, ["Ana Novak"])).toBe(false);
    expect(authorMatches("Ana Novak", undefined)).toBe(false);
  });

  test("concurrent requests → one lookup", async () => {
    let binaryCalls = 0;
    const mockClient = {
      getAllSessions: async () => [],
      get: async () => ({ book: [] }),
      getBinary: async () => {
        binaryCalls++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          bytes: new Uint8Array([1, 2]),
          contentType: "image/jpeg",
        };
      },
    };

    const results = await Promise.all([
      getCover("item-concurrent", {
        config,
        db,
        createAbsClient: () => mockClient as any,
      }),
      getCover("item-concurrent", {
        config,
        db,
        createAbsClient: () => mockClient as any,
      }),
      getCover("item-concurrent", {
        config,
        db,
        createAbsClient: () => mockClient as any,
      }),
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]?.contentType).toBe("image/jpeg");
    expect(results[1]?.contentType).toBe("image/jpeg");
    expect(results[2]?.contentType).toBe("image/jpeg");
    expect(binaryCalls).toBe(1);
  });

  test("non-image or > 5 MB response rejected", async () => {
    seedSession(db, "item-bad-covers", {
      title: "Bad Payload Book",
      author: "Test Author",
    });

    const mockClient = {
      getAllSessions: async () => [],
      get: async () => ({ book: [] }),
      getBinary: async () => {
        throw new Error("HTTP 404: Not Found");
      },
    };

    // Subtest A: Content-Type is text/html
    const mockFetchHtml = async (input: any) => {
      const url = String(input);
      if (url.includes("search.json")) {
        return new Response(
          JSON.stringify({ docs: [{ title: "Bad Payload Book", author_name: ["Test Author"], cover_i: 111 }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("<html>Not an image</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    };

    const coverHtml = await getCover("item-bad-covers", {
      config,
      db,
      createAbsClient: () => mockClient as any,
      fetch: mockFetchHtml as any,
    });
    expect(coverHtml).toBeNull();
    const cacheDir = coverCacheDir(config);
    expect(existsSync(join(cacheDir, "item-bad-covers.img"))).toBe(false);

    // Subtest B: Content > 5 MB (5 * 1024 * 1024 + 1 bytes)
    seedSession(db, "item-too-large", {
      title: "Large Book",
      author: "Test Author",
    });

    const largeBytes = new Uint8Array(5 * 1024 * 1024 + 10);
    const mockFetchLarge = async (input: any) => {
      const url = String(input);
      if (url.includes("search.json")) {
        return new Response(
          JSON.stringify({ docs: [{ title: "Large Book", author_name: ["Test Author"], cover_i: 222 }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(largeBytes, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    };

    const coverLarge = await getCover("item-too-large", {
      config,
      db,
      createAbsClient: () => mockClient as any,
      fetch: mockFetchLarge as any,
    });
    expect(coverLarge).toBeNull();
    expect(existsSync(join(cacheDir, "item-too-large.img"))).toBe(false);
  });

  test("the .src file content is verified for all 3 origins", async () => {
    const cacheDir = coverCacheDir(config);

    // 1. abs
    await getCover("item-src-abs", {
      config,
      db,
      createAbsClient: () =>
        ({
          getBinary: async () => ({
            bytes: new Uint8Array([1]),
            contentType: "image/jpeg",
          }),
        } as any),
    });
    expect(readFileSync(join(cacheDir, "item-src-abs.src"), "utf8").trim()).toBe("abs");

    // 2. abs-relinked
    seedSession(db, "item-src-relink", {
      title: "Relinked Book",
      author: "Relink Author",
    });
    await getCover("item-src-relink", {
      config,
      db,
      createAbsClient: () =>
        ({
          get: async (path: string) => {
            if (path === "/api/libraries") return [{ id: "l1", mediaType: "book" }];
            return {
              book: [
                {
                  libraryItem: {
                    id: "relinked-target-99",
                    media: {
                      metadata: {
                        title: "Relinked Book",
                        authorName: "Relink Author",
                      },
                    },
                  },
                },
              ],
            };
          },
          getBinary: async (path: string) => {
            if (path.includes("item-src-relink")) throw new Error("HTTP 404: Not Found");
            return { bytes: new Uint8Array([2]), contentType: "image/png" };
          },
        } as any),
    });
    expect(readFileSync(join(cacheDir, "item-src-relink.src"), "utf8").trim()).toBe(
      "abs-relinked:relinked-target-99"
    );

    // 3. openlibrary
    seedSession(db, "item-src-ol", {
      title: "OL Book",
      author: "OL Author",
    });
    await getCover("item-src-ol", {
      config,
      db,
      createAbsClient: () =>
        ({
          get: async () => ({ book: [] }),
          getBinary: async () => {
            throw new Error("HTTP 404: Not Found");
          },
        } as any),
      fetch: (async (input: any) => {
        const url = String(input);
        if (url.includes("search.json")) {
          return new Response(
            JSON.stringify({ docs: [{ title: "OL Book", author_name: ["OL Author"], cover_i: 45678 }] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(new Uint8Array([3]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }) as any,
    });
    expect(readFileSync(join(cacheDir, "item-src-ol.src"), "utf8").trim()).toBe(
      "openlibrary:45678"
    );
  });

  test("Limiter limits concurrency to at most maxConcurrent", async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peakActive = 0;

    const task = async () => {
      await limiter.run(async () => {
        active++;
        if (active > peakActive) {
          peakActive = active;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
      });
    };

    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peakActive).toBe(2);
  });
});
