// polymarket-alpha — CoinGecko prices + Fear & Greed index
// Free, no API key required

import { COINGECKO_API, FEAR_GREED_API, COIN_IDS, TTL } from "../constants.mjs";
import { fetchJSON } from "../helpers.mjs";
import * as cache from "../cache.mjs";

/**
 * Fetch current prices for multiple coins.
 * @param {string[]} coinIds - CoinGecko coin IDs
 * @returns {Promise<Record<string, {usd: number, usd_24h_change: number}>>}
 */
export async function prices(coinIds) {
  const ids = coinIds.join(",");
  const cacheKey = `cg:prices:${ids}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJSON(
      `${COINGECKO_API}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`,
    );
    cache.set(cacheKey, data, TTL.coingecko);
    return data;
  } catch {
    return {};
  }
}

/**
 * Fetch price for a single coin by name/ticker.
 * @param {string} nameOrTicker - e.g., "bitcoin", "BTC", "eth"
 */
export async function price(nameOrTicker) {
  const id = COIN_IDS[nameOrTicker.toLowerCase()] || nameOrTicker.toLowerCase();
  const data = await prices([id]);
  return data[id] || null;
}

/**
 * Fetch Crypto Fear & Greed Index.
 * @returns {Promise<{value: number, classification: string, timestamp: string}>}
 */
export async function fearGreed() {
  const cacheKey = "fng";
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJSON(`${FEAR_GREED_API}/?limit=1`);
    const entry = data.data?.[0];
    if (!entry) return null;

    const result = {
      value: Number(entry.value),
      classification: entry.value_classification,
      timestamp: entry.timestamp,
    };
    cache.set(cacheKey, result, TTL.fearGreed);
    return result;
  } catch {
    return null;
  }
}

/**
 * Extract coin references from a market question.
 * Returns CoinGecko IDs.
 */
export function extractCoins(question) {
  const q = question.toLowerCase();
  const found = new Set();

  for (const [key, id] of Object.entries(COIN_IDS)) {
    // Use word boundary for short tickers to avoid false matches
    if (key.length <= 4) {
      const re = new RegExp(`\\b${key}\\b`, "i");
      if (re.test(question)) found.add(id);
    } else {
      if (q.includes(key)) found.add(id);
    }
  }

  return [...found];
}

/**
 * Extract price threshold from a market question.
 * e.g., "bitcoin above $100,000" → { target: 100000, direction: "above" }
 */
export function extractPriceTarget(question) {
  const patterns = [
    /(?:above|exceed|reach|hit|surpass|over)\s+\$?([\d,]+(?:\.\d+)?)\s*([kmbt])?(?:\b|$)/i,
    /(?:below|under|drop|fall)\s+\$?([\d,]+(?:\.\d+)?)\s*([kmbt])?(?:\b|$)/i,
    /\$?([\d,]+(?:\.\d+)?)\s*([kmbt])?\s+(?:or higher|or more|or above)/i,
    /\$?([\d,]+(?:\.\d+)?)\s*([kmbt])?\s+(?:or lower|or less|or below)/i,
    // "$100k", "$1m", "$150,000"
    /\$([\d,]+(?:\.\d+)?)\s*([kmbt])?(?:\b|$)/i,
  ];

  for (const re of patterns) {
    const m = question.match(re);
    if (m) {
      let target = Number(m[1].replace(/,/g, ""));
      const suffix = (m[2] || "").toLowerCase();
      if (suffix === "k") target *= 1_000;
      else if (suffix === "m") target *= 1_000_000;
      else if (suffix === "b") target *= 1_000_000_000;
      else if (suffix === "t") target *= 1_000_000_000_000;
      const direction = /below|under|drop|fall|lower|less/i.test(m[0]) ? "below" : "above";
      return { target, direction };
    }
  }
  return null;
}

/**
 * Source status check.
 */
export async function statusCoinGecko() {
  try {
    const res = await fetch(`${COINGECKO_API}/ping`, {
      signal: AbortSignal.timeout(10_000),
    });
    return { name: "coingecko", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "coingecko", ok: false, error: e.message };
  }
}

export async function statusFearGreed() {
  try {
    const res = await fetch(`${FEAR_GREED_API}/?limit=1`, {
      signal: AbortSignal.timeout(10_000),
    });
    return { name: "fear_greed", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "fear_greed", ok: false, error: e.message };
  }
}
