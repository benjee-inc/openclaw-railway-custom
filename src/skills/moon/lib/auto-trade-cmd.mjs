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
import { buildGraph, detectViolations, detectViolationsAsync } from "../../polymarket-alpha/lib/network.mjs";

// ── Constants ────────────────────────────────────────────

const MAX_PER_TRADE = 20;       // $20 USDC
const MAX_PER_DAY = 50;         // $50 USDC
const MIN_LIQUIDITY = 50_000;   // $50K default
const MIN_LIQUIDITY_WEATHER = 10_000; // $10K for weather markets
const MAX_TRADES_PER_INVOCATION = 3;
const MIN_TRADE = 5;            // $5 minimum
const DEFAULT_STALE_MS = 600_000; // 10 minutes
const DEFAULT_REPO = "benjee-inc/polymarket-arb-dashboard";
const JSONL_PATH = "logs/terminal.jsonl";
const MAX_JSONL_ENTRIES = 200;

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

function sizePosition(score, signalType, dailySpend, maxDay) {
  let size = 10; // base $10

  if (signalType === "flow" && score > 5000) size = 15;
  if (signalType === "flow" && score > 15000) size = 20;
  if (signalType === "momentum" && score > 0.05) size = 15;
  if (signalType === "spread" && score > 500) size = 15;

  size = Math.min(size, MAX_PER_TRADE);
  size = Math.min(size, maxDay - dailySpend);

  return Math.max(MIN_TRADE, Math.floor(size));
}

// ── Signal evaluation (transplanted from auto-trader.mjs) ─

function getMinLiquidity(question) {
  const { category } = categorize(question || "");
  return category === "weather" ? MIN_LIQUIDITY_WEATHER : MIN_LIQUIDITY;
}

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
    });
  }

  // 2. Hourly momentum
  for (const m of (signals.movers1h || [])) {
    if (!m.conditionId) continue;
    const market = marketMap.get(m.conditionId);
    if (!market || market.liquidity < getMinLiquidity(market.question)) continue;
    if (m.price > 0.95 || m.price < 0.05) continue;
    if (isSportsMarket(m.q || market.question || "")) continue;

    const outcome = m.change1h > 0 ? "yes" : "no";
    const amount = sizePosition(Math.abs(m.change1h), "momentum", dailySpend, maxDay);
    if (amount < MIN_TRADE || dailySpend + amount > maxDay) continue;

    opportunities.push({
      conditionId: m.conditionId, outcome, amount,
      reason: `Hourly momentum: ${m.dir}${(Math.abs(m.change1h) * 100).toFixed(1)}% in 1h, now ${(m.price * 100).toFixed(1)}%`,
      signalType: "momentum", score: m.score * 1.5,
      question: m.q, liquidity: market.liquidity,
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
    });
  }

  opportunities.sort((a, b) => b.score - a.score);
  return opportunities;
}

// ── Palpha enrichment ────────────────────────────────────

// Per-market enrichment timeout. Each market gets its own deadline.
// With 8s per-source timeouts in fetchAltData, one market should finish in ~10s.
const ENRICH_PER_MARKET_MS = 12_000;
// Global safety net — even if per-market timeouts somehow stall.
const ENRICH_GLOBAL_MS = 30_000;

