// polymarket-alpha — NWS weather forecasts
// Free, no API key required

import { NWS_API, NWS_GRIDS, TTL } from "../constants.mjs";
import { fetchJSON } from "../helpers.mjs";
import * as cache from "../cache.mjs";

/**
 * Fetch NWS forecast for a city.
 * @param {string} city - city name (must match NWS_GRIDS keys)
 * @returns {Promise<{city: string, periods: Array, raw: object}|null>}
 */
export async function forecast(city) {
  const key = city.toLowerCase().trim();
  const grid = NWS_GRIDS[key];
  if (!grid) return null;

  const cacheKey = `nws:${key}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `${NWS_API}/gridpoints/${grid.office}/${grid.gridX},${grid.gridY}/forecast`;
    const data = await fetchJSON(url, {
      headers: { "User-Agent": "polymarket-alpha/1.0 (contact@example.com)" },
    }, 20_000);

    const periods = (data.properties?.periods || []).map((p) => ({
      name: p.name,
      startTime: p.startTime,
      endTime: p.endTime,
      temperature: p.temperature,
      temperatureUnit: p.temperatureUnit,
      windSpeed: p.windSpeed,
      windDirection: p.windDirection,
      shortForecast: p.shortForecast,
      detailedForecast: p.detailedForecast,
      probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value ?? null,
      isDaytime: p.isDaytime,
    }));

    const result = { city: key, lat: grid.lat, lon: grid.lon, periods };
    cache.set(cacheKey, result, TTL.nws);
    return result;
  } catch {
    return null;
  }
}

/**
 * Extract temperature forecast for a specific date.
 * @param {string} city
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @returns {Promise<{high: number|null, low: number|null, unit: string, forecast: string}|null>}
 */
export async function temperatureOnDate(city, dateStr) {
  const fc = await forecast(city);
  if (!fc) return null;

  const targetDate = dateStr.slice(0, 10); // YYYY-MM-DD
  let high = null;
  let low = null;
  let unit = "F";
  let shortForecast = "";

  for (const p of fc.periods) {
    const periodDate = p.startTime?.slice(0, 10);
    if (periodDate !== targetDate) continue;

    unit = p.temperatureUnit || "F";
    if (p.isDaytime) {
      high = p.temperature;
      shortForecast = p.shortForecast || "";
    } else {
      low = p.temperature;
    }
  }

  if (high === null && low === null) return null;
  return { high, low, unit, forecast: shortForecast };
}

/**
 * Try to extract a city name from a market question.
 * Checks against NWS_GRIDS keys.
 */
export function extractCity(question) {
  const q = question.toLowerCase();
  for (const city of Object.keys(NWS_GRIDS)) {
    if (q.includes(city)) return city;
  }
  return null;
}

/**
 * Try to extract a temperature threshold from a market question.
 * e.g., "exceed 60F" → { threshold: 60, unit: "F", direction: "above" }
 */
export function extractTempThreshold(question) {
  // "exceed 60F", "above 90 degrees", "reach 100°F", "below 32"
  const patterns = [
    /(?:exceed|above|over|reach|hit|surpass|top)\s+(\d+)\s*°?\s*([FC])?/i,
    /(?:below|under|drop below|fall below)\s+(\d+)\s*°?\s*([FC])?/i,
    /(\d+)\s*°?\s*([FC])?\s+(?:or higher|or more|or above)/i,
    /(\d+)\s*°?\s*([FC])?\s+(?:or lower|or less|or below)/i,
  ];

  for (const re of patterns) {
    const m = question.match(re);
    if (m) {
      const direction = /below|under|fall|drop|lower|less/i.test(m[0]) ? "below" : "above";
      return {
        threshold: Number(m[1]),
        unit: (m[2] || "F").toUpperCase(),
        direction,
      };
    }
  }
  return null;
}

/**
 * Try to extract a date from a market question.
 * e.g., "on March 5" → "2026-03-05"
 */
export function extractDate(question) {
  // ISO format
  const isoMatch = question.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  // "March 5", "March 5th", "Mar 5"
  const months = {
    jan: "01", january: "01", feb: "02", february: "02",
    mar: "03", march: "03", apr: "04", april: "04",
    may: "05", jun: "06", june: "06", jul: "07", july: "07",
    aug: "08", august: "08", sep: "09", september: "09",
    oct: "10", october: "10", nov: "11", november: "11",
    dec: "12", december: "12",
  };

  const dateMatch = question.match(/(?:on|by|before)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
  if (dateMatch) {
    const monthKey = dateMatch[1].toLowerCase().slice(0, 3);
    const month = months[monthKey] || months[dateMatch[1].toLowerCase()];
    const day = dateMatch[2].padStart(2, "0");
    const year = dateMatch[3] || new Date().getFullYear().toString();
    return `${year}-${month}-${day}`;
  }

  return null;
}

/**
 * Source status check.
 */
export async function status() {
  try {
    const res = await fetch(`${NWS_API}/gridpoints/OKX/33,37/forecast`, {
      headers: { "User-Agent": "polymarket-alpha/1.0 (contact@example.com)" },
      signal: AbortSignal.timeout(10_000),
    });
    return { name: "nws", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "nws", ok: false, error: e.message };
  }
}
