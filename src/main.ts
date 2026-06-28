import "./style.css";
import { applyLightness, initCloudParallax, renderMap } from "./map";

export const SETTINGS = {
    debug: {
        location: null as [number, number] | null,
        time: null as string | null,
        timeScale: 1,
        layers: {
            satellite: true,
            nightEarth: true,
            clouds: true,
            sunsetOverlay: true,
        },
    },

    mapZoom: 9,
    cachedPositionMaxAgeMs: 10 * 60 * 1000,

    lightness: {
        dayValue: 90,
        nightValue: 10,
        fullDayAltitudeDeg: 0,
        fullNightAltitudeDeg: -2,
    },

    cityLights: {
        maxOpacity: 0.55,
        fadeStartDeg: -1.75,
        fadeEndDeg: -2.5,
    },

    darkOverlay: {
        maxOpacity: 0.7,
        fadeStartDeg: 0,
        fadeEndDeg: -2,
        tintRgb: [0, 0, 0] as [number, number, number],
    },

    sunsetOverlay: {
        maxOpacity: 0.2,
        fadeInStartDeg: 0,
        peakDeg: -1.25,
        fadeOutEndDeg: -2.25,
        tintRgb: [255, 115, 0] as [number, number, number],
    },

    darknessProbe: {
        samplesPerAxis: 5,
        thresholdDeg: 0.25,
    },

    overlaySampling: {
        screenPxPerSample: 4,
        sunKeyframeIntervalMs: 60_000,
        repaintIntervalMs: 2_000,
    },

    cloudParallax: {
        maxDriftPx: 12,
        smoothing: 0.08,
    },

    cloudVeil: {
        opacity: 0.8,
        seamBlurStdDeviation: 10,
        filterRegionInset: "-25%",
        filterRegionSize: "150%",
    },

    cloudBlurMaskDownscale: 4,

    satelliteSource: {
        tiles: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        tileSize: 128,
        maxzoom: 14,
        attribution: "Sentinel-2 cloudless by EOX",
    },

    nightLightsSource: {
        tiles: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Night_Lights/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png",
        tileSize: 256,
        maxzoom: 8,
        attribution: "© NASA GIBS Night Lights",
    },

    dwdClouds: {
        longitudeRange: [-70, 60] as [number, number],
        tiles: "https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.3.0&request=GetMap"
            + "&layers=dwd:Satellite_meteosat_1km_euat_rgb_day_hrv_and_night_ir108_3h"
            + "&styles=&format=image/png&transparent=true&crs=EPSG:3857"
            + "&width=256&height=256&bbox={bbox-epsg-3857}",
        tileSize: 256,
        maxzoom: 7,
        attribution: "© Deutscher Wetterdienst / EUMETSAT",
        alphaTable: "0 0.02 0.08 0.19 0.37 0.55 0.65 0.7 0.74 0.76 0.78 0.79 0.8",
        blurCoverage: [0.15, 0.55] as [number, number],
    },

    infraredClouds: {
        tilesTemplate: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{satellite}_Band13_Clean_Infrared/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png",
        tileSize: 256,
        maxzoom: 6,
        attribution: "© NASA GIBS / NOAA / JMA",
        alphaTable: "0 0 0 0 0.03 0.08 0.2 0.4 0.58 0.7 0.76 0.79 0.8",
        blurCoverage: [0.45, 0.78] as [number, number],
    },
};

//SETTINGS.debug.location = [37.76768397896848, -122.43518534355537] // San Francisco
//SETTINGS.debug.location = [51.5074, -0.1278] // London
//SETTINGS.debug.location = [37.9838, 23.7275] // Athens
//SETTINGS.debug.location = [48.198514822371735, -106.62992896455773] // Glagow, MT

(function initLightnessEarly() {
    const debugLocation = SETTINGS.debug.location;
    if (debugLocation) {
        applyLightness(debugLocation[0], debugLocation[1]);
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
    document.documentElement.setAttribute("data-loaded", "true");
    locationInit();
    initCloudParallax();
}

function locationInit(): void {
    const debugLocation = SETTINGS.debug.location;
    if (debugLocation) {
        renderMap(debugLocation[0], debugLocation[1]);
        return;
    }

    const cachedPosition = localStorage.getItem("cachedPosition");
    if (cachedPosition) {
        try {
            const { timestamp, coords } = JSON.parse(cachedPosition);
            const age = Date.now() - timestamp;
            if (age < SETTINGS.cachedPositionMaxAgeMs) {
                renderMap(coords.latitude, coords.longitude);
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
            const { latitude, longitude } = position.coords;
            applyLightness(latitude, longitude);
            renderMap(latitude, longitude);
        },
        (error) => {
            console.error(error);
        },
        { enableHighAccuracy: false },
    );
}

function cachePosition(position: GeolocationPosition): void {
    const cacheData = {
        timestamp: position.timestamp,
        coords: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
        },
    };
    localStorage.setItem("cachedPosition", JSON.stringify(cacheData));
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
} else {
    main();
}
