// moon/lib/calc.mjs -- Position sizing, Kelly criterion, goal calculator
// Pure functions, no side effects, no imports from other lib modules.

// ─── Target Position Calculator ─────────────────────────────────────────────

/**
 * "I want $targetUsd — how many tokens at this price?"
 */
export function calcTargetPosition(currentPrice, totalSupply, targetUsd) {
  if (!currentPrice || currentPrice <= 0) return { error: "Invalid price" };
  const tokensNeeded = targetUsd / currentPrice;
  const costAtCurrentPrice = tokensNeeded * currentPrice;
  const pctOfSupply = totalSupply > 0 ? (tokensNeeded / totalSupply) * 100 : null;
  const currentMcap = totalSupply > 0 ? currentPrice * totalSupply : null;
  return { tokensNeeded, costAtCurrentPrice, pctOfSupply, currentMcap, targetUsd, currentPrice };
}

// ─── Required Mcap Calculator ───────────────────────────────────────────────

/**
 * "I hold X tokens — what mcap makes them worth $targetUsd?"
 */
export function calcRequiredMcap(tokensHeld, totalSupply, targetUsd) {
  if (!tokensHeld || tokensHeld <= 0) return { error: "Invalid token amount" };
  if (!totalSupply || totalSupply <= 0) return { error: "Invalid supply" };
  const requiredPrice = targetUsd / tokensHeld;
  const requiredMcap = requiredPrice * totalSupply;
  const currentPriceIfKnown = null; // caller can augment
  const multiplierNeeded = null;    // caller can augment with current mcap
  return { requiredMcap, requiredPrice, tokensHeld, totalSupply, targetUsd, multiplierNeeded };
}

/**
 * With current mcap known, compute multiplier needed
 */
export function calcRequiredMcapWithCurrent(tokensHeld, totalSupply, targetUsd, currentMcap) {
  const base = calcRequiredMcap(tokensHeld, totalSupply, targetUsd);
  if (base.error) return base;
  const multiplierNeeded = currentMcap > 0 ? base.requiredMcap / currentMcap : null;
  return { ...base, currentMcap, multiplierNeeded };
}

// ─── Position Size Calculator ───────────────────────────────────────────────

/**
 * Standard risk-based position sizing.
 * With stop-loss: positionSize = riskAmount / (1 - stopLossPrice/entryPrice)
 */
export function calcPositionSize(portfolioValue, riskPct, entryPrice, stopLossPrice) {
  if (!portfolioValue || portfolioValue <= 0) return { error: "Invalid portfolio value" };
  if (!riskPct || riskPct <= 0) return { error: "Invalid risk %" };
  if (!entryPrice || entryPrice <= 0) return { error: "Invalid entry price" };

  const riskAmount = portfolioValue * (riskPct / 100);

  let positionSize, tokensToBuy;

  if (stopLossPrice && stopLossPrice > 0 && stopLossPrice < entryPrice) {
    // Risk per token = entry - stop
    const riskPerToken = entryPrice - stopLossPrice;
    tokensToBuy = riskAmount / riskPerToken;
    positionSize = tokensToBuy * entryPrice;
  } else {
    // Without stop-loss, position size = risk amount (full loss assumed)
    positionSize = riskAmount;
    tokensToBuy = riskAmount / entryPrice;
  }

  const pctOfPortfolio = (positionSize / portfolioValue) * 100;

  return { positionSize, tokensToBuy, riskAmount, riskPct, pctOfPortfolio, entryPrice, stopLossPrice: stopLossPrice || null };
}

// ─── Kelly Criterion ────────────────────────────────────────────────────────

/**
 * Kelly% = W - [(1-W) / R]
 * W = win rate, R = avg win / avg loss ratio
 * Capped at 25%. Recommends half-Kelly.
 */
export function calcKellyCriterion(winRate, avgWin, avgLoss) {
  if (avgLoss === 0) return { kellyPct: 0, halfKellyPct: 0, recommendation: "No losses recorded — insufficient data" };
  if (winRate <= 0) return { kellyPct: 0, halfKellyPct: 0, recommendation: "No wins — do not trade this strategy" };

  const R = Math.abs(avgWin) / Math.abs(avgLoss);
  let kellyPct = (winRate - (1 - winRate) / R) * 100;

  // Cap at 25%
  kellyPct = Math.min(kellyPct, 25);

  const halfKellyPct = Math.max(kellyPct / 2, 0);

  let recommendation;
  if (kellyPct <= 0) recommendation = "Negative edge — do not trade this strategy";
  else if (halfKellyPct < 1) recommendation = "Very small edge — trade minimum size";
  else if (halfKellyPct < 5) recommendation = `Size positions at ${halfKellyPct.toFixed(1)}% of portfolio (half-Kelly)`;
  else recommendation = `Size positions at ${halfKellyPct.toFixed(1)}% of portfolio (half-Kelly, capped)`;

  return { kellyPct: Math.max(kellyPct, 0), halfKellyPct, winLossRatio: R, recommendation };
}

