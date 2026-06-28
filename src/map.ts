import maplibregl from "maplibre-gl";
import * as SunCalc from "suncalc";
import { SETTINGS } from "./main";

const RAD_TO_DEG = 180 / Math.PI;

function smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
}

function computeLightness(lat: number, lng: number, date: Date): number {
    const { dayValue, nightValue, fullDayAltitudeDeg, fullNightAltitudeDeg } = SETTINGS.lightness;
    const altitudeDeg = SunCalc.getPosition(date, lat, lng).altitude * RAD_TO_DEG;
    if (altitudeDeg >= fullDayAltitudeDeg) return dayValue;
    if (altitudeDeg <= fullNightAltitudeDeg) return nightValue;
    const darkness = (fullDayAltitudeDeg - altitudeDeg) / (fullDayAltitudeDeg - fullNightAltitudeDeg);
    return dayValue + (nightValue - dayValue) * smoothstep(darkness);
}

let virtualClockAnchorReal = 0;
let virtualClockAnchorVirtual = 0;
let virtualClockStarted = false;
function currentDate(): Date {
    if (SETTINGS.debug.time) return new Date(SETTINGS.debug.time);
    if (SETTINGS.debug.timeScale === 1) return new Date();
    const realNow = Date.now();
    if (!virtualClockStarted) {
        virtualClockStarted = true;
        virtualClockAnchorReal = realNow;
        virtualClockAnchorVirtual = realNow;
    }
    return new Date(virtualClockAnchorVirtual + (realNow - virtualClockAnchorReal) * SETTINGS.debug.timeScale);
}

export function applyLightness(lat: number, lng: number, date: Date = currentDate()): void {
    const value = computeLightness(lat, lng, date);
    document.documentElement.style.setProperty("--lightness", value.toFixed(3));
}

function altitudeToCityLightsOpacity(altitudeRad: number): number {
    const { maxOpacity, fadeStartDeg, fadeEndDeg } = SETTINGS.cityLights;
    const altitudeDeg = altitudeRad * RAD_TO_DEG;
    if (altitudeDeg >= fadeStartDeg) return 0;
    if (altitudeDeg <= fadeEndDeg) return maxOpacity;
    const progress = (fadeStartDeg - altitudeDeg) / (fadeStartDeg - fadeEndDeg);
    return maxOpacity * smoothstep(progress);
}

function altitudeToDarkOverlayOpacity(altitudeRad: number): number {
    const { maxOpacity, fadeStartDeg, fadeEndDeg } = SETTINGS.darkOverlay;
    const altitudeDeg = altitudeRad * RAD_TO_DEG;
    if (altitudeDeg >= fadeStartDeg) return 0;
    if (altitudeDeg <= fadeEndDeg) return maxOpacity;
    const progress = (fadeStartDeg - altitudeDeg) / (fadeStartDeg - fadeEndDeg);
    return maxOpacity * smoothstep(progress);
}

function altitudeToSunsetOverlayOpacity(altitudeRad: number): number {
    const { maxOpacity, fadeInStartDeg, peakDeg, fadeOutEndDeg } = SETTINGS.sunsetOverlay;
    const altitudeDeg = altitudeRad * RAD_TO_DEG;

    if (altitudeDeg >= fadeInStartDeg) return 0;
    if (altitudeDeg <= fadeOutEndDeg) return 0;

    if (altitudeDeg >= peakDeg) {
        const progress = (fadeInStartDeg - altitudeDeg) / (fadeInStartDeg - peakDeg);
        return maxOpacity * smoothstep(progress);
    }
    const progress = (altitudeDeg - fadeOutEndDeg) / (peakDeg - fadeOutEndDeg);
    return maxOpacity * smoothstep(progress);
}

function isAnyDarknessVisible(map: maplibregl.Map, date: Date): boolean {
    const { samplesPerAxis, thresholdDeg } = SETTINGS.darknessProbe;
    const container = map.getContainer();
    const width = container.clientWidth, height = container.clientHeight;
    for (let iy = 0; iy < samplesPerAxis; iy++) {
        for (let ix = 0; ix < samplesPerAxis; ix++) {
            const px = (ix / (samplesPerAxis - 1)) * width;
            const py = (iy / (samplesPerAxis - 1)) * height;
            const lngLat = map.unproject([px, py] as [number, number]);
            const altitudeDeg = SunCalc.getPosition(date, lngLat.lat, lngLat.lng).altitude * RAD_TO_DEG;
            if (altitudeDeg < thresholdDeg) return true;
        }
    }
    return false;
}

