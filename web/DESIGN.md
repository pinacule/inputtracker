# InputTracker Web UI — Design System & Information Architecture (`web/DESIGN.md`)

## Direction: Editorial (D1)

Home is a magazine spread, not a dashboard: near-black paper, warm cream ink,
system serif display numerals and small-cap sans labels. One theme accent marks
actions and selection; category stacks use cream tones and listening/short-form
hatching, with explicit category names in the entry list and month ledger.
Hairline rules and alignment replace cards, capsules and chip clouds.

The selected day's exact time is the headline. On phones the seven-day typographic
strip follows it, before the work list; on desktop it shares an asymmetric spread
with the headline. Norms are fine rules on the same scale, plus aligned Logged / Usual
miniatures (the existing eight-week/30-day calculation is unchanged). The month
is a full-width cadence of thin daily marks and an aligned category ledger.
A native Contents disclosure holds multi-select checkboxes and an All reset.
Date links, navigation, folded music/YouTube, short-form time, Log/Add and context
menus retain their behaviour. Motion is a four-pixel page reveal, disabled for
reduced motion. All five dark theme IDs remain; the editorial shell is scoped to
Calendar, leaving other pages' code and palettes untouched.

This direction supersedes the historical Home layout descriptions below (pills,
month card beside the day panel and category chip filtering).

## Skin: Dot (default)

The older skins are archived in `ARCHIVED_THEME_IDS` (`web/src/lib/theme.ts`): their code
and CSS stay, but they are not offered in Settings. Remove an id from that list to bring it back.


