// moon/lib/auto-trade-cmd.mjs -- CLI command: moon auto-trade
// Reads scanner signals from disk, validates with palpha, applies guardrails, executes trades.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { out, parseFlag, hasFlag } from "./helpers.mjs";
import {
  loadState, saveState, getStateDir,
  getAutoTraderState, canAutoTrade, recordAutoTrade,
  setAutoTraderLastCycle, pruneAutoTraderCooldowns, isRecentlyAutoTraded,
  getPolyBets, addPolyBet, addJournalEntry, addNarrative,
} from "./state.mjs";
import { getMarket, placeBet, placeLimitBet } from "./polymarket.mjs";

// ── Palpha imports (direct — CLI resolves all deps) ──────

import { categorize, isSportsMarket } from "../../polymarket-alpha/lib/categorizer.mjs";
import { match, fetchAltData } from "../../polymarket-alpha/lib/matcher.mjs";
import { score, recommendation } from "../../polymarket-alpha/lib/scorer.mjs";
import { fetchOrderBook, analyzeDepth } from "../../polymarket-alpha/lib/depth.mjs";
// DISABLED: Network signals generate massive false positives and bypass palpha validation.
// They caused buying multiple mutually exclusive outcomes (e.g., 5 Trump/Putin locations).
// import { buildGraph, detectViolations, detectViolationsAsync } from "../../polymarket-alpha/lib/network.mjs";

// ── Constants ────────────────────────────────────────────

const MAX_PER_DAY = Infinity;   // No daily limit
const MIN_LIQUIDITY = 50_000;   // $50K minimum liquidity
const MIN_LIQUIDITY_WEATHER = 10_000; // $10K for weather markets
const MAX_TRADES_PER_INVOCATION = 3;
const MAX_OPEN_POSITIONS = 10;  // Never hold more than 10 positions at once
const MIN_TRADE = 25;           // $25 minimum — lower floor allows more frequent smaller bets
const MAX_SPREAD_RATIO = 0.15;  // Skip trades where spread > 15% of entry price
const DUST_VALUE_THRESHOLD = 0.50; // Positions worth < $0.50 are dust — don't count toward cap
const DATA_API = "https://data-api.polymarket.com";
const DEFAULT_STALE_MS = 600_000; // 10 minutes
const DEFAULT_REPO = "benjee-inc/polymarket-arb-dashboard";
const JSONL_PATH = "logs/terminal.jsonl";
const MAX_JSONL_ENTRIES = 200;

// ── Wallet address derivation ────────────────────────────

let _cachedWalletAddr = null;
async function deriveWalletAddress() {
  if (_cachedWalletAddr) return _cachedWalletAddr;
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) return null;
  try {
    const ethers = await import("ethers");
    _cachedWalletAddr = new ethers.Wallet(pk).address;
    return _cachedWalletAddr;
  } catch {}
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire("/usr/local/lib/node_modules/");
    const ethers = req("ethers");
    _cachedWalletAddr = new ethers.Wallet(pk).address;
    return _cachedWalletAddr;
  } catch {}
  return null;
}

// ── GitHub JSONL push (dashboard) ────────────────────────

