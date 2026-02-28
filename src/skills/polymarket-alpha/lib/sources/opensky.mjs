// polymarket-alpha — OpenSky flight tracking
// Free, no API key required (400 requests/day)

import { OPENSKY_API, OPENSKY_ZONES, TTL } from "../constants.mjs";
import { fetchJSON } from "../helpers.mjs";
import * as cache from "../cache.mjs";

/**
 * Fetch aircraft count in a bounding box.
 * @param {object} bbox - { lamin, lomin, lamax, lomax }
 * @returns {Promise<{count: number, time: number}|null>}
 */
export async function flightDensity(bbox) {
  const cacheKey = `opensky:${bbox.lamin},${bbox.lomin},${bbox.lamax},${bbox.lomax}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      lamin: String(bbox.lamin),
      lomin: String(bbox.lomin),
      lamax: String(bbox.lamax),
      lomax: String(bbox.lomax),
    });
    const data = await fetchJSON(`${OPENSKY_API}/states/all?${params}`, {}, 20_000);
    const states = data.states || [];
    const result = { count: states.length, time: data.time };
    cache.set(cacheKey, result, TTL.opensky);
    return result;
  } catch {
    return null;
  }
}

/**
 * Fetch flight density for a named zone.
 * @param {string} zoneName - key from OPENSKY_ZONES
 */
export async function zoneDensity(zoneName) {
  const bbox = OPENSKY_ZONES[zoneName.toLowerCase()];
  if (!bbox) return null;
  const result = await flightDensity(bbox);
  return result ? { ...result, zone: zoneName } : null;
}

/**
 * Extract zone references from a market question.
 */
export function extractZones(question) {
  const q = question.toLowerCase();
  const zones = [];
  for (const zone of Object.keys(OPENSKY_ZONES)) {
    if (q.includes(zone.replace(/_/g, " ")) || q.includes(zone)) {
      zones.push(zone);
    }
  }
  return zones;
}

/**
 * Source status check.
 */
export async function status() {
  try {
    // Use a small bounding box to minimize load
    const res = await fetch(
      `${OPENSKY_API}/states/all?lamin=47&lomin=8&lamax=48&lomax=9`,
      { signal: AbortSignal.timeout(15_000) },
    );
    return { name: "opensky", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "opensky", ok: false, error: e.message };
  }
}
