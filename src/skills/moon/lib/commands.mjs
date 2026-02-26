// moon/lib/commands.mjs -- All 28 command handlers (V3: autonomous trading intelligence)

import { PublicKey } from "@solana/web3.js";
import { out, parseFlag, hasFlag, normalizeChain } from "./helpers.mjs";
import { RAYDIUM_V4, PUMP_SWAP, METEORA_DLMM, METEORA_CPAMM, WSOL, SOL_USDC } from "./constants.mjs";

// Base
import { getBaseClient, getBaseTokenMeta, getBasePairInfo, getBaseNewPairs, searchBasePools } from "./base.mjs";

// Solana
import {
  getSolConnection, detectSolanaDex,
  getRaydiumPoolInfo, getPumpCurveInfo, getPumpSwapPoolInfo,
  getMeteoraDlmmInfo, getMeteoraCpInfo,
  searchSolPools, getSolNewPools,
} from "./solana.mjs";

// Helius
import { getAsset, getTokenHolders, getEnhancedTransactions } from "./helius.mjs";

// Jupiter
import { getQuote, searchTokens, getTokenSafety, getJupiterPrice } from "./jupiter.mjs";

// Direct Jupiter Swaps (self-custody)
import { executeSwap, getWalletInfo, getPositions, getTokenBalance, solToLamports, tokensToRaw } from "./swap.mjs";

// Base swaps (self-custody via Uniswap V2)
import { executeBaseSwap, getBaseWalletInfo, getBasePositions, getBaseTokenBalance, ethToWei, tokensToRawBase } from "./swap-base.mjs";

// Scanner
import { scanNewTokens } from "./scanner.mjs";

// State & Calc (V3)
import {
  loadState, saveState, addJournalEntry, updateJournalEntry,
  getOpenPositions, getJournal, addWatchlistItem, removeWatchlistItem,
  getWatchlist, addNarrative, getNarratives, addScanRecord,
  getConfig, updateConfig,
  addPolyBet, getPolyBets, updatePolyBet,
} from "./state.mjs";

// Polymarket
import {
  searchMarkets, getMarket, getOrderBook,
  placeBet, placeLimitBet,
  getPolyOpenOrders, cancelOrder, cancelAllOrders,
  getPolyTrades, getPolyPositions,
} from "./polymarket.mjs";

import {
  calcTargetPosition, calcRequiredMcap, calcRequiredMcapWithCurrent,
  calcPositionSize, calcKellyCriterion, calcGoalProgress, analyzeJournal,
} from "./calc.mjs";

// ─── Research Commands ──────────────────────────────────────────────────────

export async function cmdPool(args) {
  const chain = normalizeChain(args[0]);
  const addr = args[1];
  if (!chain || !addr) {
    console.error("Usage: moon pool <chain> <address>");
    process.exit(1);
  }

  if (chain === "base") {
    const client = getBaseClient();
    const info = await getBasePairInfo(client, addr);
    out(info);
  } else {
    const conn = getSolConnection();
    const pubkey = new PublicKey(addr);
    const acct = await conn.getAccountInfo(pubkey);
    if (!acct) {
      out({ error: true, message: `Account not found: ${addr}` });
      process.exit(1);
    }

    const owner = acct.owner.toBase58();

    if (owner === RAYDIUM_V4) out(await getRaydiumPoolInfo(conn, addr));
    else if (owner === PUMP_SWAP) out(await getPumpSwapPoolInfo(conn, addr));
    else if (owner === METEORA_DLMM) out(await getMeteoraDlmmInfo(conn, addr));
    else if (owner === METEORA_CPAMM) out(await getMeteoraCpInfo(conn, addr));
    else {
      out({ error: true, message: `Unknown program owner: ${owner}. Expected Raydium, PumpSwap, or Meteora.` });
      process.exit(1);
    }
  }
}

export async function cmdPump(args) {
  const mintAddr = args[0];
  if (!mintAddr) {
    console.error("Usage: moon pump <mintAddress>");
    process.exit(1);
  }
  const conn = getSolConnection();
  out(await getPumpCurveInfo(conn, mintAddr));
}

export async function cmdNew(args) {
  const chain = normalizeChain(args[0]);
  if (!chain) {
    console.error("Usage: moon new <chain> [--limit N] [--dex NAME]");
    process.exit(1);
  }

  const limit = parseInt(parseFlag(args, "--limit", "10"), 10);
  const dexFilter = parseFlag(args, "--dex", null)?.toLowerCase() || null;

  if (chain === "base") {
    const client = getBaseClient();
    const pairs = await getBaseNewPairs(client, limit, dexFilter);
    out({ chain: "base", count: pairs.length, pairs });
  } else {
    const conn = getSolConnection();
    const pools = await getSolNewPools(conn, limit);
    out({ chain: "solana", count: pools.length, pools });
  }
}