// ─── Goal Progress ──────────────────────────────────────────────────────────

/**
 * Per-position: what multiplier needed to hit goal from that position alone.
 */
export function calcGoalProgress(positions, targetUsd) {
  if (!positions || positions.length === 0) {
    return { currentValue: 0, progressPct: 0, remainingUsd: targetUsd, targetUsd, pathToGoal: [] };
  }

  let currentValue = 0;
  const pathToGoal = [];

  for (const pos of positions) {
    const value = (pos.tokenAmount || 0) * (pos.currentPrice || pos.price || 0);
    currentValue += value;
    const multiplierNeeded = value > 0 ? targetUsd / value : Infinity;
    pathToGoal.push({
      symbol: pos.symbol || pos.mint,
      mint: pos.mint,
      currentValue: value,
      multiplierNeeded: multiplierNeeded === Infinity ? "N/A" : multiplierNeeded,
      pctOfGoal: (value / targetUsd) * 100,
    });
  }

  return {
    currentValue,
    progressPct: (currentValue / targetUsd) * 100,
    remainingUsd: targetUsd - currentValue,
    targetUsd,
    pathToGoal: pathToGoal.sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0)),
  };
}

// ─── Journal Analysis ───────────────────────────────────────────────────────

/**
 * Comprehensive analysis of closed journal entries.
 */
export function analyzeJournal(entries) {
  const closed = entries.filter(e => e.status === "closed" && e.pnlPct != null);

  if (closed.length === 0) {
    return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgPnlPct: 0, message: "No closed trades to analyze" };
  }

  const wins = closed.filter(e => e.pnlPct > 0);
  const losses = closed.filter(e => e.pnlPct <= 0);
  const winRate = wins.length / closed.length;

  const avgWinPct = wins.length > 0 ? wins.reduce((s, e) => s + e.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, e) => s + Math.abs(e.pnlPct), 0) / losses.length : 0;

  const totalPnl = closed.reduce((s, e) => s + (e.pnl || 0), 0);
  const totalPnlPct = closed.reduce((s, e) => s + (e.pnlPct || 0), 0);
  const avgPnlPct = totalPnlPct / closed.length;

  const grossProfit = wins.reduce((s, e) => s + (e.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, e) => s + (e.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const sorted = [...closed].sort((a, b) => (b.pnlPct || 0) - (a.pnlPct || 0));
  const bestTrade = sorted[0] || null;
  const worstTrade = sorted[sorted.length - 1] || null;

  // Kelly from actual results
  const kelly = calcKellyCriterion(winRate, avgWinPct, avgLossPct);

  // By narrative
  const byNarrative = {};
  for (const e of closed) {
    for (const n of (e.narratives || [])) {
      if (!byNarrative[n]) byNarrative[n] = { trades: 0, wins: 0, totalPnlPct: 0 };
      byNarrative[n].trades++;
      if (e.pnlPct > 0) byNarrative[n].wins++;
      byNarrative[n].totalPnlPct += e.pnlPct || 0;
    }
  }
  for (const n of Object.keys(byNarrative)) {
    byNarrative[n].winRate = byNarrative[n].wins / byNarrative[n].trades;
    byNarrative[n].avgPnlPct = byNarrative[n].totalPnlPct / byNarrative[n].trades;
  }

  // By chain
  const byChain = {};
  for (const e of closed) {
    const c = e.chain || "unknown";
    if (!byChain[c]) byChain[c] = { trades: 0, wins: 0, totalPnl: 0 };
    byChain[c].trades++;
    if (e.pnlPct > 0) byChain[c].wins++;
    byChain[c].totalPnl += e.pnl || 0;
  }

  // Streaks
  let currentStreak = 0, bestWinStreak = 0, worstLoseStreak = 0, tempStreak = 0;
  for (const e of closed) {
    if (e.pnlPct > 0) {
      tempStreak = tempStreak > 0 ? tempStreak + 1 : 1;
      bestWinStreak = Math.max(bestWinStreak, tempStreak);
    } else {
      tempStreak = tempStreak < 0 ? tempStreak - 1 : -1;
      worstLoseStreak = Math.max(worstLoseStreak, Math.abs(tempStreak));
    }
    currentStreak = tempStreak;
  }

  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgPnlPct,
    totalPnl,
    profitFactor,
    bestTrade: bestTrade ? { id: bestTrade.id, symbol: bestTrade.symbol, pnlPct: bestTrade.pnlPct, pnl: bestTrade.pnl } : null,
    worstTrade: worstTrade ? { id: worstTrade.id, symbol: worstTrade.symbol, pnlPct: worstTrade.pnlPct, pnl: worstTrade.pnl } : null,
    kellyPct: kelly.kellyPct,
    halfKellyPct: kelly.halfKellyPct,
    kellyRecommendation: kelly.recommendation,
    byNarrative,
    byChain,
    streaks: { current: currentStreak, bestWin: bestWinStreak, worstLose: worstLoseStreak },
  };
}
