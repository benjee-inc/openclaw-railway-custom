// polymarket-alpha — Google Trends interest data
// Uses the unofficial daily trends JSON endpoint (no auth required)
// Falls back to SerpAPI if available

import { TTL } from "../constants.mjs";
import { fetchJSON } from "../helpers.mjs";
import * as cache from "../cache.mjs";

const TRENDS_API = "https://trends.google.com/trends/api";

/**
 * Fetch relative search interest for a keyword.
 * Uses the Google Trends explore endpoint to get interest over time.
 *
 * @param {string} keyword - search term
 * @returns {Promise<{keyword: string, interestOverTime: number[], isBreakout: boolean, peakInterest: number, currentInterest: number, trend: string}|null>}
 */
export async function searchInterest(keyword) {
  const cacheKey = `trends:${keyword.toLowerCase().slice(0, 60)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Try SerpAPI first if key is available
  if (process.env.SERPAPI_KEY) {
    const serpResult = await fetchFromSerpApi(keyword);
    if (serpResult) {
      cache.set(cacheKey, serpResult, TTL.trends);
      return serpResult;
    }
  }

  // Try Google Trends direct endpoint
  const directResult = await fetchFromGoogleTrends(keyword);
  if (directResult) {
    cache.set(cacheKey, directResult, TTL.trends);
    return directResult;
  }

  return null;
}

/**
 * Fetch from SerpAPI Google Trends endpoint.
 */
async function fetchFromSerpApi(keyword) {
  try {
    const encoded = encodeURIComponent(keyword);
    const url = `https://serpapi.com/search.json?engine=google_trends&q=${encoded}&data_type=TIMESERIES&api_key=${process.env.SERPAPI_KEY}`;
    const data = await fetchJSON(url, {}, 10_000);

    if (!data?.interest_over_time?.timeline_data) return null;

    const timeline = data.interest_over_time.timeline_data;
    const values = timeline.map((t) => t.values?.[0]?.extracted_value ?? 0);
    if (values.length === 0) return null;

    return analyzeTimeline(keyword, values);
  } catch {
    return null;
  }
}

/**
 * Fetch from Google Trends direct (unofficial) endpoint.
 * This uses the daily trends API which returns trending searches.
 */
async function fetchFromGoogleTrends(keyword) {
  try {
    // Use the daily trends endpoint to check if keyword is trending
    const url = `${TRENDS_API}/dailytrends?hl=en-US&tz=-300&geo=US&ns=15`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; polymarket-alpha/1.0)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    let text = await res.text();
    // Google Trends prefixes response with ")]}'\n"
    if (text.startsWith(")]}'")) {
      text = text.slice(text.indexOf("\n") + 1);
    }

    const data = JSON.parse(text);
    const days = data?.default?.trendingSearchesDays || [];
    const kwLower = keyword.toLowerCase();

    let isBreakout = false;
    let trafficVolume = 0;

    for (const day of days) {
      for (const search of day.trendingSearches || []) {
        const title = (search.title?.query || "").toLowerCase();
        const relatedQueries = (search.relatedQueries || []).map((q) => (q.query || "").toLowerCase());
        const articles = (search.articles || []).map((a) => (a.title || "").toLowerCase());

        if (
          title.includes(kwLower) ||
          relatedQueries.some((q) => q.includes(kwLower)) ||
          articles.some((a) => a.includes(kwLower))
        ) {
          isBreakout = true;
          const vol = parseInt(search.formattedTraffic?.replace(/[+,K]/g, ""), 10) || 0;
          trafficVolume = Math.max(trafficVolume, vol);
        }
      }
    }

    if (!isBreakout) {
      // Not found in daily trends — return baseline result
      return {
        keyword,
        interestOverTime: [],
        isBreakout: false,
        peakInterest: 0,
        currentInterest: 0,
        trend: "baseline",
        source: "google_trends_daily",
      };
    }

    return {
      keyword,
      interestOverTime: [],
      isBreakout: true,
      peakInterest: 100,
      currentInterest: trafficVolume > 0 ? Math.min(100, trafficVolume) : 80,
      trend: "breakout",
      source: "google_trends_daily",
    };
  } catch {
    return null;
  }
}

/**
 * Analyze a timeline of interest values.
 */
function analyzeTimeline(keyword, values) {
  const peak = Math.max(...values);
  const current = values[values.length - 1] || 0;
  const recent = values.slice(-7);
  const older = values.slice(-14, -7);

  const recentAvg = recent.length > 0 ? recent.reduce((s, v) => s + v, 0) / recent.length : 0;
  const olderAvg = older.length > 0 ? older.reduce((s, v) => s + v, 0) / older.length : 0;

  const isBreakout = current >= 80 || (recentAvg > olderAvg * 2 && recentAvg > 30);

  let trend;
  if (isBreakout) trend = "breakout";
  else if (recentAvg > olderAvg * 1.3) trend = "rising";
  else if (recentAvg < olderAvg * 0.7) trend = "declining";
  else trend = "stable";

  return {
    keyword,
    interestOverTime: values.slice(-30), // last 30 data points
    isBreakout,
    peakInterest: peak,
    currentInterest: current,
    trend,
    source: "serpapi",
  };
}

/**
 * Extract a good search keyword from a market question.
 * Focus on the most distinctive term.
 */
export function extractKeyword(question) {
  // Remove common market phrasing
  let q = question
    .replace(/^Will\s+/i, "")
    .replace(/\?$/, "")
    .replace(/\b(before|by|on|in)\s+\w+\s+\d{1,2}(st|nd|rd|th)?,?\s*\d{0,4}/gi, "")
    .replace(/\b(before|by)\s+\d{4}-\d{2}-\d{2}/gi, "")
    .replace(/\b(yes|no|above|below|exceed|reach|hit)\b/gi, "")
    .replace(/\$[\d,]+[kmbt]?/gi, "")
    .replace(/\d+°?[FC]/gi, "")
    .trim();

  // Take the most meaningful chunk (first 3-4 words or named entity)
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return null;

  // Use first 4 words or the whole thing if short
  return words.slice(0, 4).join(" ");
}

/**
 * Source status check.
 */
export async function status() {
  try {
    const res = await fetch(
      `${TRENDS_API}/dailytrends?hl=en-US&tz=-300&geo=US&ns=15`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; polymarket-alpha/1.0)" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    return { name: "trends", ok: res.ok || res.status === 429, status: res.status };
  } catch (e) {
    return { name: "trends", ok: false, error: e.message };
  }
}
