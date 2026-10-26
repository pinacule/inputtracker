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

_Filled in by task S0: how skins add wallpapers, ambient loops, cursors and transitions._

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

_Design brief: task RW-a._

## Skin: Thinker (TH)

_Design brief: task TH-a._

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