interface CloudSource {
    source: maplibregl.RasterSourceSpecification;
    alphaTable: string;
    blurCoverage: [number, number];
}

function cloudSourceFor(lng: number): CloudSource {
    const [dwdMinLng, dwdMaxLng] = SETTINGS.dwdClouds.longitudeRange;
    if (lng >= dwdMinLng && lng < dwdMaxLng) {
        const dwd = SETTINGS.dwdClouds;
        return {
            source: { type: "raster", tiles: [dwd.tiles], tileSize: dwd.tileSize, maxzoom: dwd.maxzoom, attribution: dwd.attribution },
            alphaTable: dwd.alphaTable,
            blurCoverage: dwd.blurCoverage,
        };
    }

    const infrared = SETTINGS.infraredClouds;
    const nearestGeostationary = (lng >= 60 || lng < -160) ? "Himawari_AHI"
        : (lng < -100) ? "GOES-West_ABI"
            : "GOES-East_ABI";
    const tiles = infrared.tilesTemplate.replace("{satellite}", nearestGeostationary);
    return {
        source: { type: "raster", tiles: [tiles], tileSize: infrared.tileSize, maxzoom: infrared.maxzoom, attribution: infrared.attribution },
        alphaTable: infrared.alphaTable,
        blurCoverage: infrared.blurCoverage,
    };
}

function installCloudAlphaBoostFilter(alphaTransferTable: string): void {
    const FILTER_ID = "cloud-alpha-boost";
    const { filterRegionInset, filterRegionSize, seamBlurStdDeviation, opacity } = SETTINGS.cloudVeil;

    if (!document.getElementById(FILTER_ID)) {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", "0");
        svg.setAttribute("height", "0");
        svg.style.position = "absolute";

        const filter = document.createElementNS(svgNS, "filter");
        filter.setAttribute("id", FILTER_ID);
        filter.setAttribute("color-interpolation-filters", "sRGB");
        filter.setAttribute("x", filterRegionInset);
        filter.setAttribute("y", filterRegionInset);
        filter.setAttribute("width", filterRegionSize);
        filter.setAttribute("height", filterRegionSize);

        const luminanceToAlpha = document.createElementNS(svgNS, "feColorMatrix");
        luminanceToAlpha.setAttribute("type", "luminanceToAlpha");
        filter.appendChild(luminanceToAlpha);

        const shapeAlpha = document.createElementNS(svgNS, "feComponentTransfer");
        const alphaCurve = document.createElementNS(svgNS, "feFuncA");
        alphaCurve.setAttribute("type", "table");
        alphaCurve.setAttribute("tableValues", alphaTransferTable);
        shapeAlpha.appendChild(alphaCurve);
        filter.appendChild(shapeAlpha);

        const softenSeams = document.createElementNS(svgNS, "feGaussianBlur");
        softenSeams.setAttribute("stdDeviation", String(seamBlurStdDeviation));
        softenSeams.setAttribute("edgeMode", "duplicate");
        softenSeams.setAttribute("result", "shaped");
        filter.appendChild(softenSeams);

        const whiteFill = document.createElementNS(svgNS, "feFlood");
        whiteFill.setAttribute("flood-color", "white");
        filter.appendChild(whiteFill);

        const paintShapeWhite = document.createElementNS(svgNS, "feComposite");
        paintShapeWhite.setAttribute("in2", "shaped");
        paintShapeWhite.setAttribute("operator", "in");
        filter.appendChild(paintShapeWhite);

        svg.appendChild(filter);
        document.body.appendChild(svg);
    }

    const el = document.getElementById("map-clouds");
    if (el) {
        el.style.filter = `url(#${FILTER_ID}) opacity(${opacity})`;
        el.style.willChange = "filter";
    }
}

function installCloudBlurMask(cloudsMap: maplibregl.Map, coverageLow: number, coverageHigh: number): void {
    const el = document.getElementById("cloud-blur");
    if (!el) return;

    const source = cloudsMap.getCanvas();
    const downscale = SETTINGS.cloudBlurMaskDownscale;
    const width = Math.max(1, Math.round(source.width / downscale));
    const height = Math.max(1, Math.round(source.height / downscale));

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
    el.style.setProperty("-webkit-mask-image", maskUrl);
}

