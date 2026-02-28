/**
 * Auto-Trader — converts scanner signals into real trades.
 *
 * Runs after each scanner cycle. Receives raw markets + signals,
 * applies guardrails, picks best opportunity, and executes via CLOB API.
 *
 * Guardrails (hard limits):
 *   - Max $20 per trade
 *   - Max $50 per day
 *   - Min $50K liquidity
 *   - Max 3 trades per cycle
 *   - No sports markets (already filtered by scanner)
 *   - No closed/inactive markets
 */

// Lazy imports — these modules pull in @solana/web3.js etc. which aren't
// available in the server.js process. We import them dynamically only when
// actually executing a trade (not at module load time).
let _poly = null;
let _state = null;

async function poly() {
  if (!_poly) _poly = await import("./lib/polymarket.mjs");
  return _poly;
}

async function state() {
  if (!_state) _state = await import("./lib/state.mjs");
  return _state;
}

// ── Guardrails ───────────────────────────────────────────

const MAX_PER_TRADE = 20;       // $20 USDC
const MAX_PER_DAY = 50;         // $50 USDC
const MIN_LIQUIDITY = 50_000;   // $50K
const MAX_TRADES_PER_CYCLE = 3;
const MIN_TRADE = 5;            // $5 minimum

// ── Daily spend tracker (resets at midnight UTC) ─────────

let _daily = { date: null, amount: 0, trades: 0 };

function dailyTracker() {
  const today = new Date().toISOString().slice(0, 10);
  if (_daily.date !== today) {
    _daily = { date: today, amount: 0, trades: 0 };
  }
  return _daily;
}

function canTrade(amount) {
  const d = dailyTracker();
  return d.amount + amount <= MAX_PER_DAY;
}

function recordTrade(amount) {
  const d = dailyTracker();
  d.amount += amount;
  d.trades += 1;
}

// ── Cycle trade counter ──────────────────────────────────

let _cycleTradeCount = 0;

// ── Position sizing ──────────────────────────────────────

function sizePosition(score, signalType) {
  let size = 10; // base $10

  // Scale up for strong signals
  if (signalType === "flow" && score > 5000) size = 15;
  if (signalType === "flow" && score > 15000) size = 20;
  if (signalType === "momentum" && score > 0.05) size = 15;
  if (signalType === "spread" && score > 500) size = 15;

  // Cap at max per trade
  size = Math.min(size, MAX_PER_TRADE);

  // Cap at remaining daily budget
  const remaining = MAX_PER_DAY - dailyTracker().amount;
  size = Math.min(size, remaining);

  return Math.max(MIN_TRADE, Math.floor(size));
}

// ── Signal evaluation ────────────────────────────────────

/**
 * Evaluate all signals and return ranked tradeable opportunities.
 * Each opportunity has: { conditionId, outcome, amount, reason, signalType, score, question }
 */
