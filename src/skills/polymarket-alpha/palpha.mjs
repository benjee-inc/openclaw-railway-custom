#!/usr/bin/env node

// palpha — Polymarket Alternative Data Alpha Scanner
// Bridges external "alt data" sources with prediction market prices
// to detect mispricings across weather, crypto, economics, geopolitics, etc.

import { out, parseFlag, hasFlag, fmtPct, fmtVol, truncQ } from "./lib/helpers.mjs";
import { categorize, categorizeAll, categorySummary } from "./lib/categorizer.mjs";
import { isSportsMarket } from "./lib/categorizer.mjs";
import { fetchMarkets, fetchMarket } from "./lib/sources/polymarket.mjs";
import { match, fetchAltData } from "./lib/matcher.mjs";
import { score, recommendation } from "./lib/scorer.mjs";
import { fetchOrderBook, analyzeDepth, latestSnapshotUrl } from "./lib/depth.mjs";
import { buildGraph, detectViolations, graphStats, marketNetworkProfile } from "./lib/network.mjs";
import { fetchResolved, fetchPriceHistory, fetchPmxtPrices, mergePriceHistories, replaySignal, analyze, sleep } from "./lib/backtest.mjs";

// Min 24h volume to bother scoring (markets below this are illiquid noise)
const MIN_VOLUME_24H = 1000;
// For GDELT-only categories (politics, entertainment, unknown), require higher volume
// since the signal is weaker and GDELT calls are expensive time-wise
const MIN_VOLUME_GDELT_ONLY = 10_000;
// Max markets to score per category (prevent runaway on 300+ politics markets)
const MAX_PER_CATEGORY = 30;
// Concurrency for alt data fetches
const CONCURRENCY = 8;

// ── CLI dispatch ───────────────────────────────────────────

function usage() {
  console.log(`
palpha -- Polymarket Alternative Data Alpha Scanner

Usage:
  palpha scan                          Full scan: categorize, fetch alt data, score divergences
  palpha scan --category weather       Filter to one category
  palpha scan --top 10                 Top N results (default 20)
  palpha scan --min-vol 5000           Min 24h volume to scan (default 1000)
  palpha lookup <conditionId>          Deep dive on one market with all alt data
  palpha depth <conditionId>           Orderbook depth analysis (live CLOB + PMXT archive)
  palpha network                       Build market graph, detect network violations
  palpha network --category crypto     Filter graph to one category
  palpha crossref                      Full cross-reference: alpha + depth + network
  palpha crossref --top 10             Top N cross-referenced signals
  palpha categorize                    Debug: show market classification
  palpha backtest                       Backtest scorer against resolved markets
  palpha backtest --categories crypto   Filter to categories (comma-separated)
  palpha backtest --lookback 7,3,1      Lookback windows in days (default: 7,3,1)
  palpha backtest --limit 200           Max resolved markets to fetch (default: 100)
  palpha backtest --pmxt                Enrich prices with PMXT archive (requires DuckDB)
  palpha sources                       List data source status + connectivity
  palpha sources --test                Test all API endpoints

All output is JSON.
`.trim());
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    usage();
    process.exit(0);
  }

  const commands = {
    scan: cmdScan,
    lookup: cmdLookup,
    depth: cmdDepth,
    network: cmdNetwork,
    crossref: cmdCrossref,
    categorize: cmdCategorize,
    sources: cmdSources,
    backtest: cmdBacktest,
  };

  const fn = commands[command];
  if (!fn) {
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
  }

  try {
    await fn(args);
  } catch (err) {
    out({ error: true, message: err.message });
    process.exit(1);
  }
}

// ── Concurrency-limited batch processor ────────────────────

async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.allSettled(workers);
  return results;
}

// ── Categories that have dedicated alt data (not just GDELT) ──

const HIGH_VALUE_CATEGORIES = new Set(["weather", "crypto", "economics", "geopolitics", "tech"]);

// ── scan ───────────────────────────────────────────────────

