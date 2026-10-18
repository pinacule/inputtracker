# InputTracker Web UI — Design System & Information Architecture (`web/DESIGN.md`)

## Aesthetic Direction: Calm Reading Room & Personal Archive

InputTracker is both a daily media log and a **long-term personal archive** of everything watched, read, and listened to. Design A v2 refines the calm, warm reading-room aesthetic around four core principles:

1. **Intentional Covers (Zero Cover Bloat):**
   - Covers appear **only where they carry meaning**: the **Library** grid, a **Work's detail page**, the **Selected Day's detail panel**, the **Add to Archive** lookup results/preview, and **Review / On This Day** highlights.
   - Surfaces that show high-density structure—such as **Calendar month cells**—never render cover thumbnails or redundant top shelves. Instead, each calendar cell shows the day number, total duration, up to 2 deduplicated work titles with 6px category colour dots (on desktop), and a proportional **horizontal stacked category time bar** at the bottom of the cell.
2. **Category-First Colour System:**
   - Every visual indicator (badges, calendar bars, tabs, stacked charts, donut rings, and cover fallback tiles) is coloured by the 9 canonical `Category` values from `src/core/category.ts`:
     `anime`, `series`, `film`, `book`, `audiobook`, `youtube`, `podcast`, `music`, `other`.
3. **Graphs Over Numbers (`web/src/ui/charts/`):**
   - Rows of oversized stat cards are replaced by compact pulse strips (with inline `<Sparkline>` trends) and hand-crafted, dependency-free, accessible SVG charts with interactive hover/tap/focus tooltips and `.sr-only` data tables.
4. **Progressive Disclosure & Focused Navigation:**
   - Primary navigation focuses on the four daily/weekly habits (**Calendar**, **Library**, **Insights**, **Review**) plus the prominent **Add to Archive** trigger and **Search** (`/` shortcut).
   - **Settings** (connected sources, "Sync now", import/export, metadata providers, database status, and theme switcher) lives behind a gear icon rather than cluttering the main navigation.
   - **Review** defaults to **Month in Review** (with a month stepper), and offers a **Year View** toggle that combines the twelve months.
   - The **52-week streak/activity heatmap** is an integrated chart inside **Insights** rather than a separate top-level page.

---

## 1. Information Architecture & Routing (`web/src/lib/router.ts`)

Routes are hash-based and parsed by `parseAppRoute(hash)`:

- **`#/calendar` (Home / Today):**
  - Compact monthly pulse card with total time, `<Sparkline>`, active days, and interactive `<CategoryShareChart compact />`.
  - 7-column cover-free month grid with category time bars and desktop work-title previews.
  - Selected day detail: sticky side panel on desktop (`>= 1024px`), inline card below the grid on tablet/phone, and bottom `<Sheet>` on phone tap. Opening `#/calendar?date=YYYY-MM-DD` on desktop selects the day in the side panel without opening a modal over the page. High-volume days (e.g., 40 YouTube videos) include a category bar and collapsible item list.
- **`#/library` (Library & Work Detail):**
  - Category tabs with hours and work counts (`All`, `Anime`, `Series`, `Films`, `Books`, `Audiobooks`, `YouTube`, `Podcasts`, `Music`, `Other`).
  - Status filter (`All Works`, `In Progress`, `Finished`), search filter, sort (`recent`, `time`, `title`), and Cover Grid / Compact List toggle.
  - **Work Detail (`#/library?work=<key>`):** Hero cover, category & source badges, season-by-season progress bars (`SeasonInfo & { watched_episodes }`), personal rating & note editor (`RatingEditor`), chronological session & archive history, **"Add more seasons"**, and **Edit / Delete** actions for archive entries.
- **`#/insights` (Insights):**
  - Time range selector (`30d` = 30 days / daily, `12w` = 12 weeks / weekly, `12m` = 12 months / monthly, `all` = all time / monthly) + category filter pills.
  - Compact 3-stat pulse strip with `<Sparkline>` trends + current/longest streak.
  - `<StackedSeriesChart />`: Stacked minutes per category over time.
  - `<CategoryShareChart />`: Donut ring + ranked horizontal share bars.
  - `<PunchCardChart />`: 7 weekdays × 24 hours consumption rhythm matrix.
  - `<HeatmapCalendarChart />`: 52-week activity and streak calendar with year stepper.
  - "On This Day" memories and Annual Goals tracker.