function evaluateSignals(signals, tradeFlows, markets) {
  const opportunities = [];

  // Build conditionId → market and question → market lookups
  const marketMap = new Map();
  const questionMap = new Map();
  for (const m of markets) {
    if (m.conditionId) marketMap.set(m.conditionId, m);
    if (m.question) questionMap.set(m.question, m);
  }

  // Helper: resolve market from flow (try conditionId first, then question text)
  function resolveMarket(flow) {
    if (flow.conditionId) {
      const m = marketMap.get(flow.conditionId);
      if (m) return m;
    }
    if (flow.q) return questionMap.get(flow.q) || null;
    return null;
  }

  // 1. Trade flow imbalance — strongest real-time signal
  for (const flow of tradeFlows) {
    if (flow.imbalance < 0.6 || flow.total < 2000) continue;

    const market = resolveMarket(flow);
    if (!market || market.liquidity < MIN_LIQUIDITY) continue;
    const condId = flow.conditionId || market.conditionId;
    if (!condId) continue;

    const outcome = flow.netFlow > 0 ? "yes" : "no";
    const dir = flow.netFlow > 0 ? "BUY" : "SELL";
    const amount = sizePosition(flow.score, "flow");

    if (amount < MIN_TRADE || !canTrade(amount)) continue;

    opportunities.push({
      conditionId: condId,
      outcome,
      amount,
      reason: `Flow signal: ${dir} bias ${(flow.imbalance * 100).toFixed(0)}%, $${flow.total.toFixed(0)} volume, ${flow.buys + flow.sells} trades`,
      signalType: "flow",
      score: flow.score * 2, // 2x weight for flow signals
      question: flow.q,
      liquidity: market.liquidity,
    });
  }

  // 2. Hourly momentum — price moved ≥1%
  for (const m of (signals.movers1h || [])) {
    if (!m.conditionId) continue;

    const market = marketMap.get(m.conditionId);
    if (!market || market.liquidity < MIN_LIQUIDITY) continue;

    // Skip extreme prices (>95% or <5%) unless catalyst
    if (m.price > 0.95 || m.price < 0.05) continue;

    const outcome = m.change1h > 0 ? "yes" : "no";
    const amount = sizePosition(Math.abs(m.change1h), "momentum");

    if (amount < MIN_TRADE || !canTrade(amount)) continue;

    opportunities.push({
      conditionId: m.conditionId,
      outcome,
      amount,
      reason: `Hourly momentum: ${m.dir}${(Math.abs(m.change1h) * 100).toFixed(1)}% in 1h, now ${(m.price * 100).toFixed(1)}%`,
      signalType: "momentum",
      score: m.score * 1.5,
      question: m.q,
      liquidity: market.liquidity,
    });
  }

  // 3. Wide spread — limit order at midpoint to capture spread
  for (const m of (signals.wideSpread || [])) {
    if (!m.conditionId) continue;

    const market = marketMap.get(m.conditionId);
    if (!market || market.liquidity < MIN_LIQUIDITY) continue;

    // Only trade spreads > 5% (more profitable)
    if (m.spread < 0.05) continue;

    const midpoint = (m.bid + m.ask) / 2;
    const amount = sizePosition(m.score, "spread");

    if (amount < MIN_TRADE || !canTrade(amount)) continue;

    opportunities.push({
      conditionId: m.conditionId,
      outcome: "yes",
      amount,
      limitPrice: midpoint,
      reason: `Wide spread: ${(m.spread * 100).toFixed(1)}% spread (bid ${(m.bid * 100).toFixed(1)}% / ask ${(m.ask * 100).toFixed(1)}%), limit @ ${(midpoint * 100).toFixed(1)}%`,
      signalType: "spread",
      score: m.score,
      question: m.q,
      liquidity: market.liquidity,
    });
  }

  // 4. Catalysts — expiring markets with strong directional signal
  for (const m of (signals.catalysts || [])) {
    if (!m.conditionId) continue;

    const market = marketMap.get(m.conditionId);
    if (!market || market.liquidity < MIN_LIQUIDITY) continue;

    // Only trade catalysts with clear direction (>70% or <30%)
    if (m.price >= 0.30 && m.price <= 0.70) continue;
    // Must be resolving within 48h
    if (m.hrsLeft > 48) continue;

    const outcome = m.price > 0.5 ? "yes" : "no";
    const amount = sizePosition(m.score, "catalyst");

    if (amount < MIN_TRADE || !canTrade(amount)) continue;

    opportunities.push({
      conditionId: m.conditionId,
      outcome,
      amount,
      reason: `Catalyst: ${m.hrsLeft.toFixed(0)}h to resolution, ${(m.price * 100).toFixed(1)}% YES, betting ${outcome.toUpperCase()}`,
      signalType: "catalyst",
      score: m.score * 0.8, // Lower weight — riskier
      question: m.q,
      liquidity: market.liquidity,
    });
  }

  // Sort by score descending
  opportunities.sort((a, b) => b.score - a.score);

  return opportunities;
}

// ── Dedup: avoid re-trading same market ──────────────────

const recentTrades = new Map(); // conditionId → timestamp
const TRADE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

function isRecentlyTraded(conditionId) {
  const ts = recentTrades.get(conditionId);
  if (!ts) return false;
  return (Date.now() - ts) < TRADE_COOLDOWN_MS;
}

function markTraded(conditionId) {
  recentTrades.set(conditionId, Date.now());
  // Prune old entries
  const cutoff = Date.now() - TRADE_COOLDOWN_MS;
  for (const [id, ts] of recentTrades) {
    if (ts < cutoff) recentTrades.delete(id);
  }
}

// ── Also skip markets we already hold ────────────────────

async function isAlreadyHeld(conditionId) {
  const { getPolyBets } = await state();
  const bets = getPolyBets({ conditionId, status: "open" });
  return bets.length > 0;
}

// ── Execute trade ────────────────────────────────────────

async function executeTrade(opp) {
  const { getMarket, placeBet, placeLimitBet } = await poly();
  const { addPolyBet, addJournalEntry, addNarrative } = await state();

  // Fetch fresh market data
  const market = await getMarket(opp.conditionId);

  if (market.closed || !market.acceptingOrders) {
    return { success: false, reason: "Market closed or not accepting orders" };
  }

  // Resolve tokenId
  const tokenIdx = opp.outcome === "yes" ? 0 : 1;
  const tokenId = market.clobTokenIds?.[tokenIdx];
  if (!tokenId) {
    return { success: false, reason: `No token ID for ${opp.outcome.toUpperCase()}` };
  }

  const entryPrice = opp.outcome === "yes" ? market.yesPrice : market.noPrice;
  const shares = entryPrice > 0 ? opp.amount / entryPrice : 0;

  let result;
  if (opp.limitPrice) {
    // Round limit price to tick size
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
    note: `[auto-trader] ${opp.reason}`,
    narratives: ["auto-trader"],
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

  addNarrative("auto-trader", opp.conditionId);

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
  };
}

