# Metadata Accuracy & Library Progress (v2.2)

This document records the root-cause investigation into inaccurate series runtimes, incomplete anime season chains, and ambiguous library unit counts discovered after importing a real Achriom library, along with the fixes and invariants the codebase now enforces.

---

## 1. Root Causes Found

### 1.1 TVmaze broadcast slot runtimes (`Vikings`: 89 h instead of ~65–66 h)
- **What happened:** *Vikings* (TVmaze ID `29`, IMDb `tt2306299`, 6 seasons, 89 regular episodes) was imported with a total duration of `5340 min` (`89 h`). Real episodes are ~44–46 minutes without commercials (`~65–68 h`).
- **Why `src/server/metadata/tvmaze.ts` got it wrong:**
  - `tvmaze.ts` preferred per-episode `ep.runtime` from `/shows/:id/episodes` over `show.averageRuntime ?? show.runtime`.
  - However, for shows that aired on commercial linear television networks (History, AMC, NBC, CBS, ABC, Fox, FX, etc.), **TVmaze populates `ep.runtime` on every episode with the commercial broadcast slot** (`30`, `60`, or `90` minutes — e.g. `60` on all 89 episodes of *Vikings* and all 62 episodes of *Breaking Bad*, `30` on all 236 episodes of *Friends*, and `30`/`45`/`60` slot multiples on *The Office*), not the actual cut runtime.
  - Because `ep.runtime` was a positive integer (`60`), `buildSeasons` treated it as a measured per-episode runtime and never cross-checked Cinemeta/IMDb (`tt2306299`), even though `show.externals.imdb` was present on the TVmaze show response.
- **Same risk on TMDB (`src/server/metadata/tmdb.ts`):**
  - On TMDB `/tv/:id`, `episode_run_time` is frequently either an empty array `[]` (producing `episode_minutes: null, total_minutes: null`) or a single broadcast slot (`[60]` or `[30]`), while `external_ids.imdb_id` is available.

### 1.2 Ambiguous `LibraryWork.units` vs. seasons and episodes (`Vikings` showing "6 episodes", `One-Punch Man` showing "1")
- **What happened:**
  - *Vikings* (6 watched seasons in the archive) displayed `"6 episodes"` on its library card.
  - *One-Punch Man* (AniList `21087`, 3 released TV seasons totalling 36 episodes, imported with `watch_status = plan_to_watch`) displayed `"1"` on its library card.
- **Why `src/server/archive.ts` and `src/server/library.ts` caused this:**
  - `saveArchiveEntry` in `src/server/archive.ts` writes one `events` row per watched season (`archive:<entry_id>:s1` … `s6`) for watched series/anime, and a single placeholder row (`archive:<entry_id>:b`, `duration_seconds = 0`, `raw.status = "planned"`) for planned entries.
  - `buildAllLibraryWorks` in `src/server/library.ts` set `LibraryWork.units = workEvents.length` and did not expose season or episode progress on `LibraryWork` (`seasons` only existed on `LibraryWorkDetail`).
  - Because `units` mixed synced episodes (Simkl), listening sessions (Audiobookshelf), video plays (YouTube),watched season units (`s1..sN`), and single planned placeholder units (`b`), any UI card that labelled `units` for series/anime inevitably mislabelled 6 archive season units as `"6 episodes"` and 1 planned placeholder unit as `"1"`.

