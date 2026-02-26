// moon/lib/bankr.mjs -- Managed wallet trading via Bankr API

import { BANKR_API } from "./constants.mjs";
import { requireEnv } from "./helpers.mjs";

function bankrHeaders() {
  const key = requireEnv("BANKR_API_KEY", "Required for wallet/buy/sell/positions commands. Get one at https://bankr.fyi");
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-API-Key": key,
  };
}

// ─── Wallet Info ────────────────────────────────────────────────────────────

export async function getWalletInfo() {
  const res = await fetch(`${BANKR_API}/agent/wallet`, {
    headers: bankrHeaders(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bankr wallet error (${res.status}): ${body}`);
  }

  return await res.json();
}

// ─── Job Submission & Polling ───────────────────────────────────────────────

export async function submitJob(prompt) {
  const res = await fetch(`${BANKR_API}/agent/prompt`, {
    method: "POST",
    headers: bankrHeaders(),
    body: JSON.stringify({ prompt }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bankr submit error (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.jobId || data.id || data.job_id;
}

export async function pollJob(jobId, maxWaitMs = 60000) {
  const start = Date.now();
  const pollInterval = 2000;

  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${BANKR_API}/agent/job/${jobId}`, {
      headers: bankrHeaders(),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bankr poll error (${res.status}): ${body}`);
    }

    const data = await res.json();
    const status = (data.status || "").toLowerCase();

    if (status === "completed" || status === "success" || status === "done") {
      return { success: true, jobId, ...data };
    }
    if (status === "failed" || status === "error") {
      return { success: false, jobId, error: data.error || data.message || "Job failed", ...data };
    }

    // Still pending — wait and retry
    await new Promise(r => setTimeout(r, pollInterval));
  }

  return { success: false, jobId, error: `Job timed out after ${maxWaitMs / 1000}s` };
}

export async function executePrompt(prompt) {
  const jobId = await submitJob(prompt);
  return await pollJob(jobId);
}

// ─── Prompt Builders ────────────────────────────────────────────────────────

export function buildBuyPrompt(chain, token, amount, slippage = 5) {
  const chainName = chain === "sol" ? "Solana" : "Base";
  return `Buy ${amount} ${chainName === "Solana" ? "SOL" : "ETH"} worth of token ${token} on ${chainName} with ${slippage}% slippage`;
}

export function buildSellPrompt(chain, token, amount, slippage = 5) {
  const chainName = chain === "sol" ? "Solana" : "Base";
  if (amount === "all" || amount === "100%") {
    return `Sell all of token ${token} on ${chainName} with ${slippage}% slippage`;
  }
  return `Sell ${amount} of token ${token} on ${chainName} with ${slippage}% slippage`;
}

// ─── Positions ──────────────────────────────────────────────────────────────

export async function getPositions(chain) {
  // Get wallet info which includes token balances
  const wallet = await getWalletInfo();

  // Filter by chain if specified
  let positions = wallet.positions || wallet.tokens || wallet.balances || [];

  if (chain && positions.length > 0) {
    const chainLc = chain.toLowerCase();
    positions = positions.filter(p => {
      const pChain = (p.chain || p.network || "").toLowerCase();
      if (chainLc === "sol" || chainLc === "solana") return pChain === "solana" || pChain === "sol";
      if (chainLc === "base") return pChain === "base";
      return true;
    });
  }

  return {
    ...wallet,
    positions,
    positionCount: positions.length,
  };
}
