# InputTracker Web UI — Design System & Information Architecture (`web/DESIGN.md`)

## Aesthetic Direction: Calm Nocturnal Reading Room & Personal Archive (v2.1)

InputTracker is both a daily media log and a **long-term personal archive** of everything watched, read, and listened to. Design A v2.1 refines the calm reading-room aesthetic around six core principles:

1. **Dark Themes Only (`web/src/lib/theme.ts`, `web/src/styles/tokens.css`):**
   - Light and system modes are removed. The app offers 5 named dark themes (**Warm Study** `espresso`, **Midnight Ink** `midnight`, **Pine & Moss** `forest`, **Obsidian Archive** `obsidian`, and **Velvet Nocturne** `plum`), picked via live swatch cards in **Settings › Appearance** and applied before first paint from `localStorage` (`inputtracker.theme`) with zero flash.
   - All 9 category colour families (`anime`, `series`, `film`, `book`, `audiobook`, `youtube`, `podcast`, `music`, `other`) remain distinct and WCAG AA compliant (>= 4.5:1) on every theme.
2. **Home Page Clarity (`web/src/pages/Calendar.tsx`):**
   - One glance answers: what did I do **Today** and **This week**, how does **This month** look, and what am I in the middle of (**Continue** shelf of `in_progress` works).
   - Calendar month cells contain no truncated title rows or cover bloat: each cell shows the day number, total duration, active category dots, and a proportional horizontal stacked category bar.
   - Selected day panel header is a single clean line (`Today`, `Yesterday`, or `Saturday 17 October`) with no duplicated numeric date eyebrow.
   - Day panel items are compact, grouped by work (`groupDayPanelItems`), omit heavy letter tiles when no cover art exists, and collapse a day's YouTube plays into one expandable summary line (`12 videos · 48 min`).
3. **YouTube by Topic & Channel (`web/src/lib/youtube.ts`):**
   - By default, `"All"` excludes YouTube (`exclude=youtube`) so video plays do not drown out books, films, series, and anime (a toggle in Settings can include YouTube in `"All"`).
   - **Library › YouTube (`#/library?cat=youtube`):** Organises YouTube as **Topics → Channels → Videos** with proportional time bars, a dedicated **Channel Page**, quick **"Set topic"** for any channel, and search within YouTube.
   - **Insights › YouTube:** Shows YouTube topics over time and top channels with proportional bars.
4. **Multi-Select Category Chips (`web/src/lib/category-filter.ts`, `web/src/ui/CategoryChips.tsx`):**
   - Category filter chips are multi-select toggles across **Calendar**, **Library**, **Insights**, **Search**, and **Review**. Clicking **All** clears the selection.
   - Selection is reflected in the URL (`?cat=anime,film`) and sent as `category=` / `exclude=` query parameters to API endpoints.
5. **Ratings 0–10 with One Decimal & Quick Rating Popover (`web/src/lib/rating.ts`, `web/src/ui/QuickRating.tsx`):**
   - Ratings are `0..10` with at most one decimal (`8.5`, `10`, `0`), computed in integer tenths (`0..100`) to avoid float drift.
   - A compact `<QuickRatingPill />` on Library cards/rows, Day panel rows, Review showcases, Search results, and Work pages opens a viewport-clamped popover (0–10 slider in 0.5 steps + number field accepting one decimal + keyboard `±0.1`/`±0.5` + Clear) without opening the work. Saves optimistically via `WorkEdit.rating` with a 1-click **Undo** toast.
   - The Add to Archive form and Work page use the same `<RatingInput10 />` control.