async function cmdScan(args) {
  const topN = parseInt(parseFlag(args, "--top", "20"), 10);
  const categoryFilter = parseFlag(args, "--category", "");
  const minVol = parseInt(parseFlag(args, "--min-vol", String(MIN_VOLUME_24H)), 10);

  const scanStart = Date.now();

  // 1. Fetch all markets
  const allMarkets = await fetchMarkets();
  const nonSports = allMarkets.filter((m) => !isSportsMarket(m.question || ""));

  // 2. Categorize
  const byCategory = categorizeAll(nonSports);
  const summary = categorySummary(byCategory);

  // 3. Filter if requested
  let categoriesToScan;
  if (categoryFilter) {
    const cat = categoryFilter.toLowerCase();
    if (!byCategory.has(cat)) {
      out({ error: true, message: `No markets in category "${cat}". Available: ${[...byCategory.keys()].join(", ")}` });
      return;
    }
    categoriesToScan = new Map([[cat, byCategory.get(cat)]]);
  } else {
    categoriesToScan = byCategory;
  }

  // 4. Build the work queue — prioritize high-value categories, filter by volume
  const workQueue = [];

  for (const [cat, markets] of categoriesToScan) {
    const isHighValue = HIGH_VALUE_CATEGORIES.has(cat);
    const volumeThreshold = isHighValue ? minVol : Math.max(minVol, MIN_VOLUME_GDELT_ONLY);

    const eligible = markets
      .filter((m) => m.volume24h >= volumeThreshold)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, MAX_PER_CATEGORY);

    for (const market of eligible) {
      workQueue.push({ market, cat });
    }
  }

  // 5. Pre-fetch shared data (CoinGecko, Fear & Greed) once for all crypto markets
  const cryptoMarkets = workQueue.filter((w) => w.cat === "crypto");
  let sharedCryptoData = null;
  if (cryptoMarkets.length > 0) {
    try {
      const { prices } = await import("./lib/sources/crypto.mjs");
      const { fearGreed } = await import("./lib/sources/crypto.mjs");
      const { extractCoins } = await import("./lib/sources/crypto.mjs");

      const allCoins = new Set();
      for (const { market } of cryptoMarkets) {
        for (const id of extractCoins(market.question)) allCoins.add(id);
      }
      if (allCoins.size > 0) {
        const coinList = [...allCoins];
        const [priceData, fngData] = await Promise.all([
          prices(coinList),
          fearGreed(),
        ]);
        sharedCryptoData = { prices: priceData, fearGreed: fngData };

        // Also pre-fetch funding rates
        try {
          const { fundingRates } = await import("./lib/sources/coinglass.mjs");
          sharedCryptoData.funding = await fundingRates(coinList);
        } catch { /* proceed without funding */ }
      }
    } catch { /* proceed without pre-fetch */ }
  }

  // 6. Pre-test GDELT connectivity — skip all GDELT calls if blocked
  let gdeltFailed = false;
  let gdeltSkipped = 0;
  try {
    const gdeltMod = await import("./lib/sources/gdelt.mjs");
    const gdeltStatus = await gdeltMod.status();
    gdeltFailed = !gdeltStatus.ok;
  } catch {
    gdeltFailed = true;
  }

  // 7. Score all markets concurrently

  const alerts = [];
  let scored = 0;
  let errors = 0;

  await mapConcurrent(workQueue, CONCURRENCY, async ({ market, cat }) => {
    try {
      const matchResult = match(market);

      // If GDELT is blocked, remove it from sources to avoid timeout waste
      if (gdeltFailed) {
        const gdeltIdx = matchResult.sources.indexOf("gdelt");
        if (gdeltIdx !== -1) {
          matchResult.sources.splice(gdeltIdx, 1);
          gdeltSkipped++;
        }
      }

      // Inject pre-fetched crypto data to avoid redundant API calls
      let altData;
      if (cat === "crypto" && sharedCryptoData) {
        altData = {};
        if (sharedCryptoData.prices) altData.coingecko = sharedCryptoData.prices;
        if (sharedCryptoData.fearGreed) altData.fearGreed = sharedCryptoData.fearGreed;
        if (sharedCryptoData.funding) altData.funding = sharedCryptoData.funding;
      } else {
        altData = await fetchAltData(market, matchResult);
      }

      const scoreResult = score(market, altData, matchResult.params);
      scored++;

      if (scoreResult && Math.abs(scoreResult.alpha) > 0.01) {
        alerts.push({
          conditionId: market.conditionId,
          question: market.question,
          category: cat,
          marketPrice: market.prices?.[0] || 0,
          altDataImplied: scoreResult.altDataImplied,
          divergence: scoreResult.divergence,
          direction: scoreResult.direction,
          confidence: scoreResult.confidence,
          alpha: scoreResult.alpha,
          sources: scoreResult.sources,
          detail: scoreResult.detail,
          recommendation: recommendation(scoreResult.alpha, scoreResult.confidence),
          volume24h: market.volume24h,
          liquidity: market.liquidity,
          endDate: market.endDate,
        });
      }
    } catch {
      errors++;
    }
  });

  // 7. Rank by alpha score
  alerts.sort((a, b) => b.alpha - a.alpha);
  const topAlerts = alerts.slice(0, topN).map((a, i) => ({ rank: i + 1, ...a }));

  out({
    scanTime: new Date().toISOString(),
    durationMs: Date.now() - scanStart,
    marketsScanned: nonSports.length,
    marketsScored: scored,
    scoringErrors: errors,
    gdeltAvailable: !gdeltFailed,
    gdeltSkipped,
    categorized: summary,
    alertCount: topAlerts.length,
    alerts: topAlerts,
  });
}

// ── lookup ─────────────────────────────────────────────────

async function cmdLookup(args) {
  const conditionId = args[0];
  if (!conditionId) {
    console.error("Usage: palpha lookup <conditionId>");
    process.exit(1);
  }

  const market = await fetchMarket(conditionId);
  if (!market) {
    out({ error: true, message: `Market not found: ${conditionId}` });
    return;
  }

  const { category, score: catScore, scores } = categorize(market.question);
  const enrichedMarket = { ...market, _category: category, _catScore: catScore };
  const matchResult = match(enrichedMarket);
  const altData = await fetchAltData(enrichedMarket, matchResult);
  const scoreResult = score(enrichedMarket, altData, matchResult.params);

  out({
    market: {
      conditionId: market.conditionId,
      question: market.question,
      yesPrice: market.prices?.[0],
      noPrice: market.prices?.[1],
      volume: market.volume,
      volume24h: market.volume24h,
      liquidity: market.liquidity,
      spread: market.spread,
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      endDate: market.endDate,
      change1h: market.change1h,
      change1d: market.change1d,
    },
    classification: {
      category,
      score: catScore,
      allScores: scores,
    },
    matchedSources: matchResult.sources,
    matchParams: matchResult.params,
    altData,
    scoring: scoreResult ? {
      ...scoreResult,
      recommendation: recommendation(scoreResult.alpha, scoreResult.confidence),
    } : null,
  });
}

// ── categorize ─────────────────────────────────────────────

async function cmdCategorize(args) {
  const allMarkets = await fetchMarkets();
  const nonSports = allMarkets.filter((m) => !isSportsMarket(m.question || ""));
  const byCategory = categorizeAll(nonSports);
  const summary = categorySummary(byCategory);

  const details = {};
  for (const [cat, markets] of byCategory) {
    details[cat] = markets
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 5)
      .map((m) => ({
        question: truncQ(m.question, 80),
        conditionId: m.conditionId,
        catScore: m._catScore,
        yesPrice: m.prices?.[0],
        volume24h: m.volume24h,
      }));
  }

  out({
    totalMarkets: allMarkets.length,
    filteredSports: allMarkets.length - nonSports.length,
    nonSports: nonSports.length,
    categorized: summary,
    samplesByCategory: details,
  });
}

