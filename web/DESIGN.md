# InputTracker Web UI — Design System & Information Architecture (`web/DESIGN.md`)

## Aesthetic Direction: Calm Nocturnal Reading Room & Personal Archive (v2.2)

InputTracker is both a daily media log and a **long-term personal archive** of everything watched, read, and listened to. Design A v2.2 refines the reading-room aesthetic around six core principles:

1. **Dark Themes Only (`web/src/lib/theme.ts`, `web/src/styles/tokens.css`):**
   - Light and system modes are removed. The app offers 5 named dark themes (**Warm Study** `espresso`, **Midnight Ink** `midnight`, **Pine & Moss** `forest`, **Obsidian Archive** `obsidian`, and **Velvet Nocturne** `plum`), picked via live swatch cards in **Settings › Appearance** and applied before first paint from `localStorage` (`inputtracker.theme`) with zero flash.
   - All 10 category colour families (`anime`, `series`, `film`, `book`, `audiobook`, `youtube`, `podcast`, `music`, `shortform`, `other`) remain distinct and WCAG AA compliant (>= 4.5:1) on every theme.
    - One glance answers: what did I do **Today** and in the **Last 7 days**, how does it compare with my norm, and how does **This month** look. In-progress works live in Library's **In Progress** filter, not a Home shelf.
   - Selected day panel header is a single clean line (`Today`, `Yesterday`, or `Saturday 17 October`) with no duplicated numeric date eyebrow.
   - Day panel items are compact, grouped by work (`groupDayPanelItems`), omit heavy letter tiles when no cover art exists, and collapse a day's YouTube plays into one expandable summary line (`12 videos · 48 min`).
3. **Placement of YouTube and Music (`web/src/lib/category-filter.ts`, `web/src/lib/youtube.ts`):**
   - YouTube and music appear in **Calendar**, the day panel, heat maps, **Insights**, **Review**, and **Search** like any category (they are time spent).
   - Only **Library "All"** excludes YouTube and music (`exclude=youtube,music`). There is no separate YouTube button or sidebar/mobile-nav entry — the category chips in Library are the way in, and legacy `#/youtube` links redirect to `#/library?cat=youtube`.
   - **Library › YouTube (`#/library?cat=youtube`):** Lists the **videos** (`GET /api/youtube/videos?sort=`), default `plays` (Most played), plus `recent`, `time` (watch time), and `topic`, and groupable by **topic** or **channel** with inline channel topic setting.
   - **Library › Music (`#/library?cat=music`):** Compact **tracks list**, default `plays` (Most played), plus `recent`, `time` (listen time), and `creator` (artist). Music tracks have **no rating controls**. Plays/time lists use small proportional bars and rank numbers, not large covers.
4. **Multi-Select Category Chips & Library Sorts (`web/src/lib/category-filter.ts`, `web/src/ui/CategoryChips.tsx`):**
   - Category filter chips are multi-select toggles across **Calendar**, **Library**, **Insights**, **Search**, and **Review**. Clicking **All** clears the selection.
   - Selection is reflected in the URL (`?cat=anime,film`) and sent as `category=` / `exclude=` query parameters to API endpoints.
   - Library sorts support `plays`, `recent`, `time`, `title`, `category`, and `creator` (`LibrarySortV2`). Short-form chips appear in time views, not Library or work creation/category-edit controls.
5. **In-Place Rating Input 0–10 (`web/src/lib/rating.ts`, `web/src/ui/QuickRating.tsx`, `web/src/ui/RatingEditor.tsx`):**
   - Ratings are `0..10` with at most one decimal (`8.5`, `10`, `0`), computed in integer tenths (`0..100`) to avoid float drift.
   - No slider and no popover: clicking the `★` badge (`<QuickRatingPill />`) turns it **in place** into a compact text field showing the current value. Type `8.5`, `Enter` saves, `Escape` cancels, `blur` saves if valid; `↑`/`↓` and the mouse wheel nudge by `±0.1` (`Shift`: `±1.0`); invalid input shows a short inline hint and does not save. Saves optimistically via `WorkEdit.rating` with a 1-click **Undo** toast.
    - Hidden for music and time-only short-form (`canRateCategory` returns false).
6. **Rebuilt Work Page & Accessible Context Menu (`web/src/pages/WorkPage.tsx`, `web/src/ui/ContextMenu.tsx`, `web/src/ui/EditWorkSheet.tsx`):**
   - **Work Page (`#/library?work=<key>`):** Uses explicit `LibraryWork.progress` (`6 of 6 seasons · 65 of 65 episodes`) and `LibraryWork.creator`, renders seasons compactly (`Season 2 · 2019 · 10 ep`, stripping noisy provider season titles), formats history cleanly (never printing `"Undated · Manual (Archive)"`), and groups actions (**Add seasons / Log again**, **Edit work**, **Refresh metadata** via `POST /api/library/work/refresh-metadata?key=`, and **Edit / Delete entry**).
   - Card and row labels never print `"N episodes"` from `units`; they use `progress` (`3 seasons · 36 ep`, `planned · 3 seasons`), sessions for audiobooks, and plays for music and YouTube.
   - Right-click, touch long-press, or keyboard `Shift+F10` / `ContextMenu` key opens a viewport-clamped `role="menu"` with arrow-key navigation, `Escape`, and focus restoration.

