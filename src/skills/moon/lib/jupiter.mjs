// moon/lib/jupiter.mjs -- Quotes, token search, Shield safety
// Uses lite-api.jup.ag (free) with fallback to api.jup.ag (requires JUPITER_API_KEY)

import { WSOL } from "./constants.mjs";
import { jupiterHeaders } from "./helpers.mjs";

// lite-api.jup.ag: free, has /swap/v1/quote and /tokens/v2/search
// api.jup.ag: requires API key, has all endpoints
const LITE_API = "https://lite-api.jup.ag";
const PAID_API = "https://api.jup.ag";

function getQuoteBase() {
  return process.env.JUPITER_API_KEY ? PAID_API : LITE_API;
}

function getSearchBase() {
  return process.env.JUPITER_API_KEY ? PAID_API : LITE_API;
}

// ─── getQuote ───────────────────────────────────────────────────────────────

export async function getQuote(inputMint, outputMint, amountRaw, slippageBps = 50) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountRaw),
    slippageBps: String(slippageBps),
  });

  const url = `${getQuoteBase()}/swap/v1/quote?${params}`;
  const res = await fetch(url, { headers: jupiterHeaders() });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter quote error (${res.status}): ${body}`);
  }

  const data = await res.json();

  return {
    inputMint: data.inputMint,
    outputMint: data.outputMint,
    inAmount: data.inAmount,
    outAmount: data.outAmount,
    otherAmountThreshold: data.otherAmountThreshold,
    priceImpactPct: data.priceImpactPct,
    slippageBps: data.slippageBps,
    swapUsdValue: data.swapUsdValue || null,
    routePlan: (data.routePlan || []).map(r => ({
      swapInfo: {
        ammKey: r.swapInfo?.ammKey,
        label: r.swapInfo?.label,
        inputMint: r.swapInfo?.inputMint,
        outputMint: r.swapInfo?.outputMint,
        inAmount: r.swapInfo?.inAmount,
        outAmount: r.swapInfo?.outAmount,
        feeAmount: r.swapInfo?.feeAmount,
        feeMint: r.swapInfo?.feeMint,
      },
      percent: r.percent,
    })),
  };
}

// ─── searchTokens ───────────────────────────────────────────────────────────

export async function searchTokens(query) {
  const url = `${getSearchBase()}/tokens/v2/search?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: jupiterHeaders() });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter search error (${res.status}): ${body}`);
  }

  const tokens = await res.json();
  if (!Array.isArray(tokens)) return [];

  return tokens.slice(0, 20).map(t => ({
    address: t.id || t.address,
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    icon: t.icon || t.logoURI || null,
    usdPrice: t.usdPrice ?? null,
    mcap: t.mcap ?? null,
    fdv: t.fdv ?? null,
    liquidity: t.liquidity ?? null,
    holderCount: t.holderCount ?? null,
    isVerified: t.isVerified ?? null,
    tags: t.tags || [],
    audit: t.audit || null,
    organicScore: t.organicScore ?? null,
    organicScoreLabel: t.organicScoreLabel ?? null,
  }));
}

// ─── getTokenSafety ─────────────────────────────────────────────────────────

export async function getTokenSafety(mint) {
  // Use token search to get audit data (works without API key)
  const tokens = await searchTokens(mint);
  const token = tokens.find(t => t.address === mint);

  const risks = [];
  const warnings = [];

  if (token?.audit) {
    const a = token.audit;
    if (!a.mintAuthorityDisabled) risks.push({ name: "mint_authority_active", level: "critical", description: "Mint authority is still active — supply can be inflated" });
    if (!a.freezeAuthorityDisabled) risks.push({ name: "freeze_authority_active", level: "critical", description: "Freeze authority is active — tokens can be frozen" });
    if (a.topHoldersPercentage > 50) risks.push({ name: "high_concentration", level: "critical", description: `Top holders own ${a.topHoldersPercentage.toFixed(1)}% of supply` });
    else if (a.topHoldersPercentage > 30) warnings.push({ name: "moderate_concentration", level: "warning", description: `Top holders own ${a.topHoldersPercentage.toFixed(1)}% of supply` });
    if (a.devBalancePercentage > 5) warnings.push({ name: "high_dev_balance", level: "warning", description: `Dev holds ${a.devBalancePercentage.toFixed(2)}% of supply` });
    if (a.devMints > 10) warnings.push({ name: "many_dev_mints", level: "warning", description: `Dev made ${a.devMints} mint transactions` });
  }

  if (!token?.isVerified) warnings.push({ name: "unverified", level: "warning", description: "Token is not verified on Jupiter" });
  if (token?.organicScoreLabel === "low") warnings.push({ name: "low_organic_score", level: "warning", description: `Low organic score (${token.organicScore?.toFixed(1)})` });

  return {
    mint,
    safe: risks.length === 0,
    riskCount: risks.length,
    warningCount: warnings.length,
    risks,
    warnings,
    token: token || null,
  };
}

// ─── getJupiterPrice ────────────────────────────────────────────────────────

export async function getJupiterPrice(mint) {
  // Use token search which includes usdPrice
  try {
    const tokens = await searchTokens(mint);
    const token = tokens.find(t => t.address === mint);
    if (token?.usdPrice) {
      return {
        mint,
        priceUsd: token.usdPrice,
        mcap: token.mcap,
        liquidity: token.liquidity,
        source: "jupiter",
      };
    }
  } catch { /* fallback below */ }

  return null;
}