// ── sources ────────────────────────────────────────────────

async function cmdSources(args) {
  const doTest = hasFlag(args, "--test");

  const sourceInfo = [
    { name: "polymarket", api: "gamma-api.polymarket.com", rateLimit: "~unlimited", ttl: "2min", required: false },
    { name: "gdelt", api: "api.gdeltproject.org", rateLimit: "~unlimited", ttl: "5min", required: false },
    { name: "nws", api: "api.weather.gov", rateLimit: "~unlimited", ttl: "60min", required: false },
    { name: "ensemble", api: "api.open-meteo.com", rateLimit: "unlimited", ttl: "30min", required: false },
    { name: "coingecko", api: "api.coingecko.com", rateLimit: "10-30/min", ttl: "2min", required: false },
    { name: "fear_greed", api: "api.alternative.me", rateLimit: "~unlimited", ttl: "5min", required: false },
    { name: "coinglass", api: "open-api.coinglass.com", rateLimit: "free tier", ttl: "2min", required: false },
    { name: "fred", api: "api.stlouisfed.org", rateLimit: "unlimited w/ key", ttl: "6hr", required: false, envVar: "FRED_API_KEY" },
    { name: "opensky", api: "opensky-network.org", rateLimit: "400/day", ttl: "30s", required: false },
    { name: "arxiv", api: "export.arxiv.org", rateLimit: "~unlimited", ttl: "1hr", required: false },
    { name: "metaculus", api: "metaculus.com/api2", rateLimit: "~unlimited", ttl: "30min", required: false },
    { name: "trends", api: "trends.google.com", rateLimit: "varies", ttl: "15min", required: false, envVar: "SERPAPI_KEY" },
    { name: "montecarlo", api: "n/a (local computation)", rateLimit: "unlimited", ttl: "5min", required: false },
    { name: "particlefilter", api: "n/a (local computation)", rateLimit: "unlimited", ttl: "5min", required: false },
    { name: "copula", api: "n/a (local computation)", rateLimit: "unlimited", ttl: "5min", required: false },
  ];

  if (!doTest) {
    out({
      sources: sourceInfo.map((s) => ({
        ...s,
        configured: s.envVar ? !!process.env[s.envVar] : true,
      })),
    });
    return;
  }

  // Test all endpoints
  const statusMods = await Promise.all([
    import("./lib/sources/polymarket.mjs").then((m) => m.status()),
    import("./lib/sources/gdelt.mjs").then((m) => m.status()),
    import("./lib/sources/weather.mjs").then((m) => m.status()),
    import("./lib/sources/ensemble.mjs").then((m) => m.status()),
    import("./lib/sources/crypto.mjs").then((m) => m.statusCoinGecko()),
    import("./lib/sources/crypto.mjs").then((m) => m.statusFearGreed()),
    import("./lib/sources/coinglass.mjs").then((m) => m.status()),
    import("./lib/sources/economics.mjs").then((m) => m.status()),
    import("./lib/sources/opensky.mjs").then((m) => m.status()),
    import("./lib/sources/arxiv.mjs").then((m) => m.status()),
    import("./lib/sources/metaculus.mjs").then((m) => m.status()),
    import("./lib/sources/trends.mjs").then((m) => m.status()),
  ]);

  out({
    testTime: new Date().toISOString(),
    results: statusMods,
    allOk: statusMods.every((s) => s.ok),
  });
}

// ── depth ─────────────────────────────────────────────────

async function cmdDepth(args) {
  const conditionId = args[0];
  if (!conditionId) {
    console.error("Usage: palpha depth <conditionId>");
    process.exit(1);
  }

  const market = await fetchMarket(conditionId);
  if (!market) {
    out({ error: true, message: `Market not found: ${conditionId}` });
    return;
  }

  const book = await fetchOrderBook(market.tokenId);
  if (!book) {
    out({
      market: { conditionId, question: market.question },
      depth: { executable: false, reason: "clob_unavailable", score: 0 },
      pmxtArchive: latestSnapshotUrl(),
    });
    return;
  }

  const { category } = categorize(market.question);
  const enrichedMarket = { ...market, _category: category };
  const matchResult = match(enrichedMarket);
  const altData = await fetchAltData(enrichedMarket, matchResult);
  const scoreResult = score(enrichedMarket, altData, matchResult.params);

  const direction = scoreResult?.direction || "UNDERPRICED_YES";
  const depthAnalysis = analyzeDepth(book, market.prices?.[0] || 0.5, direction);

  out({
    market: {
      conditionId,
      question: market.question,
      yesPrice: market.prices?.[0],
      noPrice: market.prices?.[1],
      volume24h: market.volume24h,
      liquidity: market.liquidity,
    },
    alpha: scoreResult ? {
      alpha: scoreResult.alpha,
      direction: scoreResult.direction,
      confidence: scoreResult.confidence,
      recommendation: recommendation(scoreResult.alpha, scoreResult.confidence),
    } : null,
    depth: depthAnalysis,
    orderbook: {
      bids: book.bids.slice(0, 10),
      asks: book.asks.slice(0, 10),
      timestamp: book.timestamp,
    },
    pmxtArchive: latestSnapshotUrl(),
    verdict: verdictFromDepthAndAlpha(depthAnalysis, scoreResult),
  });
}

