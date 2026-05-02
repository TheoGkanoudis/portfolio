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
const DEBUG_TIME: string | null = "2024-06-01T02:20:00Z";

// Toggle which layers are fetched and rendered. Disable to isolate individual layers.
const DEBUG_LAYERS = {
    satellite: true,
    nightEarth: true,
    clouds: true,
};

$(function () {
    locationInit();
});

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

// Night-earth opacity: 0 during day, 1 at night, smooth transition through civil twilight (0 to -6 deg)
function altitudeToNightEarthOpacity(altRad: number): number {
    const MAX = 0.75; // keep satellite visible underneath
    const alt = altRad * (180 / Math.PI);
    if (alt >= 0) return 0;
    if (alt <= -6) return MAX;
    const t = -alt / 6;
    return MAX * t * t * (3 - 2 * t);
}

function getMap(lat: number, lng: number): void {
    const sources: maplibregl.StyleSpecification["sources"] = {};
    if (DEBUG_LAYERS.satellite) {
        sources["satellite"] = {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            attribution: "© Esri",
        };
    }
    if (DEBUG_LAYERS.nightEarth) {
        sources["night-earth"] = {
            type: "raster",
            tiles: [
                "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
            ],
            tileSize: 256,
            maxzoom: 8,
            attribution: "© NASA GIBS Black Marble",
        };
    }
    if (DEBUG_LAYERS.clouds) {
        sources["clouds"] = {
            type: "raster",
            tiles: [`https://tile.openweathermap.org/map/clouds/{z}/{x}/{y}.png?appid=${OWM_API_KEY}`],
            tileSize: 512,
            attribution: "© OpenWeatherMap",
        };
    }

    const layers: maplibregl.LayerSpecification[] = [];
    if (DEBUG_LAYERS.satellite) layers.push({ id: "satellite-layer", type: "raster", source: "satellite" });
    if (DEBUG_LAYERS.nightEarth) layers.push({
        id: "night-earth-layer",
        type: "raster",
        source: "night-earth",
        paint: { "raster-opacity": 0, "raster-resampling": "linear" },
    });
    if (DEBUG_LAYERS.clouds) layers.push({ id: "clouds-layer", type: "raster", source: "clouds", paint: { "raster-opacity": 0.8 } });

    const map = new maplibregl.Map({
        container: "map",
        style: { version: 8, sources, layers },
        center: [lng, lat],
        zoom: MAP_ZOOM,
        interactive: false,
        trackResize: false,
    });

    map.once("idle", () => {
        const now = DEBUG_TIME ? new Date(DEBUG_TIME) : new Date();
        if (DEBUG_LAYERS.nightEarth) {
            updateNightEarth(map, lat, lng, now);
            setInterval(() => updateNightEarth(map, lat, lng, DEBUG_TIME ? new Date(DEBUG_TIME) : new Date()), 60_000);
        }
    });

    function updateNightEarth(map: maplibregl.Map, lat: number, lng: number, date: Date): void {
        const { altitude } = SunCalc.getPosition(date, lat, lng);
        map.setPaintProperty("night-earth-layer", "raster-opacity", altitudeToNightEarthOpacity(altitude));
    }
}