- **`#/review` (Month & Year in Review):**
  - **Month in Review (default):** Month stepper (`‹ October 2026 ›`), total time with `%` comparison vs previous month, daily stacked chart, category share, monthly punch card, and cover showcases for Top Works, Finished Works, and Started Works.
  - **Year View (`#/review?view=year&year=YYYY`):** Combines the twelve months into a 12-month stacked category chart (clicking any month bar opens that Month in Review), annual category share, and top/finished works of the year.
- **`#/add` (Lookup-First Add to Archive + Offline Quick Log):**
  - Opens as a full page on phone (`#/add`) and as a large `<Sheet size="lg">` dialog from the desktop header/sidebar.
  - **Step 1 (Lookup):** Searches `/api/lookup/search?q=&category=` across AniList, TVmaze, iTunes, Open Library, and TMDB; or lets the user build a `ManualWork` by hand when no provider knows the title.
  - **Step 2 (Configure & Preview):** Tick watched seasons (with per-season episode counts and partial episode adjuster), film viewings (`times`), book progress (`0..1` + page-based estimate or hours override), or audiobook hours; pick `when` precision (`day`, `month`, `year`, or `unknown` with optional `end_date` range); optional half-star rating & note. Displays the live computed summary (e.g., `2 seasons · 48 episodes · ≈ 19 h`) before saving to `POST /api/archive`.
  - **Quick Session tab:** Preserves offline-ready single-event logging via `POST /api/events` and `lib/offline-queue.ts`.
- **`#/search` (Global Search):**
  - Reachable from the sidebar search box, `/` keyboard shortcut on desktop, or mobile top bar icon. Highlights query matches (`highlightParts`), opens full title history (`getTitleHistory`), and links directly to `Add to Archive` when a title is not yet in the library.
- **`#/settings` (Settings & Sync):**
  - Reachable via the gear icon in the sidebar footer and mobile top bar.
  - Houses **Appearance** (`system` / `light` / `dark` stored in `localStorage` under `inputtracker.theme`), **Sources & Sync** (`GET /api/settings`, `GET /api/sync/status`, "Sync now" for Audiobookshelf and Simkl), **Import / Export** (`.json`, `.csv`, YouTube Takeout `watch-history.json`), and **Metadata Providers & Database Diagnostics**.

### Legacy Route Redirects
Old deep links redirect automatically via `resolveLegacyRedirect`:
- `#/stats` → `#/insights`
- `#/heatmap` → `#/insights`
- `#/year` (and `#/year?year=YYYY`) → `#/review?view=year`
- `#/progress` → `#/library?status=in_progress`
- `#/importexport` → `#/settings`

---

## 2. CSS Tokens & Category Palette (`web/src/styles/`)

Styles are modular and imported in `web/src/styles/index.css`:
- `tokens.css`: Surfaces, typography, spacing, shadows, heat scale, and the 9 category colour families (`--cat-<category>-{fg|bg|border|solid|tile-start|tile-end}`) in both light mode (`:root`, `:root[data-theme="light"]`) and dark mode (`@media (prefers-color-scheme: dark)`, `:root[data-theme="dark"]`).
- `base.css`: Reset, typography, `:focus-visible` ring, `.tabular-nums`, `.sr-only`, `.page-container`, `.page-header`.
- `ui.css`: Shared UI primitives (`Button`, `IconButton`, `Card`, `Tabs`, `Stat`, `ProgressBar`, `Cover`, `Badge`, `EmptyState`, `Skeleton`, `Sheet`, `Toast`).
- `charts.css`: Hand-made SVG charts (`Sparkline`, `StackedSeriesChart`, `CategoryShareChart`, `PunchCardChart`, `HeatmapCalendarChart`) and `RatingEditor`.
- `shell.css`: Desktop sidebar, mobile top bar, mobile 5-tab bottom bar, and offline banner.
- `calendar.css`: Calendar pulse card, 7-column cover-free grid, and day detail panel.
- `pages.css`: Library, Work detail, Insights, Review, Add to Archive, Search, Settings, and `.ui-form-*` controls.
