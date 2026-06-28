import "./style.css";
import maplibregl from "maplibre-gl";
import * as SunCalc from "suncalc";

const MAP_ZOOM = 9;

var DEBUG_LOCATION: [number, number] | null = null 
//DEBUG_LOCATION = [37.76768397896848, -122.43518534355537] // San Francisco
//DEBUG_LOCATION = [51.5074, -0.1278] // London
//DEBUG_LOCATION = [37.9838, 23.7275] // Athens
//DEBUG_LOCATION = [48.198514822371735, -106.62992896455773] // Glagow, MT
const DEBUG_TIME: string | null = null;
const DEBUG_TIME_SCALE = 1;

const DEBUG_LAYERS = {
    satellite: true,
    nightEarth: true,
    clouds: true,
    sunsetOverlay: true,
};

const SCREEN_PX_PER_MASK_SAMPLE = 4;
const SUN_KEYFRAME_INTERVAL_MS = 60_000;
const OVERLAY_REPAINT_INTERVAL_MS = 2_000;
const MAX_CACHED_POSITION_AGE_MS = 10 * 60 * 1000;

const RAD_TO_DEG = 180 / Math.PI;

function smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
}

function computeLightness(lat: number, lng: number, date: Date): number {
    const LIGHT_LIGHTNESS = 90;
    const DARK_LIGHTNESS = 10;
    const FULL_LIGHT_ALTITUDE_DEG = 0;
    const FULL_DARK_ALTITUDE_DEG = -2;
    const altitudeDeg = SunCalc.getPosition(date, lat, lng).altitude * RAD_TO_DEG;
    if (altitudeDeg >= FULL_LIGHT_ALTITUDE_DEG) return LIGHT_LIGHTNESS;
    if (altitudeDeg <= FULL_DARK_ALTITUDE_DEG) return DARK_LIGHTNESS;
    const darkness = (FULL_LIGHT_ALTITUDE_DEG - altitudeDeg) / (FULL_LIGHT_ALTITUDE_DEG - FULL_DARK_ALTITUDE_DEG);
    return LIGHT_LIGHTNESS + (DARK_LIGHTNESS - LIGHT_LIGHTNESS) * smoothstep(darkness);
}

let virtualClockAnchorReal = 0;
let virtualClockAnchorVirtual = 0;
let virtualClockStarted = false;
function currentDate(): Date {
    if (DEBUG_TIME) return new Date(DEBUG_TIME);
    if (DEBUG_TIME_SCALE === 1) return new Date();
    const realNow = Date.now();
    if (!virtualClockStarted) {
        virtualClockStarted = true;
        virtualClockAnchorReal = realNow;
        virtualClockAnchorVirtual = realNow;
    }
    return new Date(virtualClockAnchorVirtual + (realNow - virtualClockAnchorReal) * DEBUG_TIME_SCALE);
}

function applyLightness(lat: number, lng: number, date: Date = currentDate()): void {
    const value = computeLightness(lat, lng, date);
    document.documentElement.style.setProperty("--lightness", value.toFixed(3));
}

(function initLightnessEarly() {
    if (DEBUG_LOCATION) {
        applyLightness(DEBUG_LOCATION[0], DEBUG_LOCATION[1]);
        return;
    }
    try {
        const cached = localStorage.getItem("cachedPosition");
        if (!cached) return;
        const { coords } = JSON.parse(cached);
        if (typeof coords?.latitude === "number" && typeof coords?.longitude === "number") {
            applyLightness(coords.latitude, coords.longitude);
        }
    } catch {
    }
})();

function main(): void {
    // Signal that the DOM elements and CSS are on the page (independent of the map tile /
    // weather fetches, which complete later and gate the #map-container fade-in).
    document.documentElement.setAttribute("data-loaded", "true");
    locationInit();
    initCloudParallax();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
} else {
    main();
}

