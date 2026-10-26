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

_Design brief: task NC-a._

## Skin: Rewind (RW)

_Design brief: task RW-a._

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
