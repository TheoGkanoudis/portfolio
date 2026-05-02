import { fetchWeatherApi } from "openmeteo";
import jQuery from "jquery";
import maplibregl from "maplibre-gl";
import * as SunCalc from "suncalc";

declare const $: typeof jQuery;

// ─── Configuration ────────────────────────────────────────────────────────────
const MAP_ZOOM = 10;
const OWM_API_KEY = (import.meta as any).env.VITE_OWM_API_KEY as string;
// ──────────────────────────────────────────────────────────────────────────────

$(function () {
    weatherInit();
});

function weatherInit(): void {
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            getWeatherData(latitude, longitude);
            getMap(latitude, longitude);
        },
        (error) => {
            console.error(error);
        },
    );
}

async function getWeatherData(lat: number, long: number): Promise<void> {
    const params = {
        latitude: lat,
        longitude: long,
        current: ["temperature_2m", "precipitation", "rain", "snowfall", "visibility"],
    };

    const url = "https://api.open-meteo.com/v1/forecast";
    const responses = await fetchWeatherApi(url, params);
    const response = responses[0];

    const current = response.current()!;

    const weatherData = {
        temperature: current.variables(0)!.value(),
        precipitation: current.variables(1)!.value(),
        rain: current.variables(2)!.value(),
        snowfall: current.variables(3)!.value(),
        visibility: current.variables(4)!.value(),
    };

    console.log("Current weather:", weatherData);

    $("#temperature").text(`Temperature: ${weatherData.temperature.toFixed(1)}°C`);
    $("#precipitation").text(`Precipitation: ${weatherData.precipitation} mm`);
    $("#rain").text(`Rain: ${weatherData.rain} mm`);
    $("#snowfall").text(`Snowfall: ${weatherData.snowfall} cm`);
    $("#visibility").text(`Visibility: ${(weatherData.visibility / 1000).toFixed(1)} km`);
}

function getMap(lat: number, lng: number): void {
    const now = new Date();
    const sunTimes = SunCalc.getTimes(now, lat, lng);
    const isNight = now < sunTimes.sunrise || now > sunTimes.sunset;

    const map = new maplibregl.Map({
        container: "map",
        style: {
            version: 8,
            sources: {
                satellite: {
                    type: "raster",
                    tiles: [
                        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                    ],
                    tileSize: 256,
                    attribution: "© Esri",
                },
                clouds: {
                    type: "raster",
                    tiles: [
                        `https://tile.openweathermap.org/map/clouds_new/{z}/{x}/{y}.png?appid=${OWM_API_KEY}`,
                    ],
                    tileSize: 256,
                    attribution: "© OpenWeatherMap",
                },
            },
            layers: [
                {
                    id: "satellite-layer",
                    type: "raster",
                    source: "satellite",
                },
                {
                    id: "clouds-layer",
                    type: "raster",
                    source: "clouds",
                    paint: { "raster-opacity": 0.7 },
                },
                // Darkens the map at night
                {
                    id: "night-overlay",
                    type: "background",
                    paint: {
                        "background-color": "#00010a",
                        "background-opacity": isNight ? 0.45 : 0,
                    },
                },
            ],
        },
        center: [lng, lat],
        zoom: MAP_ZOOM,
        interactive: false,
    });

    // Re-evaluate night overlay every minute
    setInterval(() => {
        const t = new Date();
        const st = SunCalc.getTimes(t, lat, lng);
        const night = t < st.sunrise || t > st.sunset;
        map.setPaintProperty("night-overlay", "background-opacity", night ? 0.45 : 0);
    }, 60_000);
}