function verdictFromDepthAndAlpha(depth, alpha) {
  if (!alpha || alpha.alpha < 0.03) {
    return { action: "SKIP", reason: "No meaningful alpha signal." };
  }
  if (!depth.executable) {
    return { action: "WATCH", reason: `Alpha signal present but orderbook ${depth.reason}. Monitor for depth improvement.` };
  }
  if (depth.depthScore >= 0.6 && alpha.alpha >= 0.15 && alpha.confidence >= 0.5) {
    return { action: "STRONG_BUY", reason: `High alpha (${(alpha.alpha * 100).toFixed(1)}%) + deep liquidity (score ${depth.depthScore}). Executable at ${depth.slippage["$100"] != null ? (depth.slippage["$100"] * 100).toFixed(2) + "% slippage/$100" : "unknown slippage"}.` };
  }
  if (depth.depthScore >= 0.4 && alpha.alpha >= 0.08) {
    return { action: "BUY", reason: `Notable alpha (${(alpha.alpha * 100).toFixed(1)}%) + adequate liquidity (score ${depth.depthScore}).` };
  }
  return { action: "MONITOR", reason: `Weak signal or thin book. Alpha: ${(alpha.alpha * 100).toFixed(1)}%, Depth: ${depth.depthScore}.` };
}

// ── network ───────────────────────────────────────────────

async function cmdNetwork(args) {
  const categoryFilter = parseFlag(args, "--category", "");
  const topN = parseInt(parseFlag(args, "--top", "20"), 10);
  const scanStart = Date.now();

  const allMarkets = await fetchMarkets();
  const nonSports = allMarkets.filter((m) => !isSportsMarket(m.question || ""));
  const byCategory = categorizeAll(nonSports);

  let marketsForGraph;
  if (categoryFilter) {
    const cat = categoryFilter.toLowerCase();
    marketsForGraph = byCategory.get(cat) || [];
  } else {
    marketsForGraph = nonSports;
  }

  const graphMarkets = marketsForGraph
    .filter((m) => m.volume24h >= MIN_VOLUME_24H)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 200);

  const graph = buildGraph(graphMarkets);
  const violations = detectViolations(graph);
  const stats = graphStats(graph);

  out({
    scanTime: new Date().toISOString(),
    durationMs: Date.now() - scanStart,
    graph: stats,
    violationCount: violations.length,
    violations: violations.slice(0, topN),
    pmxtArchive: latestSnapshotUrl(),
  });
}

// ── crossref ──────────────────────────────────────────────

async function cmdCrossref(args) {
  const topN = parseInt(parseFlag(args, "--top", "15"), 10);
  const categoryFilter = parseFlag(args, "--category", "");
  const minVol = parseInt(parseFlag(args, "--min-vol", String(MIN_VOLUME_24H)), 10);
  const scanStart = Date.now();

  // 1. Run alpha scan (reuse scan logic)
  const allMarkets = await fetchMarkets();
  const nonSports = allMarkets.filter((m) => !isSportsMarket(m.question || ""));
  const byCategory = categorizeAll(nonSports);

  let categoriesToScan;
  if (categoryFilter) {
    const cat = categoryFilter.toLowerCase();
    categoriesToScan = byCategory.has(cat) ? new Map([[cat, byCategory.get(cat)]]) : new Map();
  } else {
    categoriesToScan = byCategory;
  }

  // Build work queue
  const workQueue = [];
  for (const [cat, markets] of categoriesToScan) {
    const isHighValue = HIGH_VALUE_CATEGORIES.has(cat);
    const volumeThreshold = isHighValue ? minVol : Math.max(minVol, MIN_VOLUME_GDELT_ONLY);
    const eligible = markets
      .filter((m) => m.volume24h >= volumeThreshold)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, MAX_PER_CATEGORY);
    for (const market of eligible) workQueue.push({ market, cat });
  }

  // 2. Score all markets for alpha
  let gdeltFailed = false;
  try {
    const gdeltMod = await import("./lib/sources/gdelt.mjs");
    gdeltFailed = !(await gdeltMod.status()).ok;
  } catch { gdeltFailed = true; }

  const alerts = [];
  await mapConcurrent(workQueue, CONCURRENCY, async ({ market, cat }) => {
    try {
      const matchResult = match(market);
      if (gdeltFailed) {
        const gi = matchResult.sources.indexOf("gdelt");
        if (gi !== -1) matchResult.sources.splice(gi, 1);
      }
      const altData = await fetchAltData(market, matchResult);
      const scoreResult = score(market, altData, matchResult.params);
      if (scoreResult && Math.abs(scoreResult.alpha) > 0.01) {
        alerts.push({ market, cat, scoreResult, altData, matchParams: matchResult.params });
      }
    } catch { /* skip */ }
  });

  alerts.sort((a, b) => b.scoreResult.alpha - a.scoreResult.alpha);
  const topAlerts = alerts.slice(0, topN);

  // 3. Build network graph for context
  const graphMarkets = workQueue
    .map((w) => w.market)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 200);
  const graph = buildGraph(graphMarkets);
  const violations = detectViolations(graph);

  // 4. Fetch depth for top alpha signals concurrently
  const crossRefResults = [];

  await mapConcurrent(topAlerts, 4, async ({ market, cat, scoreResult, altData, matchParams }) => {
    const book = await fetchOrderBook(market.tokenId);
    const depthAnalysis = book
      ? analyzeDepth(book, market.prices?.[0] || 0.5, scoreResult.direction)
      : { executable: false, reason: "clob_unavailable", depthScore: 0 };

    const profile = marketNetworkProfile(graph, market.conditionId, violations);
    const verdict = verdictFromDepthAndAlpha(depthAnalysis, scoreResult);

    // Build structured research from raw alt data
    const research = buildResearch(cat, altData, matchParams, scoreResult, market);

    // Copula: check for correlated mispricing among same-category neighbors
    let copulaResult = null;
    const sameCatAlerts = topAlerts.filter((a) => a.cat === cat && a.market.conditionId !== market.conditionId);
    if (sameCatAlerts.length >= 1) {
      try {
        const { analyzeCorrelatedMarkets } = await import("./lib/sources/copula.mjs");
        const copulaMarkets = [
          { question: market.question, price: market.prices?.[0] || 0.5 },
          ...sameCatAlerts.slice(0, 9).map((a) => ({
            question: a.market.question,
            price: a.market.prices?.[0] || 0.5,
          })),
        ];
        copulaResult = analyzeCorrelatedMarkets(copulaMarkets);
      } catch { /* copula not critical */ }
    }

    crossRefResults.push({
      conditionId: market.conditionId,
      question: market.question,
      category: cat,
      marketPrice: market.prices?.[0] || 0,
      alpha: {
        score: scoreResult.alpha,
        direction: scoreResult.direction,
        confidence: scoreResult.confidence,
        recommendation: recommendation(scoreResult.alpha, scoreResult.confidence),
        detail: scoreResult.detail,
      },
      depth: {
        score: depthAnalysis.depthScore,
        executable: depthAnalysis.executable,
        spread: depthAnalysis.spread,
        nearBidLiquidity: depthAnalysis.nearBidLiquidity,
        nearAskLiquidity: depthAnalysis.nearAskLiquidity,
        slippage100: depthAnalysis.slippage?.["$100"],
      },
      research,
      network: profile ? {
        degree: profile.degree,
        isHub: profile.isHub,
        riskLevel: profile.riskLevel,
        violations: profile.violations.length,
        neighbors: profile.neighbors.length,
      } : null,
      copula: copulaResult ? {
        sweepProb: copulaResult.sweepProb,
        tailDependence: copulaResult.tailDependence,
        mispricing: copulaResult.mispricing,
        mispricingDetail: copulaResult.mispricingDetail,
        marketsAnalyzed: copulaResult.markets?.length || 0,
      } : null,
      verdict,
      compositeScore: computeComposite(scoreResult, depthAnalysis, profile),
    });
  });

  // Sort by composite score
  crossRefResults.sort((a, b) => b.compositeScore - a.compositeScore);

  out({
    scanTime: new Date().toISOString(),
    durationMs: Date.now() - scanStart,
    marketsScanned: nonSports.length,
    alphaSignals: alerts.length,
    networkViolations: violations.length,
    graphStats: graphStats(graph),
    results: crossRefResults,
    pmxtArchive: latestSnapshotUrl(),
  });
}