### 1.3 AniList franchise chains (`src/server/metadata/anilist.ts`)
- **Prequel OVAs hijacking franchise roots in search (`One-Punch Man`, `Attack on Titan`):**
  - On AniList, *One-Punch Man* Season 1 (`21087`, `format: "TV"`) has a `PREQUEL` relation to *One-Punch Man: Road to Hero* (`21386`, `format: "OVA"`, 1 episode), and *Attack on Titan* Season 1 (`16498`, `format: "TV"`) has a `PREQUEL` relation to *Attack on Titan: No Regrets* (`20811`, `format: "OVA"`, 2 episodes).
  - In `searchAnilist`, `parentsOf` added parent links across all `PREQUEL` and `SEQUEL` edges regardless of media format (`addParentLink(node.id, target.id)`). When both the TV series (`21087`) and the prequel OVA (`21386`) appeared in the search page, `findRootHitAncestor(21087)` found the OVA (`21386`) as its parent ancestor and **dropped the main TV series hit**, leaving the 1-episode OVA as the search result!
  - Furthermore, if `getAnilistWork` was called with an OVA/Special ID (`21386`), it did not step onto the parent TV series before walking `PREQUEL`/`SEQUEL` over `TV`/`TV_SHORT`/`ONA`, so the resulting work had only 1 season of 1 episode.
- **Sequel films/OVAs bridging TV seasons (`Made in Abyss`):**
  - Some anime franchises connect TV Season 1 to a canon sequel film (`MOVIE` or `OVA`/`SPECIAL`), which in turn has `SEQUEL` → TV Season 2 (for example, *Made in Abyss* `97986` (`TV`) → *Dawn of the Deep Soul* `100643` (`MOVIE`) → *The Golden City of the Scorching Sun* `114745` (`TV`)).
  - `findRelationTarget` only inspected direct 1-hop `TV`/`TV_SHORT`/`ONA` edges, stopping at Season 1 when looking up `97986` and failing to reach Season 1 when looking up `114745`.
- **Missing `duration` on newer seasons in a chain:**
  - When a newly finished or releasing season in an AniList chain (or a season in TVmaze/Cinemeta) had `duration: null` or `0` while earlier seasons had `duration: 24`, `toSeasonInfo` set `episode_minutes: null, total_minutes: null`.
  - In `src/server/archive.ts` (`computeSeasonNaturalMinutes`) and `src/io/import-achriom.ts` (`computeSeasonMinutes`), a watched season with `total_minutes: null` and `episode_minutes: null` only checked `work.runtime_minutes` (which is `null` for series/anime) and never fell back to sibling seasons' `episode_minutes`, resulting in `0` minutes for that season.

### 1.4 Unreleased 0-episode seasons and special episodes (`src/server/metadata/tvmaze.ts`, `src/server/metadata/tmdb.ts`)
- **Empty future seasons:**
  - TVmaze `/shows/:id/seasons` and TMDB `/tv/:id` include announced future seasons with `episodeOrder: null` / `episode_count: 0` and 0 aired episodes (e.g. *Severance* Season 3, *House of the Dragon* Season 4).
  - Including 0-episode seasons in `WorkDetails.seasons` inflated `seasons_total` and caused Achriom `completed` show imports (`work.seasons.map(s => ({ number: s.number }))`) to mark unreleased future seasons as watched.
- **Specials inside regular seasons:**
  - TVmaze episodes with `type !== "regular"` (e.g. `"significant_special"`, `"insignificant_special"`) or `number: null` (recaps, behind-the-scenes specials) could be counted as regular season episodes if present in the episode list.

---

## 2. Fixes and Rules Now Enforced

1. **Series runtime selection and broadcast slot cross-check (`tvmaze.ts`, `tmdb.ts`, `cinemeta.ts`):**
   - Prefer real per-episode runtimes when a provider supplies non-slot per-episode runtimes (e.g. streaming shows or varied episode lengths like `58, 48, 47`).
   - Detect broadcast slots (`30`, `60`, `90` minutes, or slot multiples `30, 45, 60, 90, 120` where the show or modal episode runtime is `30`, `60`, or `90`).
   - Whenever a TVmaze or TMDB series only has a broadcast slot runtime (or `null` runtime) and an IMDb ID (`tt\d+`) is known, cross-check Cinemeta (`GET /meta/series/<imdb>.json`).
   - Use Cinemeta's runtime when it is **clearly lower** than the broadcast slot (`realMinutes <= Math.round(slotMinutes * 0.9)` and `slotMinutes - realMinutes >= 4`, e.g. `44 min` vs `60 min` on *Vikings*, or `22 min` vs `30 min` on *Friends* / *The Office*), while preserving ~57–59 min runtimes on ad-free broadcasters (HBO, BBC). Double-length slot episodes (e.g. `60` min in a `30` min sitcom) scale proportionally.
   - If Cinemeta is unreachable or returns 404/5xx, fall back gracefully to the primary provider's runtime without failing the lookup.

