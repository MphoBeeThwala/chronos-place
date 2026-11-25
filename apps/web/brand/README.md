# Brand assets

From the Chronos Place brand board (2026-11-26): a heart formed by two embracing arms around an
hourglass. Mulberry Plum `#4b223d`, Terracotta Rose `#d45b6a`; the full palette is in
`packages/ui/src/tokens`.

- `mark.svg`: the logo mark on a transparent background (the `Logo` component draws the same paths).
- `app-icon.svg`: the app icon (terracotta-to-coral tile, light mark).

The PNGs in `public/icons/` and `src/app/icon.png` / `src/app/apple-icon.png` are rendered from
`app-icon.svg` at 512, 192, 64 and 180 px. To re-render after a change, use any SVG renderer
(for example sharp, which the profile service already depends on).

The icon and the web manifest carry no words about health, so a home screen or app list says
nothing about a member's condition.
