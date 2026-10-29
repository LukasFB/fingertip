# Marketplace artwork — Codex + T3 Code

The current upload set contains eight English-language 1920×960 PNGs in
`marketplace-assets/`: the thumbnail and galleries 1–7. Run both commands:

```sh
npm run generate:marketplace-assets
npm run generate:release-gallery
```

Copy, typography and shared layout primitives live in `artwork.mjs`; inspector
and model-key compositions live in `../generate-release-gallery.mjs`.

`npm run generate:marketplace-assets` rebuilds the four marketplace images that
contain Stream Deck hardware. It uses the same `renderSnapshotDataUrl()` path as
the plugin, rasterizes the SVGs with WebKit, and projects one complete 5×3 panel
onto each hardware shot.

The approved panel geometry and the per-image perspective corners live in
`perspective.json`. Gallery 1 is the manually approved reference. The remaining
hardware placements are registered to that reference instead of being tuned as
independent perspective shapes:

- Gallery 2 uses the identical hardware pixels translated by `(0, 20)`.
- Gallery 3 uses the identical hardware pixels translated by `(-745, 40)`.
- The thumbnail uses the same hardware at `96.424%` horizontal and `96.392%`
  vertical scale, translated by `(-726.74, 23.755)` after scaling.

Do not replace the global panel projection with per-key transforms or tune
equivalent hardware shots as unrelated quadrilaterals.

The immutable source artwork is stored in `bases/`, so repeated runs never use a
previously generated output as their input.

Requirements: macOS, Xcode command-line tools, Node.js 24+, and ImageMagick.

`npm run generate:release-gallery` rebuilds three version-stamped settings images
and `gallery-7-model-keys.png`. It replaces the obsolete generated Model Selector
image, while retaining its historical source capture in `bases/`.

Settings are rendered from the shipping Property Inspector HTML with synthetic
data at 2× resolution. The fixture selects T3 Code and shows a shared connection;
it never connects to a real server, opens the Stream Deck app or reads credentials.
The model-key artwork uses the production `renderModelKeyDataUrl()` renderer.
These are illustrative product compositions, not screenshots of a user's account.

Keep the capability boundaries visible: line-change statistics and queue badges
are Codex-only. Hardware samples 1–7 illustrate Codex; samples 8–15 illustrate T3
and omit those badges. T3 model targeting uses the most recently visited thread
with a single-window assumption. Fast Mode is provider-dependent. Do not restore
the former fixed Sol/Terra/Luna selector or its XL-only requirement.

After generation, inspect all eight images for clipping, readable copy and correct
key placement. The hardware geometry above must remain unchanged. The generator
checks for blank raster output; use ImageMagick `identify` to verify dimensions.
The submission draft for this asset set is `marketplace-assets/submission-1.2.0.md`.
The release-gallery command also assembles `marketplace-assets/previews/overview.png`
from the eight images for review; that contact sheet is not a Marketplace upload.
