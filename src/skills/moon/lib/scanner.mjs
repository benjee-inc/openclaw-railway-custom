// moon/lib/scanner.mjs -- Token discovery + scoring engine

import { getSolConnection, getSolNewPools } from "./solana.mjs";
import { getTokenHolders, getEnhancedTransactions } from "./helius.mjs";
import { getQuote, getTokenSafety } from "./jupiter.mjs";
import { WSOL } from "./constants.mjs";
import { requireEnv } from "./helpers.mjs";

// ─── Scoring Weights ────────────────────────────────────────────────────────

const WEIGHTS = {
  liquidity: 0.25,
  volume: 0.20,
  holders: 0.20,
  safety: 0.20,
  age: 0.15,
};

// ─── Individual Scorers ─────────────────────────────────────────────────────

function scoreLiquidity(priceImpactPct) {
  // 0% impact → 1.0, >5% impact → 0.0
  if (priceImpactPct == null) return 0;
  const impact = Math.abs(Number(priceImpactPct));
  return Math.max(0, Math.min(1, 1 - impact / 5));
}

function scoreVolume(txCount24h) {
  // 0 txs → 0.0, 20+ txs → 1.0
  return Math.max(0, Math.min(1, txCount24h / 20));
}

function scoreHolders(holderCount) {
  // log10(count)/3: 1 holder → 0.0, 1000+ holders → 1.0
  if (holderCount <= 1) return 0;
  return Math.max(0, Math.min(1, Math.log10(holderCount) / 3));
}

function scoreSafety(riskCount) {
  // 0 risks → 1.0, 5+ risks → 0.0
  return Math.max(0, Math.min(1, 1 - riskCount / 5));
}

function scoreAge(createdAtUnix) {
  // exp(-seconds/86400): just created → 1.0, >24h old → ~0.0
  if (!createdAtUnix) return 0.5; // unknown age → neutral
  const ageSeconds = Math.max(0, (Date.now() / 1000) - createdAtUnix);
  return Math.exp(-ageSeconds / 86400);
}

function computeScore(metrics) {
  return (
    WEIGHTS.liquidity * metrics.liquidityScore +
    WEIGHTS.volume * metrics.volumeScore +
    WEIGHTS.holders * metrics.holdersScore +
    WEIGHTS.safety * metrics.safetyScore +
    WEIGHTS.age * metrics.ageScore
  );
}

// ─── Token Analysis ─────────────────────────────────────────────────────────

async function analyzeToken(mint, createdAt) {
  const metrics = {
    mint,
    liquidityScore: 0,
    volumeScore: 0,
    holdersScore: 0,
    safetyScore: 0,
    ageScore: scoreAge(createdAt),
    holderCount: 0,
    txCount24h: 0,
    riskCount: 0,
    priceImpactPct: null,
    topHolderPct: 100,
    hasCriticalRisk: false,
    quotable: false,
  };

  // Run all data fetches in parallel
  const [holdersResult, safetyResult, quoteResult, txResult] = await Promise.allSettled([
    getTokenHolders(mint, 20),
    getTokenSafety(mint).catch(() => null),
    getQuote(WSOL, mint, 10_000_000, 100).catch(() => null), // 0.01 SOL test quote
    getEnhancedTransactions(mint, 50).catch(() => []),
  ]);

  // Holders
  if (holdersResult.status === "fulfilled" && holdersResult.value) {
    const h = holdersResult.value;
    metrics.holderCount = h.totalAccounts || 0;
    metrics.holdersScore = scoreHolders(metrics.holderCount);
    metrics.topHolderPct = h.top10ConcentrationPct || 100;
  }

  // Safety
  if (safetyResult.status === "fulfilled" && safetyResult.value) {
    const s = safetyResult.value;
    metrics.riskCount = s.riskCount + s.warningCount;
    metrics.safetyScore = scoreSafety(s.riskCount);
    metrics.hasCriticalRisk = s.riskCount > 0;
  }

  // Quote / liquidity
  if (quoteResult.status === "fulfilled" && quoteResult.value) {
    const q = quoteResult.value;
    metrics.priceImpactPct = Number(q.priceImpactPct || 0);
    metrics.liquidityScore = scoreLiquidity(metrics.priceImpactPct);
    metrics.quotable = true;
  }

  // Volume (tx count in last 24h)
  if (txResult.status === "fulfilled" && Array.isArray(txResult.value)) {
    const now = Date.now() / 1000;
    const recent = txResult.value.filter(tx => tx.timestamp && (now - tx.timestamp) < 86400);
    metrics.txCount24h = recent.length;
    metrics.volumeScore = scoreVolume(metrics.txCount24h);
  }

  metrics.score = computeScore(metrics);
  return metrics;
}