export async function cmdPrice(args) {
  const chain = normalizeChain(args[0]);
  const tokenAddr = args[1];
  if (!chain || !tokenAddr) {
    console.error("Usage: moon price <chain> <tokenAddress>");
    process.exit(1);
  }

  if (chain === "base") {
    const client = getBaseClient();
    const pools = await searchBasePools(client, tokenAddr);
    if (pools.length === 0) {
      out({ chain: "base", token: tokenAddr, error: "No pools found" });
      return;
    }
    const info = await getBasePairInfo(client, pools[0].pair);
    const tokenMeta = await getBaseTokenMeta(client, tokenAddr);
    out({
      chain: "base", token: tokenMeta, dex: info.dex, pool: pools[0].pair,
      price: info.price, reserves: info.reserves, poolsFound: pools.length,
    });
  } else {
    const conn = getSolConnection();

    // Check Pump.fun bonding curve first
    try {
      const pumpInfo = await getPumpCurveInfo(conn, tokenAddr);
      if (!pumpInfo.complete) {
        out({
          chain: "solana", token: tokenAddr, dex: "Pump.fun",
          priceInSol: pumpInfo.priceInSol, bondingCurve: pumpInfo.bondingCurve,
          completionPct: pumpInfo.completionPct, complete: false,
          note: "Token is still on the bonding curve",
        });
        return;
      }
    } catch { /* not a pump token or graduated */ }

    // Search across DEXes
    const pools = await searchSolPools(conn, tokenAddr);

    // Try Jupiter price API as fast fallback
    const jupPrice = await getJupiterPrice(tokenAddr);

    if (pools.length === 0 && !jupPrice) {
      out({ chain: "solana", token: tokenAddr, error: "No pools found" });
      return;
    }

    if (pools.length === 0 && jupPrice) {
      out({ chain: "solana", token: tokenAddr, ...jupPrice, poolsFound: 0 });
      return;
    }

    // Sample pools for best liquidity
    const nonPump = pools.filter(p => p.dex !== "Pump.fun");
    const byDex = {};
    for (const p of nonPump) {
      if (!byDex[p.dex]) byDex[p.dex] = [];
      if (byDex[p.dex].length < 2) byDex[p.dex].push(p);
    }
    const candidates = Object.values(byDex).flat().slice(0, 6);

    if (candidates.length === 0) {
      const pumpInfo = await getPumpCurveInfo(conn, tokenAddr);
      out({ chain: "solana", token: tokenAddr, ...pumpInfo, poolsFound: pools.length });
      return;
    }

    async function getPoolInfo(pool) {
      try {
        if (pool.dex === "Raydium AMM v4") return await getRaydiumPoolInfo(conn, pool.pool);
        if (pool.dex === "PumpSwap") return await getPumpSwapPoolInfo(conn, pool.pool);
        if (pool.dex === "Meteora DLMM") return await getMeteoraDlmmInfo(conn, pool.pool);
        if (pool.dex === "Meteora CP-AMM") return await getMeteoraCpInfo(conn, pool.pool);
      } catch { return null; }
      return null;
    }

    function getTotalReserve(info) {
      if (!info || !info.reserves) return 0;
      const vals = Object.values(info.reserves).filter(v => typeof v === "number");
      return vals.reduce((a, b) => a + b, 0);
    }

    const infos = await Promise.all(candidates.map(async (pool) => {
      const info = await getPoolInfo(pool);
      return { pool, info, liquidity: getTotalReserve(info) };
    }));

    const best = infos.filter(i => i.info).sort((a, b) => b.liquidity - a.liquidity)[0];
    if (!best) {
      if (jupPrice) {
        out({ chain: "solana", token: tokenAddr, ...jupPrice, poolsFound: pools.length });
      } else {
        out({ chain: "solana", token: tokenAddr, error: "Could not fetch pool info from any pool" });
      }
      return;
    }

    const result = {
      chain: "solana", token: tokenAddr, dex: best.info.dex, pool: best.pool.pool,
      price: best.info.price, reserves: best.info.reserves, poolsFound: pools.length,
    };

    // Augment with Jupiter USD price if available
    if (jupPrice?.priceUsd) result.priceUsd = jupPrice.priceUsd;

    out(result);
  }
}

export async function cmdSearch(args) {
  const chain = normalizeChain(args[0]);
  const tokenAddr = args[1];
  if (!chain || !tokenAddr) {
    console.error("Usage: moon search <chain> <tokenAddress>");
    process.exit(1);
  }

  if (chain === "base") {
    const client = getBaseClient();
    const pools = await searchBasePools(client, tokenAddr);
    out({ chain: "base", token: tokenAddr, count: pools.length, pools });
  } else {
    const conn = getSolConnection();
    const pools = await searchSolPools(conn, tokenAddr);
    out({ chain: "solana", token: tokenAddr, count: pools.length, pools });
  }
}

// ─── Jupiter Commands ───────────────────────────────────────────────────────

export async function cmdQuote(args) {
  const chain = normalizeChain(args[0]);
  if (chain !== "sol") {
    console.error("Usage: moon quote sol <inputMint> <outputMint> <amount>");
    console.error("Note: Jupiter quotes are Solana-only.");
    process.exit(1);
  }

  const inputMint = args[1];
  const outputMint = args[2];
  const amount = args[3];
  if (!inputMint || !outputMint || !amount) {
    console.error("Usage: moon quote sol <inputMint> <outputMint> <amount>");
    process.exit(1);
  }

  const slippage = parseInt(parseFlag(args, "--slippage", "50"), 10);

  // Determine if input is SOL (convert to lamports) or a token
  const isInputSol = inputMint === WSOL || inputMint.toLowerCase() === "sol";
  const actualInputMint = isInputSol ? WSOL : inputMint;
  const amountNum = Number(amount);
  const amountRaw = isInputSol ? Math.round(amountNum * 1e9) : Math.round(amountNum * 1e6);

  const quote = await getQuote(actualInputMint, outputMint, amountRaw, slippage);

  out({
    ...quote,
    inputAmountHuman: amountNum,
    inputIsSOL: isInputSol,
    note: isInputSol
      ? `${amountNum} SOL → output amount is in raw token units`
      : `Amount in raw units (assuming 6 decimals)`,
  });
}

export async function cmdToken(args) {
  const query = args.join(" ");
  if (!query) {
    console.error("Usage: moon token <query>");
    process.exit(1);
  }

  const tokens = await searchTokens(query);
  out({ query, count: tokens.length, tokens });
}

export async function cmdSafety(args) {
  const mint = args[0];
  if (!mint) {
    console.error("Usage: moon safety <mint>");
    process.exit(1);
  }

  const result = await getTokenSafety(mint);
  out(result);
}

// ─── Helius Commands ────────────────────────────────────────────────────────

export async function cmdMeta(args) {
  const chain = normalizeChain(args[0]);
  if (chain !== "sol") {
    console.error("Usage: moon meta sol <mint>");
    console.error("Note: DAS metadata is Solana-only.");
    process.exit(1);
  }

  const mint = args[1];
  if (!mint) {
    console.error("Usage: moon meta sol <mint>");
    process.exit(1);
  }

  const asset = await getAsset(mint);
  out(asset);
}

