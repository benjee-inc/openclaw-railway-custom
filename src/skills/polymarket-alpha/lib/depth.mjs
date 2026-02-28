// polymarket-alpha — orderbook depth analysis
// Fetches live orderbook data from CLOB and scores liquidity + executability
// References PMXT archive (archive.pmxt.dev) for historical depth snapshots

import { CLOB_API, TTL } from "./constants.mjs";
import * as cache from "./cache.mjs";

const PMXT_ARCHIVE = "https://r2.pmxt.dev";

/**
 * Fetch live orderbook for a market's YES token from CLOB.
 * @param {string} tokenId — CLOB token ID (numeric string)
 * @returns {Promise<{bids: [string,string][], asks: [string,string][], timestamp: number}>}
 */
export async function fetchOrderBook(tokenId) {
  if (!tokenId) return null;
  const cacheKey = `ob_${tokenId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const book = await res.json();
    const result = {
      bids: (book.bids || []).map((b) => [b.price, b.size]),
      asks: (book.asks || []).map((a) => [a.price, a.size]),
      timestamp: Date.now() / 1000,
    };
    cache.set(cacheKey, result, 30_000); // 30s cache
    return result;
  } catch {
    return null;
  }
}

/**
 * Analyze orderbook depth at and around a given price level.
 * Returns liquidity metrics relevant for trade execution.
 *
 * @param {{bids: [string,string][], asks: [string,string][]}} book
 * @param {number} targetPrice — the price level of interest (0–1)
 * @param {string} direction — "UNDERPRICED_YES" or "OVERPRICED_YES"
 * @returns {object} depth analysis
 */
export function analyzeDepth(book, targetPrice, direction) {
  if (!book || (!book.bids?.length && !book.asks?.length)) {
    return { executable: false, reason: "no_orderbook", score: 0 };
  }

  const bids = book.bids.map(([p, s]) => ({ price: Number(p), size: Number(s) }));
  const asks = book.asks.map(([p, s]) => ({ price: Number(p), size: Number(s) }));

  // Sort: bids descending, asks ascending
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price || 0;
  const bestAsk = asks[0]?.price || 1;
  const spread = bestAsk - bestBid;
  const midpoint = (bestBid + bestAsk) / 2;

  // Calculate total liquidity on each side
  const totalBidLiq = bids.reduce((s, b) => s + b.price * b.size, 0);
  const totalAskLiq = asks.reduce((s, a) => s + a.price * a.size, 0);

  // Depth within 5% of midpoint (usable liquidity)
  const nearBids = bids.filter((b) => b.price >= midpoint - 0.05);
  const nearAsks = asks.filter((a) => a.price <= midpoint + 0.05);
  const nearBidLiq = nearBids.reduce((s, b) => s + b.price * b.size, 0);
  const nearAskLiq = nearAsks.reduce((s, a) => s + a.price * a.size, 0);

  // Slippage estimate: cost to fill $100 / $500 / $1000
  const slippage100 = estimateSlippage(direction === "UNDERPRICED_YES" ? asks : bids, 100, direction);
  const slippage500 = estimateSlippage(direction === "UNDERPRICED_YES" ? asks : bids, 500, direction);
  const slippage1000 = estimateSlippage(direction === "UNDERPRICED_YES" ? asks : bids, 1000, direction);

  // Bid/ask imbalance — ratio of volume on each side
  const imbalance = totalBidLiq > 0 && totalAskLiq > 0
    ? (totalBidLiq - totalAskLiq) / (totalBidLiq + totalAskLiq)
    : 0;

  // Depth score (0–1): composite of spread, liquidity, and slippage
  const spreadScore = Math.max(0, 1 - spread / 0.10); // 10% spread = 0
  const liqScore = Math.min(1, (nearBidLiq + nearAskLiq) / 2000); // $2000 near liq = 1.0
  const slipScore = slippage100 != null ? Math.max(0, 1 - slippage100 / 0.05) : 0;
  const depthScore = spreadScore * 0.3 + liqScore * 0.4 + slipScore * 0.3;

  const executable = depthScore > 0.3 && spread < 0.15;

  return {
    executable,
    depthScore: Math.round(depthScore * 100) / 100,
    bestBid,
    bestAsk,
    spread: Math.round(spread * 10000) / 10000,
    midpoint: Math.round(midpoint * 10000) / 10000,
    totalBidLiquidity: Math.round(totalBidLiq),
    totalAskLiquidity: Math.round(totalAskLiq),
    nearBidLiquidity: Math.round(nearBidLiq),
    nearAskLiquidity: Math.round(nearAskLiq),
    bidLevels: bids.length,
    askLevels: asks.length,
    imbalance: Math.round(imbalance * 1000) / 1000,
    slippage: {
      "$100": slippage100 != null ? Math.round(slippage100 * 10000) / 10000 : null,
      "$500": slippage500 != null ? Math.round(slippage500 * 10000) / 10000 : null,
      "$1000": slippage1000 != null ? Math.round(slippage1000 * 10000) / 10000 : null,
    },
    reason: !executable
      ? spread >= 0.15 ? "wide_spread" : "thin_liquidity"
      : "tradeable",
  };
}

/**
 * Estimate price slippage for a given fill amount.
 * Returns the average execution price deviation from best price, or null if unfillable.
 */
function estimateSlippage(levels, amountUSD, direction) {
  if (!levels || levels.length === 0) return null;

  // For UNDERPRICED_YES we're buying (lifting asks), for OVERPRICED_YES we're selling (hitting bids)
  const sorted = direction === "UNDERPRICED_YES"
    ? [...levels].sort((a, b) => a.price - b.price) // asks: cheapest first
    : [...levels].sort((a, b) => b.price - a.price); // bids: highest first

  let filled = 0;
  let cost = 0;
  const bestPrice = sorted[0]?.price;

  for (const level of sorted) {
    const levelValue = level.price * level.size;
    const remaining = amountUSD - filled;
    if (remaining <= 0) break;

    if (levelValue >= remaining) {
      cost += remaining;
      filled += remaining;
    } else {
      cost += levelValue;
      filled += levelValue;
    }
  }

  if (filled < amountUSD * 0.5) return null; // less than half fillable

  const avgPrice = cost / (filled / sorted[0]?.price || 1);
  return Math.abs(avgPrice - bestPrice);
}

/**
 * Latest PMXT archive snapshot URL.
 * @returns {string} URL of most recent hourly parquet file
 */
export function latestSnapshotUrl() {
  const now = new Date();
  // Round down to previous hour
  now.setMinutes(0, 0, 0);
  now.setHours(now.getUTCHours() - 1);
  const ts = now.toISOString().replace(/:\d{2}:\d{2}\.\d{3}Z$/, "").replace(/:/g, ":");
  const dateStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}T${String(now.getUTCHours()).padStart(2, "0")}`;
  return `${PMXT_ARCHIVE}/polymarket_orderbook_${dateStr}.parquet`;
}

/**
 * Fetch historical depth from PMXT for a specific market.
 * Requires DuckDB CLI installed. Falls back gracefully.
 * @param {string} conditionId — market condition ID (0x-prefixed hex)
 * @param {string} [snapshotUrl] — optional specific snapshot URL
 * @returns {Promise<object|null>}
 */
export async function fetchHistoricalDepth(conditionId, snapshotUrl) {
  const url = snapshotUrl || latestSnapshotUrl();
  try {
    const { execSync } = await import("node:child_process");
    const query = `
      SELECT data FROM parquet_scan('${url}')
      WHERE market_id = '${conditionId}' AND update_type = 'book_snapshot'
      ORDER BY timestamp_received DESC LIMIT 2;
    `;
    const result = execSync(`duckdb -json -c "${query.replace(/\n/g, " ")}"`, {
      timeout: 30_000,
      encoding: "utf-8",
    });
    const rows = JSON.parse(result);
    if (rows.length === 0) return null;
    return rows.map((r) => JSON.parse(r.data));
  } catch {
    // DuckDB not available or query failed — fall back to null
    return null;
  }
}
