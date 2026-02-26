// moon/lib/helius.mjs -- DAS API, token holders, enhanced transactions

import { requireEnv } from "./helpers.mjs";

function heliusRpcUrl() {
  const key = requireEnv("HELIUS_API_KEY", "Required for meta/holders/history commands. Get one at https://helius.dev");
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

function heliusApiUrl() {
  const key = process.env.HELIUS_API_KEY;
  return `https://api.helius.xyz/v0`;
}

async function dasPost(method, params) {
  const url = heliusRpcUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`Helius DAS error (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  if (json.error) {
    throw new Error(`Helius DAS RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json.result;
}

// ─── getAsset ───────────────────────────────────────────────────────────────

export async function getAsset(mint) {
  const result = await dasPost("getAsset", { id: mint });
  if (!result) throw new Error(`Asset not found: ${mint}`);

  const content = result.content || {};
  const metadata = content.metadata || {};
  const links = content.links || {};
  const authority = result.authorities?.[0]?.address || null;
  const supply = result.token_info?.supply ?? null;
  const decimals = result.token_info?.decimals ?? null;

  return {
    mint,
    name: metadata.name || null,
    symbol: metadata.symbol || null,
    description: metadata.description || null,
    image: links.image || content.json_uri || null,
    authority,
    supply,
    decimals,
    tokenStandard: result.token_info?.token_program || null,
    mutable: result.mutable ?? null,
    burnt: result.burnt ?? false,
    compressed: result.compression?.compressed ?? false,
    frozen: result.ownership?.frozen ?? false,
    owner: result.ownership?.owner || null,
  };
}

// ─── getTokenHolders ────────────────────────────────────────────────────────

export async function getTokenHolders(mint, limit = 20) {
  const result = await dasPost("getTokenAccounts", {
    mint,
    limit: Math.min(limit * 2, 1000), // over-fetch for sorting
    options: { showZeroBalance: false },
  });

  if (!result || !result.token_accounts) {
    return { mint, holders: [], total: 0 };
  }

  const accounts = result.token_accounts;

  // Sort by amount descending
  accounts.sort((a, b) => {
    const aAmt = Number(a.amount || 0);
    const bAmt = Number(b.amount || 0);
    return bAmt - aAmt;
  });

  // Calculate total supply from visible accounts
  const totalVisible = accounts.reduce((sum, a) => sum + Number(a.amount || 0), 0);

  const holders = accounts.slice(0, limit).map((a, i) => {
    const amount = Number(a.amount || 0);
    const pct = totalVisible > 0 ? (amount / totalVisible) * 100 : 0;
    return {
      rank: i + 1,
      owner: a.owner,
      account: a.address,
      amount,
      pctOfVisible: Math.round(pct * 100) / 100,
    };
  });

  // Top holder concentration
  const topN = holders.slice(0, Math.min(10, holders.length));
  const topConcentration = topN.reduce((sum, h) => sum + h.pctOfVisible, 0);

  return {
    mint,
    holders,
    totalAccounts: result.total || accounts.length,
    top10ConcentrationPct: Math.round(topConcentration * 100) / 100,
  };
}

// ─── getEnhancedTransactions ────────────────────────────────────────────────

export async function getEnhancedTransactions(address, limit = 10) {
  const key = requireEnv("HELIUS_API_KEY", "Required for history command.");
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${key}&limit=${Math.min(limit, 100)}`;

  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) {
    throw new Error(`Helius enhanced txs error (${res.status}): ${await res.text()}`);
  }
  const txs = await res.json();

  return txs.map(tx => ({
    signature: tx.signature,
    type: tx.type || "UNKNOWN",
    description: tx.description || null,
    fee: tx.fee,
    feePayer: tx.feePayer,
    timestamp: tx.timestamp,
    slot: tx.slot,
    nativeTransfers: (tx.nativeTransfers || []).map(t => ({
      from: t.fromUserAccount,
      to: t.toUserAccount,
      amountSol: t.amount / 1e9,
    })),
    tokenTransfers: (tx.tokenTransfers || []).map(t => ({
      from: t.fromUserAccount,
      to: t.toUserAccount,
      mint: t.mint,
      amount: t.tokenAmount,
    })),
    source: tx.source || null,
  }));
}