function installCloudAlphaBoostFilter(alphaTransferTable: string): void {
    const FILTER_ID = "cloud-alpha-boost";
    const FILTER_REGION_INSET = "-25%";
    const FILTER_REGION_SIZE = "150%";
    const SEAM_BLUR_STD_DEVIATION = "10";

    if (!document.getElementById(FILTER_ID)) {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", "0");
        svg.setAttribute("height", "0");
        svg.style.position = "absolute";

        const filter = document.createElementNS(svgNS, "filter");
        filter.setAttribute("id", FILTER_ID);
        filter.setAttribute("color-interpolation-filters", "sRGB");
        filter.setAttribute("x", FILTER_REGION_INSET);
        filter.setAttribute("y", FILTER_REGION_INSET);
        filter.setAttribute("width", FILTER_REGION_SIZE);
        filter.setAttribute("height", FILTER_REGION_SIZE);

        // 1. luminance → alpha: cloud brightness becomes opacity, RGB is zeroed to black.
        const lumToAlpha = document.createElementNS(svgNS, "feColorMatrix");
        lumToAlpha.setAttribute("type", "luminanceToAlpha");
        filter.appendChild(lumToAlpha);

        // 2. shape that alpha: kill the dim land/sea floor, ramp clouds up (capped < 1).
        const transfer = document.createElementNS(svgNS, "feComponentTransfer");
        const funcA = document.createElementNS(svgNS, "feFuncA");
        funcA.setAttribute("type", "table");
        funcA.setAttribute("tableValues", alphaTransferTable);
        transfer.appendChild(funcA);
        filter.appendChild(transfer);

        // 3. soften the coarse satellite pixels / seams.
        const blur = document.createElementNS(svgNS, "feGaussianBlur");
        blur.setAttribute("stdDeviation", SEAM_BLUR_STD_DEVIATION);
        blur.setAttribute("edgeMode", "duplicate");
        blur.setAttribute("result", "shaped");
        filter.appendChild(blur);

        // 4. paint the shaped alpha white so clouds read as white, not black.
        const flood = document.createElementNS(svgNS, "feFlood");
        flood.setAttribute("flood-color", "white");
        filter.appendChild(flood);

        const composite = document.createElementNS(svgNS, "feComposite");
        composite.setAttribute("in2", "shaped");
        composite.setAttribute("operator", "in");
        filter.appendChild(composite);

        svg.appendChild(filter);
        document.body.appendChild(svg);
    }

    const el = document.getElementById("map-clouds");
    if (el) {
        el.style.filter = `url(#${FILTER_ID}) opacity(0.8)`;
        el.style.willChange = "filter";
    }
}