6. **Accessible Context Menu & Edit Any Work (`web/src/ui/ContextMenu.tsx`, `web/src/ui/EditWorkSheet.tsx`):**
   - Right-click, touch long-press, or keyboard `Shift+F10` / `ContextMenu` key opens a viewport-clamped `role="menu"` with arrow-key navigation, `Escape`, and focus restoration.
   - Contextual actions include: **Rate…**, **Edit work…** (title, category, status incl. `planned`, metadata provider match link, rating, note), **Change category…**, **Set topic…** (YouTube), **Add more seasons / Log again**, **Mark as finished / in progress / planned**, **Hide**, **Open**, and **Edit / Delete archive entry** (with confirmation).

---

## 1. Information Architecture & Routing (`web/src/lib/router.ts`)

Routes are hash-based and parsed by `parseAppRoute(hash)`:

- **`#/calendar` (Home / Today):**
  - At-a-glance strip (**Today**, **This week** with 7-day sparkline, **Month** with `<CategoryShareChart compact />`, and **Continue** shelf).
  - Multi-select `<CategoryChips />` (`?cat=anime,film`).
  - 7-column month grid with category dots and proportional time bars.
  - Selected day detail panel with single-line clean date heading, compact work-grouped rows with `<QuickRatingPill />`, and single-line expandable YouTube summary.
- **`#/library` (Library, Watchlist & YouTube View):**
  - Multi-select `<CategoryChips />` + **YouTube by Topic & Channel** toggle.
  - Status filter (`All Works`, `In Progress`, `Finished`, `Planned`, `Dropped`), search filter, sort (`recent`, `time`, `title`), and Covers / List toggle.
  - **Library › YouTube (`#/library?cat=youtube`):** Topics → Channels → Videos hierarchy with proportional bars, Channel Page (`#/library?cat=youtube&channel=`), inline channel topic setter, and YouTube search.
  - **Work Detail (`#/library?work=<key>`):** Hero cover, badges, quick rating pill, **Edit Work** sheet trigger, **Add more seasons / Log again**, **Edit Entry / Delete Entry** (with confirmation) for archive/imported entries, season progress bars, 0–10 `RatingEditor`, and activity history.
- **`#/insights` (Insights):**
  - Time range selector (`30d`, `12w`, `12m`, `all`) + multi-select `<CategoryChips />`.
  - KPI strip with `<Sparkline>` trends and daily streak.
  - `<StackedSeriesChart />`, `<CategoryShareChart />`, `<PunchCardChart />`, **YouTube Topics & Top Channels**, `<HeatmapCalendarChart />` (52-week calendar), "On This Day", and Annual Goals.
- **`#/review` (Month & Year in Review):**
  - Month in Review (default) and Year View (`#/review?view=year&year=YYYY`) with multi-select `<CategoryChips />`, stacked charts, category share, punch card, and cover showcases with `<QuickRatingPill />` and context menus.
- **`#/add` (Lookup-First Add to Archive + Offline Quick Log):**
  - Step 1: Metadata lookup (`/api/lookup/search`) or manual work builder.
  - Step 2: Status (`Finished`, `In Progress`, `Planned (Watchlist)`, `Dropped`), seasons/viewings/progress, `when` precision, and 0–10 `<RatingInput10 />` & note, with live computed duration preview.
- **`#/search` (Global Search):**
  - Query input (`/` shortcut), source/media-type selectors, multi-select `<CategoryChips />`, highlighted hits with `<QuickRatingPill />` and context menus, and full title history.
- **`#/settings` (Settings & Sync):**
  - **Appearance & Preferences:** 5 dark theme swatch cards (`espresso`, `midnight`, `forest`, `obsidian`, `plum`) + **"Include YouTube in All"** toggle.
  - **Import Achriom Library:** Upload `.zip`/`.csv` → **1. Preview (Dry Run)** → **2. Import Achriom Archive**, rendering `AchriomImportResult` (created, updated, unchanged, planned, matched, total time, per-file rows, and skipped reasons).
  - **Hidden Works:** Lists hidden works (`GET /api/library/hidden`) with one-click **Unhide**.
  - **Sources & Sync, Native/Takeout Import & Export, Metadata Providers & Database Diagnostics.**
