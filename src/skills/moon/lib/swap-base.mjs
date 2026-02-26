// moon/lib/swap-base.mjs -- Base chain swap execution via Uniswap V2 Router
// Self-custody using BASE_PRIVATE_KEY. Mirrors swap.mjs for Solana.

import {
  createPublicClient, createWalletClient, http, formatUnits, parseEther, parseUnits,
  getAddress, maxUint256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  BASE_RPC, BASE_WETH, UNISWAP_V2_ROUTER,
  ERC20_ABI, ERC20_WRITE_ABI, UNISWAP_V2_ROUTER_ABI,
} from "./constants.mjs";
import { requireEnv } from "./helpers.mjs";
import { getJournal, getWatchlist } from "./state.mjs";

// ─── Account & Clients ─────────────────────────────────────────────────────

function getAccount() {
  let key = requireEnv("BASE_PRIVATE_KEY", "Required for Base trading. Hex private key, 0x prefix optional.");
  if (!key.startsWith("0x")) key = "0x" + key;
  return privateKeyToAccount(key);
}

function getPublicClient() {
  return createPublicClient({ chain: base, transport: http(BASE_RPC) });
}

function getWalletClientInstance() {
  const account = getAccount();
  return createWalletClient({ account, chain: base, transport: http(BASE_RPC) });
}

// ─── Wallet Info ────────────────────────────────────────────────────────────

export async function getBaseWalletInfo() {
  const account = getAccount();
  const client = getPublicClient();
  const balance = await client.getBalance({ address: account.address });

  return {
    address: account.address,
    chain: "base",
    ethBalance: Number(formatUnits(balance, 18)),
    ethBalanceWei: balance.toString(),
  };
}

// ─── Token Balance ──────────────────────────────────────────────────────────

export async function getBaseTokenBalance(tokenAddr) {
  const account = getAccount();
  const client = getPublicClient();
  const address = getAddress(tokenAddr);

  const [balance, decimals, symbol] = await Promise.all([
    client.readContract({ address, abi: ERC20_WRITE_ABI, functionName: "balanceOf", args: [account.address] }),
    client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
    client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "???"),
  ]);

  const dec = Number(decimals);
  return {
    mint: address,
    symbol,
    amount: Number(formatUnits(balance, dec)),
    amountRaw: balance.toString(),
    decimals: dec,
  };
}

// ─── Positions (tokens from journal + watchlist) ────────────────────────────

export async function getBasePositions() {
  // Collect known Base token addresses from journal + watchlist
  const mints = new Set();

  const journal = getJournal({});
  for (const e of journal) {
    if (e.chain === "base" && e.mint) mints.add(e.mint);
  }

  const watchlist = getWatchlist();
  for (const w of watchlist) {
    if (w.chain === "base" && w.mint) mints.add(w.mint);
  }

  if (mints.size === 0) return [];

  const positions = [];
  for (const mint of mints) {
    try {
      const bal = await getBaseTokenBalance(mint);
      if (bal.amount > 0) positions.push(bal);
    } catch { /* token may not exist anymore */ }
  }

  return positions;
}

// ─── Swap Execution ─────────────────────────────────────────────────────────

export async function executeBaseSwap(inputToken, outputToken, amountIn, slippageBps = 100, isBuy = true) {
  const account = getAccount();
  const publicClient = getPublicClient();
  const walletClient = getWalletClientInstance();
  const routerAddr = getAddress(UNISWAP_V2_ROUTER);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200); // 20 min

  try {
    if (isBuy) {
      // ── Buy: ETH → Token (swapExactETHForTokens) ──
      const amountInWei = BigInt(amountIn);
      const path = [getAddress(BASE_WETH), getAddress(outputToken)];

      // Get expected output
      const amounts = await publicClient.readContract({
        address: routerAddr,
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [amountInWei, path],
      });
      const expectedOut = amounts[1];
      const amountOutMin = expectedOut * BigInt(10000 - slippageBps) / 10000n;

      const hash = await walletClient.writeContract({
        address: routerAddr,
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: "swapExactETHForTokens",
        args: [amountOutMin, path, account.address, deadline],
        value: amountInWei,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      return {
        success: receipt.status === "success",
        signature: hash,
        txHash: hash,
        explorer: `https://basescan.org/tx/${hash}`,
        inAmount: amountIn.toString(),
        outAmount: expectedOut.toString(),
        error: receipt.status !== "success" ? "Transaction reverted" : null,
      };
    } else {
      // ── Sell: Token → ETH (swapExactTokensForETH) ──
      const tokenAddr = getAddress(inputToken);
      const amountInRaw = BigInt(amountIn);
      const path = [tokenAddr, getAddress(BASE_WETH)];

      // Check allowance, approve if needed
      const allowance = await publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_WRITE_ABI,
        functionName: "allowance",
        args: [account.address, routerAddr],
      });

      if (allowance < amountInRaw) {
        const approveHash = await walletClient.writeContract({
          address: tokenAddr,
          abi: ERC20_WRITE_ABI,
          functionName: "approve",
          args: [routerAddr, maxUint256],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      // Get expected output
      const amounts = await publicClient.readContract({
        address: routerAddr,
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: "getAmountsOut",
        args: [amountInRaw, path],
      });
      const expectedOut = amounts[1];
      const amountOutMin = expectedOut * BigInt(10000 - slippageBps) / 10000n;

      const hash = await walletClient.writeContract({
        address: routerAddr,
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: "swapExactTokensForETH",
        args: [amountInRaw, amountOutMin, path, account.address, deadline],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      return {
        success: receipt.status === "success",
        signature: hash,
        txHash: hash,
        explorer: `https://basescan.org/tx/${hash}`,
        inAmount: amountIn.toString(),
        outAmount: expectedOut.toString(),
        error: receipt.status !== "success" ? "Transaction reverted" : null,
      };
    }
  } catch (err) {
    return {
      success: false,
      signature: null,
      txHash: null,
      explorer: null,
      inAmount: amountIn.toString(),
      outAmount: null,
      error: err.message,
    };
  }
}

// ─── Amount Helpers ─────────────────────────────────────────────────────────

export function ethToWei(eth) {
  return parseEther(String(eth)).toString();
}

export function tokensToRawBase(amount, decimals) {
  return parseUnits(String(amount), decimals).toString();
}