function initCloudParallax(): void {
    const el = document.getElementById("parallax-clouds");
    if (!el) return;
    // The cloud-blur layer carries a snapshot of the cloud shape as its mask; drift it by the
    // same translate so the masked backdrop blur stays registered with the cloud veil.
    const blurEl = document.getElementById("cloud-blur");
    const MAX_DRIFT_PX = 12;
    const DRIFT_SMOOTHING = 0.08;
    let targetX = 0, targetY = 0;
    let currentX = 0, currentY = 0;

    window.addEventListener("mousemove", (e) => {
        const normalizedX = (e.clientX / window.innerWidth) * 2 - 1;
        const normalizedY = (e.clientY / window.innerHeight) * 2 - 1;
        targetX = -normalizedX * MAX_DRIFT_PX;
        targetY = -normalizedY * MAX_DRIFT_PX;
    });

    const tick = () => {
        currentX += (targetX - currentX) * DRIFT_SMOOTHING;
        currentY += (targetY - currentY) * DRIFT_SMOOTHING;
        const transform = `translate(${currentX.toFixed(2)}px, ${currentY.toFixed(2)}px)`;
        el.style.transform = transform;
        if (blurEl) blurEl.style.transform = transform;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

// Reads the loaded cloud imagery back off its WebGL canvas, converts cloud luminance into an
// alpha coverage mask, and installs it on #cloud-blur. The element's backdrop-filter then
// blurs the satellite + night-lights layers only where clouds are dense, fading to sharp over
// clear sky. Anywhere the imagery is transparent (off the satellite disk) yields a transparent
// mask, so the blur simply never appears there. The coverage band is source-dependent: infrared
// clear sky reads mid-grey rather than black, so it needs a higher floor than the DWD veil.
function installCloudBlurMask(cloudsMap: maplibregl.Map, coverageLow: number, coverageHigh: number): void {
    const el = document.getElementById("cloud-blur");
    if (!el) return;

    const MASK_DOWNSCALE = 4;

    const source = cloudsMap.getCanvas();
    const width = Math.max(1, Math.round(source.width / MASK_DOWNSCALE));
    const height = Math.max(1, Math.round(source.height / MASK_DOWNSCALE));

    const scratch = document.createElement("canvas");
    scratch.width = width;
    scratch.height = height;
    const ctx = scratch.getContext("2d")!;
    ctx.drawImage(source, 0, 0, width, height);

    const img = ctx.getImageData(0, 0, width, height);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
        const luminance = (0.2125 * data[i] + 0.7154 * data[i + 1] + 0.0721 * data[i + 2]) / 255;
        const coverage = Math.min(1, Math.max(0, (luminance - coverageLow) / (coverageHigh - coverageLow)));
        data[i] = data[i + 1] = data[i + 2] = 255;
        data[i + 3] = (smoothstep(coverage) * 255) | 0;
    }
    ctx.putImageData(img, 0, 0);

    const maskUrl = `url(${scratch.toDataURL()})`;
    el.style.maskImage = maskUrl;
    (el.style as unknown as { webkitMaskImage: string }).webkitMaskImage = maskUrl;
}

function locationInit(): void {
    if (DEBUG_LOCATION) {
        const [latitude, longitude] = DEBUG_LOCATION;
        getMap(latitude, longitude);
        return;
    }

    const cachedPosition = localStorage.getItem("cachedPosition");
    if (cachedPosition) {
        try {
            const { timestamp, coords } = JSON.parse(cachedPosition);
            const age = Date.now() - timestamp;
            if (age < MAX_CACHED_POSITION_AGE_MS) {
                getMap(coords.latitude, coords.longitude);
                return;
            }
            console.log("Cached position is too old, fetching new position");
        } catch (e) {
            console.error("Failed to parse cached position, fetching new position", e);
        }
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            cachePosition(position);
            applyLightness(position.coords.latitude, position.coords.longitude);
            const { latitude, longitude } = position.coords;
            getMap(latitude, longitude);
        },
        (error) => {
            console.error(error);
        },
        { enableHighAccuracy: false },
    );

    function cachePosition(position: GeolocationPosition): void {
        const cacheData = {
            timestamp: position.timestamp,
            coords: {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude
            }
        };
        localStorage.setItem("cachedPosition", JSON.stringify(cacheData));
    }
}

function altitudeToCityLightsOpacity(altitudeRad: number): number {
    const MAX_OPACITY = 0.55;
    const FADE_START_DEG = -1.75;
    const FADE_END_DEG = -2.5;
    const altitudeDeg = altitudeRad * RAD_TO_DEG;
    if (altitudeDeg >= FADE_START_DEG) return 0;
    if (altitudeDeg <= FADE_END_DEG) return MAX_OPACITY;
    const progress = (FADE_START_DEG - altitudeDeg) / (FADE_START_DEG - FADE_END_DEG);
    return MAX_OPACITY * smoothstep(progress);
}

function altitudeToDarkOverlayOpacity(altitudeRad: number): number {
    const MAX_OPACITY = 0.7;
    const FADE_START_DEG = 0;
    const FADE_END_DEG = -2;
    const altitudeDeg = altitudeRad * RAD_TO_DEG;
    if (altitudeDeg >= FADE_START_DEG) return 0;
    if (altitudeDeg <= FADE_END_DEG) return MAX_OPACITY;
    const progress = (FADE_START_DEG - altitudeDeg) / (FADE_START_DEG - FADE_END_DEG);
    return MAX_OPACITY * smoothstep(progress);
}

function altitudeToSunsetOverlayOpacity(altitudeRad: number): number {
    const MAX_OPACITY = 0.2;
    const FADE_IN_START_DEG = 0;
    const PEAK_DEG = -1.25;
    const FADE_OUT_END_DEG = -2.25;
    const altitudeDeg = altitudeRad * RAD_TO_DEG;

    if (altitudeDeg >= FADE_IN_START_DEG) return 0;
    if (altitudeDeg <= FADE_OUT_END_DEG) return 0;

    if (altitudeDeg >= PEAK_DEG) {
        const progress = (FADE_IN_START_DEG - altitudeDeg) / (FADE_IN_START_DEG - PEAK_DEG);
        return MAX_OPACITY * smoothstep(progress);
    }
    const progress = (altitudeDeg - FADE_OUT_END_DEG) / (PEAK_DEG - FADE_OUT_END_DEG);
    return MAX_OPACITY * smoothstep(progress);
}