// ─── Filters ────────────────────────────────────────────────────────────────

function passesFilters(metrics) {
  if (metrics.holderCount < 10) return false;
  if (metrics.topHolderPct > 50) return false;
  if (metrics.hasCriticalRisk) return false;
  if (!metrics.quotable) return false;
  return true;
}

// ─── Extract Mints from Recent Pool Signatures ──────────────────────────────

async function extractMintsFromSignatures(conn, sigs, limit) {
  // Parse transactions to find token mints
  const mints = new Map(); // mint → { createdAt, dex, signature }

  // Fetch transaction details in batches of 5
  const batchSize = 5;
  for (let i = 0; i < sigs.length && mints.size < limit; i += batchSize) {
    const batch = sigs.slice(i, i + batchSize);
    const txPromises = batch.map(async (sig) => {
      try {
        const tx = await conn.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx || !tx.meta) return null;

        // Look for token mints in the transaction's token balances
        const postBalances = tx.meta.postTokenBalances || [];
        const tokenMints = new Set();
        for (const bal of postBalances) {
          if (bal.mint && bal.mint !== "So11111111111111111111111111111111111111112") {
            tokenMints.add(bal.mint);
          }
        }

        return {
          mints: [...tokenMints],
          blockTime: tx.blockTime || sig.blockTime,
          dex: sig.dex,
          signature: sig.signature,
        };
      } catch {
        return null;
      }
    });

    const results = await Promise.all(txPromises);
    for (const r of results) {
      if (!r) continue;
      for (const mint of r.mints) {
        if (!mints.has(mint)) {
          mints.set(mint, {
            createdAt: r.blockTime,
            dex: r.dex,
            signature: r.signature,
          });
        }
      }
    }
  }

  return mints;
}

// ─── Main Scanner ───────────────────────────────────────────────────────────

export async function scanNewTokens(limit = 10) {
  requireEnv("HELIUS_API_KEY", "Required for scan command (holders + tx history).");

  const conn = getSolConnection();

  // Step 1: Discover recent pool creations (over-discover 3x)
  const discoveryLimit = limit * 3;
  const recentSigs = await getSolNewPools(conn, discoveryLimit);

  if (recentSigs.length === 0) {
    return { tokens: [], message: "No recent pool creations found" };
  }

  // Step 2: Extract token mints from pool creation transactions
  const mintMap = await extractMintsFromSignatures(conn, recentSigs, discoveryLimit);

  if (mintMap.size === 0) {
    return { tokens: [], message: "Could not extract token mints from recent transactions" };
  }

  // Step 3: Analyze tokens in batches of 5
  const analyzed = [];
  const entries = [...mintMap.entries()];
  const analysisBatchSize = 5;

  for (let i = 0; i < entries.length && analyzed.length < limit * 2; i += analysisBatchSize) {
    const batch = entries.slice(i, i + analysisBatchSize);
    const results = await Promise.allSettled(
      batch.map(([mint, info]) => analyzeToken(mint, info.createdAt))
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === "fulfilled") {
        const metrics = results[j].value;
        metrics.discoveryDex = batch[j][1].dex;
        metrics.discoverySignature = batch[j][1].signature;
        analyzed.push(metrics);
      }
    }
  }

  // Step 4: Filter
  const filtered = analyzed.filter(passesFilters);

  // Step 5: Rank by score descending
  filtered.sort((a, b) => b.score - a.score);

  // Return top N
  const tokens = filtered.slice(0, limit).map((t, i) => ({
    rank: i + 1,
    mint: t.mint,
    score: Math.round(t.score * 1000) / 1000,
    breakdown: {
      liquidity: Math.round(t.liquidityScore * 100) / 100,
      volume: Math.round(t.volumeScore * 100) / 100,
      holders: Math.round(t.holdersScore * 100) / 100,
      safety: Math.round(t.safetyScore * 100) / 100,
      age: Math.round(t.ageScore * 100) / 100,
    },
    holderCount: t.holderCount,
    txCount24h: t.txCount24h,
    riskCount: t.riskCount,
    priceImpactPct: t.priceImpactPct,
    topHolderPct: t.topHolderPct,
    discoveryDex: t.discoveryDex,
  }));

  return {
    tokens,
    totalDiscovered: mintMap.size,
    totalAnalyzed: analyzed.length,
    totalPassedFilters: filtered.length,
    returned: tokens.length,
    weights: WEIGHTS,
    filters: {
      minHolders: 10,
      maxTopHolderPct: 50,
      noCriticalRisks: true,
      mustBeQuotable: true,
    },
  };
}
