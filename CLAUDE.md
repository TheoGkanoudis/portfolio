# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Code style

- Instead of comments, write readable and self-explanatory code.
- Prefer an object-centered approach where applicable and logical
- prefer to solve things through css instead of js (.hide class instead of js hide)
- avoid doing excessive styling, instead leave that up to the user

## Commands

- `npm run dev` — start the Vite dev server.
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/` locally.

There are no tests, linter, or formatter configured.

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes `dist/` to GitHub Pages. `vite.config.ts` sets `base: "./"` so assets resolve under the Pages subpath. No API keys are required at build or runtime (the cloud layer uses RainViewer, which is keyless).

## Architecture

A single-page visualization (no framework) that renders the viewer's current geographic location as a stack of aligned map layers with real-time lighting. `src/main.ts` is the lean entry point — bootstrap, geolocation, and the `localStorage` position cache — and hands coordinates to `src/map.ts`, which holds the whole visualization engine (layer stack, lighting model, overlays, clouds, terminator animation). `index.html` defines the layer DOM and `src/style.css` styles/positions it. The only runtime dependencies are MapLibre GL (map rendering) and SunCalc (sun position).

### Layer stack

`index.html` declares overlapping absolutely-positioned divs inside `#map-container`, each a separate MapLibre map or a masked overlay, all centered on the same lat/lng at `MAP_ZOOM`:

- `#map` — ArcGIS World Imagery satellite raster (bottom).
- `#map-clouds` (inside `#parallax-clouds`) — DWD Meteosat satellite cloud raster (luminance-keyed).
- `#night-overlay` — darkness overlay for night.
- `#sunset-overlay` — warm tint near the terminator.
- `#map-lights` — NASA VIIRS night-lights raster, shown only where dark.
- `#cloud-blur` — a `backdrop-filter: blur()` layer masked to cloud coverage, so the layers beneath read as softly out-of-focus under dense cloud (see _Cloud blur_).

### Location flow

`locationInit()` (in `main.ts`) resolves position from a `localStorage` cache (`cachedPosition`, valid 10 min) or the Geolocation API, then calls `renderMap()` (in `map.ts`). An IIFE at module load (`initLightnessEarly`) reads the cached position synchronously to set the `--lightness` CSS variable before paint, avoiding a flash. `main()` is the entry point, run on `DOMContentLoaded` (or immediately if the DOM is already parsed).

### Lighting model

Sun altitude (via SunCalc) drives everything time-of-day. Per-effect functions (`altitudeToCityLightsOpacity`, `altitudeToDarkOverlayOpacity`, `altitudeToSunsetOverlayOpacity`, `computeLightness`) map altitude in degrees to opacity using smoothstep easing over hand-tuned degree thresholds around the horizon. The three overlays (dark / sunset / city-lights) are **painted `<canvas>` layers**, not CSS masks — see below. `buildSampleGrid()` ray-samples the static visible area into a screen-pixel→lat/lng grid once (`SCREEN_PX_PER_MASK_SAMPLE = 4`), and `computeOverlayAlphas()` does one SunCalc pass over that grid to produce per-pixel alpha for a given time. `isAnyDarknessVisible()` samples a 5×5 grid to decide whether the night-lights map is needed at all.

### Overlay rendering (canvas, not mask-image)

Each overlay element (`#night-overlay`, `#sunset-overlay`, `#map-lights`) gets a child `<canvas>` (`makeOverlayLayer`) whose RGB is fixed — a flat tint (black / orange) or, for city-lights, a one-off snapshot of the night-lights imagery — and only the **alpha channel** is rewritten per frame, then blitted with `putImageData`. This replaced CSS `mask-image`, which flashed: swapping a mask-image URL makes the browser paint the element unmasked for one frame (a full-screen flash of the solid overlay), and decoding the new image first did not fix it. `putImageData` is synchronous, so the canvas always holds valid pixels — no unmasked frame. `makeOverlayLayer` also forces the container's `background` transparent in JS, since the canvas now supplies the colour (a solid CSS background would show through the canvas's transparent daytime areas).

The city-lights imagery comes from `snapshotNightLights()`: the NASA night-lights map is rendered **offscreen** (`ensureNightMap` builds it in an off-screen div with `canvasContextAttributes.preserveDrawingBuffer`), its WebGL canvas is read back once via `drawImage`/`getImageData` into the layer's RGB, and the map is then removed. Rendering it offscreen avoids flashing the raw unmasked imagery; snapshotting + removing frees the WebGL context.

### Real-time terminator animation

`startTerminatorUpdates()` keeps the overlays current as time passes. It holds two alpha keyframes ~1 minute apart (`SUN_KEYFRAME_INTERVAL_MS`) and, every `OVERLAY_REPAINT_INTERVAL_MS` (2 s), linearly interpolates between them and repaints (`paintOverlay`) — so the terminator drifts smoothly rather than snapping once a minute. Only the keyframe recompute runs SunCalc; in-between steps are a cheap alpha lerp + synchronous blit into reused canvases. At each minute boundary the new `from` keyframe equals the old `to` (both are "now"), so the hand-off is seamless. The loop skips work when `document.hidden`, freezes when `DEBUG_TIME` is set, and the night-lights snapshot is acquired lazily (`acquireNightLights`) the first time darkness appears (so a page left open into dusk lights up). Body `--lightness` is updated on the same tick.

### Readiness gating