Chunky alternative to the thin skins: black canvas with a faint dot grid, every
home section as its own rounded block (#111 on #000), dot-matrix numbers and
headings (Doto), Space Grotesk body, small uppercase Space Mono labels, thick
rounded bars and tracks, entries as tiles, one red accent. Same information and
layout as the other skins; only presentation changes (`styles/themes/dot.css`).

## Skin effects layer (S0)

`SkinLayer` is mounted once in `App.tsx`. Dot has no effects loader, layers or extra
stacking context. Night City (`nightcity`), Rewind (`rewind`) and Thinker (`thinker`)
are active, dark stub skins, dynamically imported as separate effects chunks. Choose
one in Settings › Appearance, or set `localStorage["inputtracker.theme"]="nightcity"`
(and reload; substitute `rewind`, `thinker` or `dot`). Dot remains the default.

Each `web/src/skins/<id>/index.ts` exports a `SkinEffects` object with
`mount(ctx: SkinContext): () => void`. The cleanup must stop any skin-owned timers,
RAF, listeners and animations. The host guards stale async imports, aborts
`ctx.signal`, stops ambient work, removes both layers, and unsubscribes all callbacks
registered through the context on every theme switch. Use `ctx.signal` for extra
DOM listeners. Custom RAF loops must check visibility/motion, cap ambient work at
30 fps and cap phone canvas DPR at 1.5.

- `ctx.bg` and `ctx.fx` are fixed viewport elements appended to `body`, marked
  `aria-hidden="true"`, `data-skin-layer="bg|fx"` and `data-skin="<id>"`. They use
  strict containment and hidden overflow. All descendants and pseudo-elements
  have `pointer-events: none !important`. Never put controls or text in them.
- Effect-enabled skins isolate the body stack: wallpaper/body background, `bg`
  at −1, regular content at auto/0, `fx` at 20, inline popovers at 30, mobile tab bar
  at 80, sheets at 100, toasts at 120 and context menus at 150. No stacking context
  is added to app content, so menus remain above the effects.
- `ctx.reducedMotion`, `ctx.finePointer` and `ctx.isPhone` are live media-query
  getters. `ctx.onVisibility(cb)` passes `true` for visible, `false` for hidden;
  `ctx.onMotionChange(cb)` passes the new reduced-motion preference. These subscribe
  to changes; read the getters/document visibility for initial state.
- `ctx.obstacles(): DOMRect[]` recomputes visible text ranges, controls, cards,
  navigation, sidebar and header bounds in viewport coordinates. Always check it
  at run time, including for event-driven effects. Full-layer background effects
  must stay behind opaque reading surfaces. Effects must never obscure text or
  controls, including after scroll/resize during their lifetime.
- `ctx.on(type, cb)` subscribes to typed `page-change` (`from/to` route IDs),
  `day-change` (`from/to` ISO date strings, `direction: -1|1`), `week-change` and
  `month-change` (both `direction`). Same-day selections emit nothing. Week arrows
  emit from WeekGraph; month changes are tracked in Calendar because MonthRhythmCard
  remounts while data loads. Initial render emits no navigation events.
  Each event also sets `html[data-skin-event]`, with `data-skin-dir="next|prev"`
  when directional, for a restartable 700 ms. Theme disposal clears the hint.
  CSS reactions must include reduced-motion overrides (shared CSS disables motion).

`ctx.ambient` is a scheduler bound to `ctx.fx`, current viewport, obstacles,
visibility and motion. `add()` returns a removal callback; `start()` and `stop()`
are idempotent. Stop removes active DOM and timers; start can reuse registrations.
Every registration waits a random `minDelay..maxDelay` before each attempt,
rechecks obstacles, and skips occupied space. Delays restart on visibility/motion
resume; active nodes are removed on pause. One effect runs across the skin by
default; `maxConcurrent: 2` permits two (hard cap), only when all active effects
also allow two. Numeric `run()` results are lifetimes in ms; promises live until
settled, including rejection. Each run receives a positioned, size-constrained,
clipped child layer; append inside it, not directly to `ctx.fx`. Keep effects
within the requested size. The scheduler removes that layer on completion or
stop; skin-owned work inside a promise must still obey `ctx.signal`/cleanup.

```ts
import type { SkinEffects } from "../types.ts";
const effects: SkinEffects = {
  mount(ctx) {
    ctx.ambient.add({
      id: "glint", minDelay: 4000, maxDelay: 9000,
      size: { width: 24, height: 24 }, prefer: "edges", margin: 12,
      run(_spot, layer) {
        const glint = document.createElement("i");
        glint.className = "my-skin-glint"; // keyframes in this skin's CSS
        layer.append(glint);
        return 800;
      },
    });
    ctx.ambient.start();
    const off = ctx.on("day-change", ({ direction }) => {
      if (ctx.reducedMotion || document.hidden) return;
      // React without an overlay: a scoped CSS rule can style this attribute.
      ctx.bg.dataset.direction = direction === 1 ? "next" : "prev";
    });
    return () => { off(); ctx.ambient.stop(); };
  },
};
export default effects;
```

`findFreeSpot({ viewport: {x,y,width,height}, obstacles, size, margin, rng,
prefer: "edges" | "anywhere" })` is DOM-free, returns a rect with `left/top/right/bottom`
or `null`, keeps margin from both obstacles and viewport edges, and tries the
perimeter first for `edges`. `rng` is injectable for deterministic tests.
`createAmbientScheduler({ clock?, rng?, ... })` supports an injected clock and
geometry/visibility/layer providers for network-free unit tests; skins normally
use the bound context scheduler instead.

Stable entrance selectors (scope to `:root[data-theme="<id>"]`): `.home-topbar`,
`.home-category-index`, `.home-day-overview`, `.home-day-entries`, `.home-week-card`,
`.home-rhythm-card`, `.ui-card` (Insights, Review and Settings sections),
`.insights-goal-item`, `.insights-otd-card`, `.library-work-card`,
`.library-work-list-row`, `.yt-topic-card`, `.review-poster`, and `.theme-tile`.
These existing hooks require no visual/DOM changes. Avoid animating layout
properties or adding a transform to a common ancestor of fixed dialogs.

Each skin worker owns only `styles/themes/<id>.css` and `styles/themes/<id>/`,
`styles/fonts/<id>.css`, `skins/<id>/`, `public/wallpapers/<id>/`,
`public/fonts/<id>/`, `public/cursors/<id>/`, its registry entry in `lib/theme.ts`
and its design section below. Font files are already imported after shared
`fonts.css`: add local `@font-face` and root/preview font stacks there. Theme CSS
uses the full Dot token structure and matching `.theme-preview[data-theme="<id>"]`
scopes; it contains no imports, font faces or remote URLs. Category tokens must
match the registry: ten distinct category solids, AA text on actual surfaces.
Set `--wallpaper` to local artwork/gradients. Cursor tokens `--cursor-default`,
`--cursor-pointer`, `--cursor-text` include their CSS fallback, e.g.
`url("/cursors/nightcity/default.svg") 3 3, auto`; Dot defines none.

Budgets enforced by `test/web-themes.test.ts`: each skin's theme CSS plus its
nested directory ≤64 KiB; each effects directory ≤60 KiB source. Each new skin's
wallpaper directory accepts AVIF/WebP/JPG/SVG/Markdown/`.gitkeep`, each image
≤400 KiB and total ≤1.5 MiB, with `CREDITS.md` when images exist. Production
wallpapers should be ≤350 KiB/2400 px desktop and ≤200 KiB/900–1200 px phone.
Fonts are local WOFF2 plus licence/`.gitkeep`, total ≤600 KiB, with a licence
when fonts exist. Cursors accept SVG/PNG/CUR/`.gitkeep`, each ≤16 KiB.
Downloaded images/fonts require source URL, author and redistribution licence in
`CREDITS.md`/`LICENSE.md`. S0 downloads no assets and adds no dependencies.

## Skin: Night City (NC)

### 1. Concept

Night City is a personal media terminal overlooking a rain-soaked anime metropolis after midnight.
Deep navy architectural shadows, cyan tube light, a few pink signs and thin holographic frames
make the world recognizable before any label is read. The existing day map becomes a city-block
readout and the month skyline resembles illuminated towers; the information and interaction stay intact.
Avoid Dot's matrix lettering, dot wallpaper, soft pill navigation, chunky rounded cards and red action blocks.

### 2. Palette and verified contrast

All hex colours are sRGB; text-bearing fills are opaque, including hover, modal and tooltip states.
Set `--bg-canvas: #050B18`, `--bg-surface: #0B172A`, `--bg-surface-raised: #122138`,
`--bg-subtle: #182B43`; use subtle for `--bg-muted` too, avoiding an unverified fifth fill.
Primary text `#EAF8FF`, secondary `#B9D3E8`, muted/placeholder `#94B1C9`; never lower text opacity.
Primary accent/link `#67E8F9`, hover `#9DF2FF`, secondary accent `#FF8DE3`, warning `#FFD178`.
Accent-subtle background `#102D36`; primary buttons and selected solid controls use dark ink `#050B18`.
Borders: subtle `#263D58`, default `#385772`, strong/control boundary `#6D94B4`.
Focus ring `#9DF2FF`, 2px solid, 3px offset; reserve room so overflow cannot clip keyboard focus.
Glow colours: cyan `#23D8F3`, pink `#F467CF`, ice `#B6F5FF`; decorative only, never text shadows.
Use `0 0 14px #23D8F326` for idle frame glow, `0 0 20px #23D8F33D` on hover.
Success uses book fg/bg; errors use YouTube fg/bg plus English error text/icon, never colour alone.

Contrast below is `(Llighter + .05)/(Ldarker + .05)`, with linearized sRGB luminance.
Each vector is **canvas / surface / raised / subtle**, in that order, rounded to two decimals, `:1`.
The reproducible calculation and assertions are in `.task/nightcity-contrast.py`.

- Primary `#EAF8FF`: **18.14 / 16.55 / 14.90 / 13.22**.
- Secondary `#B9D3E8`: **12.69 / 11.58 / 10.42 / 9.24**.
- Muted `#94B1C9`: **8.80 / 8.03 / 7.22 / 6.41**.
- Cyan/link `#67E8F9`: **13.57 / 12.38 / 11.14 / 9.89**.
- Pink `#FF8DE3`: **9.53 / 8.69 / 7.82 / 6.94**.
- Amber `#FFD178`: **13.72 / 12.51 / 11.26 / 9.99**.
- Focus/hover `#9DF2FF`: **15.53 / 14.17 / 12.75 / 11.31**.

Category tokens below are **fg / bg / border / solid**; copy exactly to the registry and CSS.
Use fg on bg for chips, fg on base surfaces for legends, solid for chart marks without light labels.
If a solid fill needs a label, use ink `#050B18`; do not use white on these luminous fills.
Category-fg vectors cover every base surface; the last two values are **fg on own bg / ink on solid**.

- Anime: `#C7B5FF / #211B38 / #7967A8 / #B69AFF`; **10.76 / 9.81 / 8.83 / 7.84**; **8.98 / 8.48**.
- Series: `#78E5F5 / #102D36 / #3F8697 / #42CADD`; **13.42 / 12.24 / 11.02 / 9.78**; **9.87 / 10.05**.
- Film: `#FFD37C / #302818 / #A18546 / #E9B846`; **13.92 / 12.70 / 11.43 / 10.14**; **10.30 / 10.69**.
- Book: `#A5E79A / #1B2D25 / #648C66 / #7CCB72`; **13.58 / 12.39 / 11.15 / 9.89**; **10.01 / 9.97**.
- Audiobook: `#B3C6FF / #1D263D / #687DB6 / #8FA8F5`; **11.65 / 10.63 / 9.57 / 8.49**; **8.90 / 8.51**.
- YouTube: `#FFAAA1 / #341F28 / #A86F70 / #F57F79`; **10.79 / 9.84 / 8.86 / 7.86**; **8.39 / 7.68**.
- Podcast: `#FFC18A / #33251E / #A9815D / #F4A25E`; **12.41 / 11.32 / 10.19 / 9.04**; **9.30 / 9.53**.
- Music: `#FF9ACD / #321F35 / #A96892 / #ED74B8`; **10.08 / 9.19 / 8.27 / 7.34**; **7.78 / 7.30**.
- Shortform: `#D5E87D / #292E1B / #899754 / #BCD45B`; **14.68 / 13.39 / 12.05 / 10.69**; **10.44 / 11.90**.
- Other: `#C7D0DB / #242A34 / #7D8998 / #9EADBF`; **12.62 / 11.51 / 10.36 / 9.19**; **9.26 / 8.60**.

Primary/secondary/muted also pass on every category bg; worst cases are **12.91 / 9.03 / 6.26**.
Their primary / secondary / muted ratios on each category bg are:
anime **15.15 / 10.59 / 7.35**; series **13.35 / 9.34 / 6.47**; film **13.43 / 9.39 / 6.51**;
book **13.37 / 9.35 / 6.48**; audiobook **13.87 / 9.70 / 6.72**; YouTube **14.11 / 9.87 / 6.84**;
podcast **13.60 / 9.51 / 6.59**; music **14.01 / 9.79 / 6.79**; shortform **12.91 / 9.03 / 6.26**;
other **13.31 / 9.30 / 6.45**. Cyan on accent-subtle is **9.99**, ink on primary cyan is **13.57**.
Keep category names, totals and existing hover/focus details: nearby hues must not be the only key.
Map cell hover changes a border/accent rail, not fill opacity; override the inherited mixed-colour fill.
Never dim an entire control or chart group with opacity when it contains text; dim decorative marks only.

### 3. Fonts

- Display: **Rajdhani**, Indian Type Foundry, weights **600, 700**, SIL OFL 1.1.
  [Source and licence](https://github.com/google/fonts/tree/main/ofl/rajdhani).
  Squared, condensed strokes suggest a transit terminal; headings 28–44px, phone 24–32px, line-height 1.12.
  Use sentence/title case for existing page headings; small section labels may be uppercase, tracking .08em.
- Body: **Barlow**, Jeremy Tribby, weights **400, 500, 600**, SIL OFL 1.1.
  [Source and licence](https://github.com/google/fonts/tree/main/ofl/barlow).
  Its open, practical shapes keep long work descriptions readable; 16px/1.5 body, 14px/1.4 supporting text.
- Numbers: **IBM Plex Mono**, Mike Abbink/Bold Monday, weight **500**, SIL OFL 1.1, copyright IBM.
  [Source and licence](https://github.com/google/fonts/tree/main/ofl/ibmplexmono).
  Fixed-width aligned readouts, `font-variant-numeric: tabular-nums`; hero 64–88px, phone 44–56px.
- Labels/mono: **IBM Plex Mono 400**, same source/licence; 12px/1.4 labels and chart ticks, tracking .04em.
  Never use condensed display type for paragraphs or tiny data, and never synthesize a missing 900 weight.
- Decoration only: **Noto Sans JP 700**, Google/Adobe, SIL OFL 1.1.
  [Source and licence](https://github.com/google/fonts/tree/main/ofl/notosansjp).
  Subset to the unique glyphs in `夜の街雨東京未来電脳営業中光空駅`; signs may read `夜の街`, `雨`, `東京`,
  `未来`, `電脳`, `営業中`, `電光` or `空駅`, with `aria-hidden="true"`; these are fictional scenery only.
  Real buttons, navigation, category names, axis labels and statuses remain English; no fake Japanese UI labels.
- Ship local WOFF2: Latin + Latin-ext for the three Latin families, only the above Japanese glyphs for JP.
  Target Rajdhani 90KB, Barlow 180KB, Plex 140KB, JP 15KB; total target 425KB, hard cap 600KB.
  Use `font-display: swap`, metric-compatible sans/mono fallbacks and reserved line boxes; avoid late size changes.
  Include upstream OFL texts/copyrights in `web/public/fonts/nightcity/LICENSE.md`; honour reserved font names
  if modifying font name tables. Build-time subset acquisition is allowed; no runtime Google Fonts requests.

### 4. Cards, controls and page coverage

Retain the existing shell widths, page order, chart geometry and responsive breakpoints; skin via tokens/selectors.
Main cards: opaque surface, 1px default border, radius 2px; raised cards/popovers use raised, radius 3px.
Give the decorative frame an 8px diagonal cut at top-right and bottom-left, plus 12px cyan corner brackets.
Draw cuts/brackets in an inset pseudo-element, not a clip-path on the interactive card or its focus ring.
Use `0 12px 32px #02061199` shadow plus the small cyan glow; no backdrop-filter or transparent reading glass.
Internal separators are 1px subtle rules; title bars use raised, a 2px cyan start rail and 12px English labels.
Padded reading regions stay opaque to the edges; any frame texture belongs only in the empty frame gutter.
Keep each card's content steady while its independent frame appears to power on; never blink real text.
Primary button: cyan fill/dark ink, 3px corners, 1px cyan border; secondary: raised/primary/strong border.
Destructive button uses error fg/bg; hover raises decorative glow, press changes fill to subtle, no layout movement.
Chips: compact 3px rectangles, category fg/bg/border; selected adds a 2px underline/check without resizing.
Inputs/selects: surface fill, primary value, muted placeholder, strong boundary; focus ring outside, no animated caret.
Tabs: rectangular transparent segments over an opaque rail; active cyan underline and primary label, no capsule.
Desktop sidebar: opaque surface, 1px strong right edge; active item has subtle fill and 3px cyan left marker.
Keep the InputTracker identity/English route names; decorate vacant sidebar bottom with one small fictional sign.
Phone bottom tab bar: opaque surface, strong top rule, cyan active icon/underline, English labels, safe-area padding.
Library covers keep natural artwork colours; 2px corners, thin frames, readable titles on separate opaque bands.
Library list rows use ruled raised hover backgrounds; preserve sorts, category toggles and Covers/List behavior.
Work page: framed hero/cover, opaque description and history panels, mono metric strip; artwork viewer stays unchanged.
Review cover strips use a narrow cyan baseline and rectangular rating badges, never recolour actual cover art.
Settings groups, Search results, Add steps, sheets, menus, toasts and validation share these control/surface rules.
Search highlights use cyan/dark ink; keyboard focus and error messages stay visible above all decoration.

### 5. Charts

Final data is exact throughout: no perspective, decorative fake chart towers or invented activity; first-mount growth
and the brief aria-hidden HUD number decode are presentation only, with exact accessible values retained throughout.
Home day map: keep nested category/item time areas, 3px group gaps and 2px cell inset from `DayMap.tsx`.
Use 2px category frame corners, opaque category bg per cell, fg labels and primary totals; no solid bright cell fill.
Use category solid for a 2px side rail; item subdivisions use a 1px category border; tiny cells retain their tooltips.
Enable the existing day-map presentation for this skin; preserve context menus, links and keyboard-focus details.
Last-7-days bars: upright rectangular light towers, 1px corners, existing proportional category stack heights.
Keep 1px navy separators inside stacks; selected day gets a cyan bracket and underline, not a rounded backdrop.
Norm markers remain thin strong-colour rules on the same scale; legend labels/totals are always visible.
Month card: daily stacked skyline, 1px corners, maximum 10px bar width inside existing columns; zero is a tiny dash.
Selected date uses a cyan bottom bracket; keep totals, category ledger/share and previous-month comparison unchanged.
Do not assign month-only records to a day or treat missing data as zero; preserve existing messages.
Insights KPI strip: 2px ruled divisions, Plex numbers, cyan 2px sparklines with square terminal dots, no blurred line.
Stacked series: category solid fills at full opacity, 1px canvas separators; keep legend names, dates and totals.
Category share: the existing bar/donut geometry, square bar ends and clean ring segments, labelled legend alongside.
Punch card: keep circles and their area scale, solid cyan with strong outline; zero cells hollow, no decorative hits.
52-week heatmap: 2px corners; fills `#122138`, `#174353`, `#216A79`, `#3198A6`, `#67E8F9` low to high.
Use `#6D94B4` outlines for occupied low-level cells; no text inside coloured cells; retain dates/values in details.
Top lists/Most played: square-ended category bars, mono ranks and durations, opaque rows; keep plays/time selectors.
Review: reuse the same stacked/share/punch styles; month/year charts and cover strips share category colours.
Gridlines `#263D58` at 1px, axes/ticks muted at full opacity, baseline `#6D94B4`; no glow on data or gridlines.
Tooltips: opaque raised, 1px strong border, 3px corners, primary title/secondary detail/mono value; viewport-clamped.
Use current keyboard/touch tooltip behavior; do not add a hover-only dependency or hide units to make space.

### 6. Wallpaper direction and licensed sources

Choose the **freely licensed photo fallback**, stylised offline toward an anime background with broad navy shadows,
cyan light bloom, restrained magenta highlights, softened fine detail and a few original graphic sign panels.
Do not claim these are anime illustrations; no anime/film/game frame or recognizable franchise imagery is used.
Six concrete licensed photographs, direct files, dimensions and reviewed previews are in `.task/wallpaper-candidates.md`.
Desktop primary: Base64's **Hong Kong Night Skyline non-HDR** (4670×2000), **CC BY-SA 3.0**: an elevated panorama
of dense towers, harbour light and low cloud. It wins over Foggy Night's street-level alley because the layered
high-rises and cloud bank establish a whole neon city immediately; Minato's night skyline is a quieter reserve.
Phone primary: Romain Guy's **Alone in Tokyo III** (3805×5707), umbrella silhouette and wet cyan pavement.
Both have been viewed; export only after replacing legible business names/logos with plain dark panels/fictitious signs.
Avoid faces as focal points; the skyline has none at this scale, and phone retains only the anonymous back-facing silhouette.
The candidate list records less suitable alternatives and why; do not randomly choose a different image per visit.
Grade recipe: slightly simplify detail, cool shadows to navy, retain cyan lights, reduce amber saturation by about 50%,
then replace signage locally; retain architectural edges/reflections instead of applying a flat blue filter alone.
Desktop crop: central 3200×2000 region (x≈735–3935), then resize to ≤2400×1500; keep the cloud bank at the top
and the main tower group near 52% x/60% y; test at 1440×900 with the sidebar covering the left edge.
Phone crop: 9:19.5 from the portrait, aim umbrella at 52% x/42% y, reflection along the bottom; export 1080×2340.
Stack: canvas → local image → uniform `#050B18` scrim at .58 desktop/.66 phone → navy bottom vignette
(.10 top to .60 bottom) → original flat SVG skyline/signs → continuous rain/ambient bg → opaque app surfaces → masked fx.
Code-drawn foreground: two parallax-free SVG silhouette planes, far `#102238` and near `#071221`, rooted at the
bottom and side edges; flat stepped rooftops/antennae, 8–12 towers desktop / 4–6 phone, no perspective or outlines.
Bottom roofs reach 8–18vh, side towers ≤10vw desktop/6vw phone; place 2×4px cyan/amber window rectangles in sparse
fixed patterns and 2–3 original neon signs (`夜の街`, `電脳`, `未来`) in the side architecture, all behind content.
Keep shapes crisp like painted anime cels; a static navy-to-transparent haze gradient separates the two planes.
Use one local/generated SVG (target ≤12KB, included in CSS/JS budget), not another raster wallpaper or copied city art.
Silhouettes/windows stay still; only eligible neon signs animate through the scheduler. Scale/crop the same drawing
on phone, keep it clipped to the viewport, and retain it in the no-photo fallback so the world reads as anime city art.
Expose wallpaper in gutters and page edges, not through labels; no runtime parallax or backdrop blur.
Fallback without image: navy linear gradient plus the same flat skyline, window patterns and neon signs.
Export local WebP: desktop ≤2400px wide/350KB; phone ≤1080px wide/200KB, each below the 400KB per-file cap.
Ship one desktop and one phone asset, target ≤550KB combined; no duplicate AVIF/fallback unless needed.
Hard wallpaper total ≤1.5MB including any preview derivative; reuse the desktop image for the Settings miniature.
Use responsive source selection so a phone never fetches the desktop wallpaper too; no timed wallpaper slideshow.
Build worker must record each author/source/licence link and grade/crop/sign replacement in
`web/public/wallpapers/nightcity/CREDITS.md`; credit Base64 and distribute the edited Hong Kong image under
CC BY-SA 3.0, with the licence link and changes stated; phone image remains CC0. Research previews stay in `.task/`.

### 7. Interaction and transition animation

Shared ease-out `cubic-bezier(.16,1,.3,1)`, ease-standard `cubic-bezier(.2,0,.2,1)`; no spring overshoot.
Page change: new panel translates 6px up to rest over 280ms ease-out; its opaque content is readable immediately.
Card entrance: frame-only 420ms power-on, 40ms stagger for at most six cards, all finished within 660ms.
Make it a visible holographic flicker: frame stroke/segments brighten, dip to .15 at 80–120ms and 230–270ms,
then settle to 1 by 420ms; two quick dips, 1px decorative segment offsets and cyan glow, confined to the thin frame.
During the same 420ms, sweep a faint 2px scanline through empty card padding only, masking out text/controls
and their 8px clearance; never sweep the reading body or flash the full card background.
The actual card background, text and controls never inherit that opacity; below-fold frames enter once per mount.
Hover: frame/glow colour 140ms ease-standard; fine-pointer button hover underline extends over 160ms.
Press: inset rail brightens for 80ms; avoid scaling touch targets or translating real controls.
Focus: immediate solid ring, optional decorative corner expansion 120ms; never delay or pulse the focus indicator.
Hero numbers (Today time, week total, KPIs): 280ms HUD decode on first mount/value change, using an aria-hidden
decorative copy in the reserved number box; scramble digit positions only at 35ms steps, keeping units/spacing fixed.
The real exact text stays in the DOM for screen readers, visually clipped only during the decode; copy ends on the
exact value at 280ms, then is removed and real text restored. Do not add live-region announcements or change values.
If copy placement cannot be measured safely, use a 280ms scanline wipe instead; never delay the exact accessible text.
Other number changes retain the 220ms underline sweep. Draw sparklines with stroke-dashoffset over 420ms ease-out.
First mount: week bar stacks and month skyline grow from `scaleY(0)` to `scaleY(1)`, bottom transform-origin,
**380ms** ease-out with **30ms** per-column stagger (week ≤560ms; 31-day month ≤1280ms).
Transform the bar stack only, not labels/totals/norm markers; reserve final chart dimensions, no layout shift.
Keep outer date hit areas available and final hit geometry settled by animation end; never replay growth on hover.
Day-map cells scan in with a cyan 2px sweep line traversing left-to-right over **500ms**, clipped to map tile fills
and excluding label/number glyph bounds, focus rings and controls; exact areas/hit targets are present immediately.
Use the decorative chart frame draw-in for 360ms alongside these; first-mount chart timelines run independently
of S0's 700ms event attribute, so the full month stagger is not cut short. Later range changes use the rails below.
Day/week/month switch: outgoing decoration clears in 100ms, new frame rails sweep 260ms in the supplied direction;
data changes normally. `next` moves the rail left-to-right, `prev` right-to-left; no sliding page-width panels.
Loading skeletons: opaque raised blocks, one low-contrast 1000ms sheen confined inside placeholders, no text shimmer.
Stop loading decoration after data loads; continuous rain and occasional ambient effects continue. Retain current
error/retry UI and keep dimensions reserved to prevent shifts.

### 8. Ambient loops and placement

All decoration is silent and click-through. **Continuous rain is the constant atmosphere, outside ambient slots**:
draw it in `bg` behind the opaque cards, spread across the full viewport so every gutter/card edge sees falling rain.
Use **30–60 simultaneous streaks desktop at 30fps / 15–25 phone at 20fps**, 1px wide, 12–28px long, falling 10°,
opacity .12–.24 and 900–1400ms travel. Keep light rain running throughout visible/non-reduced-motion use.
Every random **20–40s**, a heavier **6s burst** raises counts to 75–90 desktop / 30–40 phone and opacity ≤.32,
then returns to light rain; no rain-free interval. Opaque cards naturally occlude all background streaks.
Front rain detail: every 10–18s pick one visible card, bead 1–3 drops (phone 1–2) on its frame and run them
20–60px down its border over 900–1400ms; add 2–3 tiny 2px splash ticks on its top frame edge for 160ms.
Render these in `fx`, clipped to an explicit 1–2px frame-stroke mask (not the card interior or padding),
subtract focus outlines and controls touching the border; skip if a clean frame segment is unavailable.
Rain/front detail share the rain controller, outside the slots, with at most one card carrying front drops at once.
The ambient scheduler separately wakes every random 8–16s and enforces each effect's cooldown; at most
**two scheduled effects desktop, one phone**, in addition to rain. All six scheduled types below also run on phone.
Validate each scheduled effect's entire swept bounds against text/controls/cards expanded by 20px (12px phone),
plus header/sidebar/bottom navigation/dialogs; if no free rectangle fits, skip rather than draw over content.

- **Neon sign buzz:** one original `夜の街` or `電脳` sign in a vacant wallpaper patch, 32–64px tall (phone 22–36px).
  Every 24–40s, 1.4s long; two slow uneven brightness dips (.45→.85), no full on/off flashing.
- **Passing drone light:** two 3px cyan points and a 24px fading tail along a free upper/right edge strip.
  Every 35–60s, travel 3.2s; no drone silhouette over the page, phone path ≤100px.
- **Train window ribbon:** 4–7 amber 6px window marks glide along a free horizontal wallpaper strip near an edge.
  Every 45–75s, 4s; desktop swept width ≤220px, phone ≤100px; skip if navigation occupies that edge.
- **Puddle ripple:** two thin cyan ellipses expand 12→64px over 1.8s in a free lower wallpaper patch.
  Every 18–32s, opacity ≤.22, phone diameter ≤36px; no ring under a button or chart value.
- **Hologram ad glitch:** a fictional sign's decorative corner breaks into three 2px-offset slices for 600ms.
  Every 40–65s, one event without repeats; affect only that sign, never headings, artwork, values or labels.
- **Rooftop beacon:** a fixed 4px cyan point in free top-edge wallpaper breathes once over 2.4s.
  Every 28–48s, opacity .20→.65→.20; phone 3px, no high-contrast flash or new fake status indicator.

If only narrow gutters are free, render scaled rain/beacons there; do not force a sign or train into a card.
No ambient effect sits over text even though `pointer-events: none`; visual obstruction is still obstruction.

### 9. Cursor

Fine pointers with hover only: local 32×32 cursors, native fallback always; coarse/touch uses platform cursors.
Normal: angular 18px arrow, navy core, 1.5px ice outline, tiny cyan heel notch, hotspot **3 2**.
Pointer: 20px cyan-outlined arrow with two corner brackets around its heel, dark core, hotspot **3 2**;
retain the obvious arrow tip so link targeting is clear. Fallback is `pointer`, never `none`.
Text: slim 18px I-beam, ice stem/cyan end caps with dark 1px outline, hotspot **16 16**, fallback `text`.
Tokens: `--cursor-default`, `--cursor-pointer`, `--cursor-text`; PNG or SVG cursor URLs plus native keyword.
Optional heel glow: one 6px translucent dot 10px behind the tip, fades after 100ms, no particle trail over text.
Suppress that dot whenever its bounds touch protected content, on text input/selection, reduced motion or hidden tab.
Keep normal resize/drag/not-allowed system cursor states; no pointer lock or replacement cursor DOM hiding the native tip.

### 10. Signature effect — the city terminal comes online

On page arrival, cyan bracket segments draw around the opaque cards while a fictional sign powers up in the
nearest free gutter; the rain briefly catches the same light, making the panels feel suspended above a wet street.
Sequence: 0–180ms corner rails extend; two frame dips and the padding scanline finish by 420ms;
420–660ms sign glow settles while the city behind it keeps raining and a frame-edge bead can catch the light.
It reuses the entrance/scheduler/rain controllers, consumes a scheduled slot for the sign only and adds no new overlay.
Content is readable and actionable throughout; if no gutter fits, the card-frame sequence alone is the signature.

### 11. Settings › Appearance preview tile

Use the existing native radio/label structure and `.theme-preview[data-theme="nightcity"]` token scope.
Miniature shows the blue Hong Kong tower crop and flat SVG foreground behind a 2px-corner navy panel, cyan top rail, Rajdhani heading,
Plex `2h 48m` readout and the existing four category bars; one tiny static Japanese sign at the image edge.
Keep visible skin name **Night City** and description **Rain-lit skyline · neon HUD** in English.
Selected state retains the actual radio/check and focus behavior; add cyan boundary, never rely on glow alone.
The tile is static, loads no effects controller and uses no additional wallpaper download.

### 12. Phone at 390px

Keep existing single-column order and native map sizing; reduce panel padding to 16px and frame brackets to 8px.
Retain category/entry/tooltips and date selection; do not make the day map a separate scrollable dashboard.
Keep 44px navigation/control targets, wrapping chip rows and safe-area bottom spacing; no horizontal page scroll.
Titles can wrap; fixed-width numbers stay within the card, month total moves to the existing second line if needed.
Keep opaque mobile header/tab bar, all six scheduled ambient types, continuous rain/front edge drops, lively chart/HUD
entrances, wallpaper, flat skyline and decorative signs. Scale scheduled loops to free gutters, one at once plus rain;
draw rain/ambient work at **20fps**, DPR **≤1.5**, no full-resolution blur; use the phone rain counts above.
Only phone wallpaper is fetched; local fonts are shared with desktop, preload at most body regular + number medium.
Use one bounded canvas or a small recycled sprite pool; no individual DOM node for every raindrop.

### 13. Reduced motion and quiet states

`prefers-reduced-motion: reduce`: no card flicker, sweeps, translation, rain, ambient loops, cursor dot,
number decode/copy, chart growth/scans/drawing, front beads/splashes or skeleton sheen; show exact real text immediately.
Keep static wallpaper, flat skyline/window patterns, fictional signs, cyan brackets, palette, fonts and cursor shapes.
Focus appears instantly; hover/press colours change instantly. Never substitute a slower moving loop.
Hidden tab: cancel timers/RAF, remove transient sprites and suspend animations; on visibility resume light rain immediately,
schedule bursts/ambient effects with fresh random delays, never replay entrances/backlogs. Unmount removes all resources.

### 14. Technical plan and acceptance

Build task only: CSS in `web/src/styles/themes/nightcity.css` (optional owned subdirectory); font faces in
`web/src/styles/fonts/nightcity.css`; assets in the skin's local wallpaper/font/cursor directories.
CSS owns tokens, typography, component/chart frames, growth/flicker/scan keyframes, static preview, event selectors
and motion media rules; use masked decorative overlays for map/padding scans and frame-edge rain details.
Scope every live selector to `:root[data-theme="nightcity"]`; only preview rules also match its preview scope.
Override inherited Dot-specific map visibility/rounding through Night City selectors, without editing Dot or shared pages.
JS in `web/src/skins/nightcity/`: effects controller, continuous rain/burst/front-edge renderer, free-spot scheduler,
HUD decode copies/cleanup, static original SVG skyline creation and optional cursor glow.
Use S0's real exported effects-layer API when available; do not invent a second global overlay or modify page behavior.
Mount wallpaper/SVG skyline/rain/signs in fixed **bg** behind content; use **fx** above content for masked free-space
sprites/cursor glow and tightly stroke-clipped card-edge beads/splashes. Local padding/map scans and HUD copies are
aria-hidden presentation attachments only; all effect layers/descendants remain `pointer-events: none` and decorative.
Clip effect buffers to viewport bounds; avoid negative z-index traps, CSS layout effects and sideways overflow.
Subscribe to `page-change`, `day-change`, `week-change`, `month-change`; route CSS through
`html[data-skin-event="…"][data-skin-dir="next|prev"]`, which S0 retains for **700ms**.
Event-driven transitions finish within 660ms of that window; independent first-mount month growth may last 1280ms.
Events need no new API/data calls; real values never come from the decorative number copy.
Free-spot placement considers rendered text ranges, all controls/links, opaque panels and open overlays; remeasure
on resize/scroll/route changes at most once per frame, cancel any active path that becomes occupied.
Use IntersectionObserver for visible frame entrances, ResizeObserver for bounds; disconnect both on teardown.
Reuse S0 scheduling/visibility primitives where supplied; cap desktop ambient RAF at **30fps**, phone at **20fps**.
Rain remains active while visible; skip idle work in other controllers, cap DPR (desktop 2, phone 1.5), cache image
decoding/static geometry and pause all moving effects on hidden tab. Reduced motion creates no rain/decode loops.
Budgets: skin CSS **≤64KB**, effects JS **≤60KB**, wallpaper set **≤1.5MB**, each image **≤400KB**,
with stricter selected export targets **350KB desktop / 200KB phone**; fonts **≤600KB** total, cursors target ≤12KB.
No new dependencies; no CDN/runtime external assets; production credits include every downloaded asset and licence.
Check Home, Library, work page, Insights, Review, Settings, Search and Add at 1440px and 390px, plus keyboard/reduced motion.
Build worker must run Dot and Night City screenshot sweeps and inspect PNGs: overflow 0, blocked count no worse than Dot;
inspect animation frames for protected text and controls, then pass `bun run check` and `bun run build:web`.
This task delivers the brief and inspected source previews only; effects implementation and live Night City screenshots
belong to the build task, after S0's shared effects API lands.

## Skin: Rewind (RW)

### 1. Chosen direction — blue VCR menu on a CRT

**Manager choice: A / blue VCR menu.** The blue screen and yellow selection strips are the most instantly recognisable VHS image. The black/mint prototype read too close to Dot, and the warm prototype overlapped Thinker's firelight. A VCR menu is displayed on a CRT, so the chosen skin keeps A's palette and square geometry with B's fine scanlines, subtle outer RGB frame glow and dark screen-edge vignette. B and C were comparison prototypes only; neither is shipped. There is one `rewind` skin, no look attribute, localStorage look preference or public look picker.

Rewind presents a personal archive through a paused VHS deck: cassette compartments, crisp VT323 OSD headings, transport markings and Share Tech Mono counters. A brighter VCR-blue photograph of real vintage televisions establishes the physical world in gutters. Opaque blue reading surfaces keep every English label and data value clear. Preserve the existing pages, controls, chart geometry, data ordering, focus and navigation behaviour; decorative `PLAY`/`SP` text is never a replacement action or recording claim. Avoid Dot's matrix typography/pill geometry and cyberpunk HUDs.

The current RW-b foundation is **entirely static**. Sections 7–10 describe future RW-c motion/cursor work; section 11 describes future RW-d tile polish.

### 2. Palette and measured contrast

All text-bearing substrates are opaque. Canvas/surface/raised/subtle map to `--bg-canvas/--bg-surface/--bg-surface-raised/--bg-subtle`; `--bg-muted` equals subtle. Wallpaper is visible only in gutters and empty margins.

- Canvas **#07164C**, surface **#0B215B**, raised **#102B68**, subtle/muted **#163777**.
- Primary **#F4F8FF**, secondary **#D5E2FF**, muted **#B7CAF1**, all at opacity 1.
- Accent **#FFDF6D**, hover **#FFEB9C**, secondary accent **#91DDFF**, dark action ink **#07164C**. Accent-subtle is surface; accent-border is strong border.
- Subtle/default/strong borders **#3D5F9E/#5F84C8/#9ABBFF**; focus **#B9DEFF**, solid 2px ring with 3px offset. Necessary controls use the strong outline; decorative rules may use default/subtle. Never use glow as the focus cue.
- Outer bezel light is restrained RGB **#FF6C9E/#77FFAD/#70BCFF**, outside reading areas; it does not recolour glyphs or chart fills. Double blue rules remain **#537FFF**.
- Modal backdrop `rgba(0,0,0,.82)`, body = raised. Decorative future REC dot **#FF9587**, letters = primary. No blend mode or translucent wash on content.
- Base WCAG contrast vectors are **canvas / surface / raised / subtle**: primary **16.05/14.26/12.58/10.68**, secondary **13.15/11.68/10.30/8.75**, muted **10.37/9.21/8.12/6.89**; accent **13.05/11.59/10.23/8.68**, secondary accent **11.39/10.12/8.93/7.57**. Dark ink on accent/hover **13.05/14.34**. Default control border worst case **3.04**; focus worst case **8.10**.
- Static foreground scanline ink is black **.06**, one pixel every **3px**. The future white rolling band is capped at **.04**; no band currently exists. Effective combined future content noise must stay within **.07 black/.04 white** using normal source-over composition. Conservative contrast checks darken the light glyph and brighten its background at opposite extrema. The original A audit at both caps gives primary/muted minima **8.18/5.32**, category minimum **4.97**, and strong-border minimum **4.58**. Re-audit token or overlay changes; opacity never lowers real text contrast.

Ten distinct category families are retained. Each tuple is **fg / opaque chip bg / border / unlabelled chart solid**:
- anime: `#D2B6FF / #271E3A / #9874D0 / #B185F2` — violet.
- series: `#A5E7F5 / #172F39 / #569DAF / #65C8E3` — cyan.
- film: `#FCE4A4 / #382D19 / #B2924D / #E4BE61` — straw gold.
- book: `#B9E9BA / #203223 / #739C6A / #8FC787` — sage green.
- audiobook: `#C1CAFF / #21283F / #7887C7 / #8E9FEF` — periwinkle.
- youtube: `#FFB5AD / #3F2423 / #B86E67 / #F28F83` — coral red.
- podcast: `#FFD0A2 / #3B2A1E / #B28455 / #E7A16D` — apricot orange.
- music: `#F2BADA / #382133 / #AC6A96 / #DD8FBC` — rose pink.
- shortform: `#AED9FF / #192B41 / #648BC1 / #78AFF0` — sky blue.
- other: `#DBD5C7 / #2C2C2A / #918D81 / #B6B1A5` — neutral putty.

Category fg contrasts below are **own chip bg; canvas/surface/raised/subtle**:
- anime: **8.91; 9.67/8.59/7.58/6.43**.
- series: **10.22; 12.50/11.10/9.79/8.31**.
- film: **10.77; 13.66/12.13/10.70/9.08**.
- book: **10.01; 12.56/11.16/9.84/8.35**.
- audiobook: **9.14; 10.71/9.52/8.40/7.13**.
- youtube: **8.38; 10.15/9.01/7.95/6.75**.
- podcast: **9.63; 12.05/10.70/9.44/8.01**.
- music: **8.94; 10.43/9.26/8.17/6.94**.
- shortform: **9.68; 11.54/10.25/9.04/7.67**.
- other: **9.56; 11.69/10.38/9.16/7.77**.

Use category names and stable legend order as well as colour. Never put primary/light text on category solids; chips use their audited fg/bg and visible checks/outlines. Status success/warning/danger/info map to book/film/youtube/series fg/bg/border. Existing labels/icons, selection, Search highlights, errors and ratings stay on audited substrates.

### 3. Fonts

- **Display / OSD:** `VT323`, Peter Hull / VT323 Project Authors, regular **400**, SIL **OFL 1.1**. Source https://fonts.google.com/specimen/VT323 ; upstream and licence https://github.com/google/fonts/tree/main/ofl/vt323 . Its continuous terminal strokes evoke video OSD, unlike Dot's disconnected matrix dots; use at 28–48px for headings and 20–24px for decorative stamps, never for paragraphs or tiny axis labels.
- **Body:** `IBM Plex Sans`, IBM / Mike Abbink and Bold Monday, **400/500/600**, SIL **OFL 1.1**. Source https://fonts.google.com/specimen/IBM+Plex+Sans ; upstream and licence https://github.com/google/fonts/tree/main/ofl/ibmplexsans . Open counters and neutral hardware-manual proportions keep long work titles, settings and descriptions readable; body 16px/1.5, metadata 14px/1.45.
- **Numbers and labels/mono:** `Share Tech Mono`, Carrois Type Design / Ralph du Carrois, **400**, SIL **OFL 1.1**. Source https://fonts.google.com/specimen/Share+Tech+Mono ; upstream and licence https://github.com/google/fonts/tree/main/ofl/sharetechmono . Squared rounded-counter forms feel like a tape deck rather than a pixel clock; large totals 48–72px, compact totals 22–32px, real labels/axes at least 13px. Use tabular figures, lining numerals, zero tracking on numbers and .04em on short labels.
- Role: VT323 for headings/OSD, IBM Plex Sans for body and small work titles, Share Tech Mono for counters/short labels. Uppercase only short heading/label treatments; preserve mixed-case work titles. No handwriting font is shipped.
- Counter *appearance*, not new formatting: retain `4h 12m`, decimal ratings and existing date strings; do not convert durations to fake timestamps or add imaginary seconds. Colons are allowed only in decorative transport artwork with no data claim.
- Fallback stacks: display `VT323, ui-monospace, monospace`; body `IBM Plex Sans, system-ui, sans-serif`; mono `Share Tech Mono, ui-monospace, monospace`. Keep form text 16px on phones; avoid global pixelated font rendering.
- Build-time download only: local WOFF2, upstream Latin + Latin-ext subsets, `font-display: swap`, no CDN/import at runtime. Include OFL text and source/author/weights in `web/public/fonts/rewind/LICENSE.md`; respect reserved names `Plex` and `Share` when modifying fonts (prefer upstream distributed subsets). Preload body regular and counter only. Plex and VT323 ship upstream Latin + Latin-ext subsets; upstream Share Tech Mono only provides Latin, so extended Latin uses Plex Latin-ext. Five WOFF2 files total 124,484 bytes. Target total ≤300KB, hard cap ≤600KB.

### 4. Cards, shapes and page coverage

- Preserve Dot's information layout and ordering (including the day treemap and desktop/phone week-summary placement), not its visual geometry. Use the existing containers; never rebuild the Home layout or alter a treemap's measured rectangles.
- Shared shell: inset cassette frame, 1px structural borders, 2px active/control strokes, 3px inner separation, restrained 6px physical-looking outer bezel. Header, sidebar, bottom nav, chart labels and page-reading bodies are opaque surface; wallpaper is visible only through gutters/unused space.
  - Chosen geometry: radii xs/sm/md/lg/xl/full **0/0/2/2/2/2px**; square blue frames, two 1px cyan/blue rules 3px apart, shadow `0 8px 24px #00000055` plus low-alpha outer RGB glow; double blue rules remain sharp; yellow rectangular active strip with dark ink. No raised OS-window bevels.
- Title bars use existing card headers, opaque subtle background, 10px vertical/14px horizontal padding where space permits, 1px bottom rule. Short decorative `PLAY`, `SP` or rewind chevrons sit in existing empty header padding; remove them if the heading/actions would wrap into them.
- Buttons: rectangular 44px minimum targets, primary solid accent/dark audited ink, secondary raised/primary ink/default border; disabled text muted at opacity 1. Preserve behaviour; no button is renamed `REC` or `PLAY`.
- Chips: 2px corners, opaque category bg/fg, square 6px colour marker plus existing selection semantics; checked chips add a strong outline and visible check, not just stronger saturation. Preserve multi-select and the All reset.
- Inputs/selects/search: opaque raised background, primary text, muted placeholder, 1px default border and inset `0 2px 0 #00000040`; focus ring outside, error hint in audited danger fg/bg. Preserve native select/file input/date behaviour and keyboard navigation.
- Tabs/range selectors: adjacent rectangular transport-key shapes, no pill rail; active accent underline + primary ink on subtle, or solid accent with dark ink. Add/ratings retain their existing editable controls, validation, Undo and hit areas.
- Desktop sidebar stays its existing width/ordering; opaque cassette fascia, 1px inner rule, rectangular active row with a static `▶`-shaped decorative notch in empty padding. Phone bottom tab bar keeps all current tabs, English names and safe-area padding; active underline, no circular bubble.
- Library covers/list and work pages: neutral inset cassette sleeves with 2px corners and category edge markers; real artwork stays untouched, no fake movie screenshots, blurred RGB lettering or stamped labels across covers. Work hero/description/history/seasons and artwork gallery use opaque text backing; keep all menus and gallery interactions.
- Insights/Review: small counter bays plus long signal-analysis frames, not the same repeated large card treatment. Settings groups read like a deck setup menu; Search results get left-edge tape index marks, match text accent on surface; Add steps use existing structure with numbered counter badges, not a new wizard.
- Long titles/descriptions wrap normally; `min-width: 0` on grid children; never clip/mask the live reading DOM, focus rings, popovers or cover art. Tracking-copy slices and counter-digit windows may use `overflow: clip`; real content geometry and interactive hit targets stay fixed.


### 5. Charts

- Common: square-ended category fills, 1px separation rules, no pill-shaped stacks, blurred data marks, invented signal values or changed scales. Use existing accessible SVG/DOM hit targets and titles; numeric labels are Share Tech Mono, chart axes muted at opacity 1, solid primary selected markers.
  - Chosen geometry: 0px bar/cell radius, cyan/yellow measurement guides, no chart bloom.
- **Home day map:** retain `DayMap.tsx`'s category area → nested entry area time proportions, current header placement inside the biggest cell, responsive height, tooltip and context menus. Category groups are cassette compartments; entry cells use opaque surface/raised backgrounds with category-solid edge strokes, crisp primary titles and counters. Do not put primary text over a bright `--map-cat` fill; reset legacy translucent fills. Existing small-cell label suppression stays, and hover/focus/tap exposes the full data.
- **Last 7 days:** seven vertical record-level meters with square stacked segments and 1px gaps, actual total above, weekday/date below. Preserve rolling-window semantics, selected-day outline and same-scale usual/norm marker; selection gets a 2px accent bottom register line, not a new navigation bubble. Never round a short segment up visually to imply extra minutes.
- **Month card:** daily skyline becomes a strip of fine square magnetic-track columns (roughly 5–8px desktop, available width on phone), exact category stacks/totals and existing previous-month comparison. Zero days remain empty outlined wells; selected-day marker is a small triangle in the reserved baseline zone. Keep month-precision time explicitly separate, not invented daily bars.
- **Insights KPI strip + sparklines:** opaque counter windows, title above/value below, tiny unblurred 1.5px accent trace in its existing area. Big KPI digits roll on a decorative layer as specified in section 7; the exact real value is immediately present in the accessible DOM. Sparklines retain their data scale and peak endpoint.
- **Stacked series/category share:** the same category solid fills/legend order, square caps, thin 4px-dash/4px-gap gridlines using subtle border, muted axes at least 13px, exact hover/focus readout in the existing metadata strip. Share bars/rings keep their established shape and calculations; do not turn a real ring into an unrelated illustration.
- **Punch card:** keep the existing radius-by-value circles and hourly/weekday grid, but give the surrounding frame CRT register marks and a quiet accent outline on the active cell. The skin does not replace circles with newly sized squares; keep unplaced-time messages, zero/no-data distinctions and native SVG hit regions.
- **52-week heatmap:** five opaque signal levels in existing calendar cells, existing week/day positioning, tooltip and keyboard day selection. Do not recolour calendar intensities by category or manufacture a signal for missing days.
  - Heat 0→4: `#0B215B/#284777/#406DA0/#70A5C6/#B9DEFF`.
  - Heat borders 1→4 equal the corresponding heat fills; 0 uses default border, hover/focus uses focus ring. Cells contain no text; labels/legend words sit on opaque surface, not on intermediate heat fills. Retain existing value thresholds and legend.
- **Top lists/Most played:** aligned tape-counter ranks, untouched titles/creator lines, squared proportional mini-bars, category swatch and audited muted secondary metadata. Preserve plays/time/range controls and do not add music rating controls.
- **Review:** same series/share/punch-card language, covers aligned like a strip of cassette spines with narrow frame gaps; keep cover ratios, captions, ratings and context menus. Category headers are OSD labels, not titles printed across images; short-form remains time-only without fabricated covers.
- Tooltips: opaque raised surface, primary/secondary text, strong control outline, 2px corners and one static accent register corner; only the audited full-screen fine scanlines may cross them, never local noise or tracking copies. Keep inline chart readouts inline and existing floating tips viewport-clamped; never restyle inline hints into hover-only functionality.


### 6. Wallpaper and CRT composition

- Ship only `vcr-desktop.webp` (**2400×1350**) and `vcr-phone.webp` (**1080×1800**) under `web/public/wallpapers/rewind/`. These names identify the selected VCR aesthetic; both use **RW-01**, Liana S's [wall of vintage televisions](https://unsplash.com/photos/stack-of-vintage-televisions-in-dark-room-EM6GGiK1_go), [Unsplash License](https://unsplash.com/license). Badge marks were retouched using adjacent plain chassis texture; grayscale, levels and a brighter VCR-blue tint make the real hardware visible in unused gutters. Exact edits, source URLs and bytes are in `CREDITS.md`. No entertainment imagery/logos or runtime hotlinks.
- S0 `bg`: blue canvas → responsive photo at **.88 opacity**, anchor desktop **72% 46%**, phone **64% 48%** → light canvas tint **.08→.30** → 1px black **.07** scanlines every **4px** → slight edge vignette **0→.25**. These stronger layers are behind opaque reading surfaces, never over text. The unused blank-tape and warm-room pairs are removed.
- S0 `fx`: a fixed, full-viewport, click-through static scanline gradient, **1px/.06 black every 3px**, aria-hidden through S0. No canvas, noise bitmap or moving band. Main frames have a soft external red/green/blue fringe; screen-edge darkening belongs to the background, not glyphs. Phone glow radius is capped at 6px.
- Desktop outer gutter 20px; phone 12px, with existing content padding and layout order. No broad decorative layer may consume control space or change measured chart rectangles. Text-bearing page/card/navigation surfaces remain opaque.
- Only the viewport's one variant loads. Save-Data and `prefers-reduced-data` use canvas/texture without a photograph. Images stay ≤350KB/2400px desktop and ≤200KB/900–1200px phone, preferred pair ≤300KB+150KB. No unused production images, font variants, remote CSS, video or backdrop blur.
- RW-c may later add the section-7 rolling brighter band, capped at .04 white and paused/removed for hidden/reduced-motion states. It is not part of the current static foundation.

### 7. Animations — planned for RW-c

- Easing constants: settle `cubic-bezier(.16,1,.3,1)`, interaction `cubic-bezier(.2,.7,.2,1)`, mechanical `steps(2,end)`, linear for streak travel. All decorative nodes click-through; reserve geometry first, never delay fetching/rendering or change document flow.
- **Page transition:** 260ms settle on border/register decorations (opacity .35→1 and translateY 4px→0), wallpaper light pool settles over 420ms. Text/controls render immediately and remain readable; no whole-page blackout, CRT power-off collapse or brightness flash.
- **Card entrance — signal acquired:** on first visible mount, one broken horizontal noise band (4–8px tall) crosses the card for 100–160ms, followed by brightness **1.04→1** and frame-corner settle; each card's complete effect **≤320ms**. Put stronger noise (alpha ≤.22) in empty card padding; over glyphs use only the shared .07-black/.04-white effective caps, not an opaque static band. Stagger cards 35ms up to 210ms without delaying real content; no whole-card opacity fade, target movement or brightness flash. Offscreen cards acquire signal only once when first visible.
- **Hover/press:** 140ms interaction border/outer glow increase, 80ms mechanical inset-shadow press, 120ms release. No scaling, cover tilt or pointer-target movement; coarse pointers receive the same border feedback on press.
- **Focus:** 120ms settle of a secondary outer bezel halo; the solid focus ring appears immediately and never pulses/blinks. Inputs' native caret remains steady according to OS behaviour, with no skin-added blink.
- **Tape-counter roll:** big Today time, week/month totals and KPI numbers roll on **first mount and value change**. Keep the exact formatted real value in the DOM immediately for assistive technology and reserve its final width/height; an `aria-hidden`, inert, click-through visual layer renders one clipped vertical 0–9 digit strip per numeric character. Fixed units, separators and decimals never slide, and ratings/small labels do not roll.
  - Each digit column slides through at most 2–3 intermediate glyphs to its **exact final digit**, 220ms settle, stagger **right→left by 14ms**, capped at 126ms total delay; all columns lock and temporary strips are removed **≤360ms** after mount/change. Decorative intermediate glyphs are motion, not stored/announced intermediate totals; no invented seconds, changed duration format or fabricated precision.
  - The real value retains the accessible name and live-region behaviour; only its visual glyphs are temporarily hidden behind the opaque decorative counter window, not its semantics or layout. Never clone labels/ARIA live regions. Cancel an in-flight roll on a new value and target the latest exact value immediately; on missing font/measurement, reduced motion, interaction or controller failure show the real value without a roll. Never put an animating clone over editable numbers or controls.
- **Chart draw-in:** 320ms settle of a thin register border around the plotting area; optional sparkline dash reveal 300ms linear on its existing unlabelled stroke. Bars/cells are already their correct dimensions and opacity; do not animate value heights or obscure legends.
- **Day/week/month switch:** use the shared 700ms skin event envelope, with a **≤620ms tracking-lock sequence** (section 10). Day uses 2 wallpaper bands/±8px; week 3/±16px plus rewind streaks; month 3/±12px and a longer baseline settle. On day/week changes, the day card, week-bars card and month card **whose displayed data or selected-day marker changed** also get a genuine **≤240ms content-slice glitch**; leave unchanged cards alone. `prev` streaks left, `next` right. All real data updates immediately; do not animate value proportions or scroll the page to fake tape movement.
- **Loading:** real existing loading state/skeleton only, opaque raised blocks plus 1px rectangular progress-edge animation, 1200ms linear low-amplitude cycle. Never simulate recording/upload progress; errors stop the decoration and retain Retry. No shimmer laid over text.
- Rate-limit switching to one choreography per 900ms; rapid actions still update immediately, replace pending decorations instead of queuing long animations. After the final event, settle cleanly; no more than one short high-contrast glitch pair per switch and no strobe (≤2 abrupt changes/second).


### 8. Ambient loops — planned for RW-c

- The rolling scanline band and Home REC lamp are continuous base decorations, not scheduled emissions; both pause while hidden. The random scheduler starts after an 8–16s idle wait; sample the six intermittent effects below with independent cooldowns. Defaults **max two desktop / one phone** including cursor accents, excluding the cheap CSS base decorations; transition choreography takes priority and suspends random ambient work. All decorations are `aria-hidden`, `pointer-events: none`, with no audio or live announcements.
- Free spots are wallpaper gaps, unused bezel margins or genuinely empty padding, never chart plots (even empty ones), covers, text, control hit areas, focus rings, scrollbars or safe-area nav. Inflate exclusions 16px desktop/12px phone; require a complete swept-path fit, revalidate before play, cancel on overlap/scroll/resize, skip rather than force placement.
- **Steady Home masthead `REC ●`:** always present while Home is mounted, in a reserved upper-corner header-padding slot (64×24px desktop, 52×24px phone) clear of headings/actions. Primary `REC` letters remain steady and readable; only the 6px `#FF9587` dot blinks **1Hz**, 500ms on/500ms off with `steps(1,end)`, no glow flash. This is decorative OSD nostalgia, never a claim that recording is happening; not random, not a status/live region and never placed over a control. Reduced motion keeps the dot steadily on; Settings previews remain static.
- **TRACKING OSD:** ≥110×30px empty outer-margin slot; every 35–65s, 2.8s with 350ms fade in/600ms fade out and one static underline. English VT323 letters are on their own opaque surface plaque, never over photo pixels without backing.
- **VHS dropout:** one 40–160px, 1–2px broken line rolls 60–120px through a verified empty wallpaper rectangle; every 18–32s, 900ms linear, alpha ≤.22. No long stripe sweeping the actual screen.
- **Head-switching seam:** sparse 1–2px staggered dashes inside a free 8px-high bottom wallpaper edge; every 28–50s, 1.6s mechanical drift of ±3px, alpha ≤.2. On phone use a free side/bottom gutter *above* the protected tab bar; skip if none exists, never draw on nav or across its top labels.
- **Tape rewind streaks:** three 28–80px horizontal hairlines travel 90px within a free ≥190×24px gutter; every 40–70s, 1.1s linear. Direction random for ambient only; active navigation uses the true event direction.
- **Reel reflection:** a tiny stationary crescent glints on an exposed photographed reel or bezel edge, not a cover; every 55–90s, 3.6s sine-like opacity ease at ≤.12. If the chosen wallpaper has no exposed reel, use an unlabelled frame corner instead.
- **Phosphor settling:** 18–36px corner bracket briefly blooms then settles in free frame padding; every 22–38s, 2.2s settle, glow radius ≤8px. Use cyan/yellow with a restrained outer RGB fringe; no actual glyph flicker.
- Colouring: white/cyan/yellow with restrained RGB on bezel/slice edges. All six intermittent effects and the steady masthead REC lamp exist on phone, with half streak count/travel and unchanged cooldowns. Random ambient eligibility can safely suppress an emission lacking room; the audited screen sheet/band and deliberately targeted tracking/counter/entrance layers are separate, controlled content-crossing effects, not permission for ambient noise over text.


### 9. Cursor — planned for RW-c

- Fine pointers only (`hover: hover` and `pointer: fine`): local 32×32 SVG cursor assets, logical footprint ~18px; native cursor stays visible as the interaction cue, never a JS cursor replacement.
- Normal: chunky stepped white/cream arrow with 2px canvas-colour outline and a 1px trailing transport notch; hotspot **(3,2)**. Edge cyan; the arrow's bright face uses primary ink.
- Pointer: same arrow plus a small `▶` notch at bottom-right (not a huge crosshair/hand covering the link), hotspot **(3,2)**; text: compact 16px I-beam with primary centre/canvas outline, hotspot **(16,16)**. Fall back to `default`, `pointer`, `text` respectively; preserve resize/grab/not-allowed system cursors.
- Optional small effect: at most two 2px phosphor beads with 180ms fade behind movement, no particle spray; emit at most every 80ms and only inside a verified wallpaper free spot, ≥18px away from the cursor/control/text exclusion. Disable during selection, drag, modal interaction, transitions and reduced motion; no continuous RAF needed.
- Bind `--cursor-default`, `--cursor-pointer`, `--cursor-text` through S0; clear them on skin teardown. Phone/coarse pointers have no cursor assets requested and no trail.


### 10. Signature effect — Tracking lock — planned for RW-c

Changing day or week looks like the deck has found the next recorded segment: **both the room's picture and the changed cards' visual contents** briefly track sideways, thin rewind scratches race through the margins, and an OSD `TRACKING` plaque locks into `PLAY` before disappearing.
- **Content-glitch construction:** use **2–4 horizontal `clip-path` slices of decorative copies of the newly updated card body**, not merely its border. Alternate slice offsets **±6–10px day / ±10–14px week**, with two mechanical positions and a short 1–2px RGB fringe on slice/frame edges, then lock. Copies keep original opaque substrates and crisp original-colour glyphs; fringes affect edges, not recoloured text. The complete card-local glitch lasts **≤240ms**, then copies disappear and the stationary real card is exposed exactly aligned.
- Copies are `aria-hidden`, inert and `pointer-events: none`; strip IDs, live regions, form/interactive elements, handlers and external asset requests. Clip them within the card's original paint bounds to prevent horizontal overflow; protect control/link hit rectangles, focus rings, tooltips, covers and editable/selected text. Real DOM/data/targets underneath update immediately, are never transformed, and clicks always reach them; pointer-down, keyboard focus, selection or opening a menu cancels the local copy instantly. If copying cannot be done safely, skip that card's copy, not the remaining wallpaper/streak/plaque choreography.
- 0–80ms: update data/focus immediately; show the safe-slot `TRACKING` plaque, two/three wallpaper bands and first shifted card slices. Counter strips may start independently on changed big values, but tracking copies exclude active digit-roll windows so the two effects never double-render the same number.
- 80–240ms: second mechanical card-slice offset and directional gutter streaks; wallpaper streak alpha ≤.22, edge RGB fringes narrow and brief, no whole-screen white flash. All content slices return to zero and are removed by 240ms; the real data shapes/proportions were never changed.
- 240–400ms: restore wallpaper alignment, one short head-switching seam in a free bottom/side edge; local card content is already stable, and any counter roll completes by 360ms.
- 400–620ms: plaque changes to decorative `PLAY`, bezel corners settle with the yellow accent; fade plaque to zero. If no plaque slot exists, run only the unobstructed wallpaper/frame parts.
- 620–700ms: everything is static and temporary nodes are removed; the shared event attribute may expire independently. Page changes use the section-7 reveal instead of a fake date-navigation rewind.
- The chosen blue VCR menu locks onto the new segment with yellow corner accents and a brief RGB tracking fringe; keep it recognisable on phone.


### 11. Settings › Appearance preview tile — polish planned for RW-d

Keep the native radio tile, Rewind label, English description, checked state and keyboard behaviour. Its scoped default palette now matches the sole blue/yellow skin. Future RW-d polish uses a near-square blue screen, static `PLAY` corner, sample `2h 48m`, square category segments, cassette/TV silhouette and restrained RGB corner glow. Use code silhouettes and scoped tokens rather than fetching the wallpaper as a thumbnail. Preview is static and has no look attribute, cursor effect, timers or duplicated announcements.

### 12. Phone at 390px

- Keep existing shell order, day map, seven bars, month totals, Library/work-page features and five bottom tabs. Preserve existing responsive breakpoints rather than hard-coding a separate page; outer gutter ~12–16px, frame padding ~14–16px, 44px touch targets, inset counter fonts ≤48px when long values need space.
- Month heading/total and range controls wrap using the existing grid; full title visibility wins over decorative `SP` stamps. Chips wrap without sideways page scrolling; the 52-week chart keeps its intentional internal scroller. Work descriptions and long source names must wrap, inputs stay 16px, popovers/sheets keep existing mobile behaviour.
- Current build keeps static full-viewport scanlines. Future RW-c also keeps the slow band, signal-acquired entrance, steady 1Hz Home REC dot, digit rolls and content tracking lock. Use two card slices at **±6px**, two wallpaper bands with half travel, one random ambient effect, a 4px noise zone and max 6px glow; keep the same 240/360/620ms duration caps. Where the fixed bottom tab bar occupies the bottom edge, use a safe side gutter for stronger head-switch noise or skip that emission; only the audited faint screen sheet/band crosses nav.
  - Preserve the blue menu, yellow selection strips, square geometry and subtle external RGB frame glow on phone.
- Use the portrait image only; effects do not allocate full-page canvases. Prefer transform/opacity CSS, no backdrop blur/WebGL/video; if a canvas fallback is necessary cap ambient at **24fps desktop / 15fps phone**, DPR **≤1.5 phone** and ≤2 desktop, render only safe effect bounds. Lazy-load extras after first useful paint; pause when hidden and do not catch up missed loops.

### 13. Reduced motion

- `prefers-reduced-motion: reduce`: no rolling brighter band, tracking-copy slips/fringes, signal-acquired noise/brightness settle, digit rolls, blinking REC, ambient scheduler, cursor beads, fades, chart draw-in or loading-edge movement; do not merely slow them down. Remove temporary copies/strips and reveal the exact real values immediately; no hidden-tab timers/RAF or deferred motion bursts.
- Preserve the chosen photo/tint, static low-alpha full-screen scanline sheet within its audited cap plus the stronger background scanlines, cassette frames, stationary bottom-edge noise sample only in empty wallpaper, crisp counter type, steady Home `REC ●` and static accent focus/selection outlines. Remove the brighter rolling band entirely; focus remains immediate, chart values and loading/error labels complete.
- Keep static blue/yellow menu geometry, TV-wall tint and faint outer RGB bezel glow. Standard CSS/native custom cursor is allowed for fine pointers without animated side effects. Decorative `PLAY` may be fixed in empty padding; never blink REC.

### 14. Implementation and handoff

- RW-b implements one blue/yellow palette in `styles/themes/rewind.css`, matched by Rewind's entry in `lib/theme.ts` and its `.theme-preview` tokens. All selectors stay scoped to Rewind; other skins and shared components are untouched. No comparison look preference/attribute remains.
- Local faces are in `styles/fonts/rewind.css`, assets/licences in `public/fonts/rewind/`; only the two selected photo variants and credits remain in `public/wallpapers/rewind/`. Fonts alias body/display/numbers/mono and legacy sans/serif roles. No new dependencies.
- `skins/rewind/index.ts` mounts the existing S0 room/screen layers and two local font preloads, honours Save-Data, then removes owned classes/preloads/state on teardown. It reads no localStorage, starts no timers/RAF and adds no motion. Existing component animations/transitions are disabled for the static foundation; RW-c must deliberately replace that temporary static rule when implementing motion.
- RW-c owns sections 7–10: use actual S0 `SkinEffects`/`SkinContext`, events and ambient free-space APIs, visibility/motion guards, sanitized card copies, exact counters and bounded deadlines. Never animate live data geometry, delay real rendering, duplicate announcements, cover protected controls/covers/focus, queue missed events or fetch/store/log source data. Cleanup must cancel every timer/listener/observer/copy/strip; future cursor files stay under `public/cursors/rewind/`.
- Budgets: theme CSS including nested files ≤64KB; effects source ≤60KB; wallpapers ≤350KB desktop/≤200KB phone, total directory ≤1.5MB; fonts ≤600KB, preferred ≤300KB. Keep local-only runtime assets, responsive selection, no native/npm dependencies.
- Acceptance: `bun run check`, `bun run build:web`, network-free tests for no storage dependency, lifecycle/Save-Data cleanup, one responsive pair, registry/default/preview agreement and worst-case composited AA. Future motion requires its own S0 event/cleanup, timing, sanitization, pause/reduced-motion and safe-placement coverage.
- Demo-only screenshots at Vite 5193/API 8793: Home (`calendar?date=2026-10-24`), Insights, Library, Settings and work at 1440px/390px into `.task/shots/final/`; inspect actual PNGs/full-page captures, require no horizontal overflow and blocked controls no worse than Dot. Phase-1 comparison captures remain in ignored `.task/` as historical references, not shipped options.

## Skin: Thinker (TH)

### 1. Concept

Thinker is a soot-dark chamber containing pale sculpture, seen beside an unseen hearth.
A seated Thinker and monumental marble faces catch flickering light while oversized statue and figure shadows sway continuously across the cave wall behind the cards.
The interface is a collection of engraved stone slabs whose rims catch that same fire: cream serif headings, crisp numerals, bronze bevels and mineral-coloured data inlays.
At a glance, the pale silhouette, directional firelight and almost-square stone frames must identify it without reading the skin name.
Avoid Dot's dot grid, pixel/dot fonts, red action pills, balloon corners and thick candy bars; also avoid a gold luxury dashboard, fantasy HUD or museum slideshow.
**No quotations, epigraphs, aphorisms, quotation-mark ornaments or philosopher text anywhere in the UI.** Existing English labels, data, routes and interaction order remain unchanged.

### 2. Palette and measured contrast

- Canvas `--bg-canvas: #0B0A09`; surface `#171411`; raised `#211C17`; subtle `#2A231D`; muted/track surface `#302720`.
- Primary text `#F4EEE4` (marble); secondary `#D5C8B7` (limestone); muted `#B6A895` (ash). Never lower their opacity to make them quieter.
- Primary accent `#F0BB79`; hover `#FFD298`; accent subtle background `#302216`; accent border `#94704F`; secondary accent/moonlit detail `#D8DDE0`.
- Accent-button and solid-category label ink `--text-on-accent: #0B0A09`; use it **only** on bright fills, never on dark surfaces.
- Decorative borders: subtle `#393027`, default `#544638`, strong `#8A7862`; functional input/control edges use strong (≥ 3:1), not default.
- Focus ring `#FFD79A`, 2px solid, 3px offset; selection also has an outline/marker, never colour alone.
- Glow colours: ember `#D7602C`, fire `#F0A557`, flame core `#FFE0AA`, cool marble `#D8DDE0`; glows are decoration, never text colours.
- Overlay `rgba(11,10,9,0.88)` for modal scrim; every modal, popover and reading surface itself is opaque.
- Status success fg/bg/border `#BFD69E / #1E2719 / #708657`; warning `#F4D18B / #302619 / #A58C5D`.
- Status danger `#F0A997 / #30201D / #AE7869`; info `#C9DBED / #1B242D / #7390AA`; retain status icons and literal labels.
- WCAG ratios below use linearised sRGB luminance, `(Llighter + .05) / (Ldarker + .05)`, rounded to two decimals only after checking unrounded ≥ 4.5.
- Audit source: `.task/contrast.ts`, run with `bun .task/contrast.ts`; no network or personal data. All below are text at full opacity on opaque backgrounds.
- Listed ratios are the **unlit baseline**. Card-edge lighting may change a neutral surface's WCAG linear-sRGB luminance Y by at most **±0.020** (two percentage points, not HSL lightness), clamped at zero.
  The worst neutral surface is `#302720`, Y = **0.021837**; the dimmest text is `#B6A895`, Y = **0.401203**. Its theoretical positive headroom before 4.5:1 is **0.028430**.
  Our +0.020 ceiling gives **(0.401203 + .05) / (0.021837 + .020 + .05) = 4.91:1**; all primary/secondary/category/status text on lit neutral surfaces is brighter and also passes.
  Normal breathing targets ΔY ≤ **0.010**; overlapping flicker, edge gradient and torch-pass lighting **share** the +0.020 ceiling, never add separate allowances. Interpolate baked, audited edge colours beneath text, not an overlay above it.
  Inputs, focus/control edges, chips/status fills, category solids and heatmap levels stay unmodulated, preserving their listed text and ≥ 3:1 functional-edge contrast; darker shadow patches only improve light-text contrast.

Core surface order for every following ratio line: **canvas / surface / raised / subtle / muted**.

- Primary: **17.14 / 15.90 / 14.64 / 13.41 / 12.67**.
- Secondary: **12.03 / 11.16 / 10.28 / 9.42 / 8.89**.
- Muted: **8.50 / 7.88 / 7.26 / 6.65 / 6.28**.
- Accent as link text: **11.39 / 10.56 / 9.72 / 8.91 / 8.41**.
- Hover accent as link text: **14.06 / 13.04 / 12.01 / 11.00 / 10.39**.
- Moonlit text: **14.45 / 13.40 / 12.34 / 11.31 / 10.68**.
- Success text: **12.55 / 11.64 / 10.72 / 9.82 / 9.28**.
- Warning text: **13.51 / 12.53 / 11.53 / 10.57 / 9.98**.
- Danger text: **10.20 / 9.46 / 8.71 / 7.98 / 7.54**.
- Info text: **13.98 / 12.96 / 11.94 / 10.94 / 10.33**.
- Real special backgrounds: accent on accent-subtle **8.85**; dark ink on accent/hover buttons **11.39 / 14.06**.
- Status fg on own badge bg: success **9.80**, warning **10.12**, danger **8.02**, info **11.10**.

Ten category families; map these values literally to `--cat-<id>-fg/bg/border/solid` and the registry, not the shared Dot colours.
Each category's ratios are **fg on canvas / surface / raised / subtle / muted / its own bg; dark ink on its solid**.

- Anime, fluorite: fg `#D8C7EC`, bg `#241C2C`, border `#806994`, solid `#B9A5D6`.
  Ratios **12.53 / 11.62 / 10.70 / 9.80 / 9.26 / 10.41; 8.87**.
- Series, oxidised copper: fg `#A4DAD2`, bg `#182824`, border `#527F77`, solid `#65B7AD`.
  Ratios **12.75 / 11.83 / 10.89 / 9.98 / 9.42 / 9.90; 8.41**.
- Film, ochre: fg `#EED99F`, bg `#2D2618`, border `#927D48`, solid `#D5B96E`.
  Ratios **14.19 / 13.16 / 12.12 / 11.10 / 10.48 / 10.74; 10.36**.
- Book, olive stone: fg `#CFDDB0`, bg `#23291C`, border `#768554`, solid `#A2B87C`.
  Ratios **13.77 / 12.78 / 11.76 / 10.78 / 10.18 / 10.40; 9.12**.
- Audiobook, lapis ash: fg `#C5CAF0`, bg `#202235`, border `#7076A1`, solid `#989ED0`.
  Ratios **12.32 / 11.43 / 10.52 / 9.64 / 9.10 / 9.75; 7.66**.
- YouTube, red clay: fg `#F2BCA9`, bg `#30201B`, border `#A36D5A`, solid `#DB927D`.
  Ratios **11.81 / 10.96 / 10.09 / 9.24 / 8.73 / 9.30; 7.93**.
- Podcast, sandstone: fg `#E7C5A6`, bg `#2C231C`, border `#94704F`, solid `#D3A07B`.
  Ratios **12.18 / 11.30 / 10.41 / 9.53 / 9.00 / 9.48; 8.56**.
- Music, garnet: fg `#EDBDD5`, bg `#2D1E28`, border `#95647F`, solid `#D894B6`.
  Ratios **12.10 / 11.22 / 10.33 / 9.47 / 8.94 / 9.67; 8.32**.
- Short-form, blue slate: fg `#BCD9EB`, bg `#1C2630`, border `#617F94`, solid `#88B4CF`.
  Ratios **13.44 / 12.46 / 11.47 / 10.51 / 9.93 / 10.42; 8.93**.
- Other, limestone: fg `#DDD6C9`, bg `#28251F`, border `#8A8273`, solid `#C8C1B4`.
  Ratios **13.69 / 12.70 / 11.69 / 10.72 / 10.12 / 10.57; 11.06**.

Shared primary / secondary / muted text on each category bg (e.g. chips with duration labels):
anime **14.24 / 10.00 / 7.06**; series **13.30 / 9.34 / 6.60**; film **12.98 / 9.11 / 6.44**;
book **12.95 / 9.09 / 6.42**; audiobook **13.56 / 9.52 / 6.73**; youtube **13.50 / 9.48 / 6.69**;
podcast **13.34 / 9.36 / 6.61**; music **13.70 / 9.62 / 6.80**; shortform **13.29 / 9.33 / 6.59**; other **13.24 / 9.29 / 6.56**.
Do not place pale text on category solids, borders or arbitrary colour mixes; keep bar labels outside fills, or use the audited dark ink.
Day-map cells use the opaque subtle surface, not Dot's translucent category wash; coloured seams supply identity, and only their edge lighting uses the bounded neutral-surface allowance above.

### 3. Fonts

- Display: **Cormorant Garamond**, Christian Thalmann / Cormorant Project Authors, SIL OFL 1.1; upright weights 500 and 600.
  Source <https://github.com/google/fonts/tree/main/ofl/cormorantgaramond>; licence <https://raw.githubusercontent.com/google/fonts/main/ofl/cormorantgaramond/OFL.txt>.
  Its sculptural contrast and long serifs resemble carved museum lettering without pretending to be ancient Greek. Use for headings, not small controls or charts.
- Body: **Source Sans 3**, Paul D. Hunt / Adobe, SIL OFL 1.1; upright 400, 600, 700 from the variable Roman file.
  Source <https://github.com/google/fonts/tree/main/ofl/sourcesans3>; licence <https://raw.githubusercontent.com/google/fonts/main/ofl/sourcesans3/OFL.txt>.
  Humanist forms keep titles, English instructions and dense forms readable beside the dramatic display face.
- Numbers: **Source Sans 3**, same local font file, weights 600/700; `font-variant-numeric: tabular-nums lining-nums` for all time, counts, axes and rankings.
  Exact aligned figures feel cut into the slab; no dot numerals, thin ornamental digits or 900-weight inheritance. Large time values use 600, 52–64px desktop / 40–48px phone.
- Labels/mono: **IBM Plex Mono**, Mike Abbink / Bold Monday / IBM, SIL OFL 1.1; upright 400 and 500.
  Source <https://github.com/google/fonts/tree/main/ofl/ibmplexmono>; licence <https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexmono/OFL.txt>.
  Reserve mono for dates, compact chart readouts and small index labels; navigation and buttons remain Source Sans 3, not all-caps terminal text.
- Display 36–44px desktop / 28–32px phone, 600, tracking −.015em; body 16px/1.5, small text ≥ 12px/1.4; labels 12px, .06em tracking.
- Keep real heading/label strings and casing; no faux Latin, Greek captions or text ornaments. Fallbacks: Georgia / system-ui / ui-monospace respectively.
- Self-host WOFF2, Latin + Latin-ext only, `font-display: swap`; preserve copyright and OFL notices/Reserved Font Names when subsetting.
  Target Cormorant ≤ 130KB, Source Sans ≤ 180KB, both Plex weights together ≤ 110KB: total ≤ 420KB, hard ceiling 600KB. No italics or extra families.

### 4. Cards, shapes and every page

- Keep the existing shell widths, page order, grid breakpoints and DOM behaviour. Change materials and silhouettes, not information architecture.
- Radius tokens xs/sm/md/lg/xl/full = **1 / 2 / 3 / 4 / 6 / 3px**; rectangular slabs and controls, no pills. Covers retain their image aspect ratio.
- Cards: opaque surface, 1px default bronze border, bronze top/left bevel and dark opposite seam; optional 6px corner brackets. **Every visible card**, not only selection, catches a warm rim.
  A 1–2px `#F0BB79` top/rim highlight flickers at opacity **.25–.60** from the shared flame; a 16–24px inward warm edge gradient breathes beneath content, centre colour fixed, ΔY bounded as above.
- Base shadow `0 12px 30px #00000080`; raised `0 18px 40px #000000A6`. With shared flame position x/y in −1…1, offsets become **−6x px / (12 + 3y)px** (raised **−8x / 18 + 4y**).
  Blur/spread/colour stay fixed; offset moves opposite the fire, smoothly and constantly. Rim glow is a fixed 18px-softness pseudo-element whose opacity follows the flame, never animated blur or glow radius.
- Stone texture is a **static**, sparse original vein graphic at ≤ 2% opacity in borders/gutters, not a repeating dot grid, sand noise over letters or marble-white cards.
- Card title bars are a flat `#211C17` header band with a 1px bottom rule and 12–16px inset; serif title, sans subtitle, no ribbon or decorative prose.
- Home masthead and Contents retain their disclosure; day summary, week chart and day map have squared slab edges, and month spans the existing width below.
  Set Thinker's own home reading/panel tokens explicitly; do not inherit Dot's capsule readouts, hidden summary decisions or 900-weight typography.
- Primary buttons: amber slab with dark ink, 3px corners and strong edge; secondary: opaque raised with primary text; danger uses its labelled status family.
- Chips: 2px corners, own category bg + fg, 2px solid-category left seam; selected chips add an inset focus-coloured outline/check while keeping the dark fill.
- Inputs/selects/textareas: subtle fill, strong 1px edge (3.44:1 on the brightest core surface), 3px corners, primary input text, muted placeholders at full opacity.
- Tabs/segmented controls: joined rectangular stones; selected tab raised, primary text, 2px amber baseline. Do not remove native input/radio semantics.
- Desktop sidebar: opaque surface with one carved vertical rule, serif brand text, sans navigation, active rectangular raised block plus amber left marker.
- Phone bottom navigation: opaque surface, safe-area padding, 2px amber top rule on the active tab; no white oval selection. Header remains opaque and compact.
- Library: preserve Covers/List, filters and sort; dark plinth under covers, fine ruled list rows, existing category icon for missing art (never a statue replacing a work cover).
- Work page: existing artwork and metadata remain authoritative; Thinker texture only around the reading pane, not over cover art, descriptions, rating editor or history.
- Search: engraved-looking opaque field, hits on ruled slabs; query highlights use accent-subtle + accent text. Add: same steps, fields, validation and offline controls.
- Settings: framed sections with opaque inputs; menus, quick-rating edit fields, drawers and dialogs use raised surfaces without wallpaper transparency.

### 5. Charts

- Shared grammar: mineral inlay colours, 1px seams, square bar ends (CSS/SVG radii 1px, inner radius 0); avoid glossy tubes, fire-shaped bars or perspective.
- Axes and ticks use 12–13px Source Sans 3 tabular figures in muted text; gridlines `#544638` at full opacity, 1px, solid; baseline strong.
- Legends pair the existing category name with a 6 × 10px rectangular solid swatch. Maintain the original units, scales, dates and category order.
- Tooltips: opaque raised, strong border, 3px corners, no backdrop blur; primary title/value, secondary details, same keyboard/focus and touch behaviour.
- **Home day map:** retain `DayMap`'s category → entry nested treemap, exact area proportions, existing layout inset/gaps and hover/focus/context menus.
  `.home-map-tile-inner` becomes a square stone frame; `.home-map-fill` is opaque subtle at opacity 1 in both idle and hover states.
  Use `--map-cat` for a 2px cell seam and swatch, not a translucent overlay. Titles, totals and category header stay in their current measured boxes.
  Totals use Source Sans 3 600, not inherited 900 serif; small cells stay unlabelled visually with existing accessible tooltip, never invented data. Frame bevels share the card rim flicker.
- **Last 7 days:** same rolling seven columns, proportional category stacks and norm calculation; 1px dark separators, no chunky rounded blocks.
  Selected day has an amber baseline and fine rectangle around its existing hit target; norm marker is a labelled moonlit hairline at its true value.
  On first mount, paint-only stacks rise from baseline with scaleY(0 → 1), **420ms per column / 30ms stagger**; a warm left→right torch band follows, norm markers and labels stationary.
- **Month card:** skyline resembles a distant colonnade, straight daily stacks with no flame caps; total is a large crisp numeral separated from month heading by a bronze rule.
  Keep zero-day marks, selected-day outline, share bar, category ledger, previous-month comparison and separately labelled month-precision time.
  Skyline paint rises with the same **420ms / 30ms stagger** and passing warm band; no repeated mount animation on hover, filtering or ordinary redraw, and zero days stay zero.
- **Insights KPI strip:** three/four existing metrics remain in position; serif labels where headings, sans/tabular values, 1.5px amber sparklines with no blurred glow.
- **Stacked series:** opaque category solids with 1px dark seams, the same scales and min/max markers; no decorative stack gaps that falsify height.
- **Category share:** existing proportions and shape; square-ended track sections or existing share-chart wedges, category labels on opaque neutral ground.
- **Punch card:** existing circles become amber-lit stone studs, fixed 1px border and genuine radius/area encoding; faint baseline grid, never random twinkle per datum.
  Unplaced short-form time remains reported as unplaced; skin effects never create an hourly observation.
- **52-week heatmap:** 1px-corner tesserae; levels 0–4 = `#171411 / #493325 / #805032 / #BF8050 / #F0BB79` in the existing monotonic intensity mapping.
  If labels occur inside cells: primary at levels 0–2 (15.90 / 10.20 / 5.85), dark ink at 3–4 (6.05 / 11.39); tooltips always use raised background.
- **Top lists/Most played:** aligned ranks, hairline tracks, square mineral bars, value outside fill; preserve plays/time and historical range controls.
- **Review:** reuse this chart grammar; existing cover strips feel like objects on a narrow plinth, cover colours untouched, names/ratings on opaque labels.
  No statue watermark inside data, no ornamental trend interpolation, no quote card or extra metric added.

### 6. Wallpapers and compositing

- Verified candidates, direct originals, authors, licences, resolutions and inspected local previews: `.task/wallpaper-candidates.md` and `.task/candidates/`.
- Ship **TH-1 pale Met Thinker**, **TH-2 Rodin marble Hugo**, **TH-3 Roman marble Plato** only; TH-4 seated marble man and TH-5 Medusa remain reserves.
- TH-1 is a plaster cast, not marble; credit the medium accurately. Genuine marble TH-2/TH-3 carries the marble world; never recolour a bronze statue white.
- Build-time prep: isolate contours, remove museum labels/display architecture, retain original sculpture detail, neutralise background blue, grade to warm ivory without orange flooding.
- Fixed `bg` composition order: original dark cave wall/veins → softly enlarged silhouette shadow → local isolated-statue composite → directional warm mask → soot vignette.
  The cave wall and shadow shapes are original SVG/CSS art; photos remain recognisable and untouched geometrically. No generated statue replacing the licensed photograph.
- Constant wall shadows: sculpture contour projects at **1.5–1.8×** photo scale; a second, original fire-cast figure silhouette occupies **65–90vh × 25–40vw** desktop, **55–75vh × 35–55vw** phone.
  Both remain present behind the opaque cards, opacity **.35–.60**, static 10–16px softness baked into masks; their visible parts reach across wall gaps, not just a tiny statue halo.
  Flame-position sway is continuous: offset **±24px / rotation ±2°** desktop, **±12px / ±1.5°** phone, smoothly over **5–9s**; small flame tremor modulates contours without flashes.
  Every **18–30s**, one projection lengthens scaleX **1.00 → 1.25 → 1.00** over **3–5s**, anchored at its base. Events swing both shadows to the torch's side; never distort the photograph or animate blur.
  Ivory highlight occupies ≤ 12% of the viewport; no full-screen brightening. Wall/figure shadows can extend underneath cards because the opaque card/text plane occludes them completely.
- Desktop: extend portrait subjects onto a ≤ 2400px wide dark-wall composite; main face/pose sits in the far-right 28%, full Thinker silhouette fits without stretching.
  Retain 60–65% empty wall for the app. Visible statue windows in shell gutters/unused heading space repeat the same scene crop, not a second unrelated image.
- If a heading has sufficient measured free space, its decorative background window is clipped away from text/controls by the S0 exclusion mask; otherwise keep it hidden there.
  At 1440px a recognisable sculpture fragment must remain visible in the wallpaper gutter; do not hide the entire image beneath one giant opaque page wrapper.
- Heading-window target: right-aligned 220 × 140px desktop, 80 × 112px phone, 16px inner inset, soft 12px outer fade; reduce to the largest fully safe rectangle or omit.
  Reuse the active scene via a Thinker-owned decorative pseudo-element/crop; only this empty window can interrupt an otherwise opaque header background, never its text area.
- Phone: separate 1000 × ~1600px portrait composite, face/Thinker elbow in upper-right, anchor 72% 12%; scale with cover, never stretch or mirror the sculpture.
  Reuse the scene in empty masthead space with a narrow protected crop when safe; content wins when no space exists. Keep the bottom-nav region completely effect-free.
- Scene routing: Calendar = Thinker; Library/work/Review = Hugo; Insights/Settings/Search/Add = Plato. Switch only on route family change, never randomly while reading.
- Base scene colour grade approximately `brightness(.62) saturate(.45)` baked into image; fixed soot vignette darkens outer edges, preserving a small ivory highlight.
  **Text never sits on this image**: ordinary reading areas are 100% opaque, decorative windows cannot intersect protected rectangles.
- Statue warmth uses a build-time contour mask and asymmetric gradient, origin lower-left; opposite contour retains cool marble `#D8DDE0` at ≤ .05.
  The same flame lights card rims and their bounded surface-edge gradients; those are card background decorations below the text plane, not confined to empty wallpaper space.
- Ship six WebP variants: desktop ≤ 280KB each (hard ≤ 350KB), phone ≤ 150KB each (hard ≤ 200KB); target images ≤ 1.29MB, total including contour art ≤ 1.5MB.
  Each asset also respects the general ≤ 400KB cap. No redundant AVIF + fallback pairs unless measured totals still fit; WebP alone is the default.
- Credits in `web/public/wallpapers/thinker/CREDITS.md`: source page, photographer/institution, sculptor, exact licence link, medium, modifications and local output names.
  CC BY-SA Plato composite and photo-derived contour stay CC BY-SA 4.0; CC0 Thinker/Hugo derivatives remain credited as CC0. No runtime CDN/fetch to Commons.

### 7. Interaction animations

- Standard easing **cubic-bezier(.22,1,.36,1)**; material settling **cubic-bezier(.4,0,.2,1)**; ambient **ease-in-out**, with asymmetric keyframe timings.
- Page transition: content translateY(6px → 0), **360ms**, text/surfaces always opacity 1; decorative edge reveals .3 → 1 and backdrop responds **650ms**, never a screen flash.
- Card entrance: translateY(8px → 0), **420ms**, border-only highlight settles; first six existing cards stagger **35ms**, later cards no extra delay; no layout shift or text fading.
- Hover: border highlight **160ms**, preserving the continuously moving fire-cast shadow; buttons may translateY(−1px) **140ms**, data cells do not move or enlarge.
- Press: button translateY(1px) **80ms**, no scaling the whole app; release **160ms**. Native active/disabled states and hit boxes stay intact.
- Focus: solid focus ring appears immediately; optional **240ms** edge-only halo settle, no animated disappearing ring and no delay to keyboard feedback.
- **Numbers ignite:** big time/KPI numerals receive one travelling `#FFE0AA` glow wash across the actual digit area on first mount and value change, **460ms**, left→right (reverse for `prev`).
  Keep real digits at full primary-ink opacity; a **glyph-shaped glow mask**, not a rectangular label flash, carries the soft wash **behind** their ink within the shared ΔY ceiling. No counting, duplicated accessible text, flickering letters or width changes.
- Chart draw-in: week/skyline scaleY(0 → 1), bottom origin, **≤ 420ms per column**, **30ms left→right stagger**, on paint-only fill wrappers; labels, norms and interactive targets stay final-sized.
  The accompanying warm light sweep uses a narrow **12–18% chart-width** band beneath foreground ink, never recolours category solids. Seven-column sequence ≤ **600ms**; 31-day sequence ≤ **1320ms**, including stagger.
  First-mount staging is independent of the 700ms event attribute; cancel a stale reveal on navigation. Other chart fills/sparkline strokes draw in **420ms**, no layout dimensions or hit-test geometry animate.
- **Day/week/month switch = torch pass:** a narrow warm band crosses the changed card **left→right for next / right→left for prev**, **650ms**, lighting its edge/bevel and bounded surface gradient.
  The wall shadows swing **24px desktop / 12px phone** toward that side over the same **650ms**, then blend back over **900ms** into constant sway; entry inlays settle **220ms** without rebuilding interaction geometry.
  Data and focus update immediately. Rapid switches replace the current pass rather than stack it; limit broad high-amplitude light crests to **one per second**, never delay navigation or turn the whole card into a flashing panel.
- Loading skeletons: opaque raised blocks with a quiet **1800ms** luminance breathe (no sweeping streak over text); fixed geometry, no fire sparks on placeholders.
- Prefer opacity/transform and short SVG stroke reveals. The explicit exception is the **shared-position card box-shadow offset**: fixed blur/spread/colour, visible cards only, low-rate updates; no animated blur, backdrop-filter or full-screen filter.

### 8. Ambient loops

**Continuous base is the main animation:** statue firelight, flickering card rims/bevels, breathing edge surfaces, two oversized swaying wall silhouettes and moving card shadows all share one flame signal.
Use **three smoothly interpolated, non-periodic noise bands**: fine variation every **.15–.26s**, medium every **.32–.60s**, slow envelope every **2.5–5s**; example weights **.04 / .07 / .20** about a .55 baseline, clamped .24–.86.
Fine/medium changes are small tremors, never hard on/off flashes; broad changes exceeding .15 rim opacity or ΔY .005 take **≥ 1s**, and high-amplitude crests never repeat faster than **1Hz**. No pixel-noise overlay.
Slow flame position drives the 5–9s wall sway and card-shadow offsets; continuous bases remain active on phone too and do not consume transient slots. Surface colour variation obeys the audited cumulative ceiling, text ink never flickers.
Random scheduler attempts every **8–16s** desktop / **12–22s** phone; each effect has a cooldown below, no immediate repetition, no more than **2** transients desktop / **1** phone.
Base silhouettes/light layers reuse fixed nodes. Transients remain click-through and aria-hidden; `fx` particles never cross text/controls/data/covers, while large `bg` shadows may pass beneath opaque cards but never over their ink.

- **Rising ember bursts — clearly noticeable:** **6–8** orange/ivory points desktop, **4–6** phone, 1–3px cores at opacity **.45–.75**, rise **180–320px / 120–220px** from the bottom wall edge over **4s**.
  Burst every **14–24s desktop / 18–30s phone**, max one group; keep emission above the phone bottom-tab safe area, render behind cards or in protected gutters, never a confetti cloud over controls.
- **Walking cave shadow — clearly noticeable:** the original tall figure silhouette traverses **40–65% viewport width** across the wall over **9–12s**, opacity **.45–.60**, start-to-start every **40–90s on desktop and phone**.
  Reuse/reposition the constant figure's `bg` node during its walk, then return to continuous sway; it passes behind cards, visible in wall gaps, not a tiny free-space glyph, jump scare or foreground apparition.
- **Flame gust:** a warm masked crescent on one statue edge swells .10 → .20 → .10 opacity, accompanied by a longer contour shadow; **2.6s**, cooldown **18–32s**.
- **Light-shaft dust:** 5–8 tiny ash flecks drift 24–48px in a free diagonal shaft, opacity ≤ .18; **6s**, cooldown **25–45s**, max one shaft.
- **Hearth tongue:** 2–3 abstract flame shapes rise 18–32px at an empty bottom corner, never a persistent footer fire; **2.8s**, cooldown **20–36s**.
- **Soot ribbon:** narrow translucent smoky strip curls along a spare outer gutter, not across a chart; **5s**, cooldown **35–55s**, max one ribbon.
- **Marble edge glint:** 2px-wide light edge slowly travels along a statue's cheek/forearm contour, off all content; **2s**, cooldown **28–48s**, max one glint.

Ember bursts and the 40–90s walking figure are **priority scheduled beats**: reserve a slot within their start windows on both devices, and reject lower-priority loops that would overlap it; other cooldowns feed weighted selection (gust 3, dust 2, others 1).
Measure the entire swept box of above-content `fx`, not just its start; if unsafe, skip or render safely behind an opaque card in `bg`. Background silhouettes need no empty rectangle the size of their whole projection; verify opaque occlusion instead.
Scrolling/resize or an opened menu invalidates affected `fx` spots: pause spawning and cancel an occupied path; `bg` shadows continue safely behind opaque surfaces. No scroll-driven parallax.

### 9. Cursor

- Fine pointer + hover devices only. Use native CSS cursor assets, never `cursor:none` or a JS replacement that lags behind the pointer.
- Normal: 28 × 32px original ember-tipped arrow/torch, crisp ivory tip `#F4EEE4`, dark 1px outline, amber core `#F0BB79`, hotspot **(4,3)**.
- Pointer: 28 × 32px slender torch with a small pointing ivory tip and slightly larger warm core, hotspot **(4,3)**; keep recognisable pointing affordance.
- Text: 24 × 28px thin ivory I-beam with 2px bronze endcaps, dark outline, hotspot **(12,14)**; no flame/trail while selecting or editing text.
- Optional empty-wall trail: up to three 2px embers, offset ≥ 14px behind pointer, opacity ≤ .22, **320ms** fade, emitted at most once per **120ms**.
  Disable over controls/text/cards, while dragging, and on coarse pointers; no click bursts or particles obscuring the hotspot. Trail counts within the transient cap.
- Set `--cursor-default`, `--cursor-pointer`, `--cursor-text` to local cursor URLs plus native `default`, `pointer`, `text` fallbacks; three SVG/PNG assets total ≤ 8KB.

### 10. Signature effect

**The statue stays still; its shadow seems alive.** The Thinker's immutable pale contour casts a much larger shadow that breathes and lengthens as firelight catches its forearm.
On date/page events, one edge brightens and the shadow leans in the navigation direction for **650ms**, then rejoins the slow ambient cycle.
Use the same build-time contour for photo lighting and shadow projection so the shadow belongs to this sculpture, not a generic floating blob.
The same fire visibly catches every card's rim and moves its cast shadow, while oversized statue/figure shadows sway behind the slabs. Text stays steady; never distort the photograph or cast a foreground shadow across ink.

### 11. Settings preview tile

Use the existing radio/preview DOM, Thinker-scoped tokens and its real name **Thinker**; preserve keyboard selection and checked indicator.
Miniature: soot canvas, recognisable pale Thinker crop in the far-right 30%, square raised slab, serif heading, tabular time and thin mineral inlay strip.
Description: **Marble, firelight and moving cave shadows**. No slogan or quote. Unselected previews are static and fetch no other route scenes.
Selected/hovered fine-pointer preview can breathe its decorative edge **once over 1200ms**; no scheduler/cursor mounted inside a tile, reduced-motion always static.
Reuse the local Thinker image/thumbnail cache; never load all six wallpaper variants just to render Settings.

### 12. Phone, 390px

Keep the same masthead → day summary → seven-day bars → nested day map → month order, all filters, existing disclosures and bottom tabs.
Use current responsive gutters (target 16px), slab inset 14–16px, corners 3px, wrapped controls and existing touch targets ≥ 44px where available.
No new horizontal page scrolling; 52-week heatmap retains its existing contained overflow, long titles wrap/truncate exactly where the app already does.
Same rim flicker, bounded edge breathing, number ignition, torch/chart passes, continuous wall sway and all seven loop types remain; use the specified phone shadow amplitudes and ember counts, transient cap one.
Load only the phone scene variant using a media-selected local source; lazy-load route companions, no desktop file download followed by phone replacement.
Prefer CSS/SVG compositing; if an ambient canvas is necessary, cap **24fps** phone / **30fps** desktop, DPR **≤ 1.5** phone, **≤ 2** desktop.
Limit particle nodes to 8 phone / 16 desktop and global effect nodes to 24; card light uses CSS pseudo-elements, not particle nodes. Update shared flame opacity **20fps desktop / 12fps phone**; no WebGL/video/full-screen blur.
Only viewport-visible cards receive moving box-shadow offsets, sampled **10fps desktop / 8fps phone**, with **120ms** offset interpolation and fixed softness; pause offscreen cards and avoid per-frame geometry reads.
When safe space disappears, retain static visible sculpture where possible and base background lighting, skip only unsafe transients; never trade legibility for spectacle.

### 13. Reduced motion

`prefers-reduced-motion: reduce`: static warm-left/cool-right photograph, steady warm card bevels, fixed card shadows and both long wall silhouettes; no flicker, breathing, sway, walking, timer, particles, trail or preview animation.
Remove entrance transforms, digit ignition, torch passes, skeleton breathing and staggered chart rise; route/day/week/month changes render final data and fixed lighting immediately.
Static custom cursor shapes may remain on fine pointers; solid focus outlines, pressed/selected markers and functional loading indication stay visible.
Also stop timers/RAF and pause CSS animations while `document.hidden`; resume from a quiet baseline with a fresh random delay, never replay missed effects.
Listen for motion-preference changes at runtime and tear down/restart safely; no audio, vibration or autoplay media in either version.

### 14. Technical implementation and handoff

- CSS owner: `web/src/styles/themes/thinker.css` (optional `themes/thinker/`); tokens scoped to `:root[data-theme="thinker"]` and `.theme-preview[data-theme="thinker"]` only.
  Own card/control/chart rules, below-ink bounded edge gradients/rim pseudo-elements, flame-position box-shadow offsets, digit ignition/chart-rise/torch-pass keyframes and reduced-motion overrides; hard CSS budget **64KB**.
- Font declarations: `web/src/styles/fonts/thinker.css`; local font files and full licences/credit ledger under `web/public/fonts/thinker/`, total **≤ 600KB**.
  Map display/body/numbers/mono and legacy serif/sans aliases together; explicitly override inherited Dot-like case/weight/radius/chart tokens.
- Effects JS owner: `web/src/skins/thinker/`; use the actual S0 effects-layer exports once published, not a guessed parallel mount/scheduler framework.
  Responsibilities: route scenes, one shared flame/noise/position driver, oversized shadow geometry, priority ember/walker beats, occupancy checks and optional cursor trail; hard JS budget **60KB**.
  Publish numeric `--th-flame`, `--th-flame-x`, `--th-flame-y` through the skin root; CSS consumes them for rim opacity, audited edge interpolation and opposite-direction card shadow offsets. No separate flame timer per card.
- Use S0's fixed **bg** behind content for cave/photo/shadow/light, and **fx** above content only for genuinely free-space particles/trail; both click-through and aria-hidden.
  Clip effect roots to viewport, never document-width overflow; `fx` excludes text, controls, plots, covers, dialogs and navigation by ≥ 18px. `bg` shadows may extend beneath opaque cards; local card lighting paints below foreground ink.
- Subscribe to S0 `page-change`, `day-change`, `week-change`, `month-change`; CSS uses `<html data-skin-event="…" data-skin-dir="next|prev">` valid for **700ms**.
  Directional torch pass ends within **650ms**; its shadow then eases back to base sway independently of attribute lifetime. Do not change URL/date math, duplicate navigation handlers or emit fabricated events.
- Ambient scheduler uses S0's measured free spots and shared 1–2 cap; register seven definitions/cooldowns and swept-box validation, not seven autonomous intervals.
  Reserve due slots for ember bursts/walking figure without exceeding the cap; continuous wall/rim bases are fixed layers, not additional scheduled transients. Cursor tokens remain S0 `--cursor-default / --cursor-pointer / --cursor-text`.
- Cleanup on skin change/unmount: remove effects, cancel timers/RAF/listeners, release image/canvas references; restore no shared styles manually. Dot remains default and visually unchanged.
- Assets: `web/public/wallpapers/thinker/` six local WebP composites plus small contour art and CREDITS; `web/public/cursors/thinker/` original cursors.
  No new dependencies; fetch originals/fonts only at build preparation, never at runtime. Credit adapted photo masks too; avoid storing research originals in the shipped bundle.
- Implementation QA: synthetic tests for baseline **and maximally lit** contrast, shared-driver/visibility teardown, priority beats/caps/occlusion, first-mount versus change motion, route crops and cursor fallbacks; mock fetch.
  Run `bun run check` and `bun run build:web`; then screenshot Calendar (2026-10-21), Insights and Settings at 1440/390 plus Library/work/Review/Search/Add.
- Use the task-assigned Vite port and provided `scripts/shots.ts`, compare Dot and Thinker: overflow **0**, blocked controls no increase, inspect all PNGs and the 16-frame sequence.
  Verify card rims visibly flicker, both large shadows sway, bursts/walks appear on phone, bars rise and digits ignite without ink washout; measure maximum lit-surface AA and fixed focus/control contrast, plus motion/visibility budgets.
- This TH-a deliverable is a brief, not implementation; this manager revision changes **only this DESIGN section**, preserving existing research notes/previews. Runtime assets, effects and screenshot QA belong to build workers.

## Aesthetic Direction: Calm Nocturnal Reading Room & Personal Archive (v2.2)

InputTracker is both a daily media log and a **long-term personal archive** of everything watched, read, and listened to. Design A v2.2 refines the reading-room aesthetic around six core principles:

1. **Named app skins (`web/src/lib/theme.ts`, `web/src/styles/tokens.css`):**
   - The five original dark palettes remain, alongside Hermes, Workbench, CWM (monochrome light), and Signal. Settings › Appearance has live miniature skin previews. Choices persist in `localStorage` (`inputtracker.theme`); Vite embeds the registry's bootstrap in the head before first paint. Unset/invalid preferences still use `espresso`.
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
  - **Appearance:** Nine skin preview tiles, with native keyboard-selectable radios.
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

## Work artwork gallery (W18)

`WorkArt.tsx` / `work-art.css` add a full-width Art section immediately after the hero, before
seasons and the existing Rating/History row. A contained large image preserves the full poster or
backdrop without cropping; the fixed 16:9 stage (4:3 on phones) and thumbnail sizes reserve space.
Wide imagery is featured first, otherwise the largest known image. Images load lazily through
local `/api/meta-art` URLs only; failed images are removed and empty/unavailable art has no box.
Native thumbnail buttons expose selection, and the featured button opens a full-screen native
modal dialog: the shell becomes inert, Tab/Shift-Tab cycle controls, Esc closes, arrows navigate,
and closing restores focus. All colours/geometry use theme tokens; reduced motion removes the
selection transition. CSS targets 375px and 1440px without changing home/shell styles.

## Themes

`theme.ts` owns IDs, labels, validation, persistence and category colours. Each new skin lives in `web/src/styles/themes/<id>.css`, imported by `index.css`. Preview scopes (`.theme-preview[data-theme]`) reset to the default tokens then use the same overrides as `:root[data-theme]`; there is no second preview design.

- **Original palettes:** espresso (walnut/terracotta, default), midnight (navy/sky), forest (pine/sage), obsidian (carbon/gold), plum (aubergine/rose). Existing saved choices and reading-room geometry remain supported.
- **Hermes:** engraved ink navy, tall condensed uppercase stacks, tracked navigation, sharp rectangles and one electric-blue action block. Fine conic rays behind page headers; numerical data is mono. AA blue links are distinct from the darker electric block's white labels.
- **Workbench:** tiled original SVG circuit tracks, bitmap-style mono stacks, square controls, light/dark inset bevels, card title bars and taskbar-like navigation. Segmented progress fills evoke desktop meters.
- **CWM:** white/black terminal panes, zero radius, hard black edges and dense original dithered lozenges. Key/value labels and ten ANSI category fills; bright ANSI hues use black text instead of failing contrast on white. Status controls and fallback covers stay monochrome.
- **Signal:** near-black procedural particle grain, mint widely tracked typewriter headings, bracket-corner mono labels and one thin rounded content frame. Opaque quiet cards protect text from the texture.

Skin tokens (in addition to existing colour/spacing/type tokens):
- Type: `--font-body`, `--font-display`, `--font-numbers`, `--font-mono`; `--display-case`, `--display-tracking`, `--display-weight`, `--display-stretch`, `--display-color`, `--label-case`, `--label-tracking`, `--font-smoothing`. Legacy `--font-serif`/`--font-sans` aliases also change so existing pages inherit the skin. No fonts are downloaded.
- Geometry: `--radius-xs/sm/md/lg/xl/full`, `--border-width/style`; `--card-border/shadow/shadow-raised`, `--card-title-bg/color/padding/border/shadow`, `--control-shadow`, `--input-shadow`, `--nav-shadow/item-shadow/active-bg/active-color`, `--cover-sheen`.
- Canvas: `--wallpaper`, `--wallpaper-size/position/repeat`, `--header-art`, `--texture-overlay/size/opacity`, `--content-frame/radius`. All artwork is local CSS or inline SVG; textures are static and never intercept input.
- Data/accessibility: `--chart-radius/svg-radius/svg-inner-radius/cell-radius/fill-image/fill-shadow/linecap`, `--icon-stroke/cap/join`, `--focus-width/style/offset`, `--scrollbar-thumb/track/radius`. Numeric data uses tabular figures; reduced-motion disables motion globally. Theme changes do not alter the spacing scale or shell widths.

---

## Home page (`#/calendar`, W17 — `web/src/pages/Calendar.tsx`, `web/src/ui/home/`, `web/src/lib/home*.ts`, `web/src/styles/home.css`)

1. **Phone-first, balanced desktop:** Below the compact header/category filters, rolling pills are the main element, followed by selected-day detail and the month summary. Desktop (`>=1024px`) puts pills + day panel left and month summary right, with no sticky tall inspector. The month calendar grid and **In the middle of** shelf are removed; Library's **In Progress** filter is the place to continue works.

2. **Rolling seven-day pills (`WeekGraph.tsx`, `home-norm.ts`):** Oldest at left, today at right by default; never Monday–Sunday. Each shows total above a minute-proportional category stack, weekday/date below, and an outline for selection. Tapping selects without moving the window. ‹/› move its end by seven local dates, clamped at today; the forward button is disabled there. A valid `?date=YYYY-MM-DD` selects that day at the right end (future links clamp at today). Local-date arithmetic is DST-safe; month-boundary windows fetch both months.

3. **Compared with your norm:** Each faint marker is the median of that weekday's eight preceding occurrences, including zero-activity days. Fewer than four available occurrences use the preceding 30 available days' median. Dates before `SeriesResult.history_start` are not invented observations; the target day is excluded. All seven pills fetch their full lookback (62 days before the window end). Bars and markers share one scale, including a 60-minute floor and the highest norm, so markers never clip. Two plain sentences show today's (or the historical selected day's) comparison and the window total vs the sum of seven norms: **Today 2h 2m · 40 min more than a usual Tuesday**, **Last 7 days 3h 59m · 1h more than usual**. Inclusive ±10% says **about usual**. Filters apply equally to observed time and norms; hidden/planned works do not count. A history fetch failure shows an error/retry, not a fictitious zero norm.

4. **Month summary (`MonthRhythmCard.tsx`):** Month heading, total, share bar, category pills, daily stacked skyline and previous-month comparison. Month-precision time counts in summary totals and is labelled separately, never assigned an invented day in the skyline. Clicking a skyline day selects it and repositions the rolling window only if necessary. Category filters apply to both months' comparison totals.

5. **Calm day rows:** Real cover art only; otherwise a compact category-coloured icon. YouTube and music always fold into one expandable summary line each, even a single music track. Short-form is one non-expandable **Short-form · 47 min** line with its own colour/icon, zero works, no rating or work actions. Ratings on work/video rows appear only on hover or keyboard focus, without layout jumps; right-click/long-press, Shift+F10 and the More menu remain accessible. The removed shelf's per-row Log buttons are gone; day-level Log and primary Add stay available.

6. **Consistent position and creator:** Audiobook/book position uses `LibraryWork.consumption_progress`: latest ABS snapshot (including resets to zero), otherwise latest session position. Logged minutes remain session sums, not percentage estimates. Day rows and Library meta use the same position. Library creator building shares `parseBookAuthors` with cover lookup, filtering folder/publisher placeholders (Downloads, GraphicAudio, Unknown…) while preserving real authors.

7. **Plain-word headings and accessibility:** Today, Yesterday, or Saturday 17 October; no duplicated date eyebrow. Hash links preserve `date`/`month`/`cat` through `replaceState`. Pills, navigation and skyline use native keyboard-focusable buttons with pressed/current-day labels; norm values are included in each pill's accessible description.
