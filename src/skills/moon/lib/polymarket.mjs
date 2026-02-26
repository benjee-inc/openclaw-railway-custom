// moon/lib/polymarket.mjs -- Polymarket CLOB SDK wrapper
// Markets on Polygon (chain 137). Bets in USDC. Order book via CLOB API.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { requireEnv } from "./helpers.mjs";
import { getStateDir } from "./state.mjs";
import {
  POLYMARKET_CLOB_HOST, POLYMARKET_GAMMA_API, POLYMARKET_CHAIN_ID,
} from "./constants.mjs";

// ─── Lazy Imports (globally installed) ──────────────────────────────────────

let _ethers = null;
async function getEthers() {
  if (!_ethers) _ethers = await import("ethers");
  return _ethers;
}

let _clobModule = null;
async function getClobModule() {
  if (!_clobModule) _clobModule = await import("@polymarket/clob-client");
  return _clobModule;
}

// ─── Client Singleton ───────────────────────────────────────────────────────

let _clientCache = null;

export async function getPolyClient() {
  if (_clientCache) return _clientCache;

  const pk = requireEnv("POLYMARKET_PRIVATE_KEY", "Set POLYMARKET_PRIVATE_KEY (hex, 0x prefix) for Polymarket trading.");
  const ethers = await getEthers();
  const wallet = new ethers.Wallet(pk);

  const { ClobClient } = await getClobModule();

  // Check for cached API creds
  const credsPath = join(getStateDir(), "polymarket-creds.json");
  let creds = null;
  try {
    creds = JSON.parse(readFileSync(credsPath, "utf-8"));
  } catch { /* no cached creds */ }

  if (!creds) {
    // Derive API creds from wallet signature (no creds needed for temp client)
    const tempClient = new ClobClient(POLYMARKET_CLOB_HOST, POLYMARKET_CHAIN_ID, wallet);
    creds = await tempClient.createOrDeriveApiKey();
    mkdirSync(getStateDir(), { recursive: true });
    writeFileSync(credsPath, JSON.stringify({ ...creds, derivedAt: Date.now() }, null, 2), "utf-8");
  }

  // signatureType 0 = EOA wallet
  const client = new ClobClient(POLYMARKET_CLOB_HOST, POLYMARKET_CHAIN_ID, wallet, creds, 0);
  _clientCache = { clobClient: client, wallet };
  return _clientCache;
}

// Reset cached client (on auth failure)
function resetClient() {
  _clientCache = null;
  const credsPath = join(getStateDir(), "polymarket-creds.json");
  try { unlinkSync(credsPath); } catch { /* ignore */ }
}

// Retry wrapper — re-derive creds on 401/403
async function withAuthRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    const status = err?.response?.status || err?.status;
    if (status === 401 || status === 403) {
      resetClient();
      await getPolyClient();
      return await fn();
    }
    throw err;
  }
}

// ─── Market Queries (Gamma API) ─────────────────────────────────────────────

export async function searchMarkets(query, limit = 20) {
  // Gamma API has no text search param — fetch events and filter client-side
  const url = `${POLYMARKET_GAMMA_API}/events?active=true&closed=false&limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma API error: ${res.status} ${res.statusText}`);
  const events = await res.json();

  const q = query.toLowerCase();
  const results = [];

  for (const event of events) {
    const titleMatch = event.title?.toLowerCase().includes(q);
    for (const market of (event.markets || [])) {
      if (titleMatch || market.question?.toLowerCase().includes(q)) {
        const tokenIds = typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : (market.clobTokenIds || []);
        results.push({
          conditionId: market.conditionId,
          question: market.question,
          eventTitle: event.title,
          yesPrice: market.outcomePrices ? parseFloat(JSON.parse(market.outcomePrices)[0]) : null,
          noPrice: market.outcomePrices ? parseFloat(JSON.parse(market.outcomePrices)[1]) : null,
          volume: parseFloat(market.volume || 0),
          liquidity: parseFloat(market.liquidityNum || 0),
          endDate: market.endDate,
          clobTokenIds: tokenIds,
          negRisk: event.negRisk || false,
          tickSize: parseFloat(market.minimumTickSize || "0.01"),
          active: market.active,
          closed: market.closed,
        });
      }
    }
  }

  // Sort by volume desc, take top N
  results.sort((a, b) => b.volume - a.volume);
  return results.slice(0, limit);
}

