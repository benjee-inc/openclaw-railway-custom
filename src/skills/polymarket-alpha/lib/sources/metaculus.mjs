// polymarket-alpha — Metaculus calibrated community forecasts
// Free, no API key required

import { METACULUS_API, TTL } from "../constants.mjs";
import { fetchJSON } from "../helpers.mjs";
import * as cache from "../cache.mjs";

/**
 * Search Metaculus for questions matching a Polymarket market.
 * Returns the best-matching open question with community prediction.
 *
 * @param {string} query - search query derived from market question
 * @returns {Promise<{question: string, url: string, communityPrediction: number|null, numForecasters: number, id: number}|null>}
 */
export async function searchQuestion(query) {
  const cacheKey = `metaculus:search:${query.slice(0, 80)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const encodedQuery = encodeURIComponent(query.slice(0, 100));
    const url = `${METACULUS_API}/questions/?search=${encodedQuery}&status=open&type=binary&limit=5&order_by=-activity`;
    const data = await fetchJSON(url, {}, 15_000);

    const results = data?.results || data || [];
    if (!Array.isArray(results) || results.length === 0) return null;

    // Find best match — prefer questions with more forecasters
    const best = results
      .filter((q) => q.question?.type === "binary" || q.type === "binary" || q.possibilities?.type === "binary")
      .sort((a, b) => (b.number_of_forecasters || b.forecasts_count || 0) - (a.number_of_forecasters || a.forecasts_count || 0))
      [0];

    if (!best) {
      // Try first result regardless of type
      const first = results[0];
      if (!first) return null;
      const result = extractPrediction(first);
      if (result) cache.set(cacheKey, result, TTL.metaculus);
      return result;
    }

    const result = extractPrediction(best);
    if (result) cache.set(cacheKey, result, TTL.metaculus);
    return result;
  } catch {
    return null;
  }
}

/**
 * Extract prediction data from a Metaculus question object.
 */
function extractPrediction(q) {
  // Metaculus API v2 has different field names depending on version
  const communityPrediction =
    q.community_prediction?.full?.q2 ??
    q.community_prediction?.full?.median ??
    q.community_prediction?.q2 ??
    q.community_prediction ??
    q.aggregations?.recency_weighted?.latest?.centers?.[0] ??
    null;

  const numForecasters =
    q.number_of_forecasters ??
    q.forecasts_count ??
    q.nr_forecasters ??
    0;

  if (communityPrediction === null) return null;

  return {
    question: q.title || q.title_short || q.question_text || "",
    url: q.url || `https://www.metaculus.com/questions/${q.id}/`,
    communityPrediction: typeof communityPrediction === "number" ? communityPrediction : Number(communityPrediction),
    numForecasters,
    id: q.id,
  };
}

/**
 * Compute divergence between Polymarket price and Metaculus prediction.
 *
 * @param {number} polymarketPrice - Polymarket YES price (0-1)
 * @param {number} metaculusPrediction - Metaculus community prediction (0-1)
 * @returns {{ divergence: number, direction: string, significance: string }}
 */
export function computeDivergence(polymarketPrice, metaculusPrediction) {
  const divergence = metaculusPrediction - polymarketPrice;
  const absDivergence = Math.abs(divergence);

  let significance;
  if (absDivergence > 0.20) significance = "high";
  else if (absDivergence > 0.10) significance = "notable";
  else if (absDivergence > 0.05) significance = "mild";
  else significance = "negligible";

  const direction = divergence > 0 ? "metaculus_higher" : divergence < 0 ? "metaculus_lower" : "aligned";

  return { divergence, direction, significance };
}

/**
 * Extract a search query from a Polymarket question for Metaculus matching.
 * Strips betting-specific language to find the core prediction question.
 */
export function extractSearchQuery(question) {
  return question
    .replace(/^Will\s+/i, "")
    .replace(/\?$/, "")
    .replace(/\b(before|by|on|in)\s+\w+\s+\d{1,2}(st|nd|rd|th)?,?\s*\d{0,4}/gi, "")
    .replace(/\b(before|by)\s+\d{4}-\d{2}-\d{2}/gi, "")
    .replace(/\b(yes|no)\b/gi, "")
    .trim()
    .slice(0, 100);
}

/**
 * Source status check.
 */
export async function status() {
  try {
    const res = await fetch(`${METACULUS_API}/questions/?limit=1`, {
      signal: AbortSignal.timeout(10_000),
    });
    return { name: "metaculus", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "metaculus", ok: false, error: e.message };
  }
}
