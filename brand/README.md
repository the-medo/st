# S.T. Seam

Seam is the S.T. mark: two rounded forms separated by an open S-shaped seam,
with a horizontal opening that suggests the T. The editable master is
[st-seam.svg](st-seam.svg); its two paths use `currentColor` and have no font
or raster dependencies. Keep its square aspect ratio and clear space.

| Surface | Transparent mark | App/browser tile |
| --- | --- | --- |
| Light | [st-logo-light.svg](st-logo-light.svg), [PNG](st-logo-light.png) — dark ink | [favicon-light.svg](favicon-light.svg), [512px PNG](st-icon-light.png) |
| Dark | [st-logo-dark.svg](st-logo-dark.svg), [PNG](st-logo-dark.png) — ivory | [favicon-dark.svg](favicon-dark.svg), [512px PNG](st-icon-dark.png) |

Suffixes describe the **background**, not the mark's colour. Transparent PNGs
are 1024px. [favicon.svg](favicon.svg) switches with the browser's colour
scheme; PNG, Apple touch and Windows ICO fallbacks use a self-contained ivory
tile that stays legible against either background. The ICO contains 16, 24,
32, 48, 64, 128 and 256px images.

Edit the master, then run from the repository root:

```sh
python3 scripts/generate-brand.py --raster
python3 scripts/generate-brand.py --check
```

Raster regeneration requires `rsvg-convert` from librsvg. Without `--raster`,
the script regenerates the SVGs and copies the existing PNG/ICO exports.
`--check --raster` also compares regenerated raster exports.

The script synchronizes the React and legacy consoles, faceplate, Windows
shortcuts, legacy tray and repository favicon. The consoles' `/st-logo.svg` remains an alias
for the ivory mark for existing planner integrations. The faceplate imports
its assets through Vite so they are versioned and cached for offline use.
The native Windows package includes `st-icon.ico` beside the executable; its
Start menu controls use that icon. The legacy Python client's 64px tray icon
lives beside `client.py`. Ovis and third-party service marks retain their own identity.
