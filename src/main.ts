import { fetchWeatherApi } from "openmeteo";
import jQuery from "jquery";
import maplibregl from "maplibre-gl";
import * as SunCalc from "suncalc";

declare const $: typeof jQuery;

const MAP_ZOOM = 8;
const OWM_API_KEY = (import.meta as any).env.VITE_OWM_API_KEY as string;

const DEBUG_LOCATION: [number, number] | null = null;
const DEBUG_TIME: string | null = null;

const DEBUG_LAYERS = {
    satellite: true,
    nightEarth: true,
    clouds: true,
    sunsetOverlay: true,
};

function computeLightness(lat: number, lng: number, date: Date): number {
    const LIGHT = 90;
    const DARK = 10;
    const ABOVE_DEG = 0;     // fully light at/above horizon
    const BELOW_DEG = -2;    // fully dark — matches dark overlay end
    const altDeg = SunCalc.getPosition(date, lat, lng).altitude * (180 / Math.PI);
    if (altDeg >= ABOVE_DEG) return LIGHT;
    if (altDeg <= BELOW_DEG) return DARK;
    const t = (ABOVE_DEG - altDeg) / (ABOVE_DEG - BELOW_DEG); // 0..1, 0=light
    const eased = t * t * (3 - 2 * t);
    return LIGHT + (DARK - LIGHT) * eased;
}

