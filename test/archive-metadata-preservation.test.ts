import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/core/config.ts";
import type { ArchiveRequest, LibraryWorkDetail, ManualWork, WorkDetails, WorkEdit } from "../src/core/contract.ts";
import { openDb } from "../src/core/db.ts";
import { ACHRIOM_CSV_HEADERS, achriomRowEntryId, importAchriom } from "../src/io/import-achriom.ts";
import { escapeCsvField } from "../src/io/csv.ts";
import { createApp } from "../src/server/app.ts";
import { deleteArchiveEntry, getArchiveEntry, saveArchiveEntry } from "../src/server/archive.ts";
import { editLibraryWork, getLibrary, getLibraryWorkDetail, refreshLibraryWorkMetadata } from "../src/server/library.ts";
import { getWorkOverrides } from "../src/server/overrides.ts";
import { writeWorkCache } from "../src/server/metadata/cache.ts";
import { buildArchiveRequest, loadArchiveContext } from "../web/src/lib/archive-form.ts";
import { buildInProgressShelf } from "../web/src/lib/home.ts";
import { performWorkEdit } from "../web/src/lib/work-edits.ts";

const TZ = "Europe/Bratislava";
const ENTRY = "15151515-1111-4111-8111-111111111111";
const AGAIN = "15151515-2222-4222-8222-222222222222";
const KEY = "series:imdb:tt9900151";
const NOW = "2026-10-17T08:15:00.000Z";

function linkedWork(): WorkDetails {
  return {
    provider: "tvmaze", provider_id: "990151", category: "series", title: "Synthetic Lantern Patrol",
    original_title: "Synthetic Original", year: 2020, cover_url: "/api/meta-cover/tvmaze/990151",
    creators: ["Synthetic Creator"], genres: ["Synthetic Drama"], description: "Synthetic description.",
    seasons: [
      { number: 1, title: "Synthetic First", year: 2020, episodes: 9, episode_minutes: 43, total_minutes: 389, provider_id: "991001" },
      { number: 2, title: "Synthetic Second", year: 2021, episodes: 7, episode_minutes: 47, total_minutes: 331, provider_id: "991002" },
      { number: 3, title: "Synthetic Third", year: 2022, episodes: 5, episode_minutes: 41, total_minutes: 207, provider_id: "991003" },
    ],
    runtime_minutes: null, pages: null,
    external_ids: { tvmaze: "990151", imdb: "tt9900151", thetvdb: "990152", tmdb: "990153" },
  };
}

function manualWork(): ManualWork {
  const { category, title, year, creators, seasons, runtime_minutes, pages } = linkedWork();
  return { provider: "manual", category, title, year, creators, seasons, runtime_minutes, pages };
}

