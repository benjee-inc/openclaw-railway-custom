// moon/lib/swap.mjs -- Direct Jupiter swap execution + wallet utilities
// No third-party custody. Uses SOLANA_PRIVATE_KEY for self-custody trading.

import { Keypair, VersionedTransaction, PublicKey, Connection } from "@solana/web3.js";
import { WSOL } from "./constants.mjs";
import { jupiterHeaders, requireEnv } from "./helpers.mjs";

const LITE_API = "https://lite-api.jup.ag";
const PAID_API = "https://api.jup.ag";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function getApiBase() {
  return process.env.JUPITER_API_KEY ? PAID_API : LITE_API;
}

// ─── Base58 Decoder (no external dep) ───────────────────────────────────────

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str) {
  const bytes = [0];
  for (const char of str) {
    const idx = B58.indexOf(char);
    if (idx < 0) throw new Error("Invalid base58 character: " + char);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

// ─── Keypair & Connection ───────────────────────────────────────────────────

function getKeypair() {
  const key = requireEnv("SOLANA_PRIVATE_KEY", "Required for trading. Base58 secret key or JSON byte array.");
  // JSON array format: [1,2,3,...,64]
  if (key.startsWith("[")) {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(key)));
  }
  // Base58 format (Phantom export, solana-keygen)
  return Keypair.fromSecretKey(base58Decode(key));
}

function getConnection() {
  const rpc = process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(rpc, "confirmed");
}

// ─── Jupiter Swap Execution ─────────────────────────────────────────────────

export async function executeSwap(inputMint, outputMint, amountRaw, slippageBps = 100) {
  const keypair = getKeypair();
  const conn = getConnection();

  // 1. Get quote
  const quoteParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountRaw),
    slippageBps: String(slippageBps),
  });

  const quoteRes = await fetch(`${getApiBase()}/swap/v1/quote?${quoteParams}`, {
    headers: jupiterHeaders(),
  });
  if (!quoteRes.ok) {
    const body = await quoteRes.text();
    throw new Error(`Jupiter quote error (${quoteRes.status}): ${body}`);
  }
  const quoteResponse = await quoteRes.json();

  // 2. Get swap transaction
  const swapRes = await fetch(`${getApiBase()}/swap/v1/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jupiterHeaders() },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!swapRes.ok) {
    const body = await swapRes.text();
    throw new Error(`Jupiter swap error (${swapRes.status}): ${body}`);
  }
  const { swapTransaction } = await swapRes.json();

  // 3. Deserialize and sign
  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  // 4. Send
  const signature = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });

  // 5. Confirm
  const confirmation = await conn.confirmTransaction(signature, "confirmed");

  return {
    success: !confirmation.value?.err,
    signature,
    explorer: `https://solscan.io/tx/${signature}`,
    inputMint,
    outputMint,
    inAmount: quoteResponse.inAmount,
    outAmount: quoteResponse.outAmount,
    priceImpactPct: quoteResponse.priceImpactPct,
    error: confirmation.value?.err || null,
  };
}

// ─── Wallet Info ────────────────────────────────────────────────────────────

export async function getWalletInfo() {
  const keypair = getKeypair();
  const conn = getConnection();

  const solBalance = await conn.getBalance(keypair.publicKey);

  return {
    address: keypair.publicKey.toBase58(),
    chain: "solana",
    solBalance: solBalance / 1e9,
    solBalanceLamports: solBalance,
  };
}

// ─── Token Positions ────────────────────────────────────────────────────────

export async function getPositions() {
  const keypair = getKeypair();
  const conn = getConnection();

  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(keypair.publicKey, {
    programId: TOKEN_PROGRAM,
  });

  const positions = tokenAccounts.value
    .map(acct => {
      const info = acct.account.data.parsed.info;
      return {
        mint: info.mint,
        amount: info.tokenAmount.uiAmount,
        amountRaw: info.tokenAmount.amount,
        decimals: info.tokenAmount.decimals,
      };
    })
    .filter(p => p.amount > 0);

  return positions;
}

// ─── Token Balance for a Specific Mint ──────────────────────────────────────

export async function getTokenBalance(mint) {
  const positions = await getPositions();
  return positions.find(p => p.mint === mint) || null;
}

// ─── Build Amount Helpers ───────────────────────────────────────────────────

export function solToLamports(sol) {
  return Math.round(Number(sol) * 1e9);
}

export function tokensToRaw(amount, decimals) {
  return Math.round(Number(amount) * Math.pow(10, decimals));
}
