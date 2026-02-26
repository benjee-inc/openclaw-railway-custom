// moon/lib/constants.mjs -- Addresses, ABIs, RPC URLs, API bases

import { parseAbi } from "viem";

// ─── RPC Endpoints ──────────────────────────────────────────────────────────

export const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";

export function getSolRpcUrl() {
  return process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
}

export function getHeliusApiUrl() {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  return `https://api.helius.xyz/v0`;
}

export function getHeliusRpcUrl() {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

// ─── API Bases ──────────────────────────────────────────────────────────────

export const BANKR_API = "https://bankr.fyi/api";

// ─── Base Contracts ─────────────────────────────────────────────────────────

export const UNISWAP_V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";
export const AERODROME_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
export const BASE_WETH = "0x4200000000000000000000000000000000000006";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// ─── Solana Program IDs ─────────────────────────────────────────────────────

export const RAYDIUM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const PUMP_FUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_SWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const METEORA_DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const METEORA_CPAMM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

// ─── Well-Known Solana Tokens ───────────────────────────────────────────────

export const WSOL = "So11111111111111111111111111111111111111112";
export const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ─── Uniswap V2 Router (Base) ────────────────────────────────────────────────

export const UNISWAP_V2_ROUTER = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";

// ─── ABIs ───────────────────────────────────────────────────────────────────

export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

export const ERC20_WRITE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

export const UNISWAP_V2_ROUTER_ABI = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint256[] memory amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint256[] memory amounts)",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)",
]);

export const PAIR_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function factory() view returns (address)",
]);

export const FACTORY_ABI = parseAbi([
  "function getPair(address, address) view returns (address)",
  "function allPairsLength() view returns (uint256)",
]);

export const AERO_FACTORY_ABI = parseAbi([
  "function getPool(address, address, bool) view returns (address)",
  "function allPoolsLength() view returns (uint256)",
]);

// ─── Polymarket (Polygon) ───────────────────────────────────────────────────

export const POLYMARKET_CLOB_HOST = "https://clob.polymarket.com";
export const POLYMARKET_GAMMA_API = "https://gamma-api.polymarket.com";
export const POLYMARKET_CHAIN_ID = 137;
export const POLY_CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
export const POLY_NEG_RISK_CTF_EXCHANGE = "0xc5d563a36ae78145c45a50134d48a1215220f80a";
export const POLY_CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
export const POLY_USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// ─── Event Topics ───────────────────────────────────────────────────────────

export const PAIR_CREATED_TOPIC = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
export const POOL_CREATED_TOPIC = "0x2128d88d14c80cb081c1252a5acff7a264671bf199ce226b53571a894b946ea7";
