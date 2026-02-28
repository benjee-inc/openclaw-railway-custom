// polymarket-alpha — Coinglass funding rates + open interest
// Free public endpoints, no API key required

import { COINGLASS_API, TTL } from "../constants.mjs";
import { fetchJSON } from "../helpers.mjs";
import * as cache from "../cache.mjs";

// Map CoinGecko IDs to Coinglass symbols
const SYMBOL_MAP = {
  bitcoin: "BTC",
  ethereum: "ETH",
  solana: "SOL",
  dogecoin: "DOGE",
  cardano: "ADA",
  ripple: "XRP",
  "avalanche-2": "AVAX",
  "matic-network": "MATIC",
  polkadot: "DOT",
  chainlink: "LINK",
  litecoin: "LTC",
  binancecoin: "BNB",
};

/**
 * Fetch funding rates for a coin.
 * Positive funding = longs paying shorts = overleveraged bullish.
 * Negative funding = shorts paying longs = overleveraged bearish.
 *
 * @param {string} coinId - CoinGecko coin ID (e.g., "bitcoin")
 * @returns {Promise<{symbol: string, rate: number, openInterest: number|null, longRatio: number|null}|null>}
 */
export async function fundingRate(coinId) {
  const symbol = SYMBOL_MAP[coinId];
  if (!symbol) return null;

  const cacheKey = `coinglass:funding:${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `${COINGLASS_API}/public/v2/funding`;
    const data = await fetchJSON(url, {}, 10_000);

    if (!data?.data) return null;

    // Find the coin in the response
    const entry = data.data.find((d) =>
      d.symbol?.toUpperCase() === symbol || d.slug?.toUpperCase() === symbol,
    );
    if (!entry) return null;

    const result = {
      symbol,
      rate: Number(entry.uMarginFundingRate || entry.fundingRate || 0),
      openInterest: entry.openInterest ? Number(entry.openInterest) : null,
      longRatio: entry.longRate ? Number(entry.longRate) : null,
    };

    cache.set(cacheKey, result, TTL.coinglass);
    return result;
  } catch {
    // Fallback: try the alternative public endpoint
    return fetchFundingFallback(symbol);
  }
}

/**
 * Fallback: try Coinglass open interest endpoint.
 */
async function fetchFundingFallback(symbol) {
  try {
    const url = `${COINGLASS_API}/public/v2/open_interest?symbol=${symbol}`;
    const data = await fetchJSON(url, {}, 10_000);

    if (!data?.data?.[0]) return null;

    const entry = data.data[0];
    const result = {
      symbol,
      rate: 0, // Not available from OI endpoint
      openInterest: entry.openInterest ? Number(entry.openInterest) : null,
      longRatio: null,
    };

    cache.set(`coinglass:funding:${symbol}`, result, TTL.coinglass);
    return result;
  } catch {
    return null;
  }
}

/**
 * Fetch funding rates for multiple coins.
 * @param {string[]} coinIds - CoinGecko coin IDs
 */
export async function fundingRates(coinIds) {
  const results = {};
  // The /funding endpoint returns all coins at once, so fetch once
  const cacheKey = "coinglass:funding:all";
  let allData = cache.get(cacheKey);

  if (!allData) {
    try {
      const data = await fetchJSON(`${COINGLASS_API}/public/v2/funding`, {}, 10_000);
      if (data?.data) {
        allData = data.data;
        cache.set(cacheKey, allData, TTL.coinglass);
      }
    } catch {
      allData = null;
    }
  }

  if (!allData) return results;

  for (const coinId of coinIds) {
    const symbol = SYMBOL_MAP[coinId];
    if (!symbol) continue;

    const entry = allData.find((d) =>
      d.symbol?.toUpperCase() === symbol || d.slug?.toUpperCase() === symbol,
    );
    if (!entry) continue;

    results[coinId] = {
      symbol,
      rate: Number(entry.uMarginFundingRate || entry.fundingRate || 0),
      openInterest: entry.openInterest ? Number(entry.openInterest) : null,
      longRatio: entry.longRate ? Number(entry.longRate) : null,
    };
  }

  return results;
}

/**
 * Interpret funding rate for scoring.
 * Returns a sentiment modifier based on funding positioning.
 *
 * @param {number} rate - funding rate (e.g., 0.01 = 1%)
 * @returns {{ signal: string, modifier: number, detail: string }}
 */
export function interpretFunding(rate) {
  if (rate > 0.05) {
    return { signal: "extreme_long", modifier: -0.08, detail: `Extreme positive funding (${(rate * 100).toFixed(3)}%) — longs massively crowded, squeeze risk` };
  }
  if (rate > 0.02) {
    return { signal: "crowded_long", modifier: -0.04, detail: `High positive funding (${(rate * 100).toFixed(3)}%) — overleveraged bullish` };
  }
  if (rate > 0.01) {
    return { signal: "mild_long", modifier: -0.02, detail: `Mildly positive funding (${(rate * 100).toFixed(3)}%) — slight long bias` };
  }
  if (rate < -0.05) {
    return { signal: "extreme_short", modifier: 0.08, detail: `Extreme negative funding (${(rate * 100).toFixed(3)}%) — shorts crowded, squeeze risk` };
  }
  if (rate < -0.02) {
    return { signal: "crowded_short", modifier: 0.04, detail: `High negative funding (${(rate * 100).toFixed(3)}%) — overleveraged bearish` };
  }
  if (rate < -0.01) {
    return { signal: "mild_short", modifier: 0.02, detail: `Mildly negative funding (${(rate * 100).toFixed(3)}%) — slight short bias` };
  }
  return { signal: "neutral", modifier: 0, detail: `Neutral funding (${(rate * 100).toFixed(3)}%)` };
}

/**
 * Source status check.
 */
export async function status() {
  try {
    const res = await fetch(`${COINGLASS_API}/public/v2/funding`, {
      signal: AbortSignal.timeout(10_000),
    });
    return { name: "coinglass", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "coinglass", ok: false, error: e.message };
  }
}
