// polymarket-alpha — backtest engine
// Replays the scorer against resolved markets to measure predictive accuracy.
// Two modes: full replay (crypto/economics with historical alt data)
// and market efficiency baseline (all categories).

import { fetchJSON } from "./helpers.mjs";
import { categorize, isSportsMarket } from "./categorizer.mjs";
import { match } from "./matcher.mjs";
import { score, recommendation } from "./scorer.mjs";
import { extractCoins, extractPriceTarget } from "./sources/crypto.mjs";
import { extractSeries, extractThreshold } from "./sources/economics.mjs";
import { GAMMA_API, CLOB_API, COINGECKO_API, FRED_API } from "./constants.mjs";

// ── Fetch resolved markets ────────────────────────────────

/**
 * Fetch closed/resolved markets from Gamma API.
 * @param {number} limit - markets per page
 * @param {number} offset - pagination offset
 * @returns {Promise<object[]>} resolved market objects
 */
export async function fetchResolved(limit = 100, offset = 0) {
  const params = new URLSearchParams({
    closed: "true",
    order: "endDate",
    ascending: "false",
    limit: String(limit),
    offset: String(offset),
  });

  const markets = await fetchJSON(`${GAMMA_API}/markets?${params}`, {}, 30_000);
  if (!Array.isArray(markets)) return [];

  const results = [];
  for (const m of markets) {
    if (isSportsMarket(m.question || "")) continue;

    // Parse outcome from outcomePrices
    const outcomePrices = parseJSON(m.outcomePrices);
    if (!outcomePrices || outcomePrices.length < 2) continue;
    const yesPayoff = Number(outcomePrices[0]);
    if (isNaN(yesPayoff)) continue;
    // YES won if its payoff > 0.5 (typically 1 or 0)
    const outcome = yesPayoff > 0.5 ? 1 : 0;

    // Parse clobTokenIds to get token for price history
    const tokenIds = parseJSON(m.clobTokenIds);
    if (!tokenIds || tokenIds.length === 0) continue;
    const tokenId = tokenIds[0]; // YES token

    const volumeNum = Number(m.volume) || 0;
    if (volumeNum < 5000) continue;

    const { category, score: catScore } = categorize(m.question || "");
    if (category === "sports") continue;

    // Use closedTime (actual resolution) over endDate (scheduled end)
    const closedTime = m.closedTime || m.umaEndDate || m.endDate;
    if (!closedTime) continue;

    results.push({
      question: m.question,
      conditionId: m.conditionId,
      tokenId,
      outcome,
      category,
      catScore,
      endDate: m.endDate,
      closedTime,
      volumeNum,
      _category: category,
      _catScore: catScore,
    });
  }

  return results;
}

// ── Fetch CLOB price history ──────────────────────────────

/**
 * Fetch full price history for a token from CLOB.
 * @param {string} tokenId
 * @returns {Promise<{t: number, p: number}[]>} sorted by time ascending
 */