// ── Structured research output ────────────────────────────
// Replaces the old narrative-based output with structured data
// that LLMs can reason about directly.

function buildResearch(cat, altData, params, scoreResult, market) {
  const r = { category: cat, sources: [] };

  // Weather — NWS/NOAA forecast
  if (altData?.nws) {
    const nws = altData.nws;
    r.sources.push("NOAA/NWS");
    r.nws = {
      city: nws.city,
      high: nws.high, low: nws.low, unit: nws.unit || "F",
      forecast: nws.forecast || null,
    };
    if (nws.periods) {
      r.nws.forecastPeriods = nws.periods.slice(0, 6).map((p) => ({
        name: p.name, temp: p.temperature, unit: p.temperatureUnit,
        wind: p.windSpeed, short: p.shortForecast,
        precipChance: p.probabilityOfPrecipitation,
      }));
    }
    if (params?.threshold) {
      r.nws.marketThreshold = params.threshold;
    }
  }

  // Weather — Open-Meteo ensemble
  if (altData?.ensemble) {
    r.sources.push("Open-Meteo Ensemble");
    r.ensemble = {
      agreement: altData.ensemble.agreement,
      spread: altData.ensemble.spread,
      precipProb: altData.ensemble.firstDayPrecipProb ?? altData.ensemble.precipProb ?? null,
    };
    if (altData.ensemble.days?.[0]?.forecasts) {
      r.ensemble.models = altData.ensemble.days[0].forecasts.map((f) => ({
        name: f.name, high: f.high, low: f.low,
      }));
    }
  }

  // Crypto — CoinGecko + Fear & Greed
  if (altData?.coingecko) {
    r.sources.push("CoinGecko");
    r.crypto = {};
    for (const [coin, data] of Object.entries(altData.coingecko)) {
      r.crypto[coin] = {
        price: data.usd, change24h: data.usd_24h_change,
        marketCap: data.usd_market_cap, volume24h: data.usd_24h_vol,
      };
    }
    if (params?.priceTarget) r.crypto.target = params.priceTarget;
  }
  if (altData?.fearGreed) {
    r.sources.push("Fear&Greed");
    r.fearGreed = altData.fearGreed;
  }

  // Crypto — Coinglass funding rates
  if (altData?.funding) {
    r.sources.push("Coinglass");
    r.funding = {};
    for (const [coinId, data] of Object.entries(altData.funding)) {
      r.funding[coinId] = {
        symbol: data.symbol,
        rate: data.rate,
        openInterest: data.openInterest,
        longRatio: data.longRatio,
      };
    }
  }

  // Monte Carlo simulation
  if (altData?.montecarlo) {
    r.sources.push("MonteCarlo");
    r.montecarlo = {
      mcImplied: altData.montecarlo.mcImplied,
      method: altData.montecarlo.method,
      simulations: altData.montecarlo.simulations,
      stdError: altData.montecarlo.stdError,
    };
  }

  // Economics — FRED
  if (altData?.fred?.length > 0) {
    r.sources.push("FRED");
    r.fred = altData.fred.map((obs) => ({
      series: obs.series, value: obs.value, date: obs.date,
    }));
    if (params?.threshold) r.fredThreshold = params.threshold;
  }

  // Geopolitics — GDELT + OpenSky
  if (altData?.gdelt && altData.gdelt.recent > 0) {
    r.sources.push("GDELT");
    r.gdelt = {
      articles: altData.gdelt.recent, volumeRatio: altData.gdelt.ratio,
      tone: altData.gdelt.currentTone, toneDelta: altData.gdelt.toneDelta,
    };
  }
  if (altData?.opensky?.length > 0) {
    r.sources.push("OpenSky");
    r.opensky = altData.opensky.filter(Boolean).map((f) => ({
      zone: f.zone, aircraft: f.count,
    }));
  }

  // Tech — arXiv
  if (altData?.arxiv) {
    r.sources.push("arXiv");
    r.arxiv = {
      query: altData.arxiv.query, papersPerWeek: altData.arxiv.papersPerWeek,
      acceleration: altData.arxiv.acceleration, totalResults: altData.arxiv.totalResults,
    };
  }

  // Cross-prediction-market — Metaculus
  if (altData?.metaculus) {
    r.sources.push("Metaculus");
    const mc = altData.metaculus;
    const mktPrice = market?.prices?.[0] || 0;
    r.metaculus = {
      question: mc.question,
      communityPrediction: mc.communityPrediction,
      numForecasters: mc.numForecasters,
      divergenceFromPolymarket: mc.communityPrediction != null
        ? Math.round((mc.communityPrediction - mktPrice) * 1000) / 1000
        : null,
    };
  }

  // Attention proxy — Google Trends
  if (altData?.trends) {
    r.sources.push("Google Trends");
    r.trends = {
      keyword: altData.trends.keyword,
      isBreakout: altData.trends.isBreakout,
      currentInterest: altData.trends.currentInterest,
      trend: altData.trends.trend,
    };
  }

  if (r.sources.length === 0) r.sources.push("none");

  // ── Edge source identification ──
  r.edgeSource = identifyEdgeSource(cat, r);

  // ── Time horizon ──
  r.timeHorizon = computeTimeHorizon(market);

  // ── Price analysis ──
  r.priceAnalysis = buildPriceAnalysis(cat, r, scoreResult, market);

  // ── Contradictions ──
  r.contradictions = findContradictions(cat, r, scoreResult, market);

  // ── Signal quality ──
  r.signalQuality = assessSignalQuality(r, scoreResult);

  return r;
}