function isAnyDarknessVisible(map: maplibregl.Map, date: Date): boolean {
    const SAMPLES_PER_AXIS = 5;
    const DARKNESS_THRESHOLD_DEG = 0.25;
    const container = map.getContainer();
    const width = container.clientWidth, height = container.clientHeight;
    for (let iy = 0; iy < SAMPLES_PER_AXIS; iy++) {
        for (let ix = 0; ix < SAMPLES_PER_AXIS; ix++) {
            const px = (ix / (SAMPLES_PER_AXIS - 1)) * width;
            const py = (iy / (SAMPLES_PER_AXIS - 1)) * height;
            const lngLat = map.unproject([px, py] as [number, number]);
            const altitudeDeg = SunCalc.getPosition(date, lngLat.lat, lngLat.lng).altitude * RAD_TO_DEG;
            if (altitudeDeg < DARKNESS_THRESHOLD_DEG) return true;
        }
    }
    return false;
}

interface CloudSource {
    source: maplibregl.RasterSourceSpecification;
    alphaTable: string;
    blurCoverage: [number, number];
}

// Picks cloud imagery for the viewer's longitude. DWD's Meteosat mosaic (1 km, sharpest, real
// day-HRV + night-IR) covers Europe / Africa / Atlantic; everywhere else falls back to NASA
// GIBS Band13 "Clean Infrared" from the nearest geostationary satellite — GOES-West, GOES-East,
// or Himawari. The IR layers are keyless, near-global, transparent off-disk, and read cold
// cloud tops as bright over a dark surface, so the same luminance keying as DWD applies (with a
// higher floor, since IR clear sky is mid-grey rather than black). The weakest seam is ~60–80°E
// (India / western Indian Ocean), which sits between Meteosat's and Himawari's useful coverage.
function cloudSourceFor(lng: number): CloudSource {
    const DWD_ALPHA = "0 0.02 0.08 0.19 0.37 0.55 0.65 0.7 0.74 0.76 0.78 0.79 0.8";
    const IR_ALPHA = "0 0 0 0 0.03 0.08 0.2 0.4 0.58 0.7 0.76 0.79 0.8";

    if (lng >= -70 && lng < 60) {
        const url = "https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.3.0&request=GetMap"
            + "&layers=dwd:Satellite_meteosat_1km_euat_rgb_day_hrv_and_night_ir108_3h"
            + "&styles=&format=image/png&transparent=true&crs=EPSG:3857"
            + "&width=256&height=256&bbox={bbox-epsg-3857}";
        return {
            source: { type: "raster", tiles: [url], tileSize: 256, maxzoom: 7, attribution: "© Deutscher Wetterdienst / EUMETSAT" },
            alphaTable: DWD_ALPHA,
            blurCoverage: [0.15, 0.55],
        };
    }

    const layer = (lng >= 60 || lng < -160) ? "Himawari_AHI_Band13_Clean_Infrared"
        : (lng < -100) ? "GOES-West_ABI_Band13_Clean_Infrared"
            : "GOES-East_ABI_Band13_Clean_Infrared";
    const url = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/"
        + `${layer}/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`;
    return {
        source: { type: "raster", tiles: [url], tileSize: 256, maxzoom: 6, attribution: "© NASA GIBS / NOAA / JMA" },
        alphaTable: IR_ALPHA,
        blurCoverage: [0.45, 0.78],
    };
}

