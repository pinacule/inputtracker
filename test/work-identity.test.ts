import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import type { ArchiveRequest, WorkDetails } from "../src/core/contract.ts";
import { migrations, openDb, migrate } from "../src/core/db.ts";
import { insertEvents } from "../src/core/events.ts";
import { aliasWorkKey, getWorkKeyAliases, resolveWorkKey, resolveWorkKeyIn } from "../src/core/work-identity.ts";
import { exportJson } from "../src/io/export-json.ts";
import { importNative } from "../src/io/import-native.ts";
import { getAnnotation, getWorkAnnotation, saveAnnotation } from "../src/server/annotations.ts";
import { saveArchiveEntry } from "../src/server/archive.ts";
import { createApp } from "../src/server/app.ts";
import { editLibraryWork, getHiddenLibraryWorks, getLibrary, getLibraryWorkDetail, refreshLibraryWorkMetadata } from "../src/server/library.ts";
import { getWorkOverrides, parseWorkEdit, saveWorkOverride } from "../src/server/overrides.ts";

const ENTRY = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-20T12:00:00.000Z";
const TZ = "Europe/Bratislava";
function manual(title = "Synthetic Alpha"): ArchiveRequest {
  return { entry_id: ENTRY, work: { provider: "manual", category: "series", title, year: 2020,
    creators: [], seasons: [{ number: 1, title: null, year: 2020, episodes: 2,
      episode_minutes: 24, total_minutes: 48, provider_id: null }], runtime_minutes: null, pages: null },
    consumed: { seasons: [{ number: 1 }] }, when: { precision: "day", date: "2026-10-19" } };
}
function linked(title: string, id = "901", imdb = "tt0000901"): WorkDetails {
  return { ...manual(title).work, provider: "tvmaze", provider_id: id,
    external_ids: { tvmaze: id, imdb }, original_title: null, cover_url: null, genres: [], description: null } as WorkDetails;
}
function json(body: unknown): Response { return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }); }