// ── Price analysis (replaces narrative thesis) ──────────────

function buildPriceAnalysis(cat, research, scoreResult, market) {
  if (!scoreResult || scoreResult.alpha < 0.01) {
    return { assessment: "no_signal", marketPrice: market?.prices?.[0] || 0, implied: null, gap: 0 };
  }

  const mktPrice = market?.prices?.[0] || 0;
  const implied = scoreResult.altDataImplied;
  const gap = implied != null ? implied - mktPrice : 0;
  const direction = scoreResult.direction;

  const result = {
    assessment: direction === "UNDERPRICED_YES" ? "underpriced" : "overpriced",
    marketPrice: mktPrice,
    implied,
    gap: Math.round(gap * 1000) / 1000,
    confidence: scoreResult.confidence,
    alpha: scoreResult.alpha,
  };

  // Category-specific context
  switch (cat) {
    case "crypto":
      if (research.crypto) {
        const coin = Object.keys(research.crypto).find((k) => k !== "target");
        if (coin && research.crypto[coin]) {
          result.currentPrice = research.crypto[coin].price;
          result.change24h = research.crypto[coin].change24h;
          if (research.crypto.target) {
            result.targetPrice = research.crypto.target.target;
            result.priceRatio = research.crypto[coin].price / research.crypto.target.target;
          }
        }
        if (research.funding) {
          const fundingCoin = Object.keys(research.funding)[0];
          if (fundingCoin) result.fundingRate = research.funding[fundingCoin].rate;
        }
      }
      break;
    case "weather":
      if (research.nws) {
        result.forecastTemp = research.nws.high ?? research.nws.low;
        result.threshold = research.nws.marketThreshold;
      }
      if (research.ensemble) {
        result.ensembleAgreement = research.ensemble.agreement;
        result.ensembleSpread = research.ensemble.spread;
      }
      break;
    case "economics":
      if (research.fred?.[0]) {
        result.currentValue = research.fred[0].value;
        result.dataDate = research.fred[0].date;
        result.threshold = research.fredThreshold;
      }
      break;
  }

  if (research.metaculus) {
    result.metaculusPrediction = research.metaculus.communityPrediction;
    result.metaculusDivergence = research.metaculus.divergenceFromPolymarket;
  }

  return result;
}

// ── Contradiction detection ────────────────────────────────

