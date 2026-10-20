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
- **Narrative sequels counted as seasons of a different series (W16):**
  - The reported Naruto page showed `2 of 3 seasons · 720 of 1013 episodes`; the extra 293 episodes belonged to Boruto. AniList's `SEQUEL` describes narrative chronology, not necessarily another season of the same series.
  - The chain walker checked relation type, released status and `TV`/`TV_SHORT`/`ONA` format, but not series identity. Consequently a TV-format next-generation sequel became season 3. The backward walk could also pull that separate sequel into the older series, and search could collapse its hit into the older root.
  - Regression fixtures use invented titles/IDs and the same relation shape; no real archive or provider requests were used for this fix.

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
   - TV season neighbours must share a title root across their English, romaji or native aliases: NFKC normalization, case/punctuation folding and trailing season/part/cour/number cleanup, followed by equality or a word-boundary prefix. Check both the immediate neighbour and the original/root series in forward/backward traversal. Naruto → Naruto Shippuden shares a leading root; Boruto: Naruto Next Generations does not. Containing the older title later in a new title is insufficient.
   - Apply the identity guard to TV-to-TV search ancestry and season/episode subtitles too; `SPIN_OFF` TV hits stay separate. Preserve existing OVA/Special-to-TV collapsing and film bridges, but require the TV endpoint reached through a bridge to share the starting series root.
   - This is a conservative title heuristic, not a universal franchise ontology: unrelated titles can share a prefix, while genuinely renamed sequels may stay separate. Explicitly linking the intended series remains available; no per-title IDs are hard-coded.

5. **Explicit `LibraryWork.progress` and `LibraryWork.creator` (`library.ts`, `youtube-routes.ts`, `review.ts`):**
   - Every series and seasonal anime work carries `progress: { seasons_watched, seasons_total, episodes_watched, episodes_total }`.
   - `seasons_total` and `episodes_total` come from the work's linked metadata (`baseSeasons`); when no metadata season list is linked, totals are `null`.
   - For planned works (`status === "planned"`), `seasons_watched` and `episodes_watched` are `0` while `seasons_total` and `episodes_total` reflect the full linked metadata (e.g. *One-Punch Man*: `0 of 3 seasons · 0 of 36 episodes`).
   - Standalone films, books, audiobooks, YouTube, podcasts, music, and single-entry anime films have `progress: null`.
   - `LibraryWork.creator` is populated everywhere `LibraryWork` is built (author for books/audiobooks, artist for music, channel for YouTube, studio/director/creator for anime/series/films).

6. **Append-only metadata refresh (`POST /api/library/work/refresh-metadata?key=`, CLI `archive refresh-metadata [--dry-run]`):**
   - Re-fetches linked metadata with `bypassCache: true`, updates `work_overrides` if `meta` is linked there, and re-saves any changed archive entries through `saveArchiveEntry` with the same `entry_id` (writing new append-only unit revisions in `events` and tombstoning removed units).
   - `--dry-run` performs the provider lookups and duration math without writing to the database or cover cache, printing each changed work as `<title>: <before> h → <after> h`.
   - Refresh replaces the stale season snapshot with the corrected chain while retaining watched units that still exist. Optional community-score/banner fields survive archive validation. Compare objects structurally rather than by JSON key order so a repeated unchanged refresh reports `changed: false` and appends nothing.
   - Existing Naruto entries need an explicit `archive refresh-metadata` (or the work-page action); the W16 implementation did not run this on real data.

---

## 3. Covers by title

### 3.1 Why `covers backfill` missed 21 removed Audiobookshelf items (and reported 96 not found)

When Audiobookshelf items are removed from the ABS server, `GET /api/items/<id>/cover` returns `404` (cached as `<id>.abs404`) and `src/server/covers.ts` falls back to Open Library and iTunes Audiobook search by title and author. Investigation of the real failures found the following root causes:

1. **Unfiltered `events_latest` query in `backfillCovers`:**
   - `backfillCovers` queried `SELECT DISTINCT COALESCE(json_extract(external_ids, '$.abs_item'), source_id) FROM events_latest WHERE source = 'audiobookshelf'`.
   - That query included `source_kind = 'daily_stat'` rows (whose `source_id` is a `YYYY-MM-DD` date string matching `COVER_ID_RE`) and untitled orphaned `media_progress` rows (whose fallback `title` equals the opaque `source_id`). Every such row 404'd on ABS, had no book title, wrote `<id>.none`, and inflated `attempted` and `notFound`.
