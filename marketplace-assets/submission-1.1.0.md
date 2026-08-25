# Marketplace submission 1.1.0

## Release notes

Added a bundled Stream Deck XL Model Selector with 15 Sol, Terra, and Luna
combinations across five thinking levels. The active selection is highlighted,
choices apply to the visible ChatGPT task or a new Composer, and the new live
Fast Mode key toggles the targeted task in place.

## Uploads

- Product file: `dist/com.lukas-bhm.fingertip.streamDeckPlugin`
- Thumbnail: `marketplace-assets/thumbnail.png`
- Gallery: `marketplace-assets/gallery-1-live-status.png` through
  `marketplace-assets/gallery-7-model-selector.png`

All Marketplace images are English-language 1920×960 PNG files. The new Model
Selector image uses the supplied high-resolution selector capture stored at
`scripts/marketplace-assets/bases/model-selector-ui.png`.

## Release checklist

- `npm run check`
- `npm run build`
- `npm run pack:model-selector-profile`
- `npx streamdeck validate com.lukas-bhm.fingertip.sdPlugin`
- `npx streamdeck pack com.lukas-bhm.fingertip.sdPlugin --output dist`
