import { fetchWeatherApi } from "openmeteo";
import jQuery from "jquery";
import maplibregl from "maplibre-gl";
import * as SunCalc from "suncalc";

declare const $: typeof jQuery;

// Configuration
const MAP_ZOOM = 6;
const OWM_API_KEY = (import.meta as any).env.VITE_OWM_API_KEY as string;

// Set to [lat, lng] to override geolocation (e.g. to test night side). null = use real location.
const DEBUG_LOCATION: [number, number] | null = null;
// Override the current time for testing day/night. Use an ISO string e.g. "2024-01-01T00:00:00Z" for night, "2024-07-01T12:00:00Z" for day. null = use real time.
const DEBUG_TIME: string | null = null;

// Toggle which layers are fetched and rendered. Disable to isolate individual layers.
const DEBUG_LAYERS = {
    satellite: true,
    nightEarth: true,
    clouds: true,
};

$(function () {
    locationInit();
    initParallaxDragTest(); // TEMP: remove when real parallax is wired up
});

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

// Night-earth (city lights) opacity: starts at -3°, full by -6° (3° window).
function altitudeToNightEarthOpacity(altRad: number): number {
    const MAX = 0.65;
    const START_DEG = -3;
    const END_DEG = -6;
    const alt = altRad * (180 / Math.PI);
    if (alt >= START_DEG) return 0;
    if (alt <= END_DEG) return MAX;
    const t = (START_DEG - alt) / (START_DEG - END_DEG);
    return MAX * t * t * (3 - 2 * t);
}

// Dark overlay opacity: starts at sunset (0°), fully dark by -4° (4° window).
function altitudeToDarkOverlayOpacity(altRad: number): number {
    const MAX = 0.82;
    const START_DEG = 0;
    const END_DEG = -4;
    const alt = altRad * (180 / Math.PI);
    if (alt >= START_DEG) return 0;
    if (alt <= END_DEG) return MAX;
    const t = (START_DEG - alt) / (START_DEG - END_DEG);
    return MAX * t * t * (3 - 2 * t);
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
                    attribution: "© Esri",
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

    // --- Night-earth map (city lights) ---
    if (DEBUG_LAYERS.nightEarth) {
        const nightMapStyle: maplibregl.StyleSpecification = {
            version: 8,
            sources: {
                "night-earth": {
                    type: "raster",
                    tiles: [
                        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
                    ],
                    tileSize: 256,
                    maxzoom: 8,
                    attribution: "© NASA GIBS Black Marble",
                },
            },
            layers: [{ id: "night-earth-layer", type: "raster", source: "night-earth" }],
        };

        const nightMap = new maplibregl.Map({
            container: "map-night",
            style: nightMapStyle,
            center: [lng, lat],
            zoom: MAP_ZOOM,
            interactive: false,
            trackResize: false,
        });

        nightMap.once("idle", () => {
            const now = DEBUG_TIME ? new Date(DEBUG_TIME) : new Date();
            updateTerminatorMask(satelliteMap, now);
            setInterval(() => updateTerminatorMask(satelliteMap, DEBUG_TIME ? new Date(DEBUG_TIME) : new Date()), 60_000);
        });
    }

    // --- Clouds map ---
    if (DEBUG_LAYERS.clouds) {
        const cloudsMap = new maplibregl.Map({
            container: "map-clouds",
            style: {
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
                        "raster-opacity": 1.0,
                        "raster-fade-duration": 0,
                        "raster-resampling": "linear",
                    },
                }],
            },
            center: [lng, lat],
            zoom: MAP_ZOOM,
            interactive: false,
        });
        // Container is larger than the viewport (for parallax headroom) — sync canvas size.
        cloudsMap.once("load", () => cloudsMap.resize());
        window.addEventListener("resize", () => cloudsMap.resize());
    }
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
    const nightCanvas = mkCanvas(), darkCanvas = mkCanvas();
    const nightCtx = nightCanvas.getContext("2d")!, darkCtx = darkCanvas.getContext("2d")!;
    const nightData = nightCtx.createImageData(sw, sh);
    const darkData = darkCtx.createImageData(sw, sh);

    for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
            const lngLat = map.unproject([(x + 0.5) * SCALE, (y + 0.5) * SCALE] as [number, number]);
            const { altitude } = SunCalc.getPosition(date, lngLat.lat, lngLat.lng);
            const i = (y * sw + x) * 4;

            nightData.data[i] = nightData.data[i+1] = nightData.data[i+2] = 255;
            nightData.data[i+3] = Math.round(altitudeToNightEarthOpacity(altitude) * 255);

            darkData.data[i] = darkData.data[i+1] = darkData.data[i+2] = 255;
            darkData.data[i+3] = Math.round(altitudeToDarkOverlayOpacity(altitude) * 255);
        }
    }

    nightCtx.putImageData(nightData, 0, 0);
    applyMask(document.getElementById("map-night")!, nightCanvas.toDataURL("image/png"));

    darkCtx.putImageData(darkData, 0, 0);
    applyMask(document.getElementById("night-overlay")!, darkCanvas.toDataURL("image/png"));
}