2. **Sibling-season runtime fallback (`anilist.ts`, `tvmaze.ts`, `cinemeta.ts`, `archive.ts`, `import-achriom.ts`):**
   - If a season has `episode_minutes: null` (missing or `0` episode runtime) and other seasons of the same work have known `episode_minutes > 0`, inherit the rounded average `episode_minutes` from the sibling seasons (and compute `total_minutes = episodes * episode_minutes`).
   - `computeSeasonNaturalMinutes` in `src/server/archive.ts` and `computeSeasonMinutes` in `src/io/import-achriom.ts` apply the same fallback across `work.seasons` when `work.runtime_minutes` is `null`.

3. **Specials and unreleased seasons (`tvmaze.ts`, `tmdb.ts`, `cinemeta.ts`, `anilist.ts`):**
   - Skip Season 0 (`season < 1`) across all providers.
   - In TVmaze, accept only regular episodes (`type` absent or `"regular"`, and `number` absent or `>= 1`).
   - Exclude seasons with `episodes <= 0` in TVmaze and TMDB so announced future seasons with no episode count never inflate `seasons_total` or get marked watched on import.

4. **AniList franchise hierarchy and bridging (`anilist.ts`):**
   - In `searchAnilist`, non-season entries (`OVA`, `SPECIAL`, `MOVIE`, `MUSIC`) never become parent ancestors of `TV`/`TV_SHORT`/`ONA` series; instead, prequel/sequel OVAs collapse under their parent TV series.
   - In `getAnilistWork`, if the requested ID is an `OVA` or `SPECIAL` linked to a parent `TV`/`TV_SHORT`/`ONA` series, step onto the TV series first.
   - When walking `PREQUEL` and `SEQUEL` in `getAnilistWork`, if a season has no direct `TV`/`TV_SHORT`/`ONA` neighbour, bridge across a single intermediate released `MOVIE`/`OVA`/`SPECIAL` sequel/prequel node when it leads to a released `TV`/`TV_SHORT`/`ONA` season (without adding the movie/OVA itself as a numbered TV season).

5. **Explicit `LibraryWork.progress` and `LibraryWork.creator` (`library.ts`, `youtube-routes.ts`, `review.ts`):**
   - Every series and seasonal anime work carries `progress: { seasons_watched, seasons_total, episodes_watched, episodes_total }`.
   - `seasons_total` and `episodes_total` come from the work's linked metadata (`baseSeasons`); when no metadata season list is linked, totals are `null`.
   - For planned works (`status === "planned"`), `seasons_watched` and `episodes_watched` are `0` while `seasons_total` and `episodes_total` reflect the full linked metadata (e.g. *One-Punch Man*: `0 of 3 seasons · 0 of 36 episodes`).
   - Standalone films, books, audiobooks, YouTube, podcasts, music, and single-entry anime films have `progress: null`.
   - `LibraryWork.creator` is populated everywhere `LibraryWork` is built (author for books/audiobooks, artist for music, channel for YouTube, studio/director/creator for anime/series/films).

6. **Append-only metadata refresh (`POST /api/library/work/refresh-metadata?key=`, CLI `archive refresh-metadata [--dry-run]`):**
   - Re-fetches linked metadata with `bypassCache: true`, updates `work_overrides` if `meta` is linked there, and re-saves any changed archive entries through `saveArchiveEntry` with the same `entry_id` (writing new append-only unit revisions in `events` and tombstoning removed units).
   - `--dry-run` performs the provider lookups and duration math without writing to the database or cover cache, printing each changed work as `<title>: <before> h → <after> h`.