describe("persistent work identity", () => {
  let db: Database;
  let dir: string;
  let config: Config;
  beforeEach(() => {
    dir = mkdtempSync(join(import.meta.dir, ".w14-identity-"));
    db = openDb(":memory:");
    const base = loadConfig({ env: {}, path: join(dir, "missing.toml") });
    config = { ...base, storage: { ...base.storage, db_path: join(dir, "synthetic.db") } };
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  test("link + refresh preserves category/rating/note/hidden/topic and old-key edits", async () => {
    saveArchiveEntry(db, { ...manual(), rating: 9, note: "Synthetic original note" }, TZ, { nowIso: NOW });
    const oldKey = getLibrary(db).works[0]!.key;
    const fetchMock = (async (input: unknown, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = String(input);
      if (url.endsWith("/shows/901")) return json({ id: 901, name: "Synthetic Expanded Alpha", premiered: "2020-01-01", runtime: 24, externals: { imdb: "tt0000901" } });
      if (url.endsWith("/shows/901/seasons")) return json([{ id: 1, number: 1, episodeOrder: 2 }]);
      if (url.endsWith("/shows/901/episodes")) return json([1, 2].map((n) => ({ id: n, season: 1, number: n, runtime: 24, type: "regular" })));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    await editLibraryWork(db, oldKey, { category: "anime", hidden: true, topic: "Synthetic topic", meta: { provider: "tvmaze", provider_id: "901" } }, { config, fetch: fetchMock, nowIso: NOW });
    const refreshed = await refreshLibraryWorkMetadata(db, oldKey, { config, fetch: fetchMock, nowIso: NOW });
    expect(refreshed.key).toBe("series:imdb:tt0000901");
    expect(refreshed.title).toBe("Synthetic Expanded Alpha");
    expect(refreshed.category).toBe("anime"); expect(refreshed.rating).toBe(9);
    expect(refreshed.note).toBe("Synthetic original note"); expect(refreshed.topic).toBe("Synthetic topic");
    expect(refreshed.total_minutes).toBe(48);
    expect(getLibrary(db).works).toHaveLength(0);
    expect(getHiddenLibraryWorks(db).works[0]?.key).toBe(refreshed.key);
    expect(getWorkOverrides(db).get(oldKey)?.hidden).toBe(true);
    expect(resolveWorkKey(db, oldKey)).toBe(refreshed.key);
    const edited = await editLibraryWork(db, oldKey, { hidden: false, rating: 8.5, note: "Synthetic new note" }, { nowIso: NOW });
    expect(edited.key).toBe(refreshed.key); expect(edited.category).toBe("anime");
    expect(getLibraryWorkDetail(db, oldKey)?.note).toBe("Synthetic new note");
    expect(getAnnotation(db, "manual", "Synthetic Alpha").rating).toBe(8.5);
    saveAnnotation(db, { source: "manual", title: "Synthetic Alpha", rating: 7, note: "Synthetic legacy API edit" }, NOW);
    expect(getLibraryWorkDetail(db, refreshed.key)?.rating).toBe(7);
    const app = createApp({ db, config, fetchImage: fetchMock });
    const res = await app.request(`/api/library/work?key=${encodeURIComponent(oldKey)}`);
    expect(res.status).toBe(200); expect((await res.json() as { key: string }).key).toBe(refreshed.key);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events;").get()!.n).toBeGreaterThan(1);
  });

  test("two renames produce a chain, reverse rename cannot create a cycle; latest clears stay cleared", async () => {
    saveArchiveEntry(db, { ...manual(), rating: 9, note: "Synthetic note" }, TZ, { nowIso: NOW });
    const a = getLibrary(db).works[0]!.key;
    await editLibraryWork(db, a, { category: "anime", topic: "Synthetic topic" }, { nowIso: NOW });
    saveArchiveEntry(db, manual("Synthetic Beta"), TZ, { nowIso: NOW });
    const b = getLibrary(db).works[0]!.key;
    saveArchiveEntry(db, manual("Synthetic Gamma"), TZ, { nowIso: NOW });
    const c = getLibrary(db).works[0]!.key;
    expect(a).not.toBe(b); expect(b).not.toBe(c);
    expect(getWorkKeyAliases(db)).toEqual(new Map([[a, b], [b, c]]));
    expect(getLibraryWorkDetail(db, a)?.rating).toBe(9);
    expect(getLibraryWorkDetail(db, b)?.note).toBe("Synthetic note");
    expect(getLibraryWorkDetail(db, c)?.category).toBe("anime");
    saveAnnotation(db, { source: "manual", title: "Synthetic Gamma", work_key: c, rating: null, note: null }, NOW);
    expect(getAnnotation(db, "manual", "Synthetic Alpha")).toMatchObject({ rating: null, note: null });
    expect(getLibraryWorkDetail(db, a)?.rating).toBeNull();
    saveArchiveEntry(db, manual(), TZ, { nowIso: NOW });
    expect(resolveWorkKey(db, a)).toBe(c); expect(getWorkKeyAliases(db).size).toBe(2);
    expect(getLibraryWorkDetail(db, a)?.note).toBeNull();
    expect(() => db.run("INSERT INTO work_key_aliases(old_key, new_key, created_at) VALUES (?, ?, ?);", [c, a, NOW])).toThrow("cycle");
    expect(() => aliasWorkKey(db, c, a, NOW)).not.toThrow();
    expect(() => resolveWorkKeyIn(new Map([["a", "b"], ["b", "a"]]), "a")).toThrow("cycle");
    const same = saveArchiveEntry(db, manual(), TZ, { nowIso: NOW });
    expect(same.inserted).toBe(0);
    await editLibraryWork(db, a, { category: null, topic: null }, { nowIso: NOW });
    expect(getLibraryWorkDetail(db, b)).toMatchObject({ category: "series", topic: null, rating: null, note: null });
    for (const key of [a, b, c]) {
      expect(getWorkOverrides(db).get(key)).toMatchObject({ category: null, topic: null });
    }
  });

  for (const provider of ["tmdb", "anilist"] as const) {
    test(`${provider} link + refresh preserves edits when a title-based series acquires external IDs`, async () => {
      saveArchiveEntry(db, { ...manual(), rating: 9, note: "Synthetic original note" }, TZ, { nowIso: NOW });
      const oldKey = getLibrary(db).works[0]!.key;
      if (provider === "tmdb") {
        config = { ...config, metadata: { ...config.metadata!, tmdb_api_key: "synthetic-metadata-key" } };
      }
      const title = "Synthetic Expanded Alpha";
      const fetchMock = (async (input: unknown, init?: RequestInit) => {
        if (provider === "tmdb") {
          expect(init?.method ?? "GET").toBe("GET");
          if (String(input).includes("/movie/901")) return new Response("Synthetic not found", { status: 404 });
          expect(String(input)).toContain("/tv/901");
          return json({ id: 901, name: title, first_air_date: "2020-01-01", episode_run_time: [24],
            external_ids: { imdb_id: "tt0000901" },
            seasons: [{ season_number: 1, name: "Synthetic Season", episode_count: 2, air_date: "2020-01-01" }] });
        }
        // AniList's only POST is its read-only GraphQL metadata query, never ABS.
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body)).variables.id).toBe(901);
        return json({ data: { Media: { id: 901, idMal: 902, type: "ANIME", format: "TV", status: "FINISHED",
          title: { english: title, romaji: title }, episodes: 2, duration: 24, seasonYear: 2020,
          studios: { nodes: [] }, relations: { edges: [] } } } });
      }) as typeof fetch;
      await editLibraryWork(db, oldKey, { category: "anime", hidden: true, topic: "Synthetic topic",
        meta: { provider, provider_id: "901" } }, { config, fetch: fetchMock, nowIso: NOW });
      const refreshed = await refreshLibraryWorkMetadata(db, oldKey, { config, fetch: fetchMock, nowIso: NOW });
      expect(refreshed.key).toBe(provider === "tmdb" ? "series:imdb:tt0000901" : "series:mal:902");
      expect(refreshed).toMatchObject({ title, category: "anime", rating: 9,
        note: "Synthetic original note", topic: "Synthetic topic" });
      expect(getWorkOverrides(db).get(oldKey)?.hidden).toBe(true);
      expect(getHiddenLibraryWorks(db).works[0]?.key).toBe(refreshed.key);
      expect(resolveWorkKey(db, oldKey)).toBe(refreshed.key);
      const unhidden = await editLibraryWork(db, oldKey, { hidden: false }, { nowIso: NOW });
      expect(unhidden.key).toBe(refreshed.key);
      expect(getAnnotation(db, "manual", "Synthetic Alpha").rating).toBe(9);
      expect((await refreshLibraryWorkMetadata(db, oldKey, { config, fetch: fetchMock, nowIso: NOW })).key).toBe(refreshed.key);
    });
  }

  test("all history tables enforce append-only and a failed annotation rolls back work edits", async () => {
    saveArchiveEntry(db, { ...manual(), rating: 6 }, TZ, { nowIso: NOW });
    const key = getLibrary(db).works[0]!.key;
    await editLibraryWork(db, key, { topic: "Synthetic topic" });
    saveArchiveEntry(db, manual("Synthetic Beta"), TZ, { nowIso: NOW });
    for (const table of ["events", "annotations", "work_overrides", "work_key_aliases"]) {
      expect(() => db.run(`UPDATE ${table} SET id = id;`)).toThrow("append-only");
      expect(() => db.run(`DELETE FROM ${table};`)).toThrow("append-only");
    }
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_overrides;").get()!.n;
    db.run("CREATE TRIGGER synthetic_annotation_failure BEFORE INSERT ON annotations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    await expect(editLibraryWork(db, key, { rating: 8 })).rejects.toThrow("synthetic failure");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_overrides;").get()!.n).toBe(before);
    expect(getLibraryWorkDetail(db, key)?.rating).toBe(6);
    expect(() => saveArchiveEntry(db, { ...manual("Synthetic Gamma"), rating: 8 }, TZ, { nowIso: NOW })).toThrow("synthetic failure");
    expect(getWorkKeyAliases(db).size).toBe(1);
    expect(getLibraryWorkDetail(db, key)?.title).toBe("Synthetic Beta");
  });

  test("multiple archive entries and another source follow one renamed identity", async () => {
    saveArchiveEntry(db, { ...manual(), rating: 9, note: "Synthetic shared note" }, TZ, { nowIso: NOW });
    const second = { ...manual(), entry_id: "22222222-2222-4222-8222-222222222222", when: { precision: "day" as const, date: "2026-10-18" } };
    saveArchiveEntry(db, second, TZ, { nowIso: NOW });
    insertEvents(db, null, [{ source: "simkl", source_kind: "watch", source_id: "synthetic-watch", media_type: "episode",
      title: "Synthetic Alpha", started_at: "2026-10-17T08:00:00.000Z", duration_seconds: 1440 }]);
    const key = getLibrary(db).works[0]!.key;
    await editLibraryWork(db, key, { category: "anime", topic: "Synthetic topic" });
    saveArchiveEntry(db, { ...manual(), work: linked("Synthetic Renamed Alpha") }, TZ, { nowIso: NOW });
    const newKey = resolveWorkKey(db, key);
    expect(getLibrary(db).works).toHaveLength(1);
    expect(getLibraryWorkDetail(db, key)?.sources).toEqual(["manual", "simkl"]);
    expect(getLibraryWorkDetail(db, key)?.rating).toBe(9);
    expect(getLibraryWorkDetail(db, key)?.topic).toBe("Synthetic topic");
    saveArchiveEntry(db, { ...second, work: linked("Synthetic Renamed Alpha") }, TZ, { nowIso: NOW });
    expect(getLibrary(db).works).toHaveLength(1); expect(resolveWorkKey(db, key)).toBe(newKey);
    expect(getAnnotation(db, "simkl", "Synthetic Alpha").rating).toBe(9);
  });

  test("legacy title-only annotations survive migration and bind before archive titles disappear", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.run("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
      for (const migration of migrations.filter((m) => m.version < 14)) {
        migration.up(legacy);
        legacy.run("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?);", [migration.version, NOW]);
      }
      legacy.run(`INSERT INTO annotations(record_hash, source, title, rev_id, rating, note, created_at)
        VALUES ('synthetic-hash', 'manual', 'Synthetic Alpha', '33333333-3333-4333-8333-333333333333', 9, 'Synthetic legacy note', ?);`, [NOW]);
      migrate(legacy);
      saveArchiveEntry(legacy, manual(), TZ, { nowIso: NOW });
      expect(getLibrary(legacy).works[0]?.rating).toBe(9);
      saveArchiveEntry(legacy, manual("Synthetic Beta"), TZ, { nowIso: NOW });
      expect(getLibrary(legacy).works[0]?.rating).toBe(9);
      expect(getLibraryWorkDetail(legacy, "series:synthetic alpha")?.note).toBe("Synthetic legacy note");
      expect(legacy.query<{ work_key: string | null }, []>("SELECT work_key FROM annotations ORDER BY id ASC;").all()[0]?.work_key).toBeNull();
      const key = getLibrary(legacy).works[0]!.key;
      saveAnnotation(legacy, { source: "manual", title: "Synthetic Beta", work_key: key, rating: null, note: null }, NOW);
      expect(getAnnotation(legacy, "manual", "Synthetic Alpha")).toMatchObject({ rating: null, note: null });
    } finally { legacy.close(); }
  });

  test("work-key binding separates same-title works in different categories", () => {
    saveArchiveEntry(db, { ...manual(), rating: 9 }, TZ, { nowIso: NOW });
    saveArchiveEntry(db, { ...manual(), entry_id: "22222222-2222-4222-8222-222222222222",
      work: { ...manual().work, category: "film", seasons: [], runtime_minutes: 90 }, consumed: { times: 1 }, rating: 3 }, TZ, { nowIso: NOW });
    const works = getLibrary(db).works;
    expect(works.find((work) => work.category === "series")?.rating).toBe(9);
    expect(works.find((work) => work.category === "film")?.rating).toBe(3);
    for (const work_key of ["", " ", "bad\nkey", "x".repeat(501)]) {
      expect(() => saveAnnotation(db, { source: "manual", title: "Synthetic Alpha", work_key, rating: 5 }, NOW))
        .toThrow("Invalid work_key");
    }
  });
  test("legacy explicit clears do not resurrect older override ratings or notes after a rename", () => {
    saveArchiveEntry(db, manual(), TZ, { nowIso: NOW });
    const key = getLibrary(db).works[0]!.key;
    saveWorkOverride(db, key, parseWorkEdit({ rating: 9, note: "Synthetic older override" }), null, null, NOW);
    db.run(`INSERT INTO annotations(record_hash, source, title, rev_id, rating, note, created_at)
      VALUES ('synthetic-cleared', 'manual', 'Synthetic Alpha', '33333333-3333-4333-8333-333333333333', NULL, NULL, ?);`, [NOW]);
    expect(getLibraryWorkDetail(db, key)).toMatchObject({ rating: null, note: null });
    saveArchiveEntry(db, manual("Synthetic Beta"), TZ, { nowIso: NOW });
    expect(getLibraryWorkDetail(db, key)).toMatchObject({ title: "Synthetic Beta", rating: null, note: null });
    expect(getAnnotation(db, "manual", "Synthetic Alpha")).toMatchObject({ rating: null, note: null });
    expect(getWorkAnnotation(db, key)).toMatchObject({ rating: null, note: null });
  });

  test("native export/import preserves aliases, override/annotation history and idempotency; cycles roll back", async () => {
    saveArchiveEntry(db, { ...manual(), rating: 9, note: "Synthetic note" }, TZ, { nowIso: NOW });
    const key = getLibrary(db).works[0]!.key;
    await editLibraryWork(db, key, { category: "anime", topic: "Synthetic topic" });
    saveArchiveEntry(db, { ...manual(), work: linked("Synthetic New Alpha") }, TZ, { nowIso: NOW });
    await editLibraryWork(db, key, { rating: 8, note: "Synthetic new note" });
    const exported = exportJson(db);
    const target = openDb(":memory:");
    try {
      const result = importNative(target, exported, "json");
      expect(result.work_key_aliases.inserted).toBe(1);
      expect(result.work_overrides.inserted).toBe(2);
      expect(getLibraryWorkDetail(target, key)).toEqual(getLibraryWorkDetail(db, key));
      const again = importNative(target, exported, "json");
      expect(again.work_key_aliases.inserted).toBe(0); expect(again.work_overrides.inserted).toBe(0);
      expect(again.annotations.inserted).toBe(0); expect(again.events.inserted).toBe(0);
      const bad = JSON.parse(exported);
      bad.work_key_aliases.push({ old_key: resolveWorkKey(db, key), new_key: key, created_at: NOW });
      expect(() => importNative(target, JSON.stringify(bad), "json")).toThrow("cycle");
      expect(getWorkKeyAliases(target).size).toBe(1);
      bad.work_key_aliases = [{ old_key: key, new_key: "series:conflict", created_at: NOW }];
      expect(() => importNative(target, JSON.stringify(bad), "json")).toThrow("Conflicting imported work alias");
      expect(getWorkAnnotation(target, key)?.rating).toBe(8);
    } finally { target.close(); }
  });
});