// ── Main entry point (called by scanner each cycle) ──────

/**
 * Process scanner signals and execute trades.
 *
 * @param {Object} params
 * @param {Array}  params.markets    - Raw gamma markets with conditionId, liquidity, prices
 * @param {Object} params.signals    - From detectAlpha(): movers1h, wideSpread, catalysts, etc.
 * @param {Array}  params.tradeFlows - From analyzeTradeFlow(): flow imbalance data
 * @returns {Array} JSONL entries to append to scanner output
 */
export async function processSignals({ markets, signals, tradeFlows }) {
  const entries = [];
  _cycleTradeCount = 0;

  const daily = dailyTracker();

  // Check daily budget
  if (daily.amount >= MAX_PER_DAY) {
    entries.push({
      timestamp: new Date().toISOString(),
      type: "trade",
      message: `[auto-trader] Daily limit reached ($${daily.amount.toFixed(2)}/$${MAX_PER_DAY}). Standing by.`,
    });
    return entries;
  }

  // Evaluate and rank opportunities
  const opportunities = evaluateSignals(signals, tradeFlows, markets);

  if (opportunities.length === 0) {
    entries.push({
      timestamp: new Date().toISOString(),
      type: "trade",
      message: `[auto-trader] No tradeable signals this cycle. Daily: $${daily.amount.toFixed(2)}/$${MAX_PER_DAY}, ${daily.trades} trades.`,
    });
    return entries;
  }

  // Execute top opportunities (up to MAX_TRADES_PER_CYCLE)
  for (const opp of opportunities) {
    if (_cycleTradeCount >= MAX_TRADES_PER_CYCLE) break;
    if (!canTrade(opp.amount)) break;

    // Skip recently traded or already held markets
    if (isRecentlyTraded(opp.conditionId)) continue;
    if (await isAlreadyHeld(opp.conditionId)) continue;

    try {
      console.log(`[auto-trader] Executing: ${opp.signalType} — ${opp.question} — ${opp.outcome} $${opp.amount}`);
      const result = await executeTrade(opp);

      if (result.success) {
        recordTrade(opp.amount);
        markTraded(opp.conditionId);
        _cycleTradeCount++;

        entries.push({
          timestamp: new Date().toISOString(),
          type: "trade",
          message: `[auto-trader] EXECUTED: ${result.outcome} $${result.amount} on "${result.question.slice(0, 50)}" @ ${(result.entryPrice * 100).toFixed(1)}% | ${result.reason} | order=${result.orderId || "n/a"}`,
        });

        console.log(`[auto-trader] Trade executed: ${result.orderId} — ${result.outcome} $${result.amount} @ ${result.entryPrice}`);
      } else {
        entries.push({
          timestamp: new Date().toISOString(),
          type: "trade",
          message: `[auto-trader] SKIPPED: "${opp.question.slice(0, 50)}" — ${result.reason}`,
        });
        console.log(`[auto-trader] Trade skipped: ${result.reason}`);
      }
    } catch (err) {
      entries.push({
        timestamp: new Date().toISOString(),
        type: "trade",
        message: `[auto-trader] ERROR: "${opp.question.slice(0, 50)}" — ${err.message}`,
      });
      console.error(`[auto-trader] Trade error: ${err.message}`);
    }
  }

  // Summary
  const d = dailyTracker();
  entries.push({
    timestamp: new Date().toISOString(),
    type: "trade",
    message: `[auto-trader] Cycle done: ${_cycleTradeCount} trades executed. Daily: $${d.amount.toFixed(2)}/$${MAX_PER_DAY}, ${d.trades} total trades today.`,
  });

  return entries;
}

// ── Status ───────────────────────────────────────────────

export async function getAutoTraderStatus() {
  const d = dailyTracker();
  let openCount = 0;
  try {
    const { getPolyBets } = await state();
    openCount = getPolyBets({ status: "open" }).length;
  } catch { /* state not available yet */ }
  return {
    dailySpend: d.amount,
    dailyLimit: MAX_PER_DAY,
    dailyTrades: d.trades,
    openPositions: openCount,
    recentlyTraded: recentTrades.size,
  };
}
