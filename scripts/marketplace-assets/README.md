# Marketplace hardware artwork

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
