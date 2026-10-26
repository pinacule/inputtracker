# Thinker artwork credits

Six fixed WebP scenes are local derivatives, not untouched museum photographs.
Portrait subjects are never stretched, mirrored or substituted for work cover art.
The original cave wall, sparse veins and tall fire-cast figure were drawn for
InputTracker. Changes: hand-traced isolation, removal of museum architecture,
labels and display mounts, cropping, reduced saturation, directional warm-left /
cool-right grading, enlarged contour shadow, compositing and soot vignette.
Desktop outputs are 2400 × 1500; phone outputs are 1000 × 1600. Only the
media-selected variant is loaded. No photo originals ship with the application.

## The Thinker

- Files: `thinker-desktop.webp`, `thinker-phone.webp`, `thinker-detail.webp`, `thinker-shadow.webp`, `thinker-contour.svg`.
- [Source page](https://commons.wikimedia.org/wiki/File:The_Thinker_(Le_Penseur)_MET_1447.jpg)
  and [museum record](https://www.metmuseum.org/art/collection/search/209021).
- Detail rebuilt from the museum's [full-resolution original](https://images.metmuseum.org/CRDImages/es/original/1447.jpg)
  (1460 × 1864), rather than a pregraded scene crop.
- Photograph: The Metropolitan Museum of Art, Open Access; individual
  photographer not identified. Sculpture: Auguste Rodin, 1904.
- Medium: **plaster**, including the rock seat; **not marble**. The rectangular
  museum display plinth and architecture are removed.
- Photograph and adapted scenes/contour: **CC0 1.0**,
  https://creativecommons.org/publicdomain/zero/1.0/.

## Victor Hugo

- Files: `hugo-desktop.webp`, `hugo-phone.webp`, `hugo-detail.webp`, `hugo-shadow.webp`, `hugo-contour.svg`.
- [Source page](https://commons.wikimedia.org/wiki/File:Victor_Hugo_buste_marbre_Mus%C3%A9e_Rodin_S.00464_Paris.png).
- Photographer/image improvements: **Jebulon**. Sculpture: Auguste Rodin, 1889.
- Medium: **marble**. Tabletop removed; original carved bust base retained.
- Photograph and adapted scenes/contour: **CC0 1.0**,
  https://creativecommons.org/publicdomain/zero/1.0/.

## Plato

- Files: `plato-desktop.webp`, `plato-phone.webp`, `plato-detail.webp`, `plato-shadow.webp`, `plato-contour.svg`.
- [Source page](https://commons.wikimedia.org/wiki/File:Marble_bust_of_the_Greek_philosopher_Plato,_Roman_copy_(1st_century_CE)_of_an_original_(350-340_BCE)._Altes_Museum,_Berlin.jpg).
- Photographer: **Osama Shukir Muhammed Amin FRCP(Glasg)** (Neuroforever).
- Sculpture: unidentified Roman maker, first-century CE copy of a Greek original
  from 350–340 BCE, Altes Museum, Berlin. Medium: **weathered marble**.
- Photograph **CC BY-SA 4.0**. These adapted composites and photo-derived contour,
  including their original cave composition, are distributed under the **same
  CC BY-SA 4.0 licence**: https://creativecommons.org/licenses/by-sa/4.0/.
  Isolation removes the blue museum surround and display mount; crop, colour
  grade and shadow composition are changes. No endorsement is implied.

## Original contour / wall art

`figure.svg`, `figure-shadow.webp` and `veins.svg`: original InputTracker artwork, **CC0 1.0**,
https://creativecommons.org/publicdomain/zero/1.0/. The three sculpture contours
inherit the corresponding photograph licence above. Contours share the same
coordinates as the photographic masks for the subsequent effects implementation.

## TH-c isolated details

`thinker-detail.webp` and `hugo-detail.webp` are rebuilt from the original museum
photographs (1460 × 1864 and 3925 × 5887 respectively). Clean narrow-edge masks
retain the entire head, anatomy and carved surface; the display plinth/table are
removed. Low-left ember/ivory lighting retains local surface detail, with a deep
brown-black opposite side and a soft base falloff. Both remain CC0 1.0.
`plato-detail.webp` is unchanged: cropped from the already-local phone scene,
with the wall isolated into transparency and ivory exposure raised / saturation
reduced. It remains CC BY-SA 4.0. The same alpha contour masks the warm side light and
casts the moving wall shadow; the photograph never stretches. These compact
details serve both heading sizes / phone and desktop gutters without downloading
a desktop composite on a phone. Original scene variants remain for previews.
`*-shadow.webp` bake 8px softness into each detail's same photo-derived alpha;
`figure-shadow.webp` bakes 10px softness into the original figure silhouette.
Moving projection transforms do not recalculate blur. They inherit the licences
listed above, including CC BY-SA 4.0 for Plato's photo-derived shadow.
`web/public/cursors/thinker/*.svg` are original InputTracker drawings, CC0 1.0.