function findContradictions(cat, research, scoreResult, market) {
  const contradictions = [];
  const mktPrice = market?.prices?.[0] || 0;

  // Metaculus vs Polymarket divergence
  if (research.metaculus?.divergenceFromPolymarket != null) {
    const div = Math.abs(research.metaculus.divergenceFromPolymarket);
    if (div > 0.10) {
      contradictions.push({
        type: "cross_platform",
        severity: div > 0.20 ? "high" : "notable",
        description: `Metaculus ${(research.metaculus.communityPrediction * 100).toFixed(0)}% vs Polymarket ${(mktPrice * 100).toFixed(0)}% (${(div * 100).toFixed(0)}pp gap)`,
        sources: ["Metaculus", "Polymarket"],
      });
    }
  }

  // Funding rate vs price direction (crypto)
  if (cat === "crypto" && research.funding) {
    const coin = Object.keys(research.funding)[0];
    if (coin) {
      const rate = research.funding[coin].rate;
      const target = research.crypto?.target;
      if (target && rate !== 0) {
        const longsExpectUp = rate > 0.01;
        const marketExpectsUp = target.direction === "above" && mktPrice > 0.5;
        const marketExpectsDown = target.direction === "below" && mktPrice > 0.5;

        if (longsExpectUp && marketExpectsDown) {
          contradictions.push({
            type: "positioning_vs_market",
            severity: Math.abs(rate) > 0.03 ? "high" : "notable",
            description: `Futures longs crowded (funding ${(rate * 100).toFixed(3)}%) but market prices downside`,
            sources: ["Coinglass", "Polymarket"],
          });
        }
        if (!longsExpectUp && rate < -0.01 && marketExpectsUp) {
          contradictions.push({
            type: "positioning_vs_market",
            severity: Math.abs(rate) > 0.03 ? "high" : "notable",
            description: `Futures shorts crowded (funding ${(rate * 100).toFixed(3)}%) but market prices upside`,
            sources: ["Coinglass", "Polymarket"],
          });
        }
      }
    }
  }

  // Ensemble model disagreement (weather)
  if (cat === "weather" && research.ensemble?.agreement === "very_low") {
    contradictions.push({
      type: "model_disagreement",
      severity: "high",
      description: `Weather models strongly disagree (spread ${research.ensemble.spread?.avgHigh || "?"}F) — outcome uncertain`,
      sources: ["GFS", "ECMWF", "ICON"],
    });
  }

  // GDELT news spike vs stable market price
  if (research.gdelt?.volumeRatio > 3.0 && Math.abs(scoreResult?.divergence || 0) < 0.05) {
    contradictions.push({
      type: "attention_vs_price",
      severity: "notable",
      description: `${research.gdelt.volumeRatio.toFixed(1)}x news volume surge but market price barely moved`,
      sources: ["GDELT", "Polymarket"],
    });
  }

  // Trends breakout vs stable market
  if (research.trends?.isBreakout && Math.abs(scoreResult?.divergence || 0) < 0.05) {
    contradictions.push({
      type: "attention_vs_price",
      severity: "mild",
      description: `Google Trends breakout on "${research.trends.keyword}" but market hasn't reacted`,
      sources: ["Google Trends", "Polymarket"],
    });
  }

  // OpenSky anomaly vs GDELT calm
  if (cat === "geopolitics" && research.opensky?.length > 0 && research.gdelt) {
    const hasAirspaceAnomaly = research.opensky.some((o) => {
      const baseline = ZONE_CONTEXT[o.zone]?.baseline || 100;
      return o.aircraft < baseline * 0.5;
    });
    if (hasAirspaceAnomaly && research.gdelt.volumeRatio < 1.5) {
      contradictions.push({
        type: "signal_divergence",
        severity: "notable",
        description: "Airspace anomaly detected but no corresponding news volume surge — potential early signal",
        sources: ["OpenSky", "GDELT"],
      });
    }
  }

  return contradictions;
}

// ── Signal quality assessment ─────────────────────────────

function assessSignalQuality(research, scoreResult) {
  if (!scoreResult || scoreResult.alpha < 0.01) {
    return { rating: "INSUFFICIENT", score: 0, sourcesUsed: 0, freshness: "unknown" };
  }

  const sourcesUsed = research.sources.filter((s) => s !== "none").length;
  let qualityScore = 0;

  // Source diversity (more independent sources = higher quality)
  qualityScore += Math.min(30, sourcesUsed * 8);

  // Alpha magnitude
  if (scoreResult.alpha >= 0.15) qualityScore += 25;
  else if (scoreResult.alpha >= 0.08) qualityScore += 15;
  else if (scoreResult.alpha >= 0.03) qualityScore += 8;

  // Confidence
  qualityScore += Math.round(scoreResult.confidence * 25);

  // Metaculus corroboration bonus
  if (research.metaculus?.numForecasters > 50) qualityScore += 10;
  else if (research.metaculus?.numForecasters > 10) qualityScore += 5;

  // Ensemble agreement bonus (weather)
  if (research.ensemble?.agreement === "high") qualityScore += 10;
  else if (research.ensemble?.agreement === "very_low") qualityScore -= 5;

  // Funding rate data bonus (crypto)
  if (research.funding && Object.keys(research.funding).length > 0) qualityScore += 5;

  // Data freshness
  let freshness = "real-time";
  if (research.fred?.[0]?.date) {
    const dataAge = (Date.now() - new Date(research.fred[0].date).getTime()) / (24 * 3600_000);
    if (dataAge > 14) { freshness = "stale"; qualityScore -= 10; }
    else if (dataAge > 7) { freshness = "lagging"; qualityScore -= 5; }
    else freshness = "recent";
  }

  let rating;
  if (qualityScore >= 60) rating = "HIGH";
  else if (qualityScore >= 40) rating = "MODERATE";
  else if (qualityScore >= 20) rating = "LOW";
  else rating = "WEAK";

  return { rating, score: Math.max(0, Math.min(100, qualityScore)), sourcesUsed, freshness };
}

// ── Edge source identification ──────────────────────────────

function identifyEdgeSource(cat, research) {
  switch (cat) {
    case "weather":
      if (research.ensemble && research.nws) return "NWS + multi-model ensemble";
      if (research.nws) return "NWS forecast";
      if (research.ensemble) return "multi-model ensemble";
      break;
    case "crypto":
      if (research.crypto && research.funding) {
        const hasFng = research.fearGreed != null;
        return hasFng ? "live price + funding rates + Fear & Greed" : "live price + funding rates";
      }
      if (research.crypto) {
        const hasFng = research.fearGreed != null;
        return hasFng ? "live price + Fear & Greed" : "live price vs target";
      }
      break;
    case "economics":
      if (research.fred?.length > 0 && research.metaculus) return "FRED + Metaculus";
      if (research.fred?.length > 0) return "FRED indicator data";
      if (research.metaculus) return "Metaculus community forecast";
      break;
    case "geopolitics":
      if (research.opensky?.length > 0 && research.gdelt && research.metaculus) return "airspace + news + Metaculus";
      if (research.opensky?.length > 0 && research.gdelt) return "airspace anomaly + news volume";
      if (research.metaculus && research.gdelt) return "Metaculus + news volume";
      if (research.opensky?.length > 0) return "airspace anomaly";
      if (research.metaculus) return "Metaculus community forecast";
      if (research.gdelt) return "news volume surge";
      break;
    case "tech":
      if (research.arxiv && research.metaculus) return "arXiv velocity + Metaculus";
      if (research.arxiv) return "arXiv research velocity";
      if (research.metaculus) return "Metaculus community forecast";
      break;
    case "politics":
    case "entertainment":
      if (research.metaculus) return "Metaculus community forecast";
      break;
  }
  if (research.metaculus) return "Metaculus community forecast";
  if (research.gdelt) return "GDELT news signal";
  return "none";
}

