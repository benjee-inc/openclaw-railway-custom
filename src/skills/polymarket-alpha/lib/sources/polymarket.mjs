// polymarket-alpha — Polymarket market data (Gamma + CLOB)
// Adapted from comprehensive-scanner.mjs

import { GAMMA_API, CLOB_API, TTL } from "../constants.mjs";
import { fetchJSON, tryJSON } from "../helpers.mjs";
import * as cache from "../cache.mjs";

const CACHE_KEY = "gamma_markets";

/**
 * Fetch active markets from Gamma API (paginated, up to 200).
 * Filters out sports and closed markets.
 */
export async function fetchMarkets() {
  const cached = cache.get(CACHE_KEY);
  if (cached) return cached;

  const allMarkets = [];
  for (const offset of [0, 100]) {
    const events = await fetchJSON(
      `${GAMMA_API}/events?active=true&closed=false&limit=100&offset=${offset}`,
      {},
      30_000,
    );
    if (events.length === 0) break;
    for (const event of events) {
      if (!event.markets) continue;
      for (const m of event.markets) {
        if (m.closed || !m.active) continue;
        const prices = tryJSON(m.outcomePrices) || [];
        const tokenIds = tryJSON(m.clobTokenIds) || [];
        allMarkets.push({
          question: m.question || event.title,
          conditionId: m.conditionId,
          tokenId: tokenIds[0] || null,
          prices: prices.map(Number),
          outcomes: tryJSON(m.outcomes) || [],
          volume: Number(m.volumeNum || 0),
          volume24h: Number(event.volume24hr || 0),
          liquidity: Number(event.liquidity || 0),
          endDate: m.endDate || event.endDate,
          spread: Number(m.spread || 0),
          bestBid: Number(m.bestBid || 0),
          bestAsk: Number(m.bestAsk || 0),
          lastPrice: Number(m.lastTradePrice || 0),
          change1h: m.oneHourPriceChange != null ? Number(m.oneHourPriceChange) : null,
          change1d: m.oneDayPriceChange != null ? Number(m.oneDayPriceChange) : null,
          change1w: m.oneWeekPriceChange != null ? Number(m.oneWeekPriceChange) : null,
          competitive: Number(event.competitive || 0),
        });
      }
    }
  }

  cache.set(CACHE_KEY, allMarkets, TTL.gamma);
  return allMarkets;
}

/**
 * Fetch live midpoints from CLOB (batch up to 50).
 */
export async function fetchMidpoints(tokenIds) {
  if (!tokenIds || tokenIds.length === 0) return {};
  const batch = tokenIds.slice(0, 50);
  const body = batch.map((id) => ({ token_id: id }));
  try {
    return await fetchJSON(`${CLOB_API}/midpoints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return {};
  }
}

/**
 * Fetch a single market by conditionId.
 */
export async function fetchMarket(conditionId) {
  const markets = await fetchMarkets();
  return markets.find((m) => m.conditionId === conditionId) || null;
}

/**
 * Source status check.
 */
export async function status() {
  try {
    const res = await fetch(`${GAMMA_API}/events?active=true&closed=false&limit=1`, {
      signal: AbortSignal.timeout(10_000),
    });
    return { name: "polymarket", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "polymarket", ok: false, error: e.message };
  }
}
