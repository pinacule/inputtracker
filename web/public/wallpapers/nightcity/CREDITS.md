# Night City wallpaper credits

These are licensed photographs graded toward an anime night-background palette,
not anime illustrations or screenshots. Full-resolution originals and intermediate
files are kept outside production in `.task/originals/`.

## Desktop — skyline-desktop.webp

- Source: [Hong Kong Night Skyline non-HDR](https://commons.wikimedia.org/wiki/File:Hong_Kong_Night_Skyline_non-HDR.jpg).
- Author: **Base64**.
- Licence: [Creative Commons Attribution-ShareAlike 3.0 Unported](https://creativecommons.org/licenses/by-sa/3.0/).
- This edited image is shared under the **same CC BY-SA 3.0 licence**. Attribute
  Base64, link the source and licence, and retain this change notice when sharing.
- Changes: central 3200 × 2000 crop at x=735; resized to 1920 × 1200;
  readable rooftop commercial signs replaced by plain dark panels; softened fine
  detail, reduced warm saturation, navy shadows, cyan bloom and restrained magenta;
  exported as a local WebP. No photographed rain was added or claimed.
- Export: **201,338 bytes**, 1920 × 1200, WebP quality 78.

## Phone — street-phone.webp

- Source: [Alone in Tokyo III](https://commons.wikimedia.org/wiki/File:Alone_in_Tokyo_III_(47956673191).jpg).
- Author: **Romain Guy**, [photographer](https://www.flickr.com/people/romainguy/).
- Licence: [CC0 1.0 Universal Public Domain Dedication](https://creativecommons.org/publicdomain/zero/1.0/).
- Changes: 2634 × 5707 portrait crop at x=750; resized to 1080 × 2340;
  commercial signs and flag replaced by plain dark perspective panels; softened
  detail, reduced warm saturation, navy shadows and cyan light/reflection bloom;
  retained the anonymous back-facing umbrella figure; local WebP export.
- Export: **145,878 bytes**, 1080 × 2340, WebP quality 76.

## Original code-drawn scenery

The static SVG silhouette planes, sparse rectangular windows and fictional
`夜の街`, `未来`, `電脳` signs in `city.svg` and `web/src/skins/nightcity/city.ts` are original
InputTracker artwork, distributed with the project. They do not trace the photo
or copy commercial signage. Sign glyphs use the locally bundled Noto Sans JP 700
subset, licensed under SIL OFL 1.1; see `/fonts/nightcity/LICENSE.md`.

Both photos are local; media-query selection fetches only the phone image below
768px, including the Settings miniature. If a photo is unavailable, the navy
gradient, SVG skyline, windows and signs remain. No runtime external assets.