---

## 1. Information Architecture & Routing (`web/src/lib/router.ts`)

Routes are hash-based and parsed by `parseAppRoute(hash)`:

- **`#/calendar` (Home / Today):**
   - Rolling seven-day pills with weekday median markers and plain-word comparisons.
   - Multi-select `<CategoryChips />` (`?cat=anime,film`).
   - Selected-day detail below the pills; month summary beside it on desktop and below on phone. No month calendar grid or Continue shelf.
   - Compact work-grouped rows; rating actions appear on hover/focus. YouTube and music each fold into one expandable line.
- **`#/library` (Library, Watchlist, YouTube Videos & Music Tracks):**
  - Multi-select `<CategoryChips scope="library" />` ("All" excludes YouTube and Music; legacy `#/youtube` redirects to `#/library?cat=youtube`).
   - Status filter (`All Works`, `In Progress`, `Finished`, `Planned`, `Dropped`), search filter, sort (`plays`, `recent`, `time`, `category`, `creator`, `title`), and Covers / List toggle.
   - **Library › YouTube (`#/library?cat=youtube`):** Videos list defaults to `plays`, plus `recent`, `time`, and `topic`, groupable by `topic` or `channel`. Compact Most played top-channel bars default to all time.
   - **Library › Music (`#/library?cat=music`):** Tracks list defaults to `plays`, plus `recent`, `time`, and `creator` (artist), with no rating controls. Compact Most played song/artist bars default to all time.
  - **Work Page (`#/library?work=<key>`):** Hero cover, creator subtitle, in-place `<QuickRatingPill />`, key metrics strip (`progress`, total time, recorded sessions/plays, active dates, source), grouped action toolbar (**Add seasons / Log again**, **Edit work**, **Refresh metadata**, **Edit / Delete entry**), compact seasons grid, `RatingEditor`, and readable history.
- **`#/insights` (Insights):**
  - Time range selector (`30d`, `12w`, `12m`, `all`) + multi-select `<CategoryChips />` ("All" includes YouTube and Music).
   - KPI strip with `<Sparkline>` trends and daily streak.
   - **Most played** (`MostPlayed.tsx`): top-five songs/artists/channels, plays/time controls and independent This month / This year / All time range selector; category selection limits visible rankings. No favourites UI.
   - **Short-form time**: its own category-coloured sparkline and total within the main Insights range. Daily totals do not invent hourly activity; the punch card reports unplaced time.
  - `<StackedSeriesChart />`, `<CategoryShareChart />`, `<PunchCardChart />`, **YouTube Topics & Top Channels**, `<HeatmapCalendarChart />` (52-week calendar), "On This Day", and Annual Goals.
- **`#/review` (Month & Year in Review):**
   - Month in Review (default) and Year View (`#/review?view=year&year=YYYY`) with multi-select `<CategoryChips />`, stacked charts, category share, punch card, and cover showcases with `<QuickRatingPill />` and context menus.
   - Compact **Most played** bars use the selected historical month/year and plays/time controls. Short-form appears as time only, with zero works/units and no cover showcase.
- **`#/add` (Lookup-First Add to Archive + Offline Quick Log):**
  - Step 1: Metadata lookup (`/api/lookup/search`) or manual work builder.
  - Step 2: Status (`Finished`, `In Progress`, `Planned (Watchlist)`, `Dropped`), seasons/viewings/progress, `when` precision, and 0–10 `<RatingInput10 />` (hidden for music) & note, with live computed duration preview.
- **`#/search` (Global Search):**
  - Query input (`/` shortcut), source/media-type selectors, multi-select `<CategoryChips />`, highlighted hits with `<QuickRatingPill />` and context menus, and full title history.
- **`#/settings` (Settings & Sync):**
  - **Appearance:** 5 dark theme swatch cards (`espresso`, `midnight`, `forest`, `obsidian`, `plum`).
  - **Import Achriom Library:** Upload `.zip`/`.csv` → **1. Preview (Dry Run)** → **2. Import Achriom Archive**, rendering `AchriomImportResult`.
  - **Hidden Works:** Lists hidden works (`GET /api/library/hidden`) with one-click **Unhide**.
   - **Sources & Sync, Native/Takeout Import & Export, Metadata Providers & Database Diagnostics.**

---

## Richer work page (W16 — `WorkContext.tsx`, `work-presentation.ts`, `pages.css`)

- **Quiet artwork, readable foreground:** the full-width hero has a decorative blurred/darkened
  local banner at 22% opacity, falling back on image error to a blurred local cover, then the
  category's theme gradient. Artwork is `aria-hidden` and never loads from a third-party URL.
  The reading body is an opaque `--bg-surface`, so changing artwork cannot alter the five themes'
  established text contrast. No new hard-coded theme colours.