export async function fetchPriceHistory(tokenId) {
  try {
    const params = new URLSearchParams({
      market: tokenId,
      interval: "max",
      fidelity: "60",
    });
    const data = await fetchJSON(`${CLOB_API}/prices-history?${params}`, {}, 20_000);
    if (!Array.isArray(data?.history)) return [];
    return data.history
      .map((pt) => ({ t: Number(pt.t), p: Number(pt.p) }))
      .filter((pt) => !isNaN(pt.t) && !isNaN(pt.p))
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

// ── PMXT archive prices ──────────────────────────────────

const PMXT_ARCHIVE = "https://r2.pmxt.dev";
const PMXT_RETENTION_DAYS = 7;

/**
 * Generate PMXT snapshot URL for a specific UTC hour.
 * @param {Date} date
 * @returns {string}
 */
function snapshotUrlForHour(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  return `${PMXT_ARCHIVE}/polymarket_orderbook_${y}-${m}-${d}T${h}.parquet`;
}

/**
 * Fetch price histories from PMXT archive for a batch of markets.
 * Queries hourly parquet snapshots via DuckDB HTTP range reads.
 * Uses book_snapshot records to extract best_bid/best_ask midpoints.
 *
 * Falls back gracefully if DuckDB is not installed or snapshots are unavailable.
 * Only covers the last ~7 days (PMXT retention window).
 *
 * @param {{conditionId: string, tokenId: string}[]} markets — markets with YES token IDs
 * @param {number} startTs — range start (unix seconds)
 * @param {number} endTs — range end (unix seconds)
 * @returns {Promise<Map<string, {t: number, p: number}[]>>} conditionId → price history
 */
export async function fetchPmxtPrices(markets, startTs, endTs) {
  const results = new Map();
  if (!markets.length) return results;

  let execSync;
  try {
    ({ execSync } = await import("node:child_process"));
    execSync("duckdb --version", { timeout: 5_000, encoding: "utf-8" });
  } catch {
    return results;
  }

  // YES token lookup: conditionId → tokenId
  const yesTokenMap = new Map();
  for (const m of markets) yesTokenMap.set(m.conditionId, m.tokenId);

  const conditionIds = [...new Set(markets.map((m) => m.conditionId))];

  // Clamp to PMXT retention window
  const retentionStart = Math.floor(Date.now() / 1000) - PMXT_RETENTION_DAYS * 86400;
  const effectiveStart = Math.max(startTs, retentionStart);
  if (effectiveStart >= endTs) return results;

  // Generate hourly snapshot URLs
  const start = new Date(effectiveStart * 1000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(endTs * 1000);

  const urls = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    urls.push(snapshotUrlForHour(cursor));
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  // Build SQL IN clause (conditionIds are 0x hex — safe for SQL literals)
  const idList = conditionIds.map((id) => `'${id}'`).join(",");

  for (const url of urls) {
    try {
      const query = `SELECT market_id, data, timestamp_received as ts FROM parquet_scan('${url}') WHERE market_id IN (${idList}) AND update_type = 'book_snapshot'`;

      const raw = execSync(`duckdb -json -c "${query.replace(/\n/g, " ")}"`, {
        timeout: 60_000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });

      for (const row of JSON.parse(raw || "[]")) {
        const cid = row.market_id;
        const yesToken = yesTokenMap.get(cid);
        if (!yesToken) continue;

        try {
          const d = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
          // Only use YES-side snapshots for direct price reading
          if (d.token_id !== yesToken) continue;

          const bestBid = Number(d.best_bid);
          const bestAsk = Number(d.best_ask);
          if (isNaN(bestBid) || isNaN(bestAsk) || bestBid <= 0 || bestAsk <= 0) continue;

          const ts = Math.floor(new Date(row.ts).getTime() / 1000);
          if (isNaN(ts)) continue;

          if (!results.has(cid)) results.set(cid, []);
          results.get(cid).push({ t: ts, p: (bestBid + bestAsk) / 2 });
        } catch { /* skip malformed data */ }
      }
    } catch {
      // Snapshot 404 or DuckDB error — skip this hour
      continue;
    }
  }

  // Sort each market's history ascending by time
  for (const [, history] of results) {
    history.sort((a, b) => a.t - b.t);
  }

  return results;
}

/**
 * Merge two price histories, preferring primary (PMXT) where timestamps overlap.
 * @param {{t: number, p: number}[]} primary — e.g. PMXT midpoint prices
 * @param {{t: number, p: number}[]} secondary — e.g. CLOB prices-history
 * @returns {{t: number, p: number}[]} merged, sorted ascending
 */
export function mergePriceHistories(primary, secondary) {
  if (!primary?.length) return secondary || [];
  if (!secondary?.length) return primary;

  const seen = new Set(primary.map((pt) => pt.t));
  const merged = [...primary];
  for (const pt of secondary) {
    if (!seen.has(pt.t)) merged.push(pt);
  }
  return merged.sort((a, b) => a.t - b.t);
}

/**
 * Find the price closest to a target timestamp via binary search.
 * @param {{t: number, p: number}[]} history - sorted ascending by t
 * @param {number} targetTs - unix seconds
 * @returns {number|null} price at that time
 */
export function priceAtTime(history, targetTs) {
  if (history.length === 0) return null;

  let lo = 0;
  let hi = history.length - 1;

  // Target before all data
  if (targetTs <= history[0].t) return history[0].p;
  // Target after all data
  if (targetTs >= history[hi].t) return history[hi].p;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (history[mid].t === targetTs) return history[mid].p;
    if (history[mid].t < targetTs) lo = mid + 1;
    else hi = mid - 1;
  }

  // lo is the first entry > targetTs, hi is the last entry < targetTs
  const before = history[hi];
  const after = history[lo];
  // Return whichever is closer
  return (targetTs - before.t) <= (after.t - targetTs) ? before.p : after.p;
}

// ── Historical alt data fetchers ──────────────────────────

/**
 * Fetch historical CoinGecko price data for a coin at a specific time.
 * Uses /coins/{id}/market_chart/range for historical price.
 * @param {string} coinId - CoinGecko coin ID
 * @param {number} timestampSec - target unix timestamp (seconds)
 * @returns {Promise<{usd: number, usd_24h_change: number}|null>}
 */
export async function fetchHistoricalCrypto(coinId, timestampSec) {
  try {
    // Fetch 2-day window around target
    const from = timestampSec - 86400;
    const to = timestampSec + 86400;
    const params = new URLSearchParams({
      vs_currency: "usd",
      from: String(from),
      to: String(to),
    });
    const data = await fetchJSON(
      `${COINGECKO_API}/coins/${coinId}/market_chart/range?${params}`,
      {},
      15_000,
    );
    if (!data?.prices?.length) return null;

    // Find closest price point to target timestamp
    const targetMs = timestampSec * 1000;
    let closest = data.prices[0];
    let minDist = Math.abs(closest[0] - targetMs);
    for (const pt of data.prices) {
      const dist = Math.abs(pt[0] - targetMs);
      if (dist < minDist) {
        minDist = dist;
        closest = pt;
      }
    }

    // Try to find a price ~24h before to compute change
    const prev24hMs = targetMs - 86400_000;
    let prev = data.prices[0];
    let prevDist = Math.abs(prev[0] - prev24hMs);
    for (const pt of data.prices) {
      const dist = Math.abs(pt[0] - prev24hMs);
      if (dist < prevDist) {
        prevDist = dist;
        prev = pt;
      }
    }

    const price = closest[1];
    const prevPrice = prev[1];
    const change24h = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;

    return { usd: price, usd_24h_change: change24h };
  } catch {
    return null;
  }
}

/**
 * Fetch historical Fear & Greed Index value for a date.
 * @param {number} timestampSec - target unix timestamp (seconds)
 * @returns {Promise<{value: number, classification: string}|null>}
 */
export async function fetchHistoricalFearGreed(timestampSec) {
  try {
    const data = await fetchJSON(
      "https://api.alternative.me/fng/?limit=365&format=json",
      {},
      10_000,
    );
    if (!data?.data?.length) return null;

    const targetSec = timestampSec;
    let closest = data.data[0];
    let minDist = Math.abs(Number(closest.timestamp) - targetSec);
    for (const entry of data.data) {
      const dist = Math.abs(Number(entry.timestamp) - targetSec);
      if (dist < minDist) {
        minDist = dist;
        closest = entry;
      }
    }

    return {
      value: Number(closest.value),
      classification: closest.value_classification,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch historical FRED observation near a date.
 * @param {string} seriesId - FRED series ID
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @returns {Promise<{value: number, date: string, series: string}|null>}
 */
export async function fetchHistoricalFred(seriesId, dateStr) {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;

  try {
    // Fetch observations in a 60-day window ending at target date
    const endDate = dateStr;
    const start = new Date(dateStr);
    start.setDate(start.getDate() - 60);
    const startDate = start.toISOString().slice(0, 10);

    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: key,
      file_type: "json",
      observation_start: startDate,
      observation_end: endDate,
      sort_order: "desc",
      limit: "1",
    });

    const data = await fetchJSON(`${FRED_API}/series/observations?${params}`, {}, 15_000);
    const obs = data.observations?.[0];
    if (!obs || obs.value === ".") return null;

    return {
      value: Number(obs.value),
      date: obs.date,
      series: seriesId,
    };
  } catch {
    return null;
  }
}

// ── Signal replay ─────────────────────────────────────────

/**
 * Replay the scorer for a market at a specific lookback point.
 * @param {object} market - resolved market with _category, question, endDate, outcome
 * @param {number} lookbackDays - how many days before close to evaluate
 * @param {{t: number, p: number}[]} priceHistory - full price history
 * @returns {Promise<object|null>} replay result
 */
export async function replaySignal(market, lookbackDays, priceHistory) {
  // Find the market price at T = closedTime - lookbackDays
  const closeTs = Math.floor(new Date(market.closedTime).getTime() / 1000);
  if (isNaN(closeTs)) return null;
  const evalTs = closeTs - lookbackDays * 86400;

  const marketPrice = priceAtTime(priceHistory, evalTs);
  if (marketPrice === null) return null;

  // Build a synthetic market object at the evaluation time
  const syntheticMarket = {
    ...market,
    prices: [marketPrice, 1 - marketPrice],
    endDate: market.endDate,
  };

  // Fetch historical alt data based on category
  const altData = await fetchHistoricalAltData(market, evalTs);

  // Extract params using existing matcher
  const matchResult = match(syntheticMarket);

  // Run the scorer
  const scoreResult = score(syntheticMarket, altData, matchResult.params);
  if (!scoreResult) return null;

  const rec = recommendation(scoreResult.alpha, scoreResult.confidence);

  return {
    conditionId: market.conditionId,
    question: market.question,
    category: market.category,
    lookbackDays,
    evalTimestamp: new Date(evalTs * 1000).toISOString(),
    closedTime: market.closedTime,
    closeTimestamp: new Date(closeTs * 1000).toISOString(),
    marketPrice,
    actualOutcome: market.outcome,
    scorerImplied: scoreResult.altDataImplied,
    direction: scoreResult.direction,
    alpha: scoreResult.alpha,
    confidence: scoreResult.confidence,
    recommendation: rec,
    sources: scoreResult.sources,
    detail: scoreResult.detail,
    hasAltData: scoreResult.sources.length > 0 && scoreResult.altDataImplied !== null,
  };
}

/**
 * Fetch historical alt data for a market at a specific timestamp.
 * Only fetches sources that have historical data available.
 */
async function fetchHistoricalAltData(market, evalTs) {
  const data = {};
  const cat = market._category || market.category;
  const q = market.question || "";

  if (cat === "crypto") {
    const coins = extractCoins(q);
    const priceTarget = extractPriceTarget(q);

    if (coins.length > 0) {
      const coinId = coins[0];
      const [coinData, fngData] = await Promise.all([
        fetchHistoricalCrypto(coinId, evalTs),
        fetchHistoricalFearGreed(evalTs),
      ]);
      if (coinData) {
        data.coingecko = { [coinId]: coinData };
      }
      if (fngData) {
        data.fearGreed = fngData;
      }
    }
  } else if (cat === "economics") {
    const series = extractSeries(q);
    const dateStr = new Date(evalTs * 1000).toISOString().slice(0, 10);

    if (series.length > 0) {
      const results = await Promise.all(
        series.map((s) => fetchHistoricalFred(s, dateStr)),
      );
      const valid = results.filter(Boolean);
      if (valid.length > 0) data.fred = valid;
    }
  }

  // Other categories (weather, geopolitics, etc.) don't have historical data.
  // They'll score with empty altData, giving us the GDELT-only fallback or NEUTRAL.
  return data;
}

// ── Analysis & metrics ────────────────────────────────────

/**
 * Compute Brier score: mean squared error between predicted probability and outcome.
 * Lower is better. Perfect = 0, worst = 1.
 * @param {{predicted: number, actual: number}[]} items
 * @returns {number}
 */
function brierScore(items) {
  if (items.length === 0) return null;
  const sum = items.reduce((s, i) => s + (i.predicted - i.actual) ** 2, 0);
  return sum / items.length;
}

/**
 * Compute calibration bins: group predictions into deciles and compare
 * predicted probability vs actual frequency.
 * @param {{predicted: number, actual: number}[]} items
 * @returns {object[]} calibration bins
 */
function calibrationBins(items) {
  const bins = [];
  for (let i = 0; i < 10; i++) {
    const lo = i * 0.1;
    const hi = lo + 0.1;
    const label = `${Math.round(lo * 100)}-${Math.round(hi * 100)}%`;
    const inBin = items.filter((it) => it.predicted >= lo && it.predicted < (i === 9 ? 1.01 : hi));
    if (inBin.length === 0) {
      bins.push({ bin: label, predicted: null, actual: null, n: 0 });
      continue;
    }
    const avgPred = inBin.reduce((s, i) => s + i.predicted, 0) / inBin.length;
    const avgActual = inBin.reduce((s, i) => s + i.actual, 0) / inBin.length;
    bins.push({
      bin: label,
      predicted: round(avgPred, 3),
      actual: round(avgActual, 3),
      n: inBin.length,
    });
  }
  return bins;
}

/**
 * Simulate PnL: buy YES when scorer says UNDERPRICED_YES, buy NO when OVERPRICED_YES.
 * Cost = market price. Payout = 1 if correct, 0 if wrong.
 * @param {object[]} results - replay results
 * @returns {{ totalPnl: number, avgPnl: number, trades: number, wins: number, winRate: number }}
 */
function simulatePnl(results) {
  let totalPnl = 0;
  let trades = 0;
  let wins = 0;

  for (const r of results) {
    if (!r.hasAltData || r.recommendation === "NOISE") continue;

    if (r.direction === "UNDERPRICED_YES") {
      // Buy YES at marketPrice, payout 1 if outcome=1, else 0
      const pnl = r.actualOutcome === 1 ? (1 - r.marketPrice) : -r.marketPrice;
      totalPnl += pnl;
      trades++;
      if (pnl > 0) wins++;
    } else if (r.direction === "OVERPRICED_YES") {
      // Buy NO at (1-marketPrice), payout 1 if outcome=0, else 0
      const noPrice = 1 - r.marketPrice;
      const pnl = r.actualOutcome === 0 ? (1 - noPrice) : -noPrice;
      totalPnl += pnl;
      trades++;
      if (pnl > 0) wins++;
    }
  }

  return {
    totalPnl: round(totalPnl, 3),
    avgPnl: trades > 0 ? round(totalPnl / trades, 3) : 0,
    trades,
    wins,
    winRate: trades > 0 ? round(wins / trades, 3) : 0,
  };
}

/**
 * Full analysis of backtest results.
 * @param {object[]} results - all replay results
 * @returns {object} comprehensive analysis report
 */
export function analyze(results) {
  const valid = results.filter((r) => r !== null);
  if (valid.length === 0) {
    return { meta: { marketsAnalyzed: 0 }, error: "No valid results to analyze" };
  }

  // Date range
  const dates = valid.map((r) => r.closeTimestamp).sort();
  const dateRange = `${dates[0]?.slice(0, 10) || "?"} to ${dates[dates.length - 1]?.slice(0, 10) || "?"}`;

  // Unique lookbacks
  const lookbacks = [...new Set(valid.map((r) => r.lookbackDays))].sort((a, b) => b - a);

  // ── Market baseline (Brier) ──
  // Market price itself as a predictor
  const marketItems = valid.map((r) => ({
    predicted: r.marketPrice,
    actual: r.actualOutcome,
  }));
  const brierMarket = brierScore(marketItems);

  // ── Scorer (Brier) — only for markets with alt data ──
  const withAltData = valid.filter((r) => r.hasAltData && r.scorerImplied !== null);
  const scorerItems = withAltData.map((r) => ({
    predicted: Math.max(0, Math.min(1, r.scorerImplied)),
    actual: r.actualOutcome,
  }));
  const brierScorer = brierScore(scorerItems);

  // Improvement
  let improvement = null;
  if (brierMarket != null && brierScorer != null && brierMarket > 0) {
    improvement = round(((brierMarket - brierScorer) / brierMarket) * 100, 1);
  }

  // ── Calibration ──
  const calibrationMarket = calibrationBins(marketItems);
  const calibrationScorer = withAltData.length > 0 ? calibrationBins(scorerItems) : null;

  // ── By recommendation tier ──
  const byRec = {};
  for (const tier of ["ACTIONABLE", "NOTABLE", "MONITOR", "NOISE"]) {
    const tierResults = valid.filter((r) => r.recommendation === tier);
    if (tierResults.length === 0) {
      byRec[tier] = { n: 0, winRate: 0, avgPnl: 0 };
      continue;
    }
    const pnl = simulatePnl(tierResults);
    byRec[tier] = {
      n: tierResults.length,
      winRate: pnl.winRate,
      avgPnl: pnl.avgPnl,
      totalPnl: pnl.totalPnl,
    };
  }

  // ── By category ──
  const categories = [...new Set(valid.map((r) => r.category))];
  const byCategory = {};
  for (const cat of categories) {
    const catResults = valid.filter((r) => r.category === cat);
    const catMarketItems = catResults.map((r) => ({ predicted: r.marketPrice, actual: r.actualOutcome }));
    const catBrierMarket = brierScore(catMarketItems);

    const catWithAlt = catResults.filter((r) => r.hasAltData && r.scorerImplied !== null);
    const catScorerItems = catWithAlt.map((r) => ({
      predicted: Math.max(0, Math.min(1, r.scorerImplied)),
      actual: r.actualOutcome,
    }));
    const catBrierScorer = catWithAlt.length > 0 ? brierScore(catScorerItems) : null;

    const catPnl = simulatePnl(catResults);

    byCategory[cat] = {
      n: catResults.length,
      withAltData: catWithAlt.length,
      brierMarket: catBrierMarket != null ? round(catBrierMarket, 4) : null,
      brierScorer: catBrierScorer != null ? round(catBrierScorer, 4) : null,
      winRate: catPnl.winRate,
      avgPnl: catPnl.avgPnl,
    };
  }

  // ── By lookback ──
  const byLookback = {};
  for (const lb of lookbacks) {
    const lbResults = valid.filter((r) => r.lookbackDays === lb);
    const lbWithAlt = lbResults.filter((r) => r.hasAltData && r.scorerImplied !== null);
    const lbScorerItems = lbWithAlt.map((r) => ({
      predicted: Math.max(0, Math.min(1, r.scorerImplied)),
      actual: r.actualOutcome,
    }));

    const lbPnl = simulatePnl(lbResults);
    byLookback[`${lb}d`] = {
      n: lbResults.length,
      withAltData: lbWithAlt.length,
      brierScorer: lbWithAlt.length > 0 ? round(brierScore(lbScorerItems), 4) : null,
      winRate: lbPnl.winRate,
      avgPnl: lbPnl.avgPnl,
    };
  }

  // ── Top/worst signals ──
  const scoredResults = withAltData
    .filter((r) => r.alpha > 0)
    .map((r) => ({
      question: r.question?.slice(0, 80),
      category: r.category,
      lookback: `${r.lookbackDays}d`,
      marketPrice: round(r.marketPrice, 3),
      scorerImplied: round(r.scorerImplied, 3),
      alpha: round(r.alpha, 3),
      recommendation: r.recommendation,
      outcome: r.actualOutcome,
      correct: (r.direction === "UNDERPRICED_YES" && r.actualOutcome === 1)
            || (r.direction === "OVERPRICED_YES" && r.actualOutcome === 0),
      pnl: computeSinglePnl(r),
    }));

  scoredResults.sort((a, b) => b.pnl - a.pnl);
  const topSignals = scoredResults.slice(0, 10);
  const worstSignals = scoredResults.slice(-10).reverse();

  // Overall PnL
  const overallPnl = simulatePnl(valid);

  return {
    meta: {
      marketsAnalyzed: valid.length,
      uniqueMarkets: new Set(valid.map((r) => r.conditionId)).size,
      withAltData: withAltData.length,
      dateRange,
      lookbacks,
    },
    baseline: {
      brierMarket: brierMarket != null ? round(brierMarket, 4) : null,
    },
    scorer: {
      brierScorer: brierScorer != null ? round(brierScorer, 4) : null,
      improvement: improvement != null ? `${improvement}%` : null,
      n: withAltData.length,
    },
    pnl: overallPnl,
    byCategory,
    byLookback,
    calibrationMarket,
    calibrationScorer,
    byRecommendation: byRec,
    topSignals,
    worstSignals,
  };
}

// ── Helpers ───────────────────────────────────────────────

function round(n, decimals) {
  if (n == null || isNaN(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function parseJSON(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return null;
  try { return JSON.parse(v); } catch { return null; }
}

function computeSinglePnl(r) {
  if (r.direction === "UNDERPRICED_YES") {
    return round(r.actualOutcome === 1 ? (1 - r.marketPrice) : -r.marketPrice, 3);
  }
  if (r.direction === "OVERPRICED_YES") {
    const noPrice = 1 - r.marketPrice;
    return round(r.actualOutcome === 0 ? (1 - noPrice) : -noPrice, 3);
  }
  return 0;
}

/**
 * Sleep for rate limiting.
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