export function initCloudParallax(): void {
    const cloudsEl = document.getElementById("parallax-clouds");
    if (!cloudsEl) return;
    const blurEl = document.getElementById("cloud-blur");

    const { maxDriftPx, smoothing } = SETTINGS.cloudParallax;
    let targetX = 0, targetY = 0;
    let currentX = 0, currentY = 0;

    window.addEventListener("mousemove", (e) => {
        const normalizedX = (e.clientX / window.innerWidth) * 2 - 1;
        const normalizedY = (e.clientY / window.innerHeight) * 2 - 1;
        targetX = -normalizedX * maxDriftPx;
        targetY = -normalizedY * maxDriftPx;
    });

    const tick = () => {
        currentX += (targetX - currentX) * smoothing;
        currentY += (targetY - currentY) * smoothing;
        const transform = `translate(${currentX.toFixed(2)}px, ${currentY.toFixed(2)}px)`;
        cloudsEl.style.transform = transform;
        if (blurEl) blurEl.style.transform = transform;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

interface Gate {
    promise: Promise<void>;
    resolve: () => void;
}

function createGate(): Gate {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

function silenceTileFetchNoise(map: maplibregl.Map): void {
    map.on("error", (e) => {
        const message = (e as { error?: { message?: string } }).error?.message ?? "";
        if (message.includes("AJAXError")) return;
        console.error(e);
    });
}

function tilesLoaded(map: maplibregl.Map): Promise<void> {
    return new Promise<void>(resolve => {
        const check = (): void => {
            if (map.areTilesLoaded()) resolve();
            else map.once("idle", check);
        };
        map.once("idle", check);
    });
}

function createSatelliteMap(lat: number, lng: number): maplibregl.Map {
    const satellite = SETTINGS.satelliteSource;
    const enabled = SETTINGS.debug.layers.satellite;
    const map = new maplibregl.Map({
        container: "map",
        style: {
            version: 8,
            sources: enabled ? {
                "satellite": {
                    type: "raster",
                    tiles: [satellite.tiles],
                    tileSize: satellite.tileSize,
                    maxzoom: satellite.maxzoom,
                    attribution: satellite.attribution,
                },
            } : {},
            layers: enabled ? [{ id: "satellite-layer", type: "raster", source: "satellite" }] : [],
        },
        center: [lng, lat],
        zoom: SETTINGS.mapZoom,
        interactive: false,
        trackResize: false,
    });
    silenceTileFetchNoise(map);
    map.once("load", () => map.resize());
    return map;
}

function createNightLightsCapture(lat: number, lng: number): { map: maplibregl.Map; container: HTMLElement } {
    const rect = document.getElementById("map-lights")!.getBoundingClientRect();
    const container = document.createElement("div");
    Object.assign(container.style, {
        position: "fixed",
        left: "0",
        top: "0",
        opacity: "0",
        pointerEvents: "none",
        width: `${Math.max(1, Math.round(rect.width))}px`,
        height: `${Math.max(1, Math.round(rect.height))}px`,
    });
    document.body.appendChild(container);

    const nightLights = SETTINGS.nightLightsSource;
    const map = new maplibregl.Map({
        container,
        style: {
            version: 8,
            sources: {
                "night-earth": {
                    type: "raster",
                    tiles: [nightLights.tiles],
                    tileSize: nightLights.tileSize,
                    maxzoom: nightLights.maxzoom,
                    attribution: nightLights.attribution,
                },
            },
            layers: [{ id: "night-earth-layer", type: "raster", source: "night-earth" }],
        },
        center: [lng, lat],
        zoom: SETTINGS.mapZoom,
        interactive: false,
        trackResize: false,
        canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    silenceTileFetchNoise(map);
    return { map, container };
}

function setupNightLayers(satelliteMap: maplibregl.Map, lat: number, lng: number, nightGate: Gate): void {
    if (!SETTINGS.debug.layers.nightEarth) {
        for (const id of ["map-lights", "night-overlay", "sunset-overlay"]) {
            const el = document.getElementById(id);
            if (el) el.style.display = "none";
        }
        nightGate.resolve();
        return;
    }

    let captureCreated = false;
    const ensureNightMap = (): { map: maplibregl.Map; container: HTMLElement } | null => {
        if (captureCreated) return null;
        if (!isAnyDarknessVisible(satelliteMap, currentDate())) return null;
        captureCreated = true;
        return createNightLightsCapture(lat, lng);
    };

    satelliteMap.once("idle", () => {
        startTerminatorUpdates(satelliteMap, [lng, lat], ensureNightMap, nightGate.resolve);
    });
}

function setupClouds(lat: number, lng: number, gates: Promise<void>[]): void {
    const cloud = cloudSourceFor(lng);
    installCloudAlphaBoostFilter(cloud.alphaTable);

    const cloudsMap = new maplibregl.Map({
        container: "map-clouds",
        style: {
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
        },
        center: [lng, lat],
        zoom: SETTINGS.mapZoom,
        interactive: false,
        canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    silenceTileFetchNoise(cloudsMap);
    gates.push(tilesLoaded(cloudsMap));
    cloudsMap.once("load", () => cloudsMap.resize());
    cloudsMap.once("idle", () => {
        try {
            installCloudBlurMask(cloudsMap, cloud.blurCoverage[0], cloud.blurCoverage[1]);
        } catch (e) {
            console.error("cloud-blur mask failed", e);
        }
    });
}

function revealWhenReady(satelliteMap: maplibregl.Map): void {
    satelliteMap.resize();
    requestAnimationFrame(() => {
        document.getElementById("map-container")?.classList.add("show");
    });
}

export function renderMap(lat: number, lng: number): void {
    const gates: Promise<void>[] = [];

    const satelliteMap = createSatelliteMap(lat, lng);
    gates.push(tilesLoaded(satelliteMap));

    const nightGate = createGate();
    gates.push(nightGate.promise);
    setupNightLayers(satelliteMap, lat, lng, nightGate);

    if (SETTINGS.debug.layers.clouds) setupClouds(lat, lng, gates);

    Promise.all(gates).then(() => revealWhenReady(satelliteMap));
}

interface SampleGrid {
    cols: number;
    rows: number;
    lat: Float64Array;
    lng: Float64Array;
}

function buildSampleGrid(map: maplibregl.Map): SampleGrid {
    const step = SETTINGS.overlaySampling.screenPxPerSample;
    const container = map.getContainer();
    const cols = Math.max(1, Math.ceil(container.clientWidth / step));
    const rows = Math.max(1, Math.ceil(container.clientHeight / step));
    const lat = new Float64Array(cols * rows);
    const lng = new Float64Array(cols * rows);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const lngLat = map.unproject([(x + 0.5) * step, (y + 0.5) * step] as [number, number]);
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
    const sunset = SETTINGS.debug.layers.sunsetOverlay ? new Uint8Array(sampleCount) : null;
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
    const { sunKeyframeIntervalMs, repaintIntervalMs } = SETTINGS.overlaySampling;
    const grid = buildSampleGrid(map);
    const darknessLayer = makeOverlayLayer("night-overlay", grid, SETTINGS.darkOverlay.tintRgb);
    const sunsetLayer = SETTINGS.debug.layers.sunsetOverlay ? makeOverlayLayer("sunset-overlay", grid, SETTINGS.sunsetOverlay.tintRgb) : null;
    const cityLightsLayer = makeOverlayLayer("map-lights", grid, null);
    const [lng, lat] = center;

    let fromTime = currentDate();
    let fromAlphas = computeOverlayAlphas(grid, fromTime);
    let toTime = new Date(fromTime.getTime() + sunKeyframeIntervalMs);
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

    if (SETTINGS.debug.time) return;

    setInterval(() => {
        if (document.hidden) return;
        const now = currentDate().getTime();
        if (now >= toTime.getTime()) {
            fromTime = new Date(now);
            fromAlphas = computeOverlayAlphas(grid, fromTime);
            toTime = new Date(now + sunKeyframeIntervalMs);
            toAlphas = computeOverlayAlphas(grid, toTime);
            acquireNightLights(() => {});
        }
        render(currentInterpolation());
        applyLightness(lat, lng, new Date(now));
    }, repaintIntervalMs);
}
