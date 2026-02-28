// polymarket-alpha — Open-Meteo multi-model ensemble weather forecasts
// Free, no API key required, unlimited requests

import { OPENMETEO_API, TTL } from "../constants.mjs";
import { fetchJSON } from "../helpers.mjs";
import * as cache from "../cache.mjs";

/**
 * Fetch multi-model ensemble forecast for a location.
 * Returns forecasts from GFS, ECMWF, and ICON side by side.
 * Model spread = uncertainty. Agreement within 2F = high confidence.
 *
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{models: Array, spread: object, agreement: string, precipProb: number|null}|null>}
 */
export async function forecast(lat, lon) {
  const cacheKey = `ensemble:${lat}:${lon}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `${OPENMETEO_API}?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&models=gfs_seamless,ecmwf_ifs025,icon_seamless&temperature_unit=fahrenheit&timezone=auto&forecast_days=7`;
    const data = await fetchJSON(url, {}, 15_000);

    const result = parseEnsembleResponse(data);
    if (result) cache.set(cacheKey, result, TTL.ensemble);
    return result;
  } catch {
    return null;
  }
}

/**
 * Parse the Open-Meteo multi-model response into structured data.
 */
function parseEnsembleResponse(data) {
  // Open-Meteo returns separate daily arrays per model
  // Models are returned as separate objects in the response
  const models = [];
  const modelNames = ["gfs_seamless", "ecmwf_ifs025", "icon_seamless"];
  const displayNames = { gfs_seamless: "GFS", ecmwf_ifs025: "ECMWF", icon_seamless: "ICON" };

  // Open-Meteo returns daily data per model when multiple models are requested
  // The response structure has daily_{modelName} keys
  for (const modelKey of modelNames) {
    const dailyKey = `daily`;
    const daily = data[dailyKey];
    if (!daily) continue;

    // When multiple models requested, data comes with model suffix
    const highKey = `temperature_2m_max`;
    const lowKey = `temperature_2m_min`;
    const precipKey = `precipitation_probability_max`;

    const highs = daily[highKey];
    const lows = daily[lowKey];
    const precip = daily[precipKey];
    const times = daily.time;

    if (!highs || !lows || !times) continue;

    // Only add once for the combined response, then break
    // Open-Meteo with multiple models returns them in a single daily block
    for (let i = 0; i < Math.min(times.length, 7); i++) {
      if (models.length <= i) {
        models.push({
          date: times[i],
          forecasts: [],
          precipProb: precip?.[i] ?? null,
        });
      }
    }
    break;
  }

  // Try the multi-model separate response format
  // Open-Meteo actually returns separate daily blocks per model
  for (const modelKey of modelNames) {
    const daily = data[`daily_${modelKey}`] || data.daily;
    if (!daily) continue;

    const highs = daily.temperature_2m_max;
    const lows = daily.temperature_2m_min;
    const times = daily.time;
    if (!highs || !lows || !times) continue;

    for (let i = 0; i < Math.min(times.length, 7); i++) {
      if (models.length <= i) {
        models.push({
          date: times[i],
          forecasts: [],
          precipProb: daily.precipitation_probability_max?.[i] ?? null,
        });
      }
      models[i].forecasts.push({
        name: displayNames[modelKey] || modelKey,
        high: highs[i],
        low: lows[i],
      });
    }
  }

  if (models.length === 0) {
    // Fallback: single-model response (Open-Meteo may combine them)
    const daily = data.daily;
    if (!daily?.time) return null;
    for (let i = 0; i < Math.min(daily.time.length, 7); i++) {
      models.push({
        date: daily.time[i],
        forecasts: [{
          name: "combined",
          high: daily.temperature_2m_max?.[i],
          low: daily.temperature_2m_min?.[i],
        }],
        precipProb: daily.precipitation_probability_max?.[i] ?? null,
      });
    }
  }

  if (models.length === 0) return null;

  // Compute spread for each day (max - min across models)
  const spreads = models.map((day) => {
    if (day.forecasts.length < 2) return { high: 0, low: 0 };
    const highs = day.forecasts.map((f) => f.high).filter((v) => v != null);
    const lows = day.forecasts.map((f) => f.low).filter((v) => v != null);
    return {
      high: highs.length > 1 ? Math.max(...highs) - Math.min(...highs) : 0,
      low: lows.length > 1 ? Math.max(...lows) - Math.min(...lows) : 0,
    };
  });

  // Aggregate: average spread over forecast period
  const avgSpreadHigh = spreads.reduce((s, x) => s + x.high, 0) / spreads.length;
  const avgSpreadLow = spreads.reduce((s, x) => s + x.low, 0) / spreads.length;

  // Agreement classification
  let agreement;
  const maxSpread = Math.max(avgSpreadHigh, avgSpreadLow);
  if (maxSpread <= 2) agreement = "high";
  else if (maxSpread <= 5) agreement = "moderate";
  else if (maxSpread <= 8) agreement = "low";
  else agreement = "very_low";

  return {
    days: models,
    spread: { avgHigh: Math.round(avgSpreadHigh * 10) / 10, avgLow: Math.round(avgSpreadLow * 10) / 10 },
    agreement,
    firstDayPrecipProb: models[0]?.precipProb ?? null,
  };
}

/**
 * Get ensemble forecast for a specific date.
 * @param {number} lat
 * @param {number} lon
 * @param {string} dateStr - YYYY-MM-DD
 */
export async function forecastOnDate(lat, lon, dateStr) {
  const fc = await forecast(lat, lon);
  if (!fc) return null;

  const target = dateStr.slice(0, 10);
  const day = fc.days.find((d) => d.date === target);
  if (!day) return null;

  return {
    date: day.date,
    forecasts: day.forecasts,
    precipProb: day.precipProb,
    agreement: fc.agreement,
    spread: fc.spread,
  };
}

/**
 * Source status check.
 */
export async function status() {
  try {
    const res = await fetch(
      `${OPENMETEO_API}?latitude=40.71&longitude=-74.01&daily=temperature_2m_max&forecast_days=1`,
      { signal: AbortSignal.timeout(10_000) },
    );
    return { name: "ensemble", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "ensemble", ok: false, error: e.message };
  }
}
