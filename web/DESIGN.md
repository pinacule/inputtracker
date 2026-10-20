# InputTracker Web UI — Design System & Information Architecture (`web/DESIGN.md`)

## Aesthetic Direction: Calm Nocturnal Reading Room & Personal Archive (v2.2)

InputTracker is both a daily media log and a **long-term personal archive** of everything watched, read, and listened to. Design A v2.2 refines the reading-room aesthetic around six core principles:

1. **Dark Themes Only (`web/src/lib/theme.ts`, `web/src/styles/tokens.css`):**
   - Light and system modes are removed. The app offers 5 named dark themes (**Warm Study** `espresso`, **Midnight Ink** `midnight`, **Pine & Moss** `forest`, **Obsidian Archive** `obsidian`, and **Velvet Nocturne** `plum`), picked via live swatch cards in **Settings › Appearance** and applied before first paint from `localStorage` (`inputtracker.theme`) with zero flash.
   - All 10 category colour families (`anime`, `series`, `film`, `book`, `audiobook`, `youtube`, `podcast`, `music`, `shortform`, `other`) remain distinct and WCAG AA compliant (>= 4.5:1) on every theme.
   - One glance answers: what did I do **Today** and **This week**, how does **This month** look, and what am I in the middle of (**Continue** shelf of `in_progress` works).
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
   - Hidden for music (`canRateCategory("music") === false`).
6. **Rebuilt Work Page & Accessible Context Menu (`web/src/pages/WorkPage.tsx`, `web/src/ui/ContextMenu.tsx`, `web/src/ui/EditWorkSheet.tsx`):**
   - **Work Page (`#/library?work=<key>`):** Uses explicit `LibraryWork.progress` (`6 of 6 seasons · 65 of 65 episodes`) and `LibraryWork.creator`, renders seasons compactly (`Season 2 · 2019 · 10 ep`, stripping noisy provider season titles), formats history cleanly (never printing `"Undated · Manual (Archive)"`), and groups actions (**Add seasons / Log again**, **Edit work**, **Refresh metadata** via `POST /api/library/work/refresh-metadata?key=`, and **Edit / Delete entry**).
   - Card and row labels never print `"N episodes"` from `units`; they use `progress` (`3 seasons · 36 ep`, `planned · 3 seasons`), sessions for audiobooks, and plays for music and YouTube.
   - Right-click, touch long-press, or keyboard `Shift+F10` / `ContextMenu` key opens a viewport-clamped `role="menu"` with arrow-key navigation, `Escape`, and focus restoration.

---

## 1. Information Architecture & Routing (`web/src/lib/router.ts`)

Routes are hash-based and parsed by `parseAppRoute(hash)`:

- **`#/calendar` (Home / Today):**
  - At-a-glance strip (**Today**, **This week** with 7-day sparkline, **Month** with `<CategoryShareChart compact />`, and **Continue** shelf).
  - Multi-select `<CategoryChips />` (`?cat=anime,film`).
  - 7-column month grid with category dots and proportional time bars.
  - Selected day detail panel with single-line clean date heading, compact work-grouped rows with `<QuickRatingPill />`, and single-line expandable YouTube summary.
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

## Home page (`#/calendar`, v2.2 — `web/src/pages/Calendar.tsx`, `web/src/ui/home/`, `web/src/lib/home.ts`, `web/src/styles/home.css`)

The v2.2 Home page is designed from scratch around how the app is used every day on a phone and reviewed across a month on desktop:

1. **Phone-First Flow (375px) & Desktop Two-Column Studio (1440px):**
   - **On phone (`< 1024px`):** Opens directly to **This week** (the 7-day stacked category bar graph) and the **Selected day detail** (`Today` by default), followed by **In the middle of** (`in_progress` works) and the **Month rhythm & calendar grid**. Checking today's and this week's activity or tapping **+ Add** requires zero scrolling past month-grid chrome.
   - **On desktop (`>= 1024px`):** Uses a two-column studio layout (`grid-template-areas: "stage inspector"`). The left stage column shows the **In the middle of** shelf, the **Month Rhythm & 31-Day Skyline Graph**, and the **7-Column Month Calendar Grid**. The right column is a sticky inspector (`position: sticky`) holding the **7-Day Week Graph** and **Selected Day Detail** beside the calendar without a modal.

2. **Graphs Over Numbers:**
   - **7-Day Week Graph (`WeekGraph.tsx`):** Interactive Monday–Sunday vertical stacked category bars scaled to the week's busiest day, showing `Today` and `Week` totals and acting as a 1-tap day switcher. When a week spans two months (e.g. `28 Sep – 4 Oct`), both months are fetched and merged so the week graph is always complete.
   - **Month Rhythm & 31-Day Skyline (`MonthRhythmCard.tsx`):** Replaces multi-box KPI banners with a proportional horizontal **Category Share Bar**, clickable category breakdown pills, and an interactive **31-day Daily Skyline stacked bar chart** where clicking any day's bar selects that day.
   - **Visual Month Calendar Grid (`MonthCalendarGrid.tsx`):** Heat-washed day cells (`--heat-0`..`--heat-4`) with a proportional stacked category bar along the bottom of every active cell. Desktop cells show up to 2 calm deduplicated work lines; narrow phone cells show category dots instead of cramped truncated text.

3. **Covers Only Where They Carry Meaning (`HomeWorkThumb.tsx`):**
   - Calendar cells never render cover images.
   - In the **Selected Day Detail** and **In the middle of** shelf, a thumbnail (`<img>`) is rendered **only when a real `cover_url` exists** (and loads cleanly). When `cover_url` is `null` or fails to load, a compact 32×32 category icon badge is rendered instead of a heavy gradient letter tile.

4. **YouTube and Music on the Home Page (Spec Section 15):**
   - On the Home page and Calendar, **"All" (`selectedCategories = []`) includes every category, including YouTube and music**.
   - **YouTube never floods the calendar or day panel:** In calendar cells, all YouTube plays collapse to a single `"YouTube"` line. In the Selected Day Detail panel, all YouTube plays on that day (even 40 short videos) collapse into **one calm expandable line** (`"40 videos · 2h 40m"` with a top-channels preview). Expanding it groups videos by channel with proportional watch-time bars, channel links, and per-video context menus and ratings.
   - **Music:** Included in all time totals and bars; when more than 2 tracks are played on a day, they collapse into a calm expandable `"Music · N plays · Xm"` row. **Ratings are never shown on music** (`isRateableCategory("music") === false`).
   - **Short-form:** One non-expandable line `"Short-form · 47 min"`, never a title list or archived work. It has its own colour in category shares, calendar bars/dots, week graph, Insights and Review. Measured PC daily Shorts suppress same-day Takeout gap estimates; phone app time stays separate. Daily records add time but zero item/works counts.

5. **Plain-Words Day Headers, Deep Links & Keyboard Accessibility:**
   - Selected day headers use plain words (`"Today"`, `"Yesterday"`, `"Saturday 17 October"`, `"Saturday 3 May 2025"`) via `formatCleanDayHeading` with no duplicate numeric date above them.
   - Deep links `?date=YYYY-MM-DD`, `?month=YYYY-MM`, and `?cat=anime,film` are synced via `replaceState`.
   - Full roving keyboard navigation inside the calendar grid (`ArrowLeft`/`Right` ±1 day, `ArrowUp`/`Down` ±7 days, `Home`/`End` start/end of week, `PageUp`/`PageDown` previous/next month) and accessible context menu support (`bindContextMenu`, right-click, long-press, `Shift+F10`).