export async function cmdHolders(args) {
  const chain = normalizeChain(args[0]);
  if (chain !== "sol") {
    console.error("Usage: moon holders sol <mint> [--limit N]");
    console.error("Note: Holder analysis is Solana-only.");
    process.exit(1);
  }

  const mint = args[1];
  if (!mint) {
    console.error("Usage: moon holders sol <mint> [--limit N]");
    process.exit(1);
  }

  const limit = parseInt(parseFlag(args, "--limit", "20"), 10);
  const result = await getTokenHolders(mint, limit);
  out(result);
}

export async function cmdHistory(args) {
  const chain = normalizeChain(args[0]);
  if (chain !== "sol") {
    console.error("Usage: moon history sol <address> [--limit N]");
    console.error("Note: Enhanced transaction history is Solana-only.");
    process.exit(1);
  }

  const addr = args[1];
  if (!addr) {
    console.error("Usage: moon history sol <address> [--limit N]");
    process.exit(1);
  }

  const limit = parseInt(parseFlag(args, "--limit", "10"), 10);
  const txs = await getEnhancedTransactions(addr, limit);
  out({ address: addr, count: txs.length, transactions: txs });
}

// ─── Bankr Trading Commands ─────────────────────────────────────────────────

export async function cmdWallet(args) {
  const chain = normalizeChain(args[0]);

  if (chain === "base") {
    const wallet = await getBaseWalletInfo();
    const positions = await getBasePositions().catch(() => []);
    out({ ...wallet, tokenCount: positions.length, positions });
  } else {
    // Default: Solana (backward compat — "moon wallet" with no arg = sol)
    const wallet = await getWalletInfo();
    const positions = await getPositions().catch(() => []);
    out({ ...wallet, tokenCount: positions.length, positions });
  }
}

export async function cmdBuy(args) {
  const chain = normalizeChain(args[0]);
  const token = args[1];
  const amount = args[2];
  if (!chain || !token || !amount) {
    console.error("Usage: moon buy <chain> <token> <amount> [--slippage N] [--note TEXT] [--narrative TAG]");
    console.error("Amount is in SOL (Solana) or ETH (Base).");
    process.exit(1);
  }

  const slippage = parseInt(parseFlag(args, "--slippage", "100"), 10);
  const note = parseFlag(args, "--note", null);
  const narrative = parseFlag(args, "--narrative", null);

  if (chain === "base") {
    // ── Base: ETH → Token via Uniswap V2 ──
    const amountWei = ethToWei(amount);

    out({ action: "buy", chain, token, amountEth: Number(amount), slippageBps: slippage, status: "swapping" });

    const result = await executeBaseSwap(null, token, amountWei, slippage, true);
    out({ action: "buy", chain, token, amountEth: Number(amount), ...result });

    // Auto-journal
    try {
      const { getBaseTokenMeta } = await import("./base.mjs");
      const { getBaseClient } = await import("./base.mjs");
      const client = getBaseClient();
      let symbol = token;
      try {
        const meta = await getBaseTokenMeta(client, token);
        if (meta?.symbol) symbol = meta.symbol;
      } catch { /* ignore */ }
      const narratives = narrative ? [narrative] : [];
      const entry = addJournalEntry({
        type: "buy", chain: "base", mint: token, symbol,
        amount: Number(amount), price: null, mcap: null,
        note, narratives,
        signature: result.txHash || null,
      });
      if (narrative) addNarrative(narrative, token);
      out({ autoJournal: true, journalId: entry.id });
    } catch { /* silent */ }
  } else {
    // ── Solana: SOL → Token via Jupiter ──
    const amountLamports = solToLamports(amount);

    out({ action: "buy", chain, token, amountSol: Number(amount), slippageBps: slippage, status: "swapping" });

    const result = await executeSwap(WSOL, token, amountLamports, slippage);
    out({ action: "buy", chain, token, amountSol: Number(amount), ...result });

    // Auto-journal: best-effort
    try {
      let price = null, mcap = null, symbol = token;
      const jupData = await getJupiterPrice(token).catch(() => null);
      if (jupData) { price = jupData.priceUsd; mcap = jupData.mcap; }
      const tokens = await searchTokens(token).catch(() => []);
      const found = tokens.find(t => t.address === token);
      if (found?.symbol) symbol = found.symbol;
      const narratives = narrative ? [narrative] : [];
      const entry = addJournalEntry({
        type: "buy", chain, mint: token, symbol,
        amount: Number(amount), price, mcap,
        note, narratives,
        signature: result.signature || null,
      });
      if (narrative) addNarrative(narrative, token);
      out({ autoJournal: true, journalId: entry.id });
    } catch { /* silent */ }
  }
}