- **Context before metrics:** creator subtitle plus year/narrator credits, a three-line plain-text
  description, wrapping quiet genre chips, paired community/personal score bars, then category rank.
  Descriptions longer than 180 characters have a keyboard-accessible More/Less button with
  `aria-expanded` / `aria-controls` and a 44px minimum target; shorter descriptions stay fully visible.
  Expanded copy keeps a readable 70ch measure. Missing description, genres, score or rank omit their
  block rather than displaying placeholders. ABS authors/narrators/genres use existing local data.
- **Public score ≠ your rating:** source and one-decimal score sit next to `You 9.0` (or `Not rated`)
  with `/ 10` and two restrained four-pixel bars. Vote counts are secondary. Scores do not change
  personal annotations; in-place rating/editor saves, edits and successful undo reload server-computed ranks. Music
  continues to hide personal-rating controls and the personal score/rating-rank line.
- **Personal, category-local rank:** `Your #1 anime by time · 12% of your anime hours` and, when rated,
  `Your #3 highest-rated anime`. Competition ties share a position (`1, 1, 3`); hidden/planned works
  are excluded and zero-time works omit the time line. Positive shares below 1% display `<1%`.
- **375px phone / 1440px desktop:** below 640px the cover/body stack, the cover narrows to 88px and
  hero padding/gaps tighten. The reading body is full width, with wrapping chips, score labels,
  metrics and long copy. At 640px and above the existing side-by-side cover/body layout is retained.
  This is a CSS design target; automated build/helper tests do not replace browser screenshot checks.

---

## Home page (`#/calendar`, W17 — `web/src/pages/Calendar.tsx`, `web/src/ui/home/`, `web/src/lib/home*.ts`, `web/src/styles/home.css`)

1. **Phone-first, balanced desktop:** Below the compact header/category filters, rolling pills are the main element, followed by selected-day detail and the month summary. Desktop (`>=1024px`) puts pills + day panel left and month summary right, with no sticky tall inspector. The month calendar grid and **In the middle of** shelf are removed; Library's **In Progress** filter is the place to continue works.

2. **Rolling seven-day pills (`WeekGraph.tsx`, `home-norm.ts`):** Oldest at left, today at right by default; never Monday–Sunday. Each shows total above a minute-proportional category stack, weekday/date below, and an outline for selection. Tapping selects without moving the window. ‹/› move its end by seven local dates, clamped at today; the forward button is disabled there. A valid `?date=YYYY-MM-DD` selects that day at the right end (future links clamp at today). Local-date arithmetic is DST-safe; month-boundary windows fetch both months.

3. **Compared with your norm:** Each faint marker is the median of that weekday's eight preceding occurrences, including zero-activity days. Fewer than four available occurrences use the preceding 30 available days' median. Dates before `SeriesResult.history_start` are not invented observations; the target day is excluded. All seven pills fetch their full lookback (62 days before the window end). Bars and markers share one scale, including a 60-minute floor and the highest norm, so markers never clip. Two plain sentences show today's (or the historical selected day's) comparison and the window total vs the sum of seven norms: **Today 2h 2m · 40 min more than a usual Tuesday**, **Last 7 days 3h 59m · 1h more than usual**. Inclusive ±10% says **about usual**. Filters apply equally to observed time and norms; hidden/planned works do not count. A history fetch failure shows an error/retry, not a fictitious zero norm.

4. **Month summary (`MonthRhythmCard.tsx`):** Month heading, total, share bar, category pills, daily stacked skyline and previous-month comparison. Month-precision time counts in summary totals and is labelled separately, never assigned an invented day in the skyline. Clicking a skyline day selects it and repositions the rolling window only if necessary. Category filters apply to both months' comparison totals.

5. **Calm day rows:** Real cover art only; otherwise a compact category-coloured icon. YouTube and music always fold into one expandable summary line each, even a single music track. Short-form is one non-expandable **Short-form · 47 min** line with its own colour/icon, zero works, no rating or work actions. Ratings on work/video rows appear only on hover or keyboard focus, without layout jumps; right-click/long-press, Shift+F10 and the More menu remain accessible. The removed shelf's per-row Log buttons are gone; day-level Log and primary Add stay available.

6. **Consistent position and creator:** Audiobook/book position uses `LibraryWork.consumption_progress`: latest ABS snapshot (including resets to zero), otherwise latest session position. Logged minutes remain session sums, not percentage estimates. Day rows and Library meta use the same position. Library creator building shares `parseBookAuthors` with cover lookup, filtering folder/publisher placeholders (Downloads, GraphicAudio, Unknown…) while preserving real authors.

7. **Plain-word headings and accessibility:** Today, Yesterday, or Saturday 17 October; no duplicated date eyebrow. Hash links preserve `date`/`month`/`cat` through `replaceState`. Pills, navigation and skyline use native keyboard-focusable buttons with pressed/current-day labels; norm values are included in each pill's accessible description.