export async function getMarket(conditionId) {
  // Use CLOB API for reliable single-market lookup (Gamma's condition_id filter is unreliable)
  const url = `${POLYMARKET_CLOB_HOST}/markets/${conditionId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CLOB API error: ${res.status} ${res.statusText}`);
  const m = await res.json();
  if (!m || !m.condition_id) throw new Error(`Market not found: ${conditionId}`);

  const tokens = m.tokens || [];
  const yesToken = tokens.find(t => t.outcome === "Yes");
  const noToken = tokens.find(t => t.outcome === "No");

  return {
    conditionId: m.condition_id,
    question: m.question,
    description: m.description,
    yesPrice: yesToken?.price ?? null,
    noPrice: noToken?.price ?? null,
    volume: null, // CLOB endpoint doesn't include volume
    liquidity: null,
    endDate: m.end_date_iso,
    clobTokenIds: [yesToken?.token_id || null, noToken?.token_id || null],
    negRisk: m.neg_risk || false,
    tickSize: parseFloat(m.minimum_tick_size || "0.01"),
    active: m.active,
    closed: m.closed,
    acceptingOrders: m.accepting_orders,
    outcomes: tokens.map(t => t.outcome),
    tags: m.tags,
    rewards: m.rewards,
  };
}

// ─── Order Book ─────────────────────────────────────────────────────────────

export async function getOrderBook(tokenId) {
  const { clobClient } = await getPolyClient();
  const book = await clobClient.getOrderBook(tokenId);
  return {
    tokenId,
    bids: (book.bids || []).slice(0, 10).map(o => ({ price: o.price, size: o.size })),
    asks: (book.asks || []).slice(0, 10).map(o => ({ price: o.price, size: o.size })),
    bestBid: book.bids?.[0]?.price || null,
    bestAsk: book.asks?.[0]?.price || null,
    spread: (book.asks?.[0]?.price && book.bids?.[0]?.price)
      ? (parseFloat(book.asks[0].price) - parseFloat(book.bids[0].price)).toFixed(4)
      : null,
  };
}

// ─── Approvals ──────────────────────────────────────────────────────────────

let _approvalDone = false;

export async function ensureApprovals() {
  if (_approvalDone) return;
  const flagPath = join(getStateDir(), "polymarket-approved.flag");
  if (existsSync(flagPath)) { _approvalDone = true; return; }

  const { clobClient } = await getPolyClient();
  const { AssetType } = await getClobModule();

  // Approve USDC (collateral) + conditional tokens (needs MATIC for gas)
  await clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  await clobClient.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL });

  mkdirSync(getStateDir(), { recursive: true });
  writeFileSync(flagPath, new Date().toISOString(), "utf-8");
  _approvalDone = true;
}

// ─── Trading ────────────────────────────────────────────────────────────────

export async function placeBet(tokenId, side, amount, negRisk, tickSize) {
  await ensureApprovals();
  return withAuthRetry(async () => {
    const { clobClient } = await getPolyClient();
    const { Side, OrderType } = await getClobModule();

    const orderSide = side.toUpperCase() === "BUY" ? Side.BUY : Side.SELL;
    // Market orders use createAndPostMarketOrder (FOK = Fill-or-Kill)
    const resp = await clobClient.createAndPostMarketOrder(
      { tokenID: tokenId, amount, side: orderSide },
      { tickSize: String(tickSize), negRisk },
      OrderType.FOK,
    );
    return { success: true, orderId: resp?.orderID || null, status: resp?.status || null, ...resp };
  });
}

export async function placeLimitBet(tokenId, side, price, size, negRisk, tickSize) {
  await ensureApprovals();
  return withAuthRetry(async () => {
    const { clobClient } = await getPolyClient();
    const { Side, OrderType } = await getClobModule();

    const orderSide = side.toUpperCase() === "BUY" ? Side.BUY : Side.SELL;
    // Limit orders use createAndPostOrder with GTC (Good-Til-Cancelled)
    const resp = await clobClient.createAndPostOrder(
      { tokenID: tokenId, price, size, side: orderSide },
      { tickSize: String(tickSize), negRisk },
      OrderType.GTC,
    );
    return { success: true, orderId: resp?.orderID || null, status: resp?.status || null, ...resp };
  });
}

// ─── Order Management ───────────────────────────────────────────────────────

export async function getPolyOpenOrders() {
  return withAuthRetry(async () => {
    const { clobClient } = await getPolyClient();
    return await clobClient.getOpenOrders();
  });
}

export async function cancelOrder(orderId) {
  return withAuthRetry(async () => {
    const { clobClient } = await getPolyClient();
    return await clobClient.cancelOrder({ id: orderId });
  });
}

export async function cancelAllOrders() {
  return withAuthRetry(async () => {
    const { clobClient } = await getPolyClient();
    return await clobClient.cancelAll();
  });
}

// ─── Trade History & Positions ──────────────────────────────────────────────

export async function getPolyTrades(limit = 20) {
  return withAuthRetry(async () => {
    const { clobClient } = await getPolyClient();
    const trades = await clobClient.getTrades();
    return (trades || []).slice(0, limit);
  });
}

export async function getPolyPositions() {
  return withAuthRetry(async () => {
    const { clobClient } = await getPolyClient();
    const { AssetType } = await getClobModule();
    const collateral = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return { collateral };
  });
}