2. **Cached `.none` negative entries blocking re-runs:**
   - Earlier lookups that failed before the iTunes fallback or title/author normalisations existed wrote `<id>.none` (7-day TTL). Both `backfillCovers` and `getCoverInternal` skipped any item with an unexpired `.none` file, so re-running `covers backfill` never retried them.
3. **Subtitles, series suffixes, and multi-author queries (`Iron Prince: Warformed: Stormweaver, Book 1` | `Bryce O'Connor, Luke Chmilenko`; `Fire and Song: Warformed: Stormweaver, Book 2`; `One Tin Soldier: The Murder of Crows, Book 3` | `Chris Tullbane`):**
   - `cleanTitle` only stripped leading `Series 1: Title` prefixes where the number appeared *before* the colon, leaving `Title: Series, Book N` intact and never generating the pre-colon main title (`Iron Prince`, `Fire and Song`, `One Tin Soldier`) as a search candidate.
   - Open Library indexes these works under the short title (`Iron Prince`, `Fire and Song`) and returns `0` results when given the full subtitle/series string or a comma-separated multi-author string (`author=Bryce O'Connor, Luke Chmilenko`).
4. **Empty author early-exit (`The Talented Mr. Ripley` | no author):**
   - `resolveExternalBookOrAudiobookCover` had `if (!coversConfig.external || targetAuthor === "") return { cover: null, hadNetworkError: false }`, and `authorMatches("", ...)` returned `false`, aborting before any search whenever the stored author was empty.
5. **`"Author - Title"` stored in the title field (`Laura Hillenbrand - Unbroken` | no author):**
   - With no separate author field, the author was embedded in the title (`Laura Hillenbrand - Unbroken`), and iTunes returned the full subtitle (`Unbroken: A World War II Story of Survival, Resilience, and Redemption (Unabridged)` by `Laura Hillenbrand`). Unlike `cleanMusicTitle`, book cover lookup never split `"Author - Title"` or verified the embedded author against the result's author.
6. **Bracketed series numbers and publisher names in the author field (`The Stormlight Archive [01] The Way Of Kings ` | `GraphicAudio`):**
   - `cleanTitle` did not strip middle `[01]` series markers without a colon, and `GraphicAudio` (the audiobook production company, not `Brandon Sanderson`) was treated as a mandatory author match, causing every Open Library and iTunes result to be rejected.
7. **Leading article differences and third-party summaries (`33 Strategies of War (Unabridged)` | `Robert Greene`):**
   - Both Open Library and iTunes list the book as `The 33 Strategies of War` (with leading `The`), which failed strict normalized title equality against `33 Strategies of War`. Meanwhile, iTunes also returns `Summary of Robert Greene's The 33 Strategies of War` (`Swift Reads`, `Abbey Beathan`) and Open Library returns `Concise 33 Strategies of War`.
8. **Mojibake in stored titles (`Sh¿gun` | `James Clavell`):**
   - A corrupted macron (`ō` → `¿`) caused `normalizeTrackForMatch("Sh¿gun")` to split the word into `"sh gun"` (two tokens), which neither Open Library's `title=` search nor exact string comparison matched against `"Shōgun"` / `"Shogun"`.
9. **Translator/role suffixes and given-name spelling variants (`Siddhartha` | `Herman Hesse, Paul Ansdell - translator`):**
   - Sending `Paul Ansdell - translator` in the query string polluted store searches, and `artistMatches` required all given-name tokens (`herman` vs `Hermann`) to appear verbatim in the candidate author set.
10. **Narrators appended to the author list (`The Sword of Kaigen: A Theonite War Story` | `M. L. Wang, Andrew Tell`; `To Engineer Is Human` | `Henry Petroski, Matthew Boston`):**
    - Audiobook tags frequently list both the author and the narrator in the author field. Sending the narrator's name in Open Library's `author=` parameter returned `0` results because Open Library only records book authors, and Open Library / iTunes results with subtitles (`To Engineer Is Human : The Role of Failure in Successful Design`) failed strict full-title equality on Open Library.
11. **Folder names as authors and radio-drama/adaptation suffixes (`A Wizard of Earthsea - BBC 1996 Radio Drama J…` | `Downloads`):**
    - `Downloads` (a folder name) was treated as a required author, and the trailing `- BBC 1996 Radio Drama J…` adaptation suffix was not stripped before searching, while iTunes appends `(Earthsea Cycle)` to the collection title.