function request(work: WorkDetails | ManualWork = linkedWork()): ArchiveRequest {
  return {
    entry_id: ENTRY, work, consumed: { seasons: [{ number: 1 }] },
    when: { precision: "month", date: "2021-03", end_date: "2021-05" },
    status: "in_progress", rating: 8.5, note: "Synthetic note",
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("archive metadata preservation (W15)", () => {
  let db: Database;
  let dir: string;
  let config: Config;
  const originalFetch = globalThis.fetch;
  const noNetwork = (async () => { throw new Error("Unexpected network request"); }) as unknown as typeof fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(import.meta.dir, ".w15-metadata-"));
    db = openDb(":memory:");
    config = {
      timezone: TZ, server: { bind: "127.0.0.1", port: 8787 },
      storage: { db_path: join(dir, "synthetic.db"), backup_dir: join(dir, "backups"), backup_keep: 1 },
      audiobookshelf: { url: "https://abs.invalid", token: "", timeout_s: 1 },
      simkl: { client_id: "", base_url: "https://simkl.invalid", poster_base_url: "https://posters.invalid", timeout_s: 1 },
      youtube: { thumb_base_url: "https://thumbnails.invalid" },
      metadata: { enabled: true, tvmaze_url: "https://tvmaze.invalid", cinemeta_url: "https://cinemeta.invalid" },
      notify: { desktop: false, ntfy_url: "", ntfy_token: "", app_url: "", weekly_summary: false },
      toJSON: () => ({}), toString: () => "{}",
    } as Config;
    globalThis.fetch = noNetwork;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function routeFetch(): void {
    const app = createApp({ db, config, fetchImage: noNetwork });
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const path = String(input);
      if (!path.startsWith("/api/")) throw new Error("Unexpected external request");
      return app.request(path, init);
    }) as typeof fetch;
  }

  test("Edit entry loads the full stored request; changing watched seasons preserves metadata and key", async () => {
    saveArchiveEntry(db, request(), TZ, { nowIso: NOW });
    routeFetch();
    const context = await loadArchiveContext({ entryId: ENTRY });
    const entry = context.editingEntry!;
    expect(entry.work).toEqual(linkedWork());
    expect(entry.status).toBe("in_progress");
    expect(entry.rating).toBe(8.5);
    expect(entry.note).toBe("Synthetic note");
    const built = buildArchiveRequest({ ...entry, consumed: { seasons: [{ number: 1 }, { number: 2, episodes: 3 }] } });
    if (!built.ok) throw new Error(built.errors.join(", "));
    expect(built.request.work).toEqual(linkedWork());
    saveArchiveEntry(db, built.request, TZ);
    expect(getArchiveEntry(db, ENTRY).work).toEqual(linkedWork());
    const library = getLibrary(db);
    expect(library.works).toHaveLength(1);
    expect(library.works[0]?.key).toBe(KEY);
    expect(library.works[0]?.cover_url).toBe(linkedWork().cover_url);
    expect(library.works[0]?.progress?.episodes_watched).toBe(12);
    expect(getLibraryWorkDetail(db, KEY)?.work_snapshot).toEqual(linkedWork());
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(3);
  });

  test("server repairs same-title/category manual re-saves before computing duration, reports kept_link, and is repeatable", async () => {
    saveArchiveEntry(db, request(), TZ, { nowIso: NOW });
    const stale = request({ ...manualWork(), seasons: [], title: "  SYNTHETIC Lantern Patrol  " });
    stale.consumed = { seasons: [{ number: 2, episodes: 3 }] };
    const app = createApp({ db, config, fetchImage: noNetwork });
    const response = await app.request("/api/archive", { method: "POST", body: JSON.stringify(stale), headers: { "content-type": "application/json" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kept_link: true, total_minutes: 141 });
    expect(getArchiveEntry(db, ENTRY).work).toEqual(linkedWork());
    expect(getLibrary(db).works[0]?.key).toBe(KEY);
    const repeat = saveArchiveEntry(db, stale, TZ);
    expect(repeat.kept_link).toBe(true);
    expect(repeat.inserted).toBe(0);
    // An older removed-unit tombstone must not win over the latest active snapshot.
    const changedMetadata = { ...linkedWork(), description: "New synthetic metadata" };
    saveArchiveEntry(db, { ...stale, work: changedMetadata }, TZ);
    saveArchiveEntry(db, stale, TZ);
    expect(getArchiveEntry(db, ENTRY).work).toEqual(changedMetadata);
  });

  test("Add more seasons / Log again reuses the full snapshot in a new entry", async () => {
    saveArchiveEntry(db, request(), TZ, { nowIso: NOW });
    routeFetch();
    const shelf = buildInProgressShelf(getLibrary(db).works, []);
    expect(shelf[0]?.key).toBe(KEY);
    expect(shelf[0]).not.toHaveProperty("manualWorkPrefill");
    const context = await loadArchiveContext({ workKey: KEY });
    expect(context.work).toEqual(linkedWork());
    expect(context.editingEntry).toBeUndefined();
    const built = buildArchiveRequest({ entry_id: AGAIN, work: context.work!, consumed: { seasons: [{ number: 2 }] }, when: { precision: "day", date: "2026-10-17" } });
    if (!built.ok) throw new Error(built.errors.join(", "));
    saveArchiveEntry(db, built.request, TZ);
    expect(getArchiveEntry(db, AGAIN).work).toEqual(linkedWork());
    expect(getLibrary(db).works).toHaveLength(1);
    expect(getLibrary(db).works[0]?.key).toBe(KEY);
    expect(getArchiveEntry(db, ENTRY).consumed).toEqual(request().consumed);
  });

  test("Log again chooses the newest stored metadata revision, not the latest consumption date", async () => {
    saveArchiveEntry(db, { ...request(), when: { precision: "year", date: "2025" } }, TZ);
    const newest = { ...linkedWork(), description: "Newest synthetic metadata revision" };
    saveArchiveEntry(db, { ...request(newest), entry_id: AGAIN, when: { precision: "year", date: "2020" } }, TZ);
    routeFetch();
    expect((await loadArchiveContext({ workKey: KEY })).work).toEqual(newest);
  });

  test("manual edits and logging again remain manual; unrelated manual replacements are not linked", async () => {
    saveArchiveEntry(db, request(manualWork()), TZ, { nowIso: NOW });
    routeFetch();
    const context = await loadArchiveContext({ entryId: ENTRY });
    expect(context.editingEntry?.work).toEqual(manualWork());
    const result = saveArchiveEntry(db, { ...context.editingEntry, consumed: { seasons: [{ number: 2 }] } }, TZ);
    expect(result.kept_link).toBeUndefined();
    const key = getLibrary(db).works[0]!.key;
    expect((await loadArchiveContext({ workKey: key })).work?.provider).toBe("manual");
    saveArchiveEntry(db, request(), TZ);
    saveArchiveEntry(db, request({ ...manualWork(), title: "Another Synthetic Show" }), TZ);
    expect(getArchiveEntry(db, ENTRY).work.provider).toBe("manual");
  });

  test("film Log again preserves runtime, cover and identity without clearing existing annotations", async () => {
    const film: WorkDetails = { ...linkedWork(), provider: "cinemeta", provider_id: "tt9900151", category: "film", seasons: [], runtime_minutes: 87, cover_url: "/api/meta-cover/cinemeta/tt9900151" };
    saveArchiveEntry(db, { ...request(film), consumed: { times: 2 } }, TZ, { nowIso: NOW });
    routeFetch();
    const context = await loadArchiveContext({ workKey: "film:imdb:tt9900151" });
    expect(context.work).toEqual(film);
    const built = buildArchiveRequest({ entry_id: AGAIN, work: context.work!, consumed: { times: 1 }, when: { precision: "unknown" } });
    if (!built.ok) throw new Error(built.errors.join(", "));
    saveArchiveEntry(db, built.request, TZ);
    expect(getArchiveEntry(db, AGAIN).work).toEqual(film);
    expect(getArchiveEntry(db, AGAIN).rating).toBe(8.5);
    expect(getArchiveEntry(db, AGAIN).note).toBe("Synthetic note");
    expect(getLibrary(db).works).toHaveLength(1);
    expect(getLibrary(db).works[0]?.total_minutes).toBe(261);
  });

  test("a newer incomplete film cache cannot replace the stored Log again snapshot", async () => {
    const film: WorkDetails = { ...linkedWork(), provider: "cinemeta", provider_id: "tt9900151", category: "film", seasons: [], runtime_minutes: 87 };
    saveArchiveEntry(db, { ...request(film), consumed: { times: 2 } }, TZ);
    writeWorkCache(config, film.provider, film.provider_id, { ...film, cover_url: null, runtime_minutes: null, external_ids: {} }, null, Date.now());
    routeFetch();
    expect((await loadArchiveContext({ workKey: "film:imdb:tt9900151" })).work).toEqual(film);
  });

  test("quick edits preserve metadata; explicit unlink persists across partial edits and blocks refresh relinking", async () => {
    saveArchiveEntry(db, request(), TZ, { nowIso: NOW });
    const edited = await editLibraryWork(db, KEY, { title: "Renamed Synthetic Show", status: "dropped", rating: 7.2, note: "New synthetic note" });
    expect(edited.work_snapshot).toEqual(linkedWork());
    expect(edited.cover_url).toBe(linkedWork().cover_url);
    expect(edited.key).toBe(KEY);
    const unlinked = await editLibraryWork(db, KEY, { meta: null });
    expect(unlinked.cover_url).toBeNull();
    expect(unlinked.work_snapshot?.provider).toBe("manual");
    expect(unlinked.key).toBe(KEY);
    await editLibraryWork(db, KEY, { status: "planned" });
    expect(getWorkOverrides(db).get(KEY)?.meta_unlinked).toBe(true);
    expect(getLibraryWorkDetail(db, KEY)?.cover_url).toBeNull();
    const refreshed = await refreshLibraryWorkMetadata(db, KEY, { config, fetch: noNetwork });
    expect(refreshed.changed).toBe(false);
    expect(getArchiveEntry(db, ENTRY).work).toEqual(linkedWork());
  });

  test("Undo of an explicit unlink restores the stored provider rather than issuing another unlink", async () => {
    saveArchiveEntry(db, request(), TZ, { nowIso: NOW });
    routeFetch();
    const result = await performWorkEdit(KEY, { meta: null });
    expect(getLibraryWorkDetail(db, KEY)?.cover_url).toBeNull();
    await result.undo();
    expect(getWorkOverrides(db).get(KEY)?.meta).toEqual({ provider: "tvmaze", provider_id: "990151" });
    expect(getLibraryWorkDetail(db, KEY)?.cover_url).toBe(linkedWork().cover_url);
    expect(getLibraryWorkDetail(db, KEY)?.work_snapshot).toEqual(linkedWork());
    expect(getArchiveEntry(db, ENTRY).work).toEqual(linkedWork());
  });

  test("offline relink reuses a stored override snapshot even when it differs from the archive", async () => {
    saveArchiveEntry(db, request(), TZ);
    const replacement: WorkDetails = { ...linkedWork(), provider_id: "990199", cover_url: "/api/meta-cover/tvmaze/990199" };
    writeWorkCache(config, replacement.provider, replacement.provider_id, replacement, null, Date.now());
    await editLibraryWork(db, KEY, { meta: { provider: replacement.provider, provider_id: replacement.provider_id } }, { config });
    await editLibraryWork(db, KEY, { meta: null });
    const restored = await editLibraryWork(db, KEY, { meta: { provider: replacement.provider, provider_id: replacement.provider_id } });
    expect(restored.work_snapshot).toEqual(replacement);
    expect(restored.cover_url).toBe(replacement.cover_url);
    expect(restored.key).toBe(KEY);
  });

  test("an unavailable metadata baseline cannot fabricate an unlink during Undo", async () => {
    const calls: WorkEdit[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return new Response("Unavailable", { status: 503 });
      calls.push(JSON.parse(String(init.body)) as WorkEdit);
      return json({});
    }) as typeof fetch;
    const result = await performWorkEdit("series:imdb:tt9900199", { meta: { provider: "tvmaze", provider_id: "990199" } });
    await result.undo();
    expect(calls).toEqual([{ meta: { provider: "tvmaze", provider_id: "990199" } }, {}]);
  });

  test("refresh retains known cover/IDs/missing seasons and never changes user consumption", async () => {
    const original = request();
    original.consumed = { seasons: [{ number: 1 }, { number: 2 }, { number: 3 }] };
    original.status = "finished";
    saveArchiveEntry(db, original, TZ, { nowIso: NOW });
    const fetchMock = (async (input: unknown, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = String(input);
      if (url.endsWith("/shows/990151")) return json({ id: 990151, name: "Provider Renamed Synthetic Show", runtime: 42 });
      if (url.endsWith("/seasons")) return json([{ id: 1, number: 1, episodeOrder: 9 }, { id: 4, number: 4, episodeOrder: 2 }]);
      if (url.endsWith("/episodes")) return json([]);
      throw new Error("Unexpected external request");
    }) as typeof fetch;
    await refreshLibraryWorkMetadata(db, KEY, { config, fetch: fetchMock });
    const entry = getArchiveEntry(db, ENTRY);
    expect(entry.consumed).toEqual(original.consumed);
    expect(entry.when).toEqual(original.when);
    expect(entry.work.provider).toBe("tvmaze");
    if (entry.work.provider === "manual") throw new Error("Lost metadata link");
    expect(entry.work.cover_url).toBe(linkedWork().cover_url);
    expect(entry.work.external_ids).toEqual(linkedWork().external_ids);
    expect(entry.work.title).toBe(linkedWork().title);
    expect(entry.work.seasons.map((s) => s.number)).toEqual([1, 2, 3, 4]);
    expect(entry.work.seasons[1]).toEqual(linkedWork().seasons[1]);
    expect(getLibrary(db).works[0]?.key).toBe(KEY);
    const repeat = await refreshLibraryWorkMetadata(db, KEY, { config, fetch: fetchMock });
    expect(repeat.changed).toBe(false);
  });

  test("Achriom offline re-import uses stored seasons, preserves link, and dry-run agrees with repeat save", async () => {
    const row = { title: linkedWork().title, tmdb_id: "990153", watch_status: "completed", user_rating: "4.5", user_notes: "Synthetic imported note" };
    const entryId = achriomRowEntryId("shows.csv", row);
    saveArchiveEntry(db, { ...request(), entry_id: entryId, status: "finished", consumed: { seasons: linkedWork().seasons.map((s) => ({ number: s.number })) } }, TZ, { nowIso: NOW });
    const headers = ACHRIOM_CSV_HEADERS["shows.csv"];
    const input = `${headers.join(",")}\n${headers.map((name) => escapeCsvField(row[name as keyof typeof row] ?? "")).join(",")}\n`;
    const opts = { db, config, input, filename: "shows.csv", fetch: noNetwork };
    const first = await importAchriom(opts);
    expect(first.updated).toBe(1);
    expect(first.total_minutes).toBe(927);
    expect(getArchiveEntry(db, entryId).work).toEqual(linkedWork());
    expect(getArchiveEntry(db, entryId).rating).toBe(9);
    const preview = await importAchriom({ ...opts, dryRun: true });
    const repeat = await importAchriom(opts);
    expect(preview.unchanged).toBe(1);
    expect(repeat.unchanged).toBe(1);
    expect(preview.total_minutes).toBe(repeat.total_minutes);
    expect(getLibrary(db).works[0]?.key).toBe(KEY);
  });

  test("full entry endpoint rejects invalid/missing/deleted entries; no fabricated fallback on load errors", async () => {
    routeFetch();
    await expect(loadArchiveContext({ entryId: "not-a-uuid" })).rejects.toThrow();
    await expect(loadArchiveContext({ entryId: ENTRY })).rejects.toThrow();
    saveArchiveEntry(db, request(), TZ);
    deleteArchiveEntry(db, ENTRY);
    await expect(loadArchiveContext({ entryId: ENTRY })).rejects.toThrow();
    await expect(loadArchiveContext({ workKey: KEY })).rejects.toThrow();
  });

  test("an absent library snapshot opens lookup rather than guessed manual metadata", async () => {
    globalThis.fetch = (async () => json({ title: "Synthetic Unsnapshotted Show", category: "series" } satisfies Partial<LibraryWorkDetail>)) as unknown as typeof fetch;
    const loaded = await loadArchiveContext({ workKey: "series:synthetic" });
    expect(loaded.work).toBeNull();
    expect(loaded.query).toBe("Synthetic Unsnapshotted Show");
  });

  test("annotation clears, exact time override and omitted status survive form re-save", () => {
    const built = buildArchiveRequest({ ...request(), status: undefined, rating: null, note: "", consumed: { seasons: [{ number: 1 }], minutes_override: 127 } });
    if (!built.ok) throw new Error(built.errors.join(", "));
    expect(built.request.rating).toBeNull();
    expect(built.request.note).toBeNull();
    expect(built.request.status).toBeUndefined();
    expect(built.request.consumed.minutes_override).toBe(127);
    expect(built.request.work).toEqual(linkedWork());
  });

  test("untouched imported consumption and dates round-trip even for a dropped zero-progress entry", () => {
    const previous: ArchiveRequest = { ...request(), status: "dropped", consumed: { seasons: [{ number: 1, episodes: 0 }], progress: 0, minutes_override: 0 } };
    const built = buildArchiveRequest({ ...previous, previous, rating: 9 });
    if (!built.ok) throw new Error(built.errors.join(", "));
    expect(built.request.consumed).toEqual(previous.consumed);
    expect(built.request.when).toEqual(previous.when);
    expect(built.request.status).toBe("dropped");
    expect(built.request.work).toEqual(linkedWork());
  });

  test("changing watched seasons preserves untouched progress, exact override, and explicit episode counts", () => {
    const previous = { ...request(), consumed: { seasons: [{ number: 1, episodes: 9 }], progress: 0.123456, minutes_override: 127.5 } };
    const consumed = { ...previous.consumed, seasons: [...previous.consumed.seasons, { number: 2, episodes: 3 }] };
    const built = buildArchiveRequest({ ...previous, previous, consumed });
    if (!built.ok) throw new Error(built.errors.join(", "));
    expect(built.request.consumed).toEqual(consumed);
  });

  test("changing only time preserves dropped zero episodes and imported film/book consumption", () => {
    const film: WorkDetails = { ...linkedWork(), category: "film", seasons: [], runtime_minutes: 87 };
    const book: WorkDetails = { ...linkedWork(), category: "book", seasons: [], pages: 333 };
    for (const previous of [
      { ...request(), status: "dropped" as const, consumed: { seasons: [{ number: 1, episodes: 0 }], progress: 0 } },
      { ...request(film), consumed: { times: 2, progress: 0.123456 } },
      { ...request(book), consumed: { progress: 0.123456, times: 2 } },
    ]) {
      const consumed = { ...previous.consumed, minutes_override: 120 };
      const built = buildArchiveRequest({ ...previous, previous, consumed });
      if (!built.ok) throw new Error(built.errors.join(", "));
      expect(built.request.consumed).toEqual(consumed);
      saveArchiveEntry(db, built.request, TZ);
      expect(getArchiveEntry(db, ENTRY).consumed).toEqual(consumed);
    }
  });
});