function getMap(lat: number, lng: number): void {
    const satelliteMap = new maplibregl.Map({
        container: "map",
        style: {
            version: 8,
            sources: DEBUG_LAYERS.satellite ? {
                "satellite": {
                    type: "raster",
                    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
                    // tileSize decouples imagery detail from framing: MapLibre fetches source
                    // zoom ≈ MAP_ZOOM + log2(512 / tileSize). At 128 a zoom-7 view is sourced
                    // from z9 tiles (sharper) without changing how much of the map is shown.
                    tileSize: 128,
                    maxzoom: 14,
                    attribution: "Sentinel-2 cloudless by EOX",
                },
            } : {},
            layers: DEBUG_LAYERS.satellite
                ? [{ id: "satellite-layer", type: "raster", source: "satellite" }]
                : [],
        },
        center: [lng, lat],
        zoom: MAP_ZOOM,
        interactive: false,
        trackResize: false,
    });

    const silenceTileFetchNoise = (m: maplibregl.Map): void => {
        m.on("error", (e) => {
            const msg = (e as any).error?.message ?? "";
            if (msg.includes("AJAXError")) return;
            console.error(e);
        });
    };
    silenceTileFetchNoise(satelliteMap);
    // MapLibre captures the container size at construction. If layout hasn't sized #map
    // yet, the canvas is created too small and CSS stretches it — the imagery looks zoomed
    // in and pixelated. trackResize is false, so it never self-corrects; resize once on load.
    satelliteMap.once("load", () => satelliteMap.resize());

    const readinessGates: Promise<void>[] = [];
    const gate = (): { promise: Promise<void>; resolve: () => void } => {
        let resolve!: () => void;
        const promise = new Promise<void>(r => { resolve = r; });
        return { promise, resolve };
    };

    // Resolve only once every requested tile for this map has actually loaded. A single
    // "idle" can fire before all tiles are in (e.g. right after a resize re-requests tiles,
    // or while tiles are still streaming), so re-arm on each idle until areTilesLoaded()
    // confirms there is nothing left to fetch.
    const tilesLoaded = (m: maplibregl.Map): Promise<void> =>
        new Promise<void>(resolve => {
            const check = (): void => {
                if (m.areTilesLoaded()) resolve();
                else m.once("idle", check);
            };
            m.once("idle", check);
        });

    readinessGates.push(tilesLoaded(satelliteMap));

    const nightGate = gate();
    readinessGates.push(nightGate.promise);

    if (DEBUG_LAYERS.nightEarth) {
        let nightMapCreated = false;
        const ensureNightMap = (): { map: maplibregl.Map; container: HTMLElement } | null => {
            if (nightMapCreated) return null;
            if (!isAnyDarknessVisible(satelliteMap, currentDate())) return null;
            nightMapCreated = true;

            const mapLightsElement = document.getElementById("map-lights")!;
            const rect = mapLightsElement.getBoundingClientRect();
            const captureContainer = document.createElement("div");
            captureContainer.style.position = "fixed";
            captureContainer.style.left = "0";
            captureContainer.style.top = "0";
            captureContainer.style.opacity = "0";
            captureContainer.style.pointerEvents = "none";
            captureContainer.style.width = `${Math.max(1, Math.round(rect.width))}px`;
            captureContainer.style.height = `${Math.max(1, Math.round(rect.height))}px`;
            document.body.appendChild(captureContainer);

            const nightMap = new maplibregl.Map({
                container: captureContainer,
                style: {
                    version: 8,
                    sources: {
                        "night-earth": {
                            type: "raster",
                            tiles: [
                                "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Night_Lights/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
                            ],
                            tileSize: 256,
                            maxzoom: 8,
                            attribution: "© NASA GIBS Night Lights",
                        },
                    },
                    layers: [{ id: "night-earth-layer", type: "raster", source: "night-earth" }],
                },
                center: [lng, lat],
                zoom: MAP_ZOOM,
                interactive: false,
                trackResize: false,
                canvasContextAttributes: { preserveDrawingBuffer: true },
            });
            silenceTileFetchNoise(nightMap);
            return { map: nightMap, container: captureContainer };
        };

        satelliteMap.once("idle", () => {
            startTerminatorUpdates(satelliteMap, [lng, lat], ensureNightMap, nightGate.resolve);
        });
    } else {
        for (const id of ["map-lights", "night-overlay", "sunset-overlay"]) {
            const el = document.getElementById(id);
            if (el) el.style.display = "none";
        }
        nightGate.resolve();
    }

    if (DEBUG_LAYERS.clouds) {
        // The cloud imagery is chosen by longitude (see cloudSourceFor): DWD's sharp Meteosat
        // mosaic over Europe/Africa/Atlantic, else NASA GIBS infrared from whichever
        // geostationary satellite actually sees the viewer. Both are keyless and need no runtime
        // fetch; the #cloud-alpha-boost filter on #map-clouds turns luminance into alpha so only
        // clouds show.
        const cloud = cloudSourceFor(lng);
        installCloudAlphaBoostFilter(cloud.alphaTable);

        const cloudStyle = (): maplibregl.StyleSpecification => ({
            version: 8,
            sources: { "clouds": cloud.source },
            layers: [{
                id: "clouds-layer",
                type: "raster",
                source: "clouds",
                paint: {
                    "raster-opacity": 1,
                    "raster-fade-duration": 0,
                    "raster-resampling": "linear",
                },
            }],
        });

        const createCloudsMap = (containerId: string) => {
            const cloudsMap = new maplibregl.Map({
                container: containerId,
                style: cloudStyle(),
                center: [lng, lat],
                zoom: MAP_ZOOM,
                interactive: false,
                // The cloud-blur mask is read back off this canvas once it settles.
                canvasContextAttributes: { preserveDrawingBuffer: true },
            });
            silenceTileFetchNoise(cloudsMap);
            readinessGates.push(tilesLoaded(cloudsMap));
            cloudsMap.once("load", () => cloudsMap.resize());
            cloudsMap.once("idle", () => {
                try {
                    installCloudBlurMask(cloudsMap, cloud.blurCoverage[0], cloud.blurCoverage[1]);
                } catch (e) {
                    console.error("cloud-blur mask failed", e);
                }
            });
        };

        createCloudsMap("map-clouds");
    }

    Promise.all(readinessGates).then(() => {
        // Final guard against the size race: if the satellite canvas was ever built at the
        // wrong size, correct it now while #map-container is still opacity:0, and let the
        // resized frame paint (rAF) before starting the 1s fade — so the reveal never shows
        // the zoomed-in, wrong-size render.
        satelliteMap.resize();
        requestAnimationFrame(() => {
            const container = document.getElementById("map-container");
            if (container) container.classList.add("show");
        });
    });
}