12. **Trilogy/omnibus suffixes and author initial spacing (`The Poppy War Trilogy` | `R.F. Kuang`):**
    - Open Library indexes the first book as `The Poppy War` by `R. F. Kuang` and iTunes lists `The Complete Poppy War Trilogy` and `The Poppy War`; without stripping trailing `Trilogy`/`Omnibus` or ignoring `Complete`, exact matching missed both.
13. **Light-novel shorthand (`Y2` | `Syougo Kinugasa`):**
    - `Y2` is shorthand for `Year 2` (*Classroom of the Elite: Year 2 (Light Novel) Vol. 1* by `Syougo Kinugasa & Tomoseshunsaku`), which only matches after expanding `Y2` → `Year 2` and matching the post-colon subtitle `Year 2` after stripping `(Light Novel) Vol. 1` when the author matches.
14. **Single-word generic / junk titles (`me`, `shadow`, `Communication`, `Focus`):**
    - Without a known author, searching a single generic word would match an unrelated book that happens to share that one-word title.

### 3.2 Rules now enforced in `src/server/covers.ts` and `src/cli/index.ts`

1. **Title normalisation and candidate generation (`cleanTitle`, `buildBookTitleCandidates`, `bookTitleMatches`):**
   - Strip `(Unabridged)`, `(Abridged)`, `(1 of 5)`, `[2 of 10]`, `(Part 1)`, `(Book 2)`, `(Light Novel)`, `(Booktrack Edition)`, `[Dramatized Adaptation]`, trailing `, Part One` / `Vol. 1`, and trailing adaptation dash suffixes (`- BBC 1996 Radio Drama…`, `- Booktrack Edition`).
   - Strip `[01]`-style bracketed series markers (`Series [01] Title` → `Title`).
   - Split `"Author - Title"` prefixes when the left side looks like an author name, requiring the store result's author to match that embedded author.
   - Generate fallback candidates with subtitles after `:` removed and with trailing `Trilogy` / `Omnibus` / `Box Set` / `Collection` stripped.
   - Compare titles with optional leading article (`The `, `A `, `An `) stripped on multi-word titles, and treat mojibake (`¿`, `\uFFFD`, intra-word `?`) as a 1–2 character alphanumeric wildcard while falling back to an author-scoped query when the title token is corrupted.
   - Expand `Y<n>` shorthand to `Year <n>` when a valid author is known.
2. **Author list parsing and matching (`parseBookAuthors`, `bookAuthorsMatch`):**
   - Split author lists on `,`, `&`, `;`, `/`, and ` and `.
   - Drop role segments (`- translator`, `(narrator)`, `read by …`, etc.) and known narrators from `mediaMetadata.narrators`.
   - Ignore obvious non-authors (publisher and folder names such as `GraphicAudio`, `Downloads`, `Audible Studios`, `Unknown`, etc.) instead of failing.
   - Accept an author match when **any** listed person matches **any** candidate author (surname match plus compatible first initial / 1-edit given name such as `Herman` ↔ `Hermann` and `R.F. Kuang` ↔ `R. F. Kuang`).
3. **Authorless searches and junk-title guard (`isDistinctiveTitleWithoutAuthor`):**
   - When no valid author is known (empty or ignored non-author, and no `"Author - Title"` prefix), require a multi-word title (`>= 2` non-article words and `>= 6` characters) so single-word junk titles (`me`, `shadow`, `Communication`, `Focus`) stay uncovered without hitting the network.
   - Require a strong (full cleaned) title match and accept only when the top non-summary result matches or there is a single clear result.
4. **Summary and analysis rejection (`isSummaryOrAnalysis`):**
   - Reject results whose title or author indicates a third-party summary, study guide, or analysis (`Summary of …`, `Book Analysis`, `Study Guide`, `Concise …`, `by Bright Summaries`, `Swift Reads`, `Abbey Beathan`, `Everest Media`, `SparkNotes`, `Instaread`, `Blinkist`, etc.).
5. **CLI `covers backfill [--limit <n>] [--retry-missing]`:**
   - Excludes `daily_stat` and untitled orphan `media_progress` rows from candidate discovery.
   - `--retry-missing` ignores cached `.none` negative entries once so previously missed items are re-evaluated.
   - Prints a per-work status line before the summary: `<title>: found (itunes|openlibrary|abs)` or `<title>: not found (<reason>)`.