export async function cmdSell(args) {
  const chain = normalizeChain(args[0]);
  const token = args[1];
  const amount = args[2];
  if (!chain || !token || !amount) {
    console.error("Usage: moon sell <chain> <token> <amount|all> [--slippage N] [--note TEXT]");
    console.error("Amount is in tokens (or 'all').");
    process.exit(1);
  }

  const slippage = parseInt(parseFlag(args, "--slippage", "100"), 10);
  const note = parseFlag(args, "--note", null);

  if (chain === "base") {
    // ── Base: Token → ETH via Uniswap V2 ──
    const balance = await getBaseTokenBalance(token);
    let amountRaw;

    if (amount === "all" || amount === "100%") {
      if (!balance || balance.amount === 0) {
        out({ error: true, message: `No balance found for token ${token}` });
        process.exit(1);
      }
      amountRaw = balance.amountRaw;
    } else {
      const decimals = balance?.decimals ?? 18;
      amountRaw = tokensToRawBase(amount, decimals);
    }

    out({ action: "sell", chain, token, amount, amountRaw, slippageBps: slippage, status: "swapping" });

    const result = await executeBaseSwap(token, null, amountRaw, slippage, false);
    out({ action: "sell", chain, token, amount, ...result });

    // Auto-journal: close matching open buy
    try {
      let symbol = token;
      try {
        const { getBaseTokenMeta, getBaseClient } = await import("./base.mjs");
        const client = getBaseClient();
        const meta = await getBaseTokenMeta(client, token);
        if (meta?.symbol) symbol = meta.symbol;
      } catch { /* ignore */ }

      const openBuys = getOpenPositions().filter(j => j.mint === token && j.type === "buy");
      if (openBuys.length > 0) {
        const buy = openBuys[0];
        updateJournalEntry(buy.id, {
          status: "closed", exitPrice: null, exitTimestamp: Date.now(), pnl: null, pnlPct: null,
        });
        out({ autoJournal: true, closed: buy.id, pnlPct: "unknown" });
      }

      addJournalEntry({
        type: "sell", chain: "base", mint: token, symbol,
        amount: amount === "all" ? "all" : Number(amount),
        price: null, note,
        signature: result.txHash || null,
        status: "closed",
      });
    } catch { /* silent */ }
  } else {
    // ── Solana: Token → SOL via Jupiter ──
    const balance = await getTokenBalance(token);
    let amountRaw;

    if (amount === "all" || amount === "100%") {
      if (!balance) {
        out({ error: true, message: `No balance found for token ${token}` });
        process.exit(1);
      }
      amountRaw = balance.amountRaw;
    } else {
      const decimals = balance?.decimals ?? 9;
      amountRaw = tokensToRaw(amount, decimals);
    }

    out({ action: "sell", chain, token, amount, amountRaw, slippageBps: slippage, status: "swapping" });

    const result = await executeSwap(token, WSOL, amountRaw, slippage);
    out({ action: "sell", chain, token, amount, ...result });

    // Auto-journal: close matching open buy, best-effort
    try {
      let exitPrice = null, symbol = token;
      const jupData = await getJupiterPrice(token).catch(() => null);
      if (jupData) exitPrice = jupData.priceUsd;
      const tokens = await searchTokens(token).catch(() => []);
      const found = tokens.find(t => t.address === token);
      if (found?.symbol) symbol = found.symbol;

      const openBuys = getOpenPositions().filter(j => j.mint === token && j.type === "buy");
      if (openBuys.length > 0) {
        const buy = openBuys[0];
        const pnl = (buy.price && exitPrice) ? (exitPrice - buy.price) * (buy.tokenAmount || 0) : null;
        const pnlPct = (buy.price && exitPrice && buy.price > 0) ? ((exitPrice - buy.price) / buy.price) * 100 : null;
        updateJournalEntry(buy.id, {
          status: "closed", exitPrice, exitTimestamp: Date.now(), pnl, pnlPct,
        });
        out({ autoJournal: true, closed: buy.id, pnlPct: pnlPct ? pnlPct.toFixed(2) + "%" : "unknown" });
      }

      addJournalEntry({
        type: "sell", chain, mint: token, symbol,
        amount: amount === "all" ? "all" : Number(amount),
        price: exitPrice, note,
        signature: result.signature || null,
        status: "closed",
      });
    } catch { /* silent */ }
  }
}

export async function cmdPositions(args) {
  const chain = normalizeChain(args[0]);

  if (chain === "base") {
    const wallet = await getBaseWalletInfo();
    const positions = await getBasePositions();
    out({ address: wallet.address, chain: "base", ethBalance: wallet.ethBalance, positionCount: positions.length, positions });
  } else {
    // Default: Solana
    const wallet = await getWalletInfo();
    const positions = await getPositions();
    out({ address: wallet.address, chain: "solana", solBalance: wallet.solBalance, positionCount: positions.length, positions });
  }
}

// ─── Scanner Command ────────────────────────────────────────────────────────

export async function cmdScan(args) {
  const chain = normalizeChain(args[0]);
  if (chain && chain !== "sol") {
    console.error("Error: scan is currently Solana-only.");
    console.error("Usage: moon scan sol [--limit N]");
    process.exit(1);
  }

  const limit = parseInt(parseFlag(args, "--limit", "10"), 10);

  out({ status: "scanning", message: `Discovering and scoring new Solana tokens (top ${limit})...` });

  const result = await scanNewTokens(limit);
  out(result);

  // Record scan in history
  try {
    addScanRecord({
      topMints: (result.tokens || []).slice(0, 5).map(t => t.mint || t.address),
      bestScore: (result.tokens || [])[0]?.score || 0,
    });
  } catch { /* silent */ }
}

// ─── Journal Commands (V3) ──────────────────────────────────────────────────

export async function cmdJournal(args) {
  const sub = args[0];
  if (sub === "add") return journalAdd(args.slice(1));
  if (sub === "review") return journalReview(args.slice(1));
  return journalShow(args);
}

async function journalShow(args) {
  const last = parseInt(parseFlag(args, "--last", "0"), 10) || undefined;
  const status = parseFlag(args, "--status", null);
  const narrative = parseFlag(args, "--narrative", null);

  const entries = getJournal({ last, status, narrative });

  out({
    command: "journal",
    count: entries.length,
    entries: entries.map(e => ({
      id: e.id,
      type: e.type,
      chain: e.chain,
      symbol: e.symbol,
      mint: e.mint,
      amount: e.amount,
      price: e.price,
      mcap: e.mcap,
      status: e.status,
      pnlPct: e.pnlPct != null ? e.pnlPct.toFixed(2) + "%" : null,
      pnl: e.pnl,
      narratives: e.narratives,
      note: e.note,
      timestamp: e.timestamp,
      date: new Date(e.timestamp).toISOString(),
    })),
  });
}