function applyLightness(lat: number, lng: number): void {
    const date = DEBUG_TIME ? new Date(DEBUG_TIME) : new Date();
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

$(function () {
    installCloudAlphaBoostFilter();
    locationInit();
    initParallaxDragTest(); // TEMP: remove when real parallax is wired up
});

function installCloudAlphaBoostFilter(): void {
    const FILTER_ID = "cloud-alpha-boost";
    if (!document.getElementById(FILTER_ID)) {
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", "0");
        svg.setAttribute("height", "0");
        svg.style.position = "absolute";
        const filter = document.createElementNS(svgNS, "filter");
        filter.setAttribute("id", FILTER_ID);
        filter.setAttribute("color-interpolation-filters", "sRGB");
        const transfer = document.createElementNS(svgNS, "feComponentTransfer");
        const funcA = document.createElementNS(svgNS, "feFuncA");
        funcA.setAttribute("type", "table");
        funcA.setAttribute("tableValues", "0 0.2 0.6 0.6 0.7 0.85 1");
        transfer.appendChild(funcA);
        filter.appendChild(transfer);
        svg.appendChild(filter);
        document.body.appendChild(svg);
    }
    const el = document.getElementById("map-clouds");
    if (el) {
        el.style.filter = `url(#${FILTER_ID})`;
        el.style.willChange = "filter";
    }
}

// TEMP PARALLAX TEST — remove this function and its call above when no longer needed.
function initParallaxDragTest(): void {
    const el = document.getElementById("parallax-clouds");
    if (!el) return;
    const MAX = 12; // px — subtle drift relative to mouse position
    let targetX = 0, targetY = 0;
    let currentX = 0, currentY = 0;

    window.addEventListener("mousemove", (e) => {
        const nx = (e.clientX / window.innerWidth) * 2 - 1;  // -1..1
        const ny = (e.clientY / window.innerHeight) * 2 - 1;
        targetX = -nx * MAX;
        targetY = -ny * MAX;
    });

    const tick = () => {
        currentX += (targetX - currentX) * 0.08;
        currentY += (targetY - currentY) * 0.08;
        el.style.transform = `translate(${currentX.toFixed(2)}px, ${currentY.toFixed(2)}px)`;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

function locationInit(): void {
    if (DEBUG_LOCATION) {
        const [latitude, longitude] = DEBUG_LOCATION;
        getWeatherData(latitude, longitude);
        getMap(latitude, longitude);
        return;
    }

    const cachedPosition = localStorage.getItem("cachedPosition");
    var usedCachedPosition = false;
    if (cachedPosition) {
        try {
            const { timestamp, coords } = JSON.parse(cachedPosition);
            const age = Date.now() - timestamp;
            if (age < 10 * 60 * 1000) { // 10 minutes
                usedCachedPosition = true;
                getWeatherData(coords.latitude, coords.longitude);
                getMap(coords.latitude, coords.longitude);
            } else {
                console.log("Cached position is too old, fetching new position");
            }
        } catch (e) {
            console.error("Failed to parse cached position, fetching new position", e);
        }
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            cachePosition(position);
            applyLightness(position.coords.latitude, position.coords.longitude);
            if(usedCachedPosition) return;
            const { latitude, longitude } = position.coords;
            getWeatherData(latitude, longitude);
            getMap(latitude, longitude);
        },
        (error) => {
            console.error(error);
        },
        { enableHighAccuracy: false},
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

async function getWeatherData(lat: number, long: number): Promise<void> {
    return
    const params = {
        latitude: lat,
        longitude: long,
        current: ["temperature_2m", "precipitation", "rain", "snowfall", "visibility"],
    };

    const url = "https://api.open-meteo.com/v1/forecast";
    const response = await fetchWeatherApi(url, params);
    const current = response[0].current()!;

    const weatherData = {
        temperature: current.variables(0)!.value(),
        precipitation: current.variables(1)!.value(),
        rain: current.variables(2)!.value(),
        snowfall: current.variables(3)!.value(),
        visibility: current.variables(4)!.value(),
    };

    $("#temperature").text(`Temperature: ${weatherData.temperature.toFixed(1)}°C`);
    $("#precipitation").text(`Precipitation: ${weatherData.precipitation} mm`);
    $("#rain").text(`Rain: ${weatherData.rain} mm`);
    $("#snowfall").text(`Snowfall: ${weatherData.snowfall} cm`);
    $("#visibility").text(`Visibility: ${(weatherData.visibility / 1000).toFixed(1)} km`);
}

function altitudeToCityLightsOpacity(altRad: number): number {
    const MAX = 0.55;
    const START_DEG = -1.75;
    const END_DEG = -2.5;
    const alt = altRad * (180 / Math.PI);
    if (alt >= START_DEG) return 0;
    if (alt <= END_DEG) return MAX;
    const t = (START_DEG - alt) / (START_DEG - END_DEG);
    return MAX * t * t * (3 - 2 * t);
}

function altitudeToDarkOverlayOpacity(altRad: number): number {
    const MAX = 0.78;
    const START_DEG = 0;
    const END_DEG = -2;
    const alt = altRad * (180 / Math.PI);
    if (alt >= START_DEG) return 0;
    if (alt <= END_DEG) return MAX;
    const t = (START_DEG - alt) / (START_DEG - END_DEG);
    return MAX * t * t * (3 - 2 * t);
}

function altitudeToSunsetOverlayOpacity(altRad: number): number {
    const MAX = 0.25;
    const START_DEG = -0.75;
    const PEAK_DEG = -1.25;
    const END_DEG = -2.25;
    const alt = altRad * (180 / Math.PI);
    
    if (alt >= START_DEG) return 0;
    if (alt <= END_DEG) return 0;
    
    if (alt >= PEAK_DEG) {
        const t = (START_DEG - alt) / (START_DEG - PEAK_DEG);
        return MAX * t * t * (3 - 2 * t);
    } else {
        const t = (alt - END_DEG) / (PEAK_DEG - END_DEG);
        return MAX * t * t * (3 - 2 * t);
    }
}

function isAnyDarknessVisible(map: maplibregl.Map, date: Date): boolean {
    const c = map.getContainer();
    const W = c.clientWidth, H = c.clientHeight;
    const N = 5; // 5x5 sample grid
    const THRESHOLD_DEG = 0.25; // small positive epsilon — start a hair before true sunset
    for (let iy = 0; iy < N; iy++) {
        for (let ix = 0; ix < N; ix++) {
            const px = (ix / (N - 1)) * W;
            const py = (iy / (N - 1)) * H;
            const ll = map.unproject([px, py] as [number, number]);
            const altDeg = SunCalc.getPosition(date, ll.lat, ll.lng).altitude * (180 / Math.PI);
            if (altDeg < THRESHOLD_DEG) return true;
        }
    }
    return false;
}

function getMap(lat: number, lng: number): void {
    // --- Satellite map (bottom layer) ---
    const satelliteMap = new maplibregl.Map({
        container: "map",
        style: {
            version: 8,
            sources: DEBUG_LAYERS.satellite ? {
                "satellite": {
                    type: "raster",
                    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
                    tileSize: 256,
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

    // Track readiness of every map that needs to render before we reveal the
    // container. Each gate resolves once that map's first "idle" fires (or, for
    // the night map, once we know it's not needed). When all gates have
    // resolved, the container gets `.show` and fades in.
    const readinessGates: Promise<void>[] = [];
    const gate = (): { promise: Promise<void>; resolve: () => void } => {
        let resolve!: () => void;
        const promise = new Promise<void>(r => { resolve = r; });
        return { promise, resolve };
    };

    const satelliteGate = gate();
    readinessGates.push(satelliteGate.promise);
    satelliteMap.once("idle", satelliteGate.resolve);

    const nightGate = gate();
    readinessGates.push(nightGate.promise);

    let nightMap: maplibregl.Map | null = null;
    let darknessActive = false;

    const nightMapStyle: maplibregl.StyleSpecification = {
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
    };

    const setDarknessElementsVisible = (visible: boolean): void => {
        const display = visible ? "" : "none";
        const lights = document.getElementById("map-lights");
        const dark = document.getElementById("night-overlay");
        const sunset = document.getElementById("sunset-overlay");
        if (lights) lights.style.display = display;
        if (dark) dark.style.display = display;
        if (sunset) sunset.style.display = display;
    };

    const ensureNightMapAndUpdate = (date: Date): void => {
        if (!nightMap) {
            nightMap = new maplibregl.Map({
                container: "map-lights",
                style: nightMapStyle,
                center: [lng, lat],
                zoom: MAP_ZOOM,
                interactive: false,
                trackResize: false,
            });
            silenceTileFetchNoise(nightMap);
            nightMap.once("idle", () => {
                updateTerminatorMask(satelliteMap, date);
                nightGate.resolve();
            });
        } else {
            updateTerminatorMask(satelliteMap, date);
        }
    };

    const evaluateDarknessTick = (): void => {
        const now = DEBUG_TIME ? new Date(DEBUG_TIME) : new Date();
        const shouldRender = DEBUG_LAYERS.nightEarth && isAnyDarknessVisible(satelliteMap, now);

        if (shouldRender && !darknessActive) {
            darknessActive = true;
            setDarknessElementsVisible(true);
            ensureNightMapAndUpdate(now);
        } else if (!shouldRender && darknessActive) {
            darknessActive = false;
            setDarknessElementsVisible(false);
        } else if (shouldRender && darknessActive) {
            updateTerminatorMask(satelliteMap, now);
        }
    };

    if (DEBUG_LAYERS.nightEarth) {
        setDarknessElementsVisible(false);
        satelliteMap.once("idle", () => {
            evaluateDarknessTick();
            // If darkness wasn't needed on first eval, the night map will never
            // be created — resolve the gate now so the reveal isn't blocked.
            if (!darknessActive) nightGate.resolve();
            setInterval(evaluateDarknessTick, 60_000);
        });
    } else {
        // Night layer disabled — nothing to wait for.
        nightGate.resolve();
    }

    if (DEBUG_LAYERS.clouds) {
        const cloudStyle = (): maplibregl.StyleSpecification => ({
            version: 8,
            sources: {
                "clouds": {
                    type: "raster",
                    tiles: [`https://tile.openweathermap.org/map/clouds_new/{z}/{x}/{y}.png?appid=${OWM_API_KEY}`],
                    tileSize: 256,
                    attribution: "© OpenWeatherMap",
                },
            },
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

        const mkCloudsMap = (containerId: string) => {
            const m = new maplibregl.Map({
                container: containerId,
                style: cloudStyle(),
                center: [lng, lat],
                zoom: MAP_ZOOM,
                interactive: false,
            });
            silenceTileFetchNoise(m);
            const cloudsGate = gate();
            readinessGates.push(cloudsGate.promise);
            m.once("idle", cloudsGate.resolve);
            m.once("load", () => m.resize());
            window.addEventListener("resize", () => m.resize());
        };

        mkCloudsMap("map-clouds");
    }

    // All gates registered above synchronously. Reveal the container once they
    // all resolve. Use a snapshot so a later push (e.g. a future re-creation)
    // can't add a new pending gate after we've already started waiting.
    Promise.all(readinessGates.slice()).then(() => {
        const container = document.getElementById("map-container");
        if (container) container.classList.add("show");
    });
}

function applyMask(el: HTMLElement, dataUrl: string): void {
    el.style.maskImage = `url(${dataUrl})`;
    (el.style as any).webkitMaskImage = `url(${dataUrl})`;
    el.style.maskSize = "100% 100%";
    (el.style as any).webkitMaskSize = "100% 100%";
    el.style.maskRepeat = "no-repeat";
    (el.style as any).webkitMaskRepeat = "no-repeat";
}

function updateTerminatorMask(map: maplibregl.Map, date: Date): void {
    const container = map.getContainer();
    const W = container.clientWidth;
    const H = container.clientHeight;

    const SCALE = 4;
    const sw = Math.ceil(W / SCALE);
    const sh = Math.ceil(H / SCALE);

    const mkCanvas = () => { const c = document.createElement("canvas"); c.width = sw; c.height = sh; return c; };
    const nightCanvas = mkCanvas(), darkCanvas = mkCanvas(), sunsetCanvas = DEBUG_LAYERS.sunsetOverlay ? mkCanvas() : null;
    const nightCtx = nightCanvas.getContext("2d")!, darkCtx = darkCanvas.getContext("2d")!, sunsetCtx = sunsetCanvas ? sunsetCanvas.getContext("2d")! : null;
    const nightData = nightCtx.createImageData(sw, sh);
    const darkData = darkCtx.createImageData(sw, sh);
    const sunsetData = sunsetCtx ? sunsetCtx.createImageData(sw, sh) : null;

    for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
            const lngLat = map.unproject([(x + 0.5) * SCALE, (y + 0.5) * SCALE] as [number, number]);
            const { altitude } = SunCalc.getPosition(date, lngLat.lat, lngLat.lng);
            const i = (y * sw + x) * 4;

            nightData.data[i] = nightData.data[i+1] = nightData.data[i+2] = 255;
            nightData.data[i+3] = Math.round(altitudeToCityLightsOpacity(altitude) * 255);

            darkData.data[i] = darkData.data[i+1] = darkData.data[i+2] = 255;
            darkData.data[i+3] = Math.round(altitudeToDarkOverlayOpacity(altitude) * 255);

            if (sunsetData) {
                sunsetData.data[i] = sunsetData.data[i+1] = sunsetData.data[i+2] = 255;
                sunsetData.data[i+3] = Math.round(altitudeToSunsetOverlayOpacity(altitude) * 255);
            }
        }
    }

    nightCtx.putImageData(nightData, 0, 0);
    applyMask(document.getElementById("map-lights")!, nightCanvas.toDataURL("image/png"));

    darkCtx.putImageData(darkData, 0, 0);
    applyMask(document.getElementById("night-overlay")!, darkCanvas.toDataURL("image/png"));

    if (sunsetCtx && sunsetData) {
        sunsetCtx.putImageData(sunsetData, 0, 0);
        applyMask(document.getElementById("sunset-overlay")!, sunsetCanvas!.toDataURL("image/png"));
    }
}