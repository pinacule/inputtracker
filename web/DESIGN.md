# InputTracker Web UI — Design System (`web/DESIGN.md`)

## Aesthetic Direction: Cover-First, Calm & Warm

InputTracker is designed like a quiet personal reading room and curated media shelf:
- **Generous whitespace & warm surfaces:** Warm cream/linen paper (`#f6f2ea` / `#fffdf9`) in light mode; deep espresso/walnut charcoal (`#14120f` / `#1d1a16`) in dark mode via `prefers-color-scheme`.
- **Cover art is the hero:** Wherever an item or title appears, lead with `<Cover />`. When no cover URL exists (or the image fails), `<Cover />` renders a warm book-tile gradient in the media kind's colour with its SVG icon and the title's initials.
- **Literary serif + crisp UI sans:** Headings and big stat numbers use `--font-serif` (`Iowan Old Style`, `Palatino`, `Charter`, `Georgia`), while controls, metadata, and body copy use `--font-sans` with `.tabular-nums` for times, counts, and durations.

---

## 1. CSS Structure & Tokens (`web/src/styles/`)

Styles are split into modular files imported by `web/src/styles/index.css`:
- `tokens.css`: All CSS custom properties (colours, typography, spacing, radii, shadows, motion).
- `base.css`: Reset, typography defaults, focus ring (`:focus-visible`), `.page-container` and `.page-header` layout primitives.
- `ui.css`: Shared component styles (`web/src/ui/*`).
- `shell.css`: App shell (desktop sidebar, mobile top/bottom bars, offline banner).
- `calendar.css`: Calendar page styles (add new page stylesheets alongside it and import them in `index.css`).

### Core Tokens

- **Surfaces:** `--bg-canvas`, `--bg-surface`, `--bg-surface-raised`, `--bg-subtle`, `--bg-muted`, `--bg-overlay`
- **Text (WCAG AA):** `--text-primary`, `--text-secondary`, `--text-muted`, `--text-on-accent`
- **Borders:** `--border-subtle`, `--border-default`, `--border-strong`
- **Brand Accent:** `--accent-primary`, `--accent-primary-hover`, `--accent-primary-subtle`, `--accent-primary-border`
- **Status:** `--status-{success|warning|danger}-{fg|bg|border}`
- **Media Kind Colours (`MediaKind` = `"audiobook" | "youtube" | "film" | "manual"`):**
  - Audiobook (`audiobookshelf`, podcasts): `--kind-audiobook-{fg|bg|border|solid|tile-start|tile-end}`
  - YouTube (`youtube`): `--kind-youtube-{fg|bg|border|solid|tile-start|tile-end}`
  - Film & Series (`simkl`, movies, TV): `--kind-film-{fg|bg|border|solid|tile-start|tile-end}`
  - Manual (`manual`, books, music, other): `--kind-manual-{fg|bg|border|solid|tile-start|tile-end}`
  - Use `resolveMediaKind(source, mediaType)` from `src/lib/ui-helpers.ts` to map any event/item to its `MediaKind`.
- **Spacing:** `--space-1` (4px) through `--space-16` (64px)
- **Radii:** `--radius-xs` (5px), `--radius-sm` (8px), `--radius-md` (12px), `--radius-lg` (16px), `--radius-xl` (22px), `--radius-full`
- **Shadows:** `--shadow-xs`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-cover`

---

## 2. Shared UI Components (`web/src/ui/`)

Import from `../ui`:

- **`<Cover src={item.cover_url} title={item.title} source={item.source} mediaType={item.media_type} size="xs|sm|md|lg|xl" aspect="square|poster|wide" />`**
  Renders the cover image with a subtle book-spine highlight, or falls back to a warm kind-coloured tile with `<MediaKindIcon />` and 1–2 initials (`extractInitials`).
- **`<Card variant="default|elevated|subtle|interactive" padding="none|sm|md|lg" title="..." subtitle="..." actions={...}>`**
  Standard surface container.
- **`<Stat label="..." value="..." sublabel="..." kind="audiobook|youtube|film|manual" size="md|lg" />`**
  Big serif tabular figure + uppercase eyebrow label + optional caption.
- **`<Badge variant="audiobook|youtube|film|manual|neutral|success|warning|danger" source={...} mediaType={...} size="sm|md" icon={...}>`**
  Pill badge. Pass `source` and `mediaType` to colour automatically by media kind.
- **`<Tabs options={...} value={...} onChange={...} ariaLabel="..." variant="segmented|pills" />`** (`SegmentedControl`)
  Accessible `tablist` for source filters, metric toggles, and view switches.
- **`<ProgressBar value={42} max={100} kind="audiobook" size="sm|md|lg" label="..." valueLabel="..." />`**
  Accessible `progressbar` coloured by `kind`.
- **`<Button variant="primary|secondary|ghost|danger" size="sm|md|lg" href="..." leadingIcon={...}>`** & **`<IconButton label="..." variant="default|subtle|ghost|primary" size="sm|md|lg">`**
  Buttons and link-buttons (`href` renders an `<a>`).
- **`<EmptyState title="..." description="..." icon={...} actions={...} compact />`**
  Dashed warm surface for empty results or zero-data states.
- **`<Skeleton width={...} height={...} circle />`**
  Calm loading placeholder (respects `prefers-reduced-motion`).
- **`<Sheet open={...} onClose={...} title="..." subtitle="...">`** (`Modal`)
  Bottom sheet on phone (`< 768px`) and centred modal dialog on desktop (`>= 768px`), with Escape and backdrop dismissal.
- **`<ToastViewport toasts={...} onDismiss={...} />`**
  Polite/assertive floating notifications.
- **Icons (`web/src/ui/icons.tsx`):**
  Inline SVG icons (`CalendarIcon`, `ProgressIcon`, `HeatmapIcon`, `StatsIcon`, `ImportExportIcon`, `AddIcon`, `YearIcon`, `SearchIcon`, `AudiobookIcon`, `YoutubeIcon`, `FilmIcon`, `TvIcon`, `PodcastIcon`, `MusicIcon`, `BookIcon`, `ManualIcon`, `RouteIcon`, `MediaKindIcon`, etc.).

---

## 3. Page Structure & Layout Rules

Every page in `web/src/pages/` should follow this structure:

```tsx
<section class="page-container" aria-label="Page Name">
  <header class="page-header">
    <div class="page-header-titles">
      <span class="page-eyebrow">Section Eyebrow</span>
      <h1>Page Title</h1>
      <p class="page-subtitle">Short calm description</p>
    </div>
    <div class="page-header-actions">{/* Filters or primary actions */}</div>
  </header>

  {/* Multi-column summary strip / main content */}
</section>
```

### Responsive & Accessibility Checklist
- **No horizontal scroll** at `375px` or `1440px`. Always use `minmax(0, 1fr)` in CSS grids and `min-width: 0` on flex children.
- **Desktop (`>= 768px` / `>= 1024px`):** Use multi-column grids (`2–4` stat cards across, side-by-side master/detail panels) rather than a single narrow column.
- **Phone (`< 768px`):** Stack cards cleanly; use `<Sheet>` for secondary drill-down details.
- **Local time:** Format UTC timestamps with `formatDateTime(iso, DEFAULT_TIMEZONE)` and `"YYYY-MM-DD"` dates with `formatLocalDay(date)` from `src/lib/format-date.ts`.
- **Reference legacy features:** Read `web/legacy/pages/*` and `web/legacy/components/*` to ensure all API calls, query parameters, and edge cases are preserved.