`renderMap()` uses a "gate" pattern: each layer that must paint registers a promise resolved on its MapLibre `idle` event. The night gate is resolved from inside `startTerminatorUpdates()` (via `acquireNightLights`) — immediately if no darkness is visible, otherwise after the night-lights snapshot is taken. `#map-container` starts at `opacity: 0` and only gets the `.show` class — fading in — once `Promise.all` of every gate resolves, so the user never sees layers pop in one at a time.

A `#loader` spinner covers the screen until then. It is defined inline in `index.html` (markup + CSS in the head `<style>`, no JS/asset dependency) so it paints on the very first frame, and is marked `visibility: visible` to stay shown while the `data-loaded` gate keeps the rest of `body` hidden. `revealWhenReady()` (the `Promise.all` callback) adds `.hidden` to fade it out and removes it on `transitionend`, crossfading into the map. Note there is no timeout — the loader's lifetime is exactly the reveal's, so a tile source that never settles would keep it visible (same risk the reveal already had).

### Cloud rendering

The cloud source is **chosen by the viewer's longitude** in `cloudSourceFor()`, because no single keyless feed covers the whole globe well:

- **Europe / Africa / Atlantic** (`-70°..60°`): DWD's free Meteosat mosaic (`Satellite_meteosat_1km_euat_rgb_day_hrv_and_night_ir108_3h` — real clouds, 1 km, day HRV + night IR, ~15 min). Served as a **WMS** whose tile URL ends in `&bbox={bbox-epsg-3857}` (MapLibre fills the placeholder per tile), so **no runtime fetch**. This is the sharpest source; it just happens to be regional (Meteosat is geostationary at 0°, and DWD crops to the `euat` window).
- **Everywhere else**: NASA GIBS **Band13 "Clean Infrared"** from the nearest geostationary satellite — `GOES-West` / `GOES-East` / `Himawari` (picked by longitude). Keyless WMTS XYZ (`/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`; `time=default` = latest, so still no metadata fetch). Near-global, transparent off the satellite disk. The weakest seam is ~60–80°E (India / W. Indian Ocean), between Meteosat and Himawari. _Why IR, not GIBS GeoColor:_ GeoColor is true-colour, so bright deserts/snow would key as false clouds, and it isn't published in Web Mercator for Himawari; single-band IR reads cold cloud tops as bright over a dark surface, matching the luminance pipeline. _(RainViewer, referenced in older docs, discontinued its public satellite feed — radar only now.)_

All sources are opaque-ish imagery (clouds bright, clear sky dark), not ready-made transparent overlays. `installCloudAlphaBoostFilter(alphaTable)` builds the inline SVG filter `#cloud-alpha-boost` (set on `#map-clouds`) that converts brightness into a white cloud veil: `feColorMatrix type="luminanceToAlpha"`, a `feComponentTransfer` table (`alphaTable`) that thresholds out the dim floor and ramps clouds up (capped <1), a small `feGaussianBlur` for seams, then `feFlood` white + `feComposite operator="in"`. The table is **source-dependent** (`cloudSourceFor` returns it): IR clear sky is mid-grey rather than black, so the IR table starts its ramp later than the DWD one. `maxzoom` overzooms the coarse source (7 for DWD, 6 for the GIBS IR layers).

### Cloud blur

`#cloud-blur` makes the layers below it (satellite + the lighting/night-lights overlays) read as out-of-focus under dense cloud. It is a plain `backdrop-filter: blur()` element placed **above** `#map-lights` in paint order, so its backdrop is the full composited stack beneath it. A `backdrop-filter` is _not_ shaped by the element's own content alpha — only by a CSS `mask` — so the cloud shape has to be supplied as a mask: `installCloudBlurMask()` reads the loaded cloud canvas back (the cloud map sets `preserveDrawingBuffer: true` for this), converts cloud luminance into an alpha coverage ramp (`smoothstep` over `COVERAGE_LOW..HIGH`), and installs the result as the element's `mask-image`. Where the mask is opaque the backdrop is blurred; over clear sky / outside the DWD footprint the mask is transparent and the blur vanishes. The element starts with a fully-transparent CSS mask so it does nothing until the snapshot lands. `#cloud-blur` mirrors `#map-clouds`'s geometry (`inset: -10%; 120%`) and `initCloudParallax()` applies the **same** drift transform to both, so the mask stays registered with the veil. Note this is the keyless reuse of the `snapshotNightLights()` readback trick; the mask is captured once (clouds are static after load, since runtime tile updating was removed).

### Conventions / gotchas

- **All tunable values live in the exported `SETTINGS` object at the top of `main.ts`** (zoom, intervals, lighting/overlay thresholds, tile-source URLs, cloud alpha tables, etc.); `map.ts` imports `SETTINGS` and reads from it. This is a deliberate import cycle (`main` ⇄ `map`) — it's safe only because `map.ts` touches `SETTINGS` solely inside functions, never at module top level. Debug toggles live under `SETTINGS.debug`: `location` (force coordinates), `time` (force a Date for lighting), `timeScale`, and `layers` (enable/disable each layer). Leave these at their defaults unless debugging.
- `initCloudParallax()` drifts the cloud layer with the mouse; it was previously flagged as temporary scaffolding, so confirm it's still wanted before building on it.
- MapLibre tile-fetch errors are intentionally silenced via `silenceTileFetchNoise()`; only non-AJAX errors reach the console.
