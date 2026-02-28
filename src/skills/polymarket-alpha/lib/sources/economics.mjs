// polymarket-alpha — FRED economic indicators
// Free with optional API key (FRED_API_KEY)

import { FRED_API, FRED_SERIES, TTL } from "../constants.mjs";
import { fetchJSON } from "../helpers.mjs";
import * as cache from "../cache.mjs";

const FRED_KEY = () => process.env.FRED_API_KEY || null;

/**
 * Fetch latest observation for a FRED series.
 * @param {string} seriesId - e.g., "CPIAUCSL"
 * @returns {Promise<{value: number, date: string, series: string}|null>}
 */
export async function latestObservation(seriesId) {
  const key = FRED_KEY();
  if (!key) return null;

  const cacheKey = `fred:${seriesId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: key,
      file_type: "json",
      sort_order: "desc",
      limit: "1",
    });
    const data = await fetchJSON(`${FRED_API}/series/observations?${params}`);
    const obs = data.observations?.[0];
    if (!obs || obs.value === ".") return null;

    const result = {
      value: Number(obs.value),
      date: obs.date,
      series: seriesId,
    };
    cache.set(cacheKey, result, TTL.fred);
    return result;
  } catch {
    return null;
  }
}

/**
 * Fetch recent observations to compute trend.
 * @param {string} seriesId
 * @param {number} count - number of recent observations
 */
export async function recentTrend(seriesId, count = 6) {
  const key = FRED_KEY();
  if (!key) return null;

  const cacheKey = `fred:trend:${seriesId}:${count}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: key,
      file_type: "json",
      sort_order: "desc",
      limit: String(count),
    });
    const data = await fetchJSON(`${FRED_API}/series/observations?${params}`);
    const observations = (data.observations || [])
      .filter((o) => o.value !== ".")
      .map((o) => ({ value: Number(o.value), date: o.date }))
      .reverse();

    if (observations.length < 2) return null;

    const first = observations[0].value;
    const last = observations[observations.length - 1].value;
    const direction = last > first ? "rising" : last < first ? "falling" : "flat";

    const result = { observations, direction, change: last - first, changePct: (last - first) / first };
    cache.set(cacheKey, result, TTL.fred);
    return result;
  } catch {
    return null;
  }
}

/**
 * Map economic keywords in market question to FRED series.
 */
export function extractSeries(question) {
  const q = question.toLowerCase();
  const matches = [];

  const mappings = [
    { keywords: ["cpi", "consumer price", "inflation rate"], series: FRED_SERIES.cpi },
    { keywords: ["unemployment", "jobless", "jobs report"], series: FRED_SERIES.unemployment },
    { keywords: ["gdp", "gross domestic"], series: FRED_SERIES.gdp },
    { keywords: ["fed funds", "federal funds", "interest rate"], series: FRED_SERIES.fed_funds },
    { keywords: ["10-year", "10 year", "treasury yield"], series: FRED_SERIES.treasury_10y },
    { keywords: ["housing start"], series: FRED_SERIES.housing_starts },
    { keywords: ["retail sales"], series: FRED_SERIES.retail_sales },
    { keywords: ["industrial production"], series: FRED_SERIES.industrial_production },
    { keywords: ["pce", "personal consumption"], series: FRED_SERIES.pce },
  ];

  for (const m of mappings) {
    if (m.keywords.some((kw) => q.includes(kw))) {
      matches.push(m.series);
    }
  }

  return matches;
}

/**
 * Extract numeric threshold from economics questions.
 * e.g., "CPI exceed 3.5%" → { threshold: 3.5, direction: "above" }
 */
export function extractThreshold(question) {
  const patterns = [
    /(?:exceed|above|over|reach|hit|surpass)\s+([\d.]+)\s*%?/i,
    /(?:below|under|drop|fall)\s+([\d.]+)\s*%?/i,
    /([\d.]+)\s*%?\s+(?:or higher|or more|or above)/i,
    /([\d.]+)\s*%?\s+(?:or lower|or less|or below)/i,
  ];

  for (const re of patterns) {
    const m = question.match(re);
    if (m) {
      const direction = /below|under|drop|fall|lower|less/i.test(m[0]) ? "below" : "above";
      return { threshold: Number(m[1]), direction };
    }
  }
  return null;
}

/**
 * Source status check.
 */
export async function status() {
  const key = FRED_KEY();
  if (!key) return { name: "fred", ok: false, error: "FRED_API_KEY not set (optional)" };
  try {
    const params = new URLSearchParams({
      series_id: "GDP",
      api_key: key,
      file_type: "json",
      sort_order: "desc",
      limit: "1",
    });
    const res = await fetch(`${FRED_API}/series/observations?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    return { name: "fred", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "fred", ok: false, error: e.message };
  }
}