async function journalAdd(args) {
  const type = args[0]; // buy|sell
  const chain = normalizeChain(args[1]);
  const mint = args[2];
  const amount = Number(args[3]);
  const price = Number(args[4]);

  if (!type || !chain || !mint || isNaN(amount) || isNaN(price)) {
    console.error("Usage: moon journal add <buy|sell> <chain> <mint> <amount> <price> [--note TEXT] [--narrative TAG]");
    process.exit(1);
  }

  const note = parseFlag(args, "--note", null);
  const narrative = parseFlag(args, "--narrative", null);
  const narratives = narrative ? [narrative] : [];

  // Try to get symbol and mcap from Jupiter
  let symbol = mint, mcap = null;
  try {
    const tokens = await searchTokens(mint).catch(() => []);
    const found = tokens.find(t => t.address === mint);
    if (found?.symbol) symbol = found.symbol;
    if (found?.mcap) mcap = found.mcap;
  } catch { /* ignore */ }

  const tokenAmount = price > 0 ? amount / price : 0;

  const entry = addJournalEntry({
    type, chain, mint, symbol, amount, tokenAmount, price, mcap,
    note, narratives,
    status: type === "sell" ? "closed" : "open",
  });

  if (narrative) addNarrative(narrative, mint);

  out({ command: "journal add", success: true, entry });
}

async function journalReview(args) {
  const narrative = parseFlag(args, "--narrative", null);
  const entries = getJournal({ narrative });
  const analysis = analyzeJournal(entries);

  const config = getConfig();
  out({
    command: "journal review",
    goalUsd: config.goalUsd,
    ...analysis,
  });
}

// ─── Watch Commands (V3) ────────────────────────────────────────────────────

export async function cmdWatch(args) {
  const sub = args[0];
  if (sub === "add") return watchAdd(args.slice(1));
  if (sub === "remove") return watchRemove(args.slice(1));
  if (sub === "check") return watchCheck(args.slice(1));
  return watchList(args.slice(sub === "list" ? 1 : 0));
}

async function watchAdd(args) {
  const mint = args[0];
  if (!mint) {
    console.error("Usage: moon watch add <mint> [--target-buy PRICE] [--target-sell PRICE] [--narrative TAG] [--note TEXT]");
    process.exit(1);
  }

  const targetBuy = parseFlag(args, "--target-buy", null);
  const targetSell = parseFlag(args, "--target-sell", null);
  const narrative = parseFlag(args, "--narrative", null);
  const notes = parseFlag(args, "--note", null);

  // Fetch current data
  let symbol = mint, priceAtAdd = null, lastMcap = null, lastHolders = null;
  try {
    const tokens = await searchTokens(mint).catch(() => []);
    const found = tokens.find(t => t.address === mint);
    if (found) {
      symbol = found.symbol || mint;
      priceAtAdd = found.usdPrice;
      lastMcap = found.mcap;
      lastHolders = found.holderCount;
    }
  } catch { /* ignore */ }

  const item = addWatchlistItem({
    mint, chain: "sol", symbol,
    targetBuy: targetBuy ? Number(targetBuy) : null,
    targetSell: targetSell ? Number(targetSell) : null,
    narratives: narrative ? [narrative] : [],
    priceAtAdd,
    lastPrice: priceAtAdd,
    lastMcap,
    lastHolders,
    notes,
  });

  if (narrative) addNarrative(narrative, mint);

  out({ command: "watch add", success: true, item });
}

async function watchRemove(args) {
  const mint = args[0];
  if (!mint) {
    console.error("Usage: moon watch remove <mint>");
    process.exit(1);
  }

  const removed = removeWatchlistItem(mint);
  out({ command: "watch remove", success: removed, mint });
}

async function watchList(args) {
  const list = getWatchlist();

  if (list.length === 0) {
    out({ command: "watch list", count: 0, watchlist: [], message: "Watchlist is empty" });
    return;
  }

  // Fetch current prices for all watched tokens
  const enriched = await Promise.all(list.map(async (item) => {
    let currentPrice = item.lastPrice, currentMcap = item.lastMcap;
    try {
      const jupData = await getJupiterPrice(item.mint).catch(() => null);
      if (jupData) {
        currentPrice = jupData.priceUsd;
        currentMcap = jupData.mcap;
      }
    } catch { /* ignore */ }

    const changePct = (item.priceAtAdd && currentPrice)
      ? ((currentPrice - item.priceAtAdd) / item.priceAtAdd) * 100
      : null;

    return {
      symbol: item.symbol,
      mint: item.mint,
      priceAtAdd: item.priceAtAdd,
      currentPrice,
      changePct: changePct != null ? changePct.toFixed(2) + "%" : null,
      currentMcap,
      targetBuy: item.targetBuy,
      targetSell: item.targetSell,
      narratives: item.narratives,
      notes: item.notes,
      addedAt: new Date(item.addedAt).toISOString(),
    };
  }));

  out({ command: "watch list", count: enriched.length, watchlist: enriched });
}

