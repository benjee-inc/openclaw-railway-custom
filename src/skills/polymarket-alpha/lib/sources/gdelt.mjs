// polymarket-alpha — GDELT news volume + tone analysis
// Free, no API key required. Rate limit: 1 request per 5 seconds.

import { GDELT_API, TTL } from "../constants.mjs";
import * as cache from "../cache.mjs";

// GDELT enforces 1 req / 5 seconds. Serialize requests with a queue.
let lastRequest = 0;
const GDELT_MIN_GAP_MS = 5500;

async function gdeltFetch(url, timeoutMs = 10_000) {
  const now = Date.now();
  const wait = Math.max(0, GDELT_MIN_GAP_MS - (now - lastRequest));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();

  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "polymarket-alpha/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
  return res.json();
}

/**
 * Search GDELT for articles matching a query.
 * Uses ToneChart mode (lighter than ArtList) to get volume + tone.
 */
export async function search(query, timespan = "24h") {
  const cacheKey = `gdelt:${query}:${timespan}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    query,
    mode: "ToneChart",
    timespan,
    format: "json",
  });

  try {
    const data = await gdeltFetch(`${GDELT_API}?${params}`);
    // ToneChart returns tone_timeline with bins: [{series: [{bin, count, tonavg}]}]
    const series = data?.tone_timeline?.[0]?.series || [];
    let totalCount = 0;
    let totalTone = 0;
    let toneWeighted = 0;

    for (const bin of series) {
      const count = Number(bin.count || 0);
      const tone = Number(bin.tonavg || 0);
      totalCount += count;
      toneWeighted += tone * count;
    }

    const avgTone = totalCount > 0 ? toneWeighted / totalCount : 0;
    const result = { count: totalCount, tone: avgTone, articles: [] };
    cache.set(cacheKey, result, TTL.gdelt);
    return result;
  } catch {
    // Fallback: try ArtList mode
    try {
      const params2 = new URLSearchParams({
        query,
        mode: "ArtList",
        maxrecords: "25",
        timespan,
        format: "json",
        sort: "DateDesc",
      });
      const data = await gdeltFetch(`${GDELT_API}?${params2}`);
      const articles = data.articles || [];
      let totalTone = 0;
      let toneCount = 0;
      for (const art of articles) {
        if (art.tone != null) { totalTone += Number(art.tone); toneCount++; }
      }
      const result = {
        count: articles.length,
        tone: toneCount > 0 ? totalTone / toneCount : 0,
        articles: articles.slice(0, 5).map((a) => ({
          title: a.title, domain: a.domain, tone: a.tone != null ? Number(a.tone) : null,
        })),
      };
      cache.set(cacheKey, result, TTL.gdelt);
      return result;
    } catch {
      return { count: 0, tone: 0, articles: [] };
    }
  }
}

/**
 * Get news volume trend — compare last 24h vs previous 7 days baseline.
 */
export async function volumeTrend(query) {
  // Single request with 7-day window to get trend via ToneChart bins
  const cacheKey = `gdelt:trend:${query}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    query,
    mode: "ToneChart",
    timespan: "7d",
    format: "json",
  });

  try {
    const data = await gdeltFetch(`${GDELT_API}?${params}`);
    const series = data?.tone_timeline?.[0]?.series || [];

    if (series.length === 0) {
      const result = { recent: 0, older: 0, ratio: 0, toneDelta: 0, currentTone: 0 };
      cache.set(cacheKey, result, TTL.gdelt);
      return result;
    }

    // Last ~24h bins vs rest
    const totalBins = series.length;
    const recentBins = Math.max(1, Math.ceil(totalBins / 7));
    const recentSlice = series.slice(-recentBins);
    const olderSlice = series.slice(0, -recentBins);

    let recentCount = 0, recentTone = 0, recentW = 0;
    for (const b of recentSlice) {
      const c = Number(b.count || 0); recentCount += c;
      recentTone += Number(b.tonavg || 0) * c; recentW += c;
    }
    let olderCount = 0, olderTone = 0, olderW = 0;
    for (const b of olderSlice) {
      const c = Number(b.count || 0); olderCount += c;
      olderTone += Number(b.tonavg || 0) * c; olderW += c;
    }

    // Normalize older to same time window
    const olderNorm = olderSlice.length > 0
      ? (olderCount / olderSlice.length) * recentBins
      : 0;

    const ratio = olderNorm > 0 ? recentCount / olderNorm : recentCount > 0 ? 5.0 : 0;
    const rTone = recentW > 0 ? recentTone / recentW : 0;
    const oTone = olderW > 0 ? olderTone / olderW : 0;

    const result = {
      recent: recentCount,
      older: Math.round(olderNorm),
      ratio: Math.round(ratio * 100) / 100,
      toneDelta: Math.round((rTone - oTone) * 100) / 100,
      currentTone: Math.round(rTone * 100) / 100,
    };
    cache.set(cacheKey, result, TTL.gdelt);
    return result;
  } catch {
    return { recent: 0, older: 0, ratio: 0, toneDelta: 0, currentTone: 0 };
  }
}

/**
 * Source status check.
 */
export async function status() {
  try {
    const params = new URLSearchParams({
      query: "test",
      mode: "ToneChart",
      timespan: "1h",
      format: "json",
    });
    const res = await fetch(`${GDELT_API}?${params}`, {
      headers: { "User-Agent": "polymarket-alpha/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    return { name: "gdelt", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "gdelt", ok: false, error: e.message };
  }
}