async function enrichWithPalpha(opportunities, markets, topN = 5) {
  const entries = [];
  const top = opportunities.slice(0, topN);
  if (top.length === 0) return { enriched: opportunities, entries, vetoed: 0 };

  const mktMap = new Map();
  for (const m of markets) {
    if (m.conditionId) mktMap.set(m.conditionId, m);
  }

  // Enrich a single market with its own timeout.
  // Returns result even on timeout (marks as unenriched, keeps raw score).
  async function enrichOne(opp) {
    const started = Date.now();
    try {
      const market = mktMap.get(opp.conditionId);
      if (!market) return { opp, enriched: false };

      // 1. Categorize
      const { category } = categorize(market.question || "");
      const enrichedMarket = { ...market, _category: category };

      // 2. Match + fetch alt data (per-source 8s timeouts inside)
      const matchResult = match(enrichedMarket);
      const altData = await fetchAltData(enrichedMarket, matchResult);

      // 3. Score divergence
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
        return { opp, enriched: true, vetoed: true, reason: `depth not executable: ${depthResult.reason}` };
      }

      // 8. Hard gate: only ACTIONABLE/NOTABLE pass through
      if (rec !== "ACTIONABLE" && rec !== "NOTABLE") {
        return { opp, enriched: true, vetoed: true, reason: `palpha rec=${rec} — below threshold` };
      }

      opp._palphaRec = rec;
      opp._palphaAlpha = scoreResult.alpha;
      opp._palphaSources = scoreResult.sources;
      opp._palphaAdjustedScore = adjustedScore;
      opp._depthScore = depthResult?.depthScore ?? null;
      opp._depthSlippage = depthResult?.slippage?.["$100"] ?? null;
      opp.score = adjustedScore;

      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const srcList = (scoreResult.sources || []).join(",");
      const dir = scoreResult.direction || "?";
      const conf = ((scoreResult.confidence || 0) * 100).toFixed(0);
      const implied = scoreResult.altDataImplied != null ? (scoreResult.altDataImplied * 100).toFixed(1) + "%" : "n/a";
      const mktPct = ((market.prices?.[0] || 0) * 100).toFixed(1);
      const depthInfo = depthResult
        ? `depth=${depthResult.executable ? "OK" : "FAIL"} slippage=$${(depthResult.slippage?.["$100"] ?? 0).toFixed(2)}`
        : "depth=n/a";
      const aligned = (scannerBuyingYes && palphaFavorsYes) || (!scannerBuyingYes && !palphaFavorsYes) ? "ALIGNED" : "CONFLICT";

      entries.push(`[palpha] "${(market.question || "").slice(0, 60)}" | cat=${category} rec=${rec} alpha=${(scoreResult.alpha * 100).toFixed(1)}% conf=${conf}% | mkt=${mktPct}% implied=${implied} dir=${dir} | sources=[${srcList}] | ${depthInfo} | scanner=${opp.outcome.toUpperCase()} vs palpha=${palphaFavorsYes ? "YES" : "NO"} → ${aligned} | (${elapsed}s)`);
      if (scoreResult.detail) {
        entries.push(`[palpha]   reasoning: ${scoreResult.detail.trim().slice(0, 300)}`);
      }
      return { opp, enriched: true, vetoed: false };
    } catch (err) {
      entries.push(`[palpha] Error: "${(opp.question || "").slice(0, 50)}": ${err.message}`);
      return { opp, enriched: false };
    }
  }

  // Run each market enrichment with its own per-market timeout.
  // Partial results are kept — a timeout on market #3 doesn't discard markets #1 and #2.
  const enrichPromises = top.map((opp) =>
    Promise.race([
      enrichOne(opp),
      new Promise((resolve) => setTimeout(() => {
        entries.push(`[palpha] Timeout on "${(opp.question || "").slice(0, 50)}" after ${ENRICH_PER_MARKET_MS / 1000}s — using raw score`);
        resolve({ opp, enriched: false });
      }, ENRICH_PER_MARKET_MS)),
    ]),
  );

  // Global safety net: collect whatever finished within the deadline.
  let results;
  const globalTimeout = new Promise((resolve) => setTimeout(() => resolve(null), ENRICH_GLOBAL_MS));
  const allSettled = Promise.allSettled(enrichPromises);

  const winner = await Promise.race([allSettled, globalTimeout]);
  if (winner === null) {
    // Global timeout hit — but some per-market promises may have already resolved.
    // allSettled is still pending; we can't await it. Use whatever we logged.
    entries.push(`[palpha] Global timeout after ${ENRICH_GLOBAL_MS / 1000}s. Using partial results.`);
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

  // Append remaining non-top opportunities AND any top opps that timed out (keep raw score)
  const topIds = new Set(top.map((o) => o.conditionId));
  for (const opp of opportunities) {
    if (!topIds.has(opp.conditionId) || (topIds.has(opp.conditionId) && !processedIds.has(opp.conditionId))) {
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

export async function cmdAutoTrade(args) {
  const dryRun = hasFlag(args, "--dry-run");
  const budgetOverride = parseFlag(args, "--budget", null);
  const maxTradesOverride = parseFlag(args, "--max-trades", null);

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
    await pushToDashboard([{ timestamp: new Date().toISOString(), type: "palpha", message: `[auto-trade] ${msg}` }]);
    return out({ error: true, message: msg, cycle: signalData.cycle, tradesExecuted: [], skipped: [] });
  }

  // 3. Check if we already processed this cycle
  const atState = getAutoTraderState();
  if (signalData.cycle && atState.lastCycle === signalData.cycle) {
    await pushToDashboard([{ timestamp: new Date().toISOString(), type: "palpha", message: `[auto-trade] Cycle ${signalData.cycle} already processed. Waiting for next scanner cycle. Daily: $${atState.dailySpend.toFixed(2)}` }]);
    return out({
      message: `Cycle ${signalData.cycle} already processed. Waiting for next scanner cycle.`,
      tradesExecuted: [], skipped: [], dailySpend: atState.dailySpend,
    });
  }

  // 4. Check daily budget
  if (atState.dailySpend >= maxDay) {
    const msg = `Daily limit reached: $${atState.dailySpend.toFixed(2)}/$${maxDay}`;
    await pushToDashboard([{ timestamp: new Date().toISOString(), type: "palpha", message: `[auto-trade] ${msg}` }]);
    return out({ message: msg, tradesExecuted: [], skipped: [], dailySpend: atState.dailySpend });
  }

  // 5. Prune expired cooldowns
  pruneAutoTraderCooldowns();

  const { markets, signals, tradeFlows, midShifts } = signalData;
  const log = [];

  // 6. Evaluate scanner signals
  const rawOpportunities = evaluateSignals(signals, tradeFlows || [], markets, atState.dailySpend, maxDay);
  log.push(`Evaluated ${rawOpportunities.length} raw opportunities from scanner signals`);

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

  // 8. Network violations
  try {
    const { opportunities: netOpps, entries: netEntries } = await detectNetworkSignals(markets, atState.dailySpend, maxDay);
    opportunities.push(...netOpps);
    log.push(...netEntries);
    opportunities.sort((a, b) => (b._palphaAdjustedScore || b.score) - (a._palphaAdjustedScore || a.score));
  } catch (err) {
    log.push(`[network] Error: ${err.message}`);
  }

  // 9. Execute trades
  const tradesExecuted = [];
  const skipped = [];
  let tradeCount = 0;
  let currentSpend = atState.dailySpend;

  for (const opp of opportunities) {
    if (tradeCount >= maxTrades) {
      skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: "max trades per invocation" });
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

    // Skip markets we already hold
    const held = getPolyBets({ conditionId: opp.conditionId, status: "open" });
    if (held.length > 0) {
      skipped.push({ conditionId: opp.conditionId, question: opp.question, reason: "already held" });
      continue;
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
    let msg = `[auto-trade] EXECUTED: ${t.outcome} $${t.amount} on "${(t.question || "").slice(0, 50)}" @ ${(t.entryPrice * 100).toFixed(1)}% | ${t.reason}`;
    if (t.palphaRec) msg += ` | palpha=${t.palphaRec}`;
    msg += ` | order=${t.orderId || "n/a"}`;
    dashEntries.push({ timestamp: iso(), type: "trade", message: msg });
  }
  if (tradesExecuted.length === 0 && skipped.length > 0) {
    const reasons = [...new Set(skipped.map(s => s.reason))].join(", ");
    dashEntries.push({ timestamp: iso(), type: "trade", message: `[auto-trade] No trades: ${reasons}. Daily: $${currentSpend.toFixed(2)}/$${maxDay}` });
  } else if (tradesExecuted.length === 0 && skipped.length === 0) {
    dashEntries.push({ timestamp: iso(), type: "palpha", message: `[auto-trade] Cycle ${signalData.cycle || "?"}: ${rawOpportunities.length} raw opps, ${opportunities.length} after enrichment, ${palphaVetoed} vetoed. No actionable trades. Daily: $${currentSpend.toFixed(2)}/$${maxDay}` });
  }
  await pushToDashboard(dashEntries);

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
  });
}