async function watchCheck(args) {
  const list = getWatchlist();
  const config = getConfig();

  if (list.length === 0) {
    out({ command: "watch check", alerts: [], message: "Watchlist is empty" });
    return;
  }

  const alerts = [];
  const state = loadState();

  for (const item of list) {
    let currentPrice = null, currentMcap = null, currentHolders = null;

    // Fetch current Jupiter data
    try {
      const tokens = await searchTokens(item.mint).catch(() => []);
      const found = tokens.find(t => t.address === item.mint);
      if (found) {
        currentPrice = found.usdPrice;
        currentMcap = found.mcap;
        currentHolders = found.holderCount;
      }
    } catch { /* ignore */ }

    if (!currentPrice) continue;

    // Price target alerts
    if (item.targetBuy && currentPrice <= item.targetBuy) {
      alerts.push({ type: "target_buy_hit", symbol: item.symbol, mint: item.mint, price: currentPrice, target: item.targetBuy });
    }
    if (item.targetSell && currentPrice >= item.targetSell) {
      alerts.push({ type: "target_sell_hit", symbol: item.symbol, mint: item.mint, price: currentPrice, target: item.targetSell });
    }

    // Big price move (>30% since last check or since added)
    const refPrice = item.lastPrice || item.priceAtAdd;
    if (refPrice && currentPrice) {
      const movePct = ((currentPrice - refPrice) / refPrice) * 100;
      if (Math.abs(movePct) >= 30) {
        alerts.push({ type: "big_move", symbol: item.symbol, mint: item.mint, movePct: movePct.toFixed(2) + "%", from: refPrice, to: currentPrice });
      }
    }

    // Holder drop >20%
    if (item.lastHolders && currentHolders && currentHolders < item.lastHolders * 0.8) {
      alerts.push({ type: "holder_drop", symbol: item.symbol, mint: item.mint, was: item.lastHolders, now: currentHolders });
    }

    // Update cached data
    const idx = state.watchlist.findIndex(w => w.mint === item.mint);
    if (idx !== -1) {
      state.watchlist[idx].lastPrice = currentPrice;
      state.watchlist[idx].lastMcap = currentMcap;
      state.watchlist[idx].lastHolders = currentHolders;
      state.watchlist[idx].lastCheck = Date.now();
    }
  }

  // Safety check for items with alerts
  for (const alert of alerts) {
    if (alert.type === "target_buy_hit") {
      try {
        const safety = await getTokenSafety(alert.mint).catch(() => null);
        if (safety && !safety.safe) {
          alerts.push({ type: "safety_warning", symbol: alert.symbol, mint: alert.mint, risks: safety.riskCount, warnings: safety.warningCount });
        }
      } catch { /* ignore */ }
    }
  }

  state.config.lastWatchCheck = Date.now();
  saveState(state);

  out({
    command: "watch check",
    checkedAt: new Date().toISOString(),
    tokensChecked: list.length,
    alertCount: alerts.length,
    alerts,
  });
}

// ─── Calc Commands (V3) ─────────────────────────────────────────────────────

export async function cmdCalc(args) {
  const sub = args[0];
  if (sub === "target") return calcTarget(args.slice(1));
  if (sub === "mcap") return calcMcapCmd(args.slice(1));
  if (sub === "size") return calcSizeCmd(args.slice(1));
  console.error("Usage: moon calc <target|mcap|size> ...");
  process.exit(1);
}

function calcTarget(args) {
  const price = Number(args[0]);
  const supply = Number(args[1]);
  const target = Number(args[2]);

  if (isNaN(price) || isNaN(supply) || isNaN(target)) {
    console.error("Usage: moon calc target <currentPrice> <totalSupply> <targetUsd>");
    process.exit(1);
  }

  const result = calcTargetPosition(price, supply, target);
  out({ command: "calc target", ...result });
}

function calcMcapCmd(args) {
  const held = Number(args[0]);
  const supply = Number(args[1]);
  const target = Number(args[2]);

  if (isNaN(held) || isNaN(supply) || isNaN(target)) {
    console.error("Usage: moon calc mcap <tokensHeld> <totalSupply> <targetUsd>");
    process.exit(1);
  }

  const result = calcRequiredMcap(held, supply, target);
  out({ command: "calc mcap", ...result });
}

function calcSizeCmd(args) {
  const portfolio = Number(args[0]);
  const riskPct = Number(args[1]);
  const price = Number(args[2]);
  const stopLoss = parseFlag(args, "--stop-loss", null);

  if (isNaN(portfolio) || isNaN(riskPct) || isNaN(price)) {
    console.error("Usage: moon calc size <portfolioValue> <riskPct> <entryPrice> [--stop-loss PRICE]");
    process.exit(1);
  }

  // Try to incorporate Kelly from journal
  let kellyInfo = null;
  try {
    const entries = getJournal({});
    const analysis = analyzeJournal(entries);
    if (analysis.totalTrades >= 5) {
      kellyInfo = { kellyPct: analysis.kellyPct, halfKellyPct: analysis.halfKellyPct, recommendation: analysis.kellyRecommendation };
    }
  } catch { /* ignore */ }

  const result = calcPositionSize(portfolio, riskPct, price, stopLoss ? Number(stopLoss) : undefined);
  out({ command: "calc size", ...result, kellyInfo });
}

// ─── Review Command (V3) ────────────────────────────────────────────────────

export async function cmdReview(args) {
  const config = getConfig();

  // 1. Current wallet positions
  let positions = null;
  try {
    const wallet = await getWalletInfo().catch(() => null);
    const tokenPositions = await getPositions().catch(() => []);
    positions = wallet ? { ...wallet, positions: tokenPositions, positionCount: tokenPositions.length } : null;
  } catch { /* ignore */ }

  // 2. Open journal entries with current prices
  const openEntries = getOpenPositions();
  const enrichedOpen = await Promise.all(openEntries.map(async (entry) => {
    let currentPrice = entry.price;
    try {
      const jupData = await getJupiterPrice(entry.mint).catch(() => null);
      if (jupData?.priceUsd) currentPrice = jupData.priceUsd;
    } catch { /* ignore */ }

    const unrealizedPnlPct = (entry.price && currentPrice && entry.price > 0)
      ? ((currentPrice - entry.price) / entry.price) * 100
      : null;

    return {
      id: entry.id,
      symbol: entry.symbol,
      mint: entry.mint,
      chain: entry.chain,
      entryPrice: entry.price,
      currentPrice,
      unrealizedPnlPct: unrealizedPnlPct != null ? unrealizedPnlPct.toFixed(2) + "%" : null,
      amount: entry.amount,
      narratives: entry.narratives,
      date: new Date(entry.timestamp).toISOString(),
    };
  }));

  // 3. Journal stats
  const allEntries = getJournal({});
  const analysis = analyzeJournal(allEntries);

  // 4. Goal progress from open positions
  const positionsForGoal = enrichedOpen.map(e => ({
    symbol: e.symbol,
    mint: e.mint,
    tokenAmount: e.amount,
    currentPrice: e.currentPrice,
    price: e.entryPrice,
  }));
  const goalProgress = calcGoalProgress(positionsForGoal, config.goalUsd);

  // 5. Watchlist alerts (stale check)
  const watchlist = getWatchlist();
  const watchStale = config.lastWatchCheck > 0
    ? (Date.now() - config.lastWatchCheck) > 2 * 60 * 60 * 1000
    : watchlist.length > 0;

  // 6. Narrative summary
  const narratives = getNarratives();

  out({
    command: "review",
    goal: {
      targetUsd: config.goalUsd,
      ...goalProgress,
    },
    openPositions: {
      count: enrichedOpen.length,
      positions: enrichedOpen,
    },
    walletPositions: positions,
    tradingStats: {
      closedTrades: analysis.totalTrades,
      winRate: analysis.winRate,
      avgPnlPct: analysis.avgPnlPct,
      profitFactor: analysis.profitFactor,
      kellyPct: analysis.kellyPct,
      halfKellyPct: analysis.halfKellyPct,
      bestTrade: analysis.bestTrade,
      worstTrade: analysis.worstTrade,
      streaks: analysis.streaks,
    },
    narratives: Object.entries(narratives).map(([name, data]) => ({
      name,
      tokenCount: data.tokens.length,
      notes: data.notes,
      performance: analysis.byNarrative?.[name] || null,
    })),
    watchlist: {
      count: watchlist.length,
      stale: watchStale,
      lastCheck: config.lastWatchCheck > 0 ? new Date(config.lastWatchCheck).toISOString() : "never",
    },
    config: {
      goalUsd: config.goalUsd,
      defaultRiskPct: config.defaultRiskPct,
      defaultStopLossPct: config.defaultStopLossPct,
    },
  });
}

