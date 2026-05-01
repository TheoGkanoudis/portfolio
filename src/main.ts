import { fetchWeatherApi } from "openmeteo";
import jQuery from "jquery";

declare const $: typeof jQuery;

$(function () {
    weatherInit();
});

function weatherInit(): void {
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            getWeatherData(latitude, longitude);
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

    $("#temperature").text(`Temperature: ${weatherData.temperature}°C`);
    $("#precipitation").text(`Precipitation: ${weatherData.precipitation}mm`);
    $("#rain").text(`Rain: ${weatherData.rain}mm`);
    $("#snowfall").text(`Snowfall: ${weatherData.snowfall}cm`);
    $("#visibility").text(`Visibility: ${weatherData.visibility}m`);
}