// ── Time horizon computation ────────────────────────────────

function computeTimeHorizon(market) {
  if (!market?.endDate) return { daysRemaining: null, urgency: "unknown" };
  try {
    const end = new Date(market.endDate).getTime();
    if (isNaN(end)) return { daysRemaining: null, urgency: "unknown" };
    const days = Math.max(0, Math.round((end - Date.now()) / (24 * 3600_000)));
    let urgency;
    if (days <= 3) urgency = "imminent";
    else if (days <= 14) urgency = "short-term";
    else if (days <= 60) urgency = "medium-term";
    else urgency = "long-term";
    return { daysRemaining: days, urgency };
  } catch {
    return { daysRemaining: null, urgency: "unknown" };
  }
}

// Zone-specific context for geopolitical analysis
const ZONE_CONTEXT = {
  ukraine: { label: "Ukraine", baseline: 100 },
  taiwan: { label: "Taiwan Strait", baseline: 50 },
  korea: { label: "Korean Peninsula", baseline: 40 },
  middle_east: { label: "Middle East", baseline: 80 },
  baltic: { label: "Baltic", baseline: 50 },
};

// ── Composite scoring ─────────────────────────────────────

function computeComposite(alpha, depth, network) {
  let s = 0;

  // Alpha component (0–50 points)
  s += Math.min(50, alpha.alpha * 200);

  // Depth component (0–30 points)
  s += depth.depthScore * 30;

  // Network bonus/penalty (0–20 points)
  if (network) {
    if (network.isHub) s += 5;
    s += Math.min(10, network.violations.length * 5);
    if (network.riskLevel === "HIGH") s += 5;
  }

  return Math.round(s * 100) / 100;
}

// ── backtest ──────────────────────────────────────────────

async function cmdBacktest(args) {
  const limitTotal = parseInt(parseFlag(args, "--limit", "100"), 10);
  const categoriesStr = parseFlag(args, "--categories", "");
  const lookbackStr = parseFlag(args, "--lookback", "7,3,1");
  const categoryFilter = categoriesStr
    ? new Set(categoriesStr.split(",").map((s) => s.trim().toLowerCase()))
    : null;
  const lookbacks = lookbackStr.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);

  const scanStart = Date.now();

  // 1. Fetch resolved markets with pagination
  let allResolved = [];
  let offset = 0;
  const pageSize = 100;

  while (allResolved.length < limitTotal) {
    const batch = await fetchResolved(pageSize, offset);
    if (batch.length === 0) break;
    allResolved.push(...batch);
    offset += pageSize;
  }
  allResolved = allResolved.slice(0, limitTotal);

  // 2. Filter by category if requested
  if (categoryFilter) {
    allResolved = allResolved.filter((m) => categoryFilter.has(m.category));
  }

  if (allResolved.length === 0) {
    out({ error: true, message: "No resolved markets found matching criteria." });
    return;
  }

  // 3. Fetch price history for all markets (concurrency 8)
  const priceHistories = new Map();
  await mapConcurrent(allResolved, 8, async (market) => {
    const history = await fetchPriceHistory(market.tokenId);
    if (history.length > 0) {
      priceHistories.set(market.conditionId, history);
    }
  });

  // 3b. Enrich with PMXT archive (depth-weighted midpoints, hourly resolution)
  const usePmxt = args.includes("--pmxt");
  let pmxtEnriched = 0;
  if (usePmxt) {
    const maxLookback = Math.max(...lookbacks);
    let minTs = Infinity, maxTs = 0;
    for (const m of allResolved) {
      const closeTs = Math.floor(new Date(m.closedTime).getTime() / 1000);
      if (isNaN(closeTs)) continue;
      const evalTs = closeTs - maxLookback * 86400;
      if (evalTs < minTs) minTs = evalTs;
      if (closeTs > maxTs) maxTs = closeTs;
    }

    if (minTs < Infinity) {
      const pmxt = await fetchPmxtPrices(
        allResolved.map((m) => ({ conditionId: m.conditionId, tokenId: m.tokenId })),
        minTs,
        maxTs,
      );
      for (const [cid, pmxtHistory] of pmxt) {
        if (pmxtHistory.length === 0) continue;
        const clobHistory = priceHistories.get(cid) || [];
        priceHistories.set(cid, mergePriceHistories(pmxtHistory, clobHistory));
        pmxtEnriched++;
      }
    }
  }

  // Filter to only markets with price history
  const marketsWithHistory = allResolved.filter((m) => priceHistories.has(m.conditionId));

  // 4. Replay signals for each market × lookback (concurrency 4, with rate limiting)
  const results = [];
  const workItems = [];
  for (const market of marketsWithHistory) {
    for (const lb of lookbacks) {
      workItems.push({ market, lb });
    }
  }

  // Determine if we need rate limiting (crypto markets use CoinGecko)
  const hasCrypto = marketsWithHistory.some((m) => m.category === "crypto");
  let requestCount = 0;

  await mapConcurrent(workItems, 4, async ({ market, lb }) => {
    // Rate limit for CoinGecko (crypto markets)
    if (market.category === "crypto") {
      requestCount++;
      if (requestCount > 1) await sleep(2000);
    }

    const history = priceHistories.get(market.conditionId);
    const result = await replaySignal(market, lb, history);
    if (result) results.push(result);
  });

  // 5. Analyze
  const report = analyze(results);
  report.meta.durationMs = Date.now() - scanStart;
  report.meta.resolvedFetched = allResolved.length;
  report.meta.withPriceHistory = marketsWithHistory.length;
  if (categoryFilter) report.meta.categoryFilter = [...categoryFilter];
  if (usePmxt) report.meta.pmxtEnriched = pmxtEnriched;

  out(report);
}

// ── run ────────────────────────────────────────────────────

main();