// ─── Polymarket Commands ────────────────────────────────────────────────────

export async function cmdMarket(args) {
  const sub = args[0];
  if (!sub) {
    console.error("Usage: moon market search <query> | moon market <conditionId> | moon market positions | moon market orders | moon market cancel <id|all> | moon market trades");
    process.exit(1);
  }

  if (sub === "search") {
    const query = args.slice(1).join(" ");
    if (!query) { console.error("Usage: moon market search <query>"); process.exit(1); }
    const limit = parseInt(parseFlag(args, "--limit", "20"), 10);
    const results = await searchMarkets(query, limit);
    out({ command: "market search", query, count: results.length, markets: results });
    return;
  }

  if (sub === "positions") {
    const polyPositions = await getPolyPositions();
    const trackedBets = getPolyBets({ status: "open" });
    out({ command: "market positions", ...polyPositions, trackedBets });
    return;
  }

  if (sub === "orders") {
    const orders = await getPolyOpenOrders();
    out({ command: "market orders", count: Array.isArray(orders) ? orders.length : 0, orders });
    return;
  }

  if (sub === "cancel") {
    const target = args[1];
    if (!target) { console.error("Usage: moon market cancel <orderId|all>"); process.exit(1); }
    if (target === "all") {
      const result = await cancelAllOrders();
      out({ command: "market cancel all", ...result });
    } else {
      const result = await cancelOrder(target);
      out({ command: "market cancel", orderId: target, ...result });
    }
    return;
  }

  if (sub === "trades") {
    const limit = parseInt(parseFlag(args, "--last", "20"), 10);
    const trades = await getPolyTrades(limit);
    out({ command: "market trades", count: trades.length, trades });
    return;
  }

  // Default: treat sub as conditionId — show market details + order book
  const conditionId = sub;
  const market = await getMarket(conditionId);

  // Get order books for YES and NO tokens (requires POLYMARKET_PRIVATE_KEY)
  let yesBook = null, noBook = null;
  const hasKey = !!process.env.POLYMARKET_PRIVATE_KEY;
  if (hasKey) {
    try {
      if (market.clobTokenIds?.[0]) yesBook = await getOrderBook(market.clobTokenIds[0]);
    } catch { /* ignore */ }
    try {
      if (market.clobTokenIds?.[1]) noBook = await getOrderBook(market.clobTokenIds[1]);
    } catch { /* ignore */ }
  }

  out({
    command: "market",
    ...market,
    orderBook: hasKey ? { yes: yesBook, no: noBook } : null,
    note: hasKey ? undefined : "Set POLYMARKET_PRIVATE_KEY to see order book data",
  });
}

export async function cmdOdds(args) {
  const conditionId = args[0];
  if (!conditionId) {
    console.error("Usage: moon odds <conditionId>");
    process.exit(1);
  }

  const market = await getMarket(conditionId);

  // Get order books for spread info (requires POLYMARKET_PRIVATE_KEY)
  let yesBook = null, noBook = null;
  const hasKey = !!process.env.POLYMARKET_PRIVATE_KEY;
  if (hasKey) {
    try {
      if (market.clobTokenIds?.[0]) yesBook = await getOrderBook(market.clobTokenIds[0]);
    } catch { /* ignore */ }
    try {
      if (market.clobTokenIds?.[1]) noBook = await getOrderBook(market.clobTokenIds[1]);
    } catch { /* ignore */ }
  }

  out({
    command: "odds",
    conditionId: market.conditionId,
    question: market.question,
    yesPrice: market.yesPrice,
    noPrice: market.noPrice,
    yesBestBid: yesBook?.bestBid || null,
    yesBestAsk: yesBook?.bestAsk || null,
    yesSpread: yesBook?.spread || null,
    noBestBid: noBook?.bestBid || null,
    noBestAsk: noBook?.bestAsk || null,
    noSpread: noBook?.spread || null,
    volume: market.volume,
    liquidity: market.liquidity,
    endDate: market.endDate,
  });
}