interface SampleGrid {
    cols: number;
    rows: number;
    lat: Float64Array;
    lng: Float64Array;
}

function buildSampleGrid(map: maplibregl.Map): SampleGrid {
    const container = map.getContainer();
    const cols = Math.max(1, Math.ceil(container.clientWidth / SCREEN_PX_PER_MASK_SAMPLE));
    const rows = Math.max(1, Math.ceil(container.clientHeight / SCREEN_PX_PER_MASK_SAMPLE));
    const lat = new Float64Array(cols * rows);
    const lng = new Float64Array(cols * rows);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const lngLat = map.unproject([(x + 0.5) * SCREEN_PX_PER_MASK_SAMPLE, (y + 0.5) * SCREEN_PX_PER_MASK_SAMPLE] as [number, number]);
            const i = y * cols + x;
            lat[i] = lngLat.lat;
            lng[i] = lngLat.lng;
        }
    }
    return { cols, rows, lat, lng };
}

interface OverlayAlphas {
    cityLights: Uint8Array;
    darkness: Uint8Array;
    sunset: Uint8Array | null;
}

function computeOverlayAlphas(grid: SampleGrid, date: Date): OverlayAlphas {
    const sampleCount = grid.cols * grid.rows;
    const cityLights = new Uint8Array(sampleCount);
    const darkness = new Uint8Array(sampleCount);
    const sunset = DEBUG_LAYERS.sunsetOverlay ? new Uint8Array(sampleCount) : null;
    for (let i = 0; i < sampleCount; i++) {
        const { altitude } = SunCalc.getPosition(date, grid.lat[i], grid.lng[i]);
        cityLights[i] = (altitudeToCityLightsOpacity(altitude) * 255) | 0;
        darkness[i] = (altitudeToDarkOverlayOpacity(altitude) * 255) | 0;
        if (sunset) sunset[i] = (altitudeToSunsetOverlayOpacity(altitude) * 255) | 0;
    }
    return { cityLights, darkness, sunset };
}

interface OverlayLayer {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    img: ImageData;
    readyToPaint: boolean;
}

function makeOverlayLayer(elementId: string, grid: SampleGrid, tint: [number, number, number] | null): OverlayLayer | null {
    const el = document.getElementById(elementId);
    if (!el) return null;
    el.style.backgroundColor = "transparent";

    const canvas = document.createElement("canvas");
    canvas.width = grid.cols;
    canvas.height = grid.rows;
    canvas.style.position = "absolute";
    canvas.style.inset = "0";

    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(grid.cols, grid.rows);
    if (tint) {
        for (let j = 0; j < img.data.length; j += 4) {
            img.data[j] = tint[0];
            img.data[j + 1] = tint[1];
            img.data[j + 2] = tint[2];
        }
    }
    el.appendChild(canvas);

    return { canvas, ctx, img, readyToPaint: tint !== null };
}

