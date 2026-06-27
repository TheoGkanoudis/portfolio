# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start the Vite dev server.
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built `dist/` locally.

There are no tests, linter, or formatter configured.

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes `dist/` to GitHub Pages. `vite.config.ts` sets `base: "./"` so assets resolve under the Pages subpath. The build needs `VITE_OWM_API_KEY` — provided locally via `.env` (gitignored) and in CI via the repo secret of the same name.

## Architecture

A single-page visualization (no framework) that renders the viewer's current geographic location as a stack of aligned map layers with real-time lighting. Effectively all logic lives in `src/main.ts`; `index.html` defines the layer DOM and `src/style.css` styles/positions it. The only runtime dependencies are MapLibre GL (map rendering) and SunCalc (sun position).

### Layer stack

`index.html` declares overlapping absolutely-positioned divs inside `#map-container`, each a separate MapLibre map or a masked overlay, all centered on the same lat/lng at `MAP_ZOOM`:

- `#map` — ArcGIS World Imagery satellite raster (bottom).
- `#map-clouds` (inside `#parallax-clouds`) — OpenWeatherMap `clouds_new` raster.
- `#night-overlay` — darkness overlay for night.
- `#sunset-overlay` — warm tint near the terminator.
- `#map-lights` — NASA VIIRS night-lights raster, shown only where dark.

### Location flow

`locationInit()` resolves position from a `localStorage` cache (`cachedPosition`, valid 10 min) or the Geolocation API, then calls `getMap()`. An IIFE at module load (`initLightnessEarly`) reads the cached position synchronously to set the `--lightness` CSS variable before paint, avoiding a flash. `main()` is the entry point, run on `DOMContentLoaded` (or immediately if the DOM is already parsed).

### Lighting model

Sun altitude (via SunCalc) drives everything time-of-day. Per-effect functions (`altitudeToCityLightsOpacity`, `altitudeToDarkOverlayOpacity`, `altitudeToSunsetOverlayOpacity`, `computeLightness`) map altitude in degrees to opacity using smoothstep easing over hand-tuned degree thresholds around the horizon. The three overlays (dark / sunset / city-lights) are **painted `<canvas>` layers**, not CSS masks — see below. `buildSampleGrid()` ray-samples the static visible area into a screen-pixel→lat/lng grid once (`SCREEN_PX_PER_MASK_SAMPLE = 4`), and `computeOverlayAlphas()` does one SunCalc pass over that grid to produce per-pixel alpha for a given time. `isAnyDarknessVisible()` samples a 5×5 grid to decide whether the night-lights map is needed at all.

### Overlay rendering (canvas, not mask-image)

Each overlay element (`#night-overlay`, `#sunset-overlay`, `#map-lights`) gets a child `<canvas>` (`makeOverlayLayer`) whose RGB is fixed — a flat tint (black / orange) or, for city-lights, a one-off snapshot of the night-lights imagery — and only the **alpha channel** is rewritten per frame, then blitted with `putImageData`. This replaced CSS `mask-image`, which flashed: swapping a mask-image URL makes the browser paint the element unmasked for one frame (a full-screen flash of the solid overlay), and decoding the new image first did not fix it. `putImageData` is synchronous, so the canvas always holds valid pixels — no unmasked frame. `makeOverlayLayer` also forces the container's `background` transparent in JS, since the canvas now supplies the colour (a solid CSS background would show through the canvas's transparent daytime areas).

The city-lights imagery comes from `snapshotNightLights()`: the NASA night-lights map is rendered **offscreen** (`ensureNightMap` builds it in an off-screen div with `canvasContextAttributes.preserveDrawingBuffer`), its WebGL canvas is read back once via `drawImage`/`getImageData` into the layer's RGB, and the map is then removed. Rendering it offscreen avoids flashing the raw unmasked imagery; snapshotting + removing frees the WebGL context.

### Real-time terminator animation

`startTerminatorUpdates()` keeps the overlays current as time passes. It holds two alpha keyframes ~1 minute apart (`SUN_KEYFRAME_INTERVAL_MS`) and, every `OVERLAY_REPAINT_INTERVAL_MS` (2 s), linearly interpolates between them and repaints (`paintOverlay`) — so the terminator drifts smoothly rather than snapping once a minute. Only the keyframe recompute runs SunCalc; in-between steps are a cheap alpha lerp + synchronous blit into reused canvases. At each minute boundary the new `from` keyframe equals the old `to` (both are "now"), so the hand-off is seamless. The loop skips work when `document.hidden`, freezes when `DEBUG_TIME` is set, and the night-lights snapshot is acquired lazily (`acquireNightLights`) the first time darkness appears (so a page left open into dusk lights up). Body `--lightness` is updated on the same tick.

### Readiness gating

`getMap()` uses a "gate" pattern: each layer that must paint registers a promise resolved on its MapLibre `idle` event. The night gate is resolved from inside `startTerminatorUpdates()` (via `acquireNightLights`) — immediately if no darkness is visible, otherwise after the night-lights snapshot is taken. `#map-container` starts at `opacity: 0` and only gets the `.show` class — fading in — once `Promise.all` of every gate resolves, so the user never sees layers pop in one at a time.

### Cloud rendering

OWM cloud tiles have visible seams (per-tile cloud values) and low resolution. Two mitigations in `installCloudAlphaBoostFilter()` and the cloud source config: an inline SVG filter (`#cloud-alpha-boost`, wide Gaussian blur + alpha transfer curve) smooths seams and shapes opacity, and `maxzoom: 6` forces MapLibre to overzoom/upsample rather than fetch pixelated deeper tiles.

### Conventions / gotchas

- **Debug toggles** at the top of `main.ts`: `DEBUG_LOCATION` (force coordinates), `DEBUG_TIME` (force a Date for lighting), and `DEBUG_LAYERS` (enable/disable each layer). Leave these at their disabled defaults unless debugging.
- `initCloudParallax()` drifts the cloud layer with the mouse; it was previously flagged as temporary scaffolding, so confirm it's still wanted before building on it.
- MapLibre tile-fetch errors are intentionally silenced via `silenceTileFetchNoise()`; only non-AJAX errors reach the console.