export async function cmdBet(args) {
  const conditionId = args[0];
  const outcome = args[1]?.toLowerCase();
  const usdcAmt = args[2];

  if (!conditionId || !outcome || !usdcAmt) {
    console.error("Usage: moon bet <conditionId> <yes|no> <usdcAmount> [--limit PRICE] [--note TEXT] [--narrative TAG]");
    process.exit(1);
  }

  if (outcome !== "yes" && outcome !== "no") {
    console.error("Outcome must be 'yes' or 'no'.");
    process.exit(1);
  }

  const amount = parseFloat(usdcAmt);
  if (isNaN(amount) || amount <= 0) {
    console.error("Amount must be a positive number (USDC).");
    process.exit(1);
  }

  const limitPrice = parseFlag(args, "--limit", null);
  const note = parseFlag(args, "--note", null);
  const narrative = parseFlag(args, "--narrative", null);

  // Fetch market data
  const market = await getMarket(conditionId);
  if (market.closed) {
    out({ error: true, message: "Market is closed. Cannot place bet." });
    process.exit(1);
  }

  // Resolve tokenId: index 0 = YES, index 1 = NO
  const tokenIdx = outcome === "yes" ? 0 : 1;
  const tokenId = market.clobTokenIds?.[tokenIdx];
  if (!tokenId) {
    out({ error: true, message: `No CLOB token ID found for ${outcome.toUpperCase()} outcome.` });
    process.exit(1);
  }

  const entryPrice = outcome === "yes" ? market.yesPrice : market.noPrice;
  const shares = entryPrice > 0 ? amount / entryPrice : 0;

  out({
    action: "bet",
    conditionId,
    question: market.question,
    outcome: outcome.toUpperCase(),
    amount,
    entryPrice,
    estimatedShares: shares.toFixed(2),
    limitPrice: limitPrice ? parseFloat(limitPrice) : null,
    negRisk: market.negRisk,
    status: "placing",
  });

  let result;
  if (limitPrice) {
    const price = parseFloat(limitPrice);
    const size = amount / price;
    result = await placeLimitBet(tokenId, "BUY", price, size, market.negRisk, market.tickSize);
  } else {
    result = await placeBet(tokenId, "BUY", amount, market.negRisk, market.tickSize);
  }

  out({ action: "bet", conditionId, outcome: outcome.toUpperCase(), amount, ...result });

  // Auto-journal
  try {
    const questionShort = market.question.length > 60 ? market.question.slice(0, 57) + "..." : market.question;
    const narratives = narrative ? [narrative] : [];
    const entry = addJournalEntry({
      type: "bet",
      chain: "polygon",
      mint: conditionId,
      symbol: questionShort,
      amount,
      price: entryPrice,
      mcap: null,
      note,
      narratives,
      signature: result.orderId || null,
      polymarket: {
        conditionId,
        tokenId,
        outcome: outcome.toUpperCase(),
        orderType: limitPrice ? "GTC" : "FOK",
        shares: shares.toFixed(2),
        limitPrice: limitPrice ? parseFloat(limitPrice) : null,
      },
    });
    if (narrative) addNarrative(narrative, conditionId);

    // Track in polymarketBets
    addPolyBet({
      conditionId,
      tokenId,
      question: market.question,
      outcome: outcome.toUpperCase(),
      amount,
      entryPrice,
      shares,
      journalId: entry.id,
      orderId: result.orderId || null,
    });

    out({ autoJournal: true, journalId: entry.id });
  } catch { /* silent */ }
}

export async function cmdRedeem(args) {
  const sub = args[0];

  if (sub === "list") {
    // Show all tracked bets that might be redeemable
    const bets = getPolyBets({});
    const enriched = [];
    for (const bet of bets) {
      let marketStatus = null;
      try {
        const m = await getMarket(bet.conditionId);
        marketStatus = { closed: m.closed, active: m.active, yesPrice: m.yesPrice, noPrice: m.noPrice };
      } catch { /* ignore */ }
      enriched.push({ ...bet, marketStatus });
    }
    out({ command: "redeem list", count: enriched.length, bets: enriched });
    return;
  }

  if (!sub) {
    console.error("Usage: moon redeem <conditionId> | moon redeem list");
    process.exit(1);
  }

  const conditionId = sub;
  const market = await getMarket(conditionId);
  const bet = getPolyBets({ conditionId })[0];

  if (!bet) {
    out({ command: "redeem", conditionId, question: market.question, closed: market.closed, message: "No tracked bet found for this market." });
    return;
  }

  if (!market.closed) {
    out({
      command: "redeem",
      conditionId,
      question: market.question,
      closed: false,
      status: bet.status,
      yesPrice: market.yesPrice,
      noPrice: market.noPrice,
      message: "Market is still open. Cannot redeem yet.",
    });
    return;
  }

  // Market is closed — determine resolution
  // If YES resolved: yesPrice ~1.0, noPrice ~0.0
  // If NO resolved: yesPrice ~0.0, noPrice ~1.0
  const yesResolved = market.yesPrice >= 0.95;
  const resolvedOutcome = yesResolved ? "YES" : "NO";
  const won = bet.outcome === resolvedOutcome;
  const exitPrice = won ? 1.0 : 0.0;
  const pnl = won ? (bet.shares * 1.0 - bet.amount) : -bet.amount;
  const pnlPct = bet.amount > 0 ? (pnl / bet.amount) * 100 : 0;

  // Update journal entry
  if (bet.journalId) {
    updateJournalEntry(bet.journalId, {
      status: "closed",
      exitPrice,
      exitTimestamp: Date.now(),
      pnl,
      pnlPct,
    });
  }

  // Update polymarket bet record
  updatePolyBet(conditionId, {
    status: "closed",
    resolvedOutcome,
    won,
    exitPrice,
    pnl,
    pnlPct,
    resolvedAt: Date.now(),
  });

  out({
    command: "redeem",
    conditionId,
    question: market.question,
    closed: true,
    resolvedOutcome,
    yourOutcome: bet.outcome,
    won,
    entryPrice: bet.entryPrice,
    exitPrice,
    shares: bet.shares,
    costUsdc: bet.amount,
    pnl: pnl.toFixed(2),
    pnlPct: pnlPct.toFixed(2) + "%",
    journalUpdated: !!bet.journalId,
  });
}