function paintOverlay(layer: OverlayLayer | null, from: Uint8Array, to: Uint8Array, t: number): void {
    if (!layer || !layer.readyToPaint) return;
    const data = layer.img.data;
    for (let i = 0, j = 3; i < from.length; i++, j += 4) {
        data[j] = (from[i] + (to[i] - from[i]) * t) | 0;
    }
    layer.ctx.putImageData(layer.img, 0, 0);
}

function snapshotNightLights(map: maplibregl.Map, layer: OverlayLayer, grid: SampleGrid): void {
    const scratch = document.createElement("canvas");
    scratch.width = grid.cols;
    scratch.height = grid.rows;
    const scratchCtx = scratch.getContext("2d")!;
    scratchCtx.drawImage(map.getCanvas(), 0, 0, grid.cols, grid.rows);
    const snapshot = scratchCtx.getImageData(0, 0, grid.cols, grid.rows).data;
    const target = layer.img.data;
    for (let k = 0; k < target.length; k += 4) {
        target[k] = snapshot[k];
        target[k + 1] = snapshot[k + 1];
        target[k + 2] = snapshot[k + 2];
    }
    layer.readyToPaint = true;
}

function startTerminatorUpdates(
    map: maplibregl.Map,
    center: [number, number],
    ensureNightMap: () => { map: maplibregl.Map; container: HTMLElement } | null,
    onReady: () => void,
): void {
    const grid = buildSampleGrid(map);
    const darknessLayer = makeOverlayLayer("night-overlay", grid, [0, 0, 0]);
    const sunsetLayer = DEBUG_LAYERS.sunsetOverlay ? makeOverlayLayer("sunset-overlay", grid, [255, 115, 0]) : null;
    const cityLightsLayer = makeOverlayLayer("map-lights", grid, null);
    const [lng, lat] = center;

    let fromTime = currentDate();
    let fromAlphas = computeOverlayAlphas(grid, fromTime);
    let toTime = new Date(fromTime.getTime() + SUN_KEYFRAME_INTERVAL_MS);
    let toAlphas = computeOverlayAlphas(grid, toTime);

    const currentInterpolation = (): number => {
        const span = toTime.getTime() - fromTime.getTime();
        return span > 0 ? Math.min(1, Math.max(0, (currentDate().getTime() - fromTime.getTime()) / span)) : 1;
    };

    const render = (t: number): void => {
        paintOverlay(darknessLayer, fromAlphas.darkness, toAlphas.darkness, t);
        if (sunsetLayer && fromAlphas.sunset && toAlphas.sunset) paintOverlay(sunsetLayer, fromAlphas.sunset, toAlphas.sunset, t);
        paintOverlay(cityLightsLayer, fromAlphas.cityLights, toAlphas.cityLights, t);
    };

    const acquireNightLights = (done: () => void): void => {
        const created = ensureNightMap();
        if (!created) { done(); return; }
        created.map.once("idle", () => {
            try {
                if (cityLightsLayer) snapshotNightLights(created.map, cityLightsLayer, grid);
            } catch (e) {
                console.error("night-lights snapshot failed", e);
            }
            created.map.remove();
            created.container.remove();
            render(currentInterpolation());
            done();
        });
    };

    applyLightness(lat, lng, fromTime);
    render(0);
    acquireNightLights(onReady);

    if (DEBUG_TIME) return;

    setInterval(() => {
        if (document.hidden) return;
        const now = currentDate().getTime();
        if (now >= toTime.getTime()) {
            fromTime = new Date(now);
            fromAlphas = computeOverlayAlphas(grid, fromTime);
            toTime = new Date(now + SUN_KEYFRAME_INTERVAL_MS);
            toAlphas = computeOverlayAlphas(grid, toTime);
            acquireNightLights(() => {});
        }
        render(currentInterpolation());
        applyLightness(lat, lng, new Date(now));
    }, OVERLAY_REPAINT_INTERVAL_MS);
}