async function pushToDashboard(dashEntries) {
  const token = process.env.GITHUB_TOKEN?.trim();
  const repo = process.env.SCANNER_REPO?.trim() || DEFAULT_REPO;
  if (!token || dashEntries.length === 0) return;

  try {
    // Get existing
    const getUrl = `https://api.github.com/repos/${repo}/contents/${JSONL_PATH}`;
    const getRes = await fetch(getUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(15_000),
    });
    let sha = null;
    let existing = [];
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
      existing = Buffer.from(data.content, "base64").toString("utf8")
        .split("\n").filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }

    const combined = [...existing, ...dashEntries].slice(-MAX_JSONL_ENTRIES);
    const content = Buffer.from(combined.map(e => JSON.stringify(e)).join("\n") + "\n").toString("base64");
    await fetch(getUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
      body: JSON.stringify({ message: "auto-trade results", content, ...(sha ? { sha } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Non-fatal
    console.error(`[auto-trade] dashboard push error: ${err.message}`);
  }
}

// ── Signal file reading ──────────────────────────────────

function readSignals() {
  const signalPath = join(getStateDir(), "signals.json");
  try {
    const raw = readFileSync(signalPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    return { error: `Cannot read signals: ${err.message}` };
  }
}

// ── Position sizing ──────────────────────────────────────

// Initial sizing for raw scanner signals (before palpha enrichment)
function sizePosition(score, signalType, dailySpend, maxDay) {
  let size = 10; // base $10 — will be resized after palpha enrichment
  return Math.max(MIN_TRADE, Math.floor(Math.min(size, maxDay - dailySpend)));
}

// Conviction-based sizing after palpha enrichment
// Sized to target ~2% daily portfolio return with 3-6 trades/day
function sizeByConviction(opp, portfolioBalance) {
  const alpha = opp._palphaAlpha || 0;
  const conf = opp._palphaConf || 0.3;
  const rec = opp._palphaRec || "NOTABLE";
  const grokConf = opp._grokConf || "low";

  // Kelly-inspired fraction: bet size proportional to edge * confidence
  // f = edge * confidence, capped for safety
  const edge = Math.min(alpha, 0.40); // cap edge at 40%
  const kellyFraction = edge * conf;

  // Base allocation as % of portfolio — aggressive enough for 2% daily target
  // ACTIONABLE + high grok: up to 12% of portfolio
  // ACTIONABLE + medium grok: up to 8%
  // NOTABLE: up to 5%
  let maxPct;
  if (rec === "ACTIONABLE" && grokConf === "high") maxPct = 0.12;
  else if (rec === "ACTIONABLE") maxPct = 0.08;
  else maxPct = 0.05;

  // Scale by kelly fraction (higher edge+conf = larger bet)
  let size = portfolioBalance * Math.min(kellyFraction, maxPct);

  // Floor and ceiling
  size = Math.max(MIN_TRADE, size);
  size = Math.min(size, portfolioBalance * 0.15); // max 15% of portfolio on one trade

  return Math.floor(size);
}

// ── Signal evaluation (transplanted from auto-trader.mjs) ─

function getMinLiquidity(question) {
  const { category } = categorize(question || "");
  return category === "weather" ? MIN_LIQUIDITY_WEATHER : MIN_LIQUIDITY;
}

const MIN_PRICE = 0.35; // Don't bet on outliers below 35% odds — low-price markets have devastating spreads

function evaluateSignals(signals, tradeFlows, markets, dailySpend, maxDay) {
  const opportunities = [];

  const marketMap = new Map();
  const questionMap = new Map();
  for (const m of markets) {
    if (m.conditionId) marketMap.set(m.conditionId, m);
    if (m.question) questionMap.set(m.question, m);
  }

  function resolveMarket(flow) {
    if (flow.conditionId) {
      const m = marketMap.get(flow.conditionId);
      if (m) return m;
    }
    if (flow.q) return questionMap.get(flow.q) || null;
    return null;
  }

  // 1. Trade flow imbalance
  for (const flow of tradeFlows) {
    if (flow.imbalance < 0.6 || flow.total < 2000) continue;
    const market = resolveMarket(flow);
    if (!market || market.liquidity < getMinLiquidity(market.question)) continue;
    if ((market.prices?.[0] || 0) < MIN_PRICE) continue;
    if (isSportsMarket(flow.q || market.question || "")) continue;
    const condId = flow.conditionId || market.conditionId;
    if (!condId) continue;

    const outcome = flow.netFlow > 0 ? "yes" : "no";
    const amount = sizePosition(flow.score, "flow", dailySpend, maxDay);
    if (amount < MIN_TRADE || dailySpend + amount > maxDay) continue;

    opportunities.push({
      conditionId: condId, outcome, amount,
      reason: `Flow signal: ${flow.netFlow > 0 ? "BUY" : "SELL"} bias ${(flow.imbalance * 100).toFixed(0)}%, $${flow.total.toFixed(0)} volume`,
      signalType: "flow", score: flow.score * 2,
      question: flow.q, liquidity: market.liquidity,
      _signalContext: `Flow signal detected — ${flow.netFlow > 0 ? "BUY" : "SELL"} bias ${(flow.imbalance * 100).toFixed(0)}%, $${flow.total.toFixed(0)} volume in recent trades.`,
    });
  }

  // 2. Hourly momentum
  for (const m of (signals.movers1h || [])) {
    if (!m.conditionId) continue;
    const market = marketMap.get(m.conditionId);
    if (!market || market.liquidity < getMinLiquidity(market.question)) continue;
    if (m.price > 0.95 || m.price < MIN_PRICE) continue;
    if (isSportsMarket(m.q || market.question || "")) continue;

    const outcome = m.change1h > 0 ? "yes" : "no";
    const amount = sizePosition(Math.abs(m.change1h), "momentum", dailySpend, maxDay);
    if (amount < MIN_TRADE || dailySpend + amount > maxDay) continue;

    opportunities.push({
      conditionId: m.conditionId, outcome, amount,
      reason: `Hourly momentum: ${m.dir}${(Math.abs(m.change1h) * 100).toFixed(1)}% in 1h, now ${(m.price * 100).toFixed(1)}%`,
      signalType: "momentum", score: m.score * 1.5,
      question: m.q, liquidity: market.liquidity,
      _signalContext: `Momentum signal — price moved ${m.dir}${(Math.abs(m.change1h) * 100).toFixed(1)}% in the last hour, now at ${(m.price * 100).toFixed(1)}%.`,
    });
  }

  // 3. Wide spread
  for (const m of (signals.wideSpread || [])) {
    if (!m.conditionId) continue;
    const market = marketMap.get(m.conditionId);
    if (!market || market.liquidity < getMinLiquidity(market.question)) continue;
    if (m.spread < 0.05) continue;
    if (isSportsMarket(m.q || market.question || "")) continue;

    const midpoint = (m.bid + m.ask) / 2;
    const amount = sizePosition(m.score, "spread", dailySpend, maxDay);
    if (amount < MIN_TRADE || dailySpend + amount > maxDay) continue;

    opportunities.push({
      conditionId: m.conditionId, outcome: "yes", amount,
      limitPrice: midpoint,
      reason: `Wide spread: ${(m.spread * 100).toFixed(1)}% spread (bid ${(m.bid * 100).toFixed(1)}% / ask ${(m.ask * 100).toFixed(1)}%), limit @ ${(midpoint * 100).toFixed(1)}%`,
      signalType: "spread", score: m.score,
      question: m.q, liquidity: market.liquidity,
      _signalContext: `Wide spread detected — ${(m.spread * 100).toFixed(1)}% spread between bid ${(m.bid * 100).toFixed(1)}% and ask ${(m.ask * 100).toFixed(1)}%. Possible liquidity inefficiency.`,
    });
  }

  // 4. Catalysts
  for (const m of (signals.catalysts || [])) {
    if (!m.conditionId) continue;
    const market = marketMap.get(m.conditionId);
    if (!market || market.liquidity < getMinLiquidity(market.question)) continue;
    // Weather markets in the 30-70% range are tradeable — NWS data provides edge
    const isWeather = categorize(market.question || "").category === "weather";
    if (!isWeather && m.price >= 0.30 && m.price <= 0.70) continue;
    if (m.hrsLeft > 48) continue;
    if (isSportsMarket(m.q || market.question || "")) continue;

    const outcome = m.price > 0.5 ? "yes" : "no";
    const amount = sizePosition(m.score, "catalyst", dailySpend, maxDay);
    if (amount < MIN_TRADE || dailySpend + amount > maxDay) continue;

    opportunities.push({
      conditionId: m.conditionId, outcome, amount,
      reason: `Catalyst: ${m.hrsLeft.toFixed(0)}h to resolution, ${(m.price * 100).toFixed(1)}% YES, betting ${outcome.toUpperCase()}`,
      signalType: "catalyst", score: m.score * 0.8,
      question: m.q, liquidity: market.liquidity,
      _signalContext: `Catalyst signal — market resolves in ${m.hrsLeft.toFixed(0)} hours, currently at ${(m.price * 100).toFixed(1)}% YES. Near-expiry convergence opportunity.`,
    });
  }

  opportunities.sort((a, b) => b.score - a.score);
  return opportunities;
}

// ── Palpha enrichment ────────────────────────────────────

// Per-market enrichment timeout. Each market gets its own deadline.
// Grok is sole decision-maker — needs up to 3 min for web_search + x_search + retries.
const ENRICH_PER_MARKET_MS = 180_000; // 3 minutes
// Global safety net — markets run in parallel so this just caps total wall time.
const ENRICH_GLOBAL_MS = 240_000; // 4 minutes

async function enrichWithPalpha(opportunities, markets, topN = 5) {
  const entries = [];
  const top = opportunities.slice(0, topN);
  if (top.length === 0) return { enriched: opportunities, entries, vetoed: 0 };

  const mktMap = new Map();
  for (const m of markets) {
    if (m.conditionId) mktMap.set(m.conditionId, m);
  }

  // Enrich a single market with its own timeout.
  // Two-phase: cheap sources first → quick score → only call Grok if promising.
  // Returns result even on timeout (marks as unenriched, keeps raw score).
  async function enrichOne(opp) {
    const started = Date.now();
    try {
      const market = mktMap.get(opp.conditionId);
      if (!market) return { opp, enriched: false };

      // 1. Categorize + attach signal context for Grok
      const { category } = categorize(market.question || "");
      const enrichedMarket = { ...market, _category: category, _signalContext: opp._signalContext || null };

      // 2. PHASE 1: Fetch cheap/fast alt data WITHOUT Grok
      const matchResult = match(enrichedMarket);
      const SKIP_GROK = new Set(["grok"]);
      const cheapAltData = await fetchAltData(enrichedMarket, matchResult, { skipSources: SKIP_GROK });

      // Pre-filter: check if cheap sources returned ANY useful data
      // If zero cheap sources responded AND scanner score is low, skip Grok
      // (no alt data to cross-reference = Grok operating blind on a weak signal)
      const cheapSources = Object.keys(cheapAltData).filter(k => cheapAltData[k] != null);
      const hasMetaculus = cheapAltData.metaculus != null;
      const hasDomainData = cheapAltData.nws != null || cheapAltData.ensemble != null
        || cheapAltData.coingecko != null || cheapAltData.fred != null
        || cheapAltData.montecarlo?.mcImplied != null;

      if (cheapSources.length === 0 && opp.score < 5) {
        const q = (market.question || "").slice(0, 60);
        entries.push(`[pre-filter] "${q}" — zero cheap sources responded + weak scanner signal (score=${opp.score.toFixed(1)}), skipping Grok`);
        return { opp, enriched: true, vetoed: true, reason: "pre-filter: no alt data + weak signal — Grok skipped" };
      }

      // If only metaculus matched (weak signal) and scanner score is low, also skip
      if (!hasDomainData && !hasMetaculus && cheapSources.length <= 1 && opp.score < 3) {
        const q = (market.question || "").slice(0, 60);
        entries.push(`[pre-filter] "${q}" — minimal alt data (${cheapSources.join(",") || "none"}) + very weak signal, skipping Grok`);
        return { opp, enriched: true, vetoed: true, reason: "pre-filter: minimal alt data + very weak signal — Grok skipped" };
      }

      // 3. PHASE 2: Market looks promising — now call Grok only
      const grokOnly = { sources: ["grok"], params: matchResult.params };
      const grokData = await fetchAltData(enrichedMarket, grokOnly);
      const altData = { ...cheapAltData, ...grokData };

      // Log which sources actually returned data
      const gotSources = Object.keys(altData).filter(k => altData[k] != null);
      if (gotSources.length === 0) {
        entries.push(`"${(market.question || "").slice(0, 60)}" — no data sources responded (check XAI_API_KEY and timeouts)`);
      } else {
        entries.push(`[data] "${(market.question || "").slice(0, 50)}" — sources: ${gotSources.join(", ")}`);
      }

      // 4. Full score with Grok
      const scoreResult = score(enrichedMarket, altData, matchResult.params);
      const rec = recommendation(scoreResult.alpha, scoreResult.confidence);

      // 4. Depth gate
      let depthResult = null;
      const tokenIdx = opp.outcome === "yes" ? 0 : 1;
      const tokenIds = market.clobTokenIds || market.tokenIds || [];
      const tokenId = tokenIds[tokenIdx];
      if (tokenId) {
        const book = await fetchOrderBook(tokenId);
        if (book) {
          depthResult = analyzeDepth(book, market.prices?.[0] || 0.5, scoreResult.direction);
        }
      }

      // 5. Score multipliers by tier
      const multipliers = { ACTIONABLE: 2.5, NOTABLE: 1.8, MONITOR: 1.0, NOISE: 0.5 };
      let adjustedScore = opp.score * (multipliers[rec] || 1.0);

      // 6. Direction alignment
      const scannerBuyingYes = opp.outcome === "yes";
      const palphaFavorsYes = scoreResult.direction === "UNDERPRICED_YES";
      if ((scannerBuyingYes && palphaFavorsYes) || (!scannerBuyingYes && !palphaFavorsYes)) {
        adjustedScore *= 1.2;
      } else if (rec === "ACTIONABLE" || rec === "NOTABLE") {
        return { opp, enriched: true, vetoed: true, reason: `palpha ${rec} disagrees on direction` };
      }

      // 7. Depth veto — hard gate
      if (depthResult && !depthResult.executable) {
        const q = (market.question || "").slice(0, 60);
        entries.push(`Skipping "${q}" — orderbook too thin to fill safely`);
        return { opp, enriched: true, vetoed: true, reason: `thin orderbook` };
      }

      // 8. Hard gate: only ACTIONABLE/NOTABLE pass through
      if (rec !== "ACTIONABLE" && rec !== "NOTABLE") {
        const q = (market.question || "").slice(0, 60);
        const mktPct = ((market.prices?.[0] || 0) * 100).toFixed(1);
        const srcs = scoreResult.sources || [];

        // Log alt data detail + Grok's full analysis
        if (scoreResult.detail) {
          entries.push(`[alt] "${q}" — ${scoreResult.detail.trim().slice(0, 400)}`);
        }
        if (altData?.grok) {
          const g = altData.grok;
          entries.push(`[grok] "${q}" → ${(g.probability * 100).toFixed(0)}% (${g.confidence}) — ${(g.reasoning || "No clear signal").slice(0, 400)}`);
          if (g.keySignals?.length > 0) entries.push(`[grok] signals: ${g.keySignals.join(" | ")}`);
          if (g.marketComparison) entries.push(`[grok] vs market: ${g.marketComparison}`);
        } else {
          entries.push(`[grok] "${q}" — unavailable (timeout or no API key)`);
        }

        return { opp, enriched: true, vetoed: true, reason: `not enough edge` };
      }

      opp._palphaRec = rec;
      opp._palphaAlpha = scoreResult.alpha;
      opp._palphaConf = scoreResult.confidence;
      opp._palphaSources = scoreResult.sources;
      opp._palphaAdjustedScore = adjustedScore;
      opp._depthScore = depthResult?.depthScore ?? null;
      opp._depthSlippage = depthResult?.slippage?.["$100"] ?? null;
      opp._grokConf = altData?.grok?.confidence || null;
      opp.score = adjustedScore;

      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const mktPct = ((market.prices?.[0] || 0) * 100).toFixed(1);
      const implied = scoreResult.altDataImplied != null ? (scoreResult.altDataImplied * 100).toFixed(1) + "%" : "n/a";
      const aligned = (scannerBuyingYes && palphaFavorsYes) || (!scannerBuyingYes && !palphaFavorsYes);
      const q = (market.question || "").slice(0, 60);

      // Grok's full analysis
      if (altData?.grok) {
        const g = altData.grok;
        entries.push(`[grok] "${q}" → ${(g.probability * 100).toFixed(0)}% (${g.confidence}) — ${(g.reasoning || "").slice(0, 400)}`);
        if (g.keySignals?.length > 0) entries.push(`[grok] signals: ${g.keySignals.join(" | ")}`);
        if (g.marketComparison) entries.push(`[grok] vs market: ${g.marketComparison}`);
      }

      entries.push(`Buying ${opp.outcome.toUpperCase()} on "${q}" — market @ ${mktPct}%${aligned ? "" : " (contrarian bet)"}`);
      if (scoreResult.detail) {
        entries.push(`[alt] ${scoreResult.detail.trim().slice(0, 400)}`);
      }
      return { opp, enriched: true, vetoed: false };
    } catch (err) {
      entries.push(`[palpha] Error: "${(opp.question || "").slice(0, 50)}": ${err.message}`);
      return { opp, enriched: true, vetoed: true, reason: `enrichment error: ${err.message}` };
    }
  }

  // Run each market enrichment with its own per-market timeout.
  // Timeout = veto. Grok is the sole decision-maker — no Grok response means no trade.
  const enrichPromises = top.map((opp) =>
    Promise.race([
      enrichOne(opp),
      new Promise((resolve) => setTimeout(() => {
        entries.push(`[palpha] Timeout on "${(opp.question || "").slice(0, 50)}" after ${ENRICH_PER_MARKET_MS / 1000}s — vetoed (no Grok)`);
        resolve({ opp, enriched: true, vetoed: true, reason: "enrichment timeout — Grok unavailable" });
      }, ENRICH_PER_MARKET_MS)),
    ]),
  );

  // Global safety net: collect whatever finished within the deadline.
  let results;
  const globalTimeout = new Promise((resolve) => setTimeout(() => resolve(null), ENRICH_GLOBAL_MS));
  const allSettled = Promise.allSettled(enrichPromises);

  const winner = await Promise.race([allSettled, globalTimeout]);
  if (winner === null) {
    // Global timeout hit — veto everything. No Grok = no trade.
    entries.push(`[palpha] Global timeout after ${ENRICH_GLOBAL_MS / 1000}s. All opportunities vetoed.`);
    results = [];
  } else {
    results = winner;
  }

  let vetoedCount = 0;
  const enrichedOpps = [];
  const processedIds = new Set();

  for (const r of results) {
    if (r.status === "rejected") continue;
    const { opp, vetoed: isVetoed, reason } = r.value;
    processedIds.add(opp.conditionId);
    if (isVetoed) {
      vetoedCount++;
      entries.push(`[palpha] VETOED: "${(opp.question || "").slice(0, 60)}" — ${reason}`);
      continue;
    }
    enrichedOpps.push(opp);
  }

  // Only pass through opportunities that were NOT in the top-N enrichment set.
  // Top-N opps that timed out or errored are vetoed — no Grok = no trade.
  const topIds = new Set(top.map((o) => o.conditionId));
  for (const opp of opportunities) {
    if (!topIds.has(opp.conditionId)) {
      enrichedOpps.push(opp);
    }
  }

  enrichedOpps.sort((a, b) => (b._palphaAdjustedScore || b.score) - (a._palphaAdjustedScore || a.score));
  return { enriched: enrichedOpps, entries, vetoed: vetoedCount };
}

// ── Network violation detection ──────────────────────────

async function detectNetworkSignals(markets, dailySpend, maxDay) {
  const opportunities = [];
  const entries = [];

  const categorized = markets
    .filter((m) => m.conditionId && m.question && m.prices?.length > 0)
    .filter((m) => !isSportsMarket(m.question)) // Block all sports markets
    .map((m) => {
      const { category } = categorize(m.question);
      if (category === "sports") return null; // Double-check via categorizer
      return { ...m, _category: category };
    })
    .filter(Boolean);

  const graph = buildGraph(categorized);
  const violations = await detectViolationsAsync(graph);

  if (violations.length > 0) {
    entries.push(`[network] ${violations.length} structural violations across ${graph.nodeCount()} markets.`);
    for (const v of violations.slice(0, 5)) {
      entries.push(`[network]   ${v.type}: severity=${(v.severity || 0).toFixed(3)} | ${(v.detail || "").slice(0, 150)}`);
    }
  }

  for (const v of violations) {
    if (v.type === "threshold_monotonicity") {
      const conditionId = v.markets[0];
      const market = markets.find((m) => m.conditionId === conditionId);
      if (!market || market.liquidity < getMinLiquidity(market.question)) continue;
      if ((market.prices?.[0] || 0) < MIN_PRICE) continue;
      const amount = sizePosition(v.severity * 10000, "flow", dailySpend, maxDay);
      if (amount < MIN_TRADE || dailySpend + amount > maxDay) continue;

      opportunities.push({
        conditionId, outcome: "yes", amount,
        reason: `Network: threshold monotonicity — ${v.detail.slice(0, 120)}`,
        signalType: "network", score: v.severity * 20000,
        question: market.question, liquidity: market.liquidity,
        _palphaRec: "ACTIONABLE",
      });
    } else if (v.type === "complement_deviation" && v.deviation < -0.03) {
      const conditionId = v.markets[0];
      const market = markets.find((m) => m.conditionId === conditionId);
      if (!market || market.liquidity < getMinLiquidity(market.question)) continue;
      if ((market.prices?.[0] || 0) < MIN_PRICE) continue;
      const outcome = v.yesPrice <= v.noPrice ? "yes" : "no";
      const amount = sizePosition(Math.abs(v.deviation) * 10000, "spread", dailySpend, maxDay);
      if (amount < MIN_TRADE || dailySpend + amount > maxDay) continue;

      opportunities.push({
        conditionId, outcome, amount,
        reason: `Network: complement arb — YES+NO=${((v.yesPrice + v.noPrice) * 100).toFixed(1)}%, buying ${outcome.toUpperCase()}`,
        signalType: "network", score: Math.abs(v.deviation) * 15000,
        question: market.question, liquidity: market.liquidity,
        _palphaRec: "ACTIONABLE",
      });
    } else if (v.type === "correlation_divergence") {
      const [id1, id2] = v.markets;
      const cheaperId = v.prices[0] < v.prices[1] ? id1 : id2;
      const market = markets.find((m) => m.conditionId === cheaperId);
      if (!market || market.liquidity < getMinLiquidity(market.question)) continue;
      if ((market.prices?.[0] || 0) < MIN_PRICE) continue;
      const amount = sizePosition(v.severity * 5000, "momentum", dailySpend, maxDay);
      if (amount < MIN_TRADE || dailySpend + amount > maxDay) continue;

      opportunities.push({
        conditionId: cheaperId, outcome: "yes", amount,
        reason: `Network: correlation divergence — ${v.detail.slice(0, 120)}`,
        signalType: "network", score: v.severity * 10000,
        question: market.question, liquidity: market.liquidity,
        _palphaRec: "NOTABLE",
      });
    }
  }

  return { opportunities, entries };
}

// ── Trade execution ──────────────────────────────────────

async function executeTrade(opp) {
  const market = await getMarket(opp.conditionId);

  if (market.closed || !market.acceptingOrders) {
    return { success: false, reason: "Market closed or not accepting orders" };
  }

  const tokenIdx = opp.outcome === "yes" ? 0 : 1;
  const tokenId = market.clobTokenIds?.[tokenIdx];
  if (!tokenId) {
    return { success: false, reason: `No token ID for ${opp.outcome.toUpperCase()}` };
  }

  const entryPrice = opp.outcome === "yes" ? market.yesPrice : market.noPrice;
  const shares = entryPrice > 0 ? opp.amount / entryPrice : 0;

  let result;
  if (opp.limitPrice) {
    const tick = market.tickSize || 0.01;
    const price = Math.round(opp.limitPrice / tick) * tick;
    const size = opp.amount / price;
    result = await placeLimitBet(tokenId, "BUY", price, size, market.negRisk, market.tickSize);
  } else {
    result = await placeBet(tokenId, "BUY", opp.amount, market.negRisk, market.tickSize);
  }

  if (!result.success) {
    return { success: false, reason: `Order rejected: ${result.status || "unknown"}`, result };
  }

  // Auto-journal
  const questionShort = market.question.length > 60
    ? market.question.slice(0, 57) + "..."
    : market.question;

  const journalEntry = addJournalEntry({
    type: "bet",
    chain: "polygon",
    mint: opp.conditionId,
    symbol: questionShort,
    amount: opp.amount,
    price: entryPrice,
    mcap: null,
    note: `[auto-trade] ${opp.reason}`,
    narratives: ["auto-trade"],
    signature: result.orderId || null,
    polymarket: {
      conditionId: opp.conditionId,
      tokenId,
      outcome: opp.outcome.toUpperCase(),
      orderType: opp.limitPrice ? "GTC" : "FOK",
      shares: shares.toFixed(2),
      limitPrice: opp.limitPrice || null,
    },
  });

  addPolyBet({
    conditionId: opp.conditionId,
    tokenId,
    question: market.question,
    outcome: opp.outcome.toUpperCase(),
    amount: opp.amount,
    entryPrice,
    shares,
    journalId: journalEntry.id,
    orderId: result.orderId || null,
  });

  addNarrative("auto-trade", opp.conditionId);

  // Record in persistent guardrail state
  recordAutoTrade(opp.conditionId, opp.amount);

  return {
    success: true,
    orderId: result.orderId,
    conditionId: opp.conditionId,
    question: market.question,
    outcome: opp.outcome.toUpperCase(),
    amount: opp.amount,
    entryPrice,
    shares: shares.toFixed(2),
    orderType: opp.limitPrice ? "GTC" : "FOK",
    reason: opp.reason,
    signalType: opp.signalType,
    palphaRec: opp._palphaRec || null,
  };
}

// ── Main CLI command ─────────────────────────────────────

export async function cmdAutoTrade(args, opts = {}) {
  const dryRun = hasFlag(args, "--dry-run");
  const budgetOverride = parseFlag(args, "--budget", null);
  const maxTradesOverride = parseFlag(args, "--max-trades", null);
  const skipDashboardPush = opts.skipDashboardPush || false;

  const maxDay = budgetOverride ? Number(budgetOverride) : MAX_PER_DAY;
  const maxTrades = maxTradesOverride ? Number(maxTradesOverride) : MAX_TRADES_PER_INVOCATION;

  // 1. Read signals from disk
  const signalData = readSignals();
  if (signalData.error) {
    return out({ error: true, message: signalData.error, tradesExecuted: [], skipped: [] });
  }

  // 2. Check freshness
  const age = Date.now() - new Date(signalData.timestamp).getTime();
  const staleAfter = signalData.staleAfterMs || DEFAULT_STALE_MS;
  if (age > staleAfter) {
    const msg = `Signals stale: ${(age / 1000).toFixed(0)}s old (max ${(staleAfter / 1000).toFixed(0)}s)`;
    const entries = [{ timestamp: new Date().toISOString(), type: "palpha", message: `[auto-trade] ${msg}` }];
    if (!skipDashboardPush) await pushToDashboard(entries);
    return out({ error: true, message: msg, cycle: signalData.cycle, tradesExecuted: [], skipped: [], dashEntries: skipDashboardPush ? entries : undefined });
  }

  // 3. Check if we already processed this cycle
  const atState = getAutoTraderState();
  if (signalData.cycle && atState.lastCycle === signalData.cycle) {
    const entries = [{ timestamp: new Date().toISOString(), type: "palpha", message: `[auto-trade] Cycle ${signalData.cycle} already processed. Waiting for next scanner cycle. Daily: $${atState.dailySpend.toFixed(2)}` }];
    if (!skipDashboardPush) await pushToDashboard(entries);
    return out({
      message: `Cycle ${signalData.cycle} already processed. Waiting for next scanner cycle.`,
      tradesExecuted: [], skipped: [], dailySpend: atState.dailySpend, dashEntries: skipDashboardPush ? entries : undefined,
    });
  }

  // 4. Prune expired cooldowns
  pruneAutoTraderCooldowns();

  const { markets, signals, tradeFlows, midShifts } = signalData;
  const log = [];

  // 6. Evaluate scanner signals
  const rawOpportunities = evaluateSignals(signals, tradeFlows || [], markets, atState.dailySpend, maxDay);
  log.push(`Found ${rawOpportunities.length} potential trades from scanner`);

  // 7. Palpha enrichment + hard gate
  let opportunities = rawOpportunities;
  let palphaVetoed = 0;
  try {
    const result = await enrichWithPalpha(rawOpportunities, markets, 5);
    opportunities = result.enriched;
    palphaVetoed = result.vetoed;
    log.push(...result.entries);
  } catch (err) {
    log.push(`[palpha] Error: ${err.message}. Using raw scores.`);
  }

  // 8. Network violations — DISABLED
  // Network signals generated 293+ false positives/cycle, bypassed palpha validation,
  // and caused buying multiple mutually exclusive outcomes (guaranteed losses).
  // log.push(`[network] DISABLED`); // silenced — no need to announce every cycle
  // To re-enable: uncomment network import at top and the detectNetworkSignals call below.
  // try {
  //   const { opportunities: netOpps, entries: netEntries } = await detectNetworkSignals(markets, atState.dailySpend, maxDay);
  //   opportunities.push(...netOpps);
  //   log.push(...netEntries);
  //   opportunities.sort((a, b) => (b._palphaAdjustedScore || b.score) - (a._palphaAdjustedScore || a.score));
  // } catch (err) {
  //   log.push(`[network] Error: ${err.message}`);
  // }

  // 8b. Fetch portfolio balance for conviction-based sizing
  let portfolioBalance = 300; // fallback estimate
  try {
    const walletAddr = process.env.POLYMARKET_WALLET_ADDRESS || await deriveWalletAddress();
    if (walletAddr) {
      // Fetch USDC balance from Polymarket proxy wallet
      const balRes = await fetch(`${DATA_API}/balance?user=${walletAddr}`, { signal: AbortSignal.timeout(5_000) });
      if (balRes.ok) {
        const balData = await balRes.json();
        const usdcBal = parseFloat(balData?.balance || balData?.usdc || 0);
        if (usdcBal > 0) portfolioBalance = usdcBal;
      }
    }
  } catch {}

  // 8c. Resize enriched opportunities by conviction
  for (const opp of opportunities) {
    if (opp._palphaRec) {
      const oldAmount = opp.amount;
      opp.amount = sizeByConviction(opp, portfolioBalance);
      log.push(`[sizing] "${(opp.question || "").slice(0, 45)}" — ${opp._palphaRec} alpha=${((opp._palphaAlpha || 0) * 100).toFixed(0)}% grok=${opp._grokConf || "n/a"} → $${opp.amount} (portfolio $${portfolioBalance.toFixed(0)})`);
    }
  }

  // 9. Execute trades
  const tradesExecuted = [];
  const skipped = [];
  let tradeCount = 0;
  let currentSpend = atState.dailySpend;

  // Fetch LIVE positions from data-API (on-chain truth) and ignore dust
  const heldEventSlugs = new Set();
  const heldConditionIds = new Set();
  let currentOpenPositions = 0;
  let totalPositions = 0;
  let dustCount = 0;
  try {
    const walletAddr = process.env.POLYMARKET_WALLET_ADDRESS || await deriveWalletAddress();
    if (walletAddr) {
      const posRes = await fetch(`${DATA_API}/positions?user=${walletAddr}`, { signal: AbortSignal.timeout(10_000) });
      if (posRes.ok) {
        const livePositions = await posRes.json();
        if (Array.isArray(livePositions)) {
          totalPositions = livePositions.length;
          for (const p of livePositions) {
            const size = parseFloat(p.size || 0);
            const curPrice = parseFloat(p.curPrice || 0);
            if (size <= 0) continue;
            const currentValue = size * curPrice;
            if (currentValue < DUST_VALUE_THRESHOLD) {
              dustCount++;
              continue; // dust — don't count toward cap or event dedup
            }
            currentOpenPositions++;
            heldConditionIds.add(p.conditionId);
            const hMkt = markets.find(m => m.conditionId === p.conditionId);
            if (hMkt?.eventSlug) heldEventSlugs.add(hMkt.eventSlug);
          }
        }
      }
    }
  } catch (err) {
    // Fallback to local state if data-API fails
    const allHeld = getPolyBets({ status: "open" });
    currentOpenPositions = allHeld.length;
    for (const h of allHeld) {
      heldConditionIds.add(h.conditionId);
      const hMkt = markets.find(m => m.conditionId === h.conditionId);
      if (hMkt?.eventSlug) heldEventSlugs.add(hMkt.eventSlug);
    }
    log.push(`[auto-trade] Warning: data-API position fetch failed (${err.message}), using local state`);
  }
  if (dustCount > 0) {
    log.push(`${currentOpenPositions} active positions (${dustCount} dust ignored)`);
  }
  // Track event slugs traded THIS cycle to avoid duplicates
  const tradedEventSlugs = new Set();

  if (currentOpenPositions >= MAX_OPEN_POSITIONS) {
    log.push(`[auto-trade] Position cap hit: ${currentOpenPositions}/${MAX_OPEN_POSITIONS} open positions. No new trades until positions close.`);
  }

  for (const opp of opportunities) {
    if (tradeCount >= maxTrades) {
      skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: "max trades per invocation" });
      continue;
    }
    if (currentOpenPositions + tradeCount >= MAX_OPEN_POSITIONS) {
      skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: `position cap: ${currentOpenPositions + tradeCount}/${MAX_OPEN_POSITIONS} open` });
      continue;
    }
    if (currentSpend + opp.amount > maxDay) {
      skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: "daily budget exceeded" });
      continue;
    }
    if (isRecentlyAutoTraded(opp.conditionId)) {
      skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: "30min cooldown" });
      continue;
    }

    // Skip markets we already hold (check live positions first, fallback to local state)
    if (heldConditionIds.has(opp.conditionId)) {
      skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: "already held" });
      continue;
    }
    const heldLocal = getPolyBets({ conditionId: opp.conditionId, status: "open" });
    if (heldLocal.length > 0) {
      skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: "already held (local)" });
      continue;
    }

    // Same-event dedup: never buy multiple outcomes of the same event
    const oppMarket = markets.find(m => m.conditionId === opp.conditionId);
    const oppEventSlug = oppMarket?.eventSlug;
    if (oppEventSlug) {
      if (heldEventSlugs.has(oppEventSlug) || tradedEventSlugs.has(oppEventSlug)) {
        skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: `same-event dedup: already hold/traded another outcome in event "${oppEventSlug}"` });
        continue;
      }
    }

    // Spread guard: skip if spread is too wide relative to entry price
    if (oppMarket) {
      const entryP = opp.outcome === "yes" ? (oppMarket.bestBid || oppMarket.prices?.[0] || 0) : (oppMarket.prices?.[1] || 0);
      const spread = oppMarket.spread || (oppMarket.bestAsk && oppMarket.bestBid ? oppMarket.bestAsk - oppMarket.bestBid : 0);
      if (entryP > 0 && spread > 0 && (spread / entryP) > MAX_SPREAD_RATIO) {
        skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: `spread too wide: ${(spread * 100).toFixed(1)}¢ on ${(entryP * 100).toFixed(1)}¢ entry (${((spread / entryP) * 100).toFixed(0)}% > ${MAX_SPREAD_RATIO * 100}% max)` });
        continue;
      }
    }

    if (dryRun) {
      skipped.push({
        conditionId: opp.conditionId, question: opp.question,
        outcome: opp.outcome, amount: opp.amount,
        reason: "dry-run", signalType: opp.signalType,
        score: opp.score, palphaRec: opp._palphaRec || null,
      });
      continue;
    }

    try {
      const result = await executeTrade(opp);
      if (result.success) {
        tradesExecuted.push(result);
        tradeCount++;
        currentSpend += opp.amount;
        // Record event slug so we don't buy another outcome of the same event
        if (oppEventSlug) tradedEventSlugs.add(oppEventSlug);
      } else {
        skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: result.reason });
      }
    } catch (err) {
      skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: `Error: ${err.message}` });
    }
  }

  // 10. Mark cycle processed
  if (signalData.cycle) {
    setAutoTraderLastCycle(signalData.cycle);
  }

  // 11. Push palpha + trade entries to dashboard
  const iso = () => new Date().toISOString();
  const dashEntries = [];
  for (const msg of log) {
    dashEntries.push({ timestamp: iso(), type: "palpha", message: msg });
  }
  for (const t of tradesExecuted) {
    let msg = `Bought ${t.outcome.toUpperCase()} $${t.amount} on "${(t.question || "").slice(0, 60)}" @ ${(t.entryPrice * 100).toFixed(1)}%`;
    if (t.reason) msg += ` — ${t.reason}`;
    dashEntries.push({ timestamp: iso(), type: "trade", message: msg });
  }
  if (tradesExecuted.length === 0 && skipped.length > 0) {
    // Group skip reasons into human-readable summary
    const reasonCounts = {};
    for (const s of skipped) {
      const r = s.reason.replace(/:.*/,"").replace(/spread too wide.*/, "spread too wide").replace(/same-event dedup.*/, "same-event dedup");
      reasonCounts[r] = (reasonCounts[r] || 0) + 1;
    }
    const summary = Object.entries(reasonCounts).map(([r, n]) => n > 1 ? `${r} (${n})` : r).join(", ");
    dashEntries.push({ timestamp: iso(), type: "trade", message: `No trades this cycle — ${summary}. Spent $${currentSpend.toFixed(0)} today.` });
  } else if (tradesExecuted.length === 0 && skipped.length === 0) {
    dashEntries.push({ timestamp: iso(), type: "palpha", message: `Evaluated ${rawOpportunities.length} opportunities, ${palphaVetoed} didn't have enough edge. Nothing actionable. Spent $${currentSpend.toFixed(0)} today.` });
  }
  if (!skipDashboardPush) await pushToDashboard(dashEntries);

  // 12. Output
  const finalState = getAutoTraderState();
  out({
    cycle: signalData.cycle,
    dryRun,
    tradesExecuted,
    skipped,
    opportunities: rawOpportunities.length,
    enriched: opportunities.length,
    vetoed: palphaVetoed,
    dailySpend: finalState.dailySpend,
    dailyTrades: finalState.dailyTrades,
    dailyLimit: maxDay,
    log,
    dashEntries: skipDashboardPush ? dashEntries : undefined,
  });
}
