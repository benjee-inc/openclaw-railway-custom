// moon/lib/solana.mjs -- Raydium, Pump.fun, PumpSwap, Meteora

import { Connection, PublicKey } from "@solana/web3.js";
import { readU64LE, readPublicKey } from "./helpers.mjs";
import {
  getSolRpcUrl, getHeliusRpcUrl,
  RAYDIUM_V4, PUMP_FUN, PUMP_SWAP, METEORA_DLMM, METEORA_CPAMM,
} from "./constants.mjs";

// ─── Connection ─────────────────────────────────────────────────────────────

export function getSolConnection() {
  // Prefer Helius RPC when available (faster, no getProgramAccounts limits)
  const url = getHeliusRpcUrl() || getSolRpcUrl();
  return new Connection(url, "confirmed");
}

// ─── DEX Detection ──────────────────────────────────────────────────────────

export function detectSolanaDex(ownerProgramId) {
  const map = {
    [RAYDIUM_V4]: "Raydium AMM v4",
    [PUMP_FUN]: "Pump.fun",
    [PUMP_SWAP]: "PumpSwap",
    [METEORA_DLMM]: "Meteora DLMM",
    [METEORA_CPAMM]: "Meteora CP-AMM",
  };
  return map[ownerProgramId] || null;
}

// ─── Raydium ────────────────────────────────────────────────────────────────

function parseRaydiumPool(data) {
  const coinDecimals = data.readUInt8(32);
  const pcDecimals = data.readUInt8(40);
  const poolCoinTokenAccount = readPublicKey(data, 336);
  const poolPcTokenAccount = readPublicKey(data, 368);
  const coinMint = readPublicKey(data, 400);
  const pcMint = readPublicKey(data, 432);
  const lpMint = readPublicKey(data, 464);
  return { coinDecimals, pcDecimals, poolCoinTokenAccount, poolPcTokenAccount, coinMint, pcMint, lpMint };
}

export async function getRaydiumPoolInfo(conn, poolAddr) {
  const pubkey = new PublicKey(poolAddr);
  const acct = await conn.getAccountInfo(pubkey);
  if (!acct || !acct.data || acct.data.length < 600) {
    throw new Error(`Not a valid Raydium pool: ${poolAddr}`);
  }
  if (acct.owner.toBase58() !== RAYDIUM_V4) {
    throw new Error(`Account owner is ${acct.owner.toBase58()}, expected Raydium v4 (${RAYDIUM_V4})`);
  }

  const pool = parseRaydiumPool(Buffer.from(acct.data));
  const [coinBal, pcBal] = await Promise.all([
    conn.getTokenAccountBalance(new PublicKey(pool.poolCoinTokenAccount)),
    conn.getTokenAccountBalance(new PublicKey(pool.poolPcTokenAccount)),
  ]);

  const coinReserve = Number(coinBal.value.uiAmount);
  const pcReserve = Number(pcBal.value.uiAmount);
  const price = coinReserve > 0 ? pcReserve / coinReserve : 0;

  return {
    dex: "Raydium AMM v4", pool: poolAddr,
    coinMint: pool.coinMint, pcMint: pool.pcMint, lpMint: pool.lpMint,
    coinDecimals: pool.coinDecimals, pcDecimals: pool.pcDecimals,
    reserves: { coin: coinReserve, pc: pcReserve }, price,
  };
}

// ─── Pump.fun ───────────────────────────────────────────────────────────────

export async function getPumpCurveInfo(conn, mintAddr) {
  const mintPubkey = new PublicKey(mintAddr);
  const programPubkey = new PublicKey(PUMP_FUN);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
    programPubkey
  );

  const acct = await conn.getAccountInfo(pda);
  if (!acct || !acct.data) {
    throw new Error(`No Pump.fun bonding curve found for mint ${mintAddr}`);
  }

  const data = Buffer.from(acct.data);
  if (data.length < 49) {
    throw new Error(`Bonding curve data too short (${data.length} bytes) for mint ${mintAddr}`);
  }

  const virtualTokenReserves = readU64LE(data, 8);
  const virtualSolReserves = readU64LE(data, 16);
  const realTokenReserves = readU64LE(data, 24);
  const realSolReserves = readU64LE(data, 32);
  const tokenTotalSupply = readU64LE(data, 40);
  const complete = data.readUInt8(48) === 1;

  const priceInSol = virtualTokenReserves > 0n
    ? Number(virtualSolReserves) / 1e9 / (Number(virtualTokenReserves) / 1e6)
    : 0;

  const initialTokenReserves = 793_100_000_000_000n;
  const tokensSold = initialTokenReserves > realTokenReserves
    ? Number(initialTokenReserves - realTokenReserves) / 1e6
    : 0;
  const completionPct = Number(initialTokenReserves) > 0
    ? (tokensSold / (Number(initialTokenReserves) / 1e6)) * 100
    : 0;

  let creator = null;
  if (data.length >= 81) {
    const creatorBytes = data.subarray(49, 81);
    const isZero = creatorBytes.every(b => b === 0);
    if (!isZero) creator = readPublicKey(data, 49);
  }

  return {
    dex: "Pump.fun", mint: mintAddr, bondingCurve: pda.toBase58(),
    virtualTokenReserves: Number(virtualTokenReserves),
    virtualSolReserves: Number(virtualSolReserves),
    realTokenReserves: Number(realTokenReserves),
    realSolReserves: Number(realSolReserves),
    tokenTotalSupply: Number(tokenTotalSupply),
    complete, creator, priceInSol,
    completionPct: Math.min(completionPct, 100),
  };
}

// ─── PumpSwap ───────────────────────────────────────────────────────────────

export async function getPumpSwapPoolInfo(conn, poolAddr) {
  const pubkey = new PublicKey(poolAddr);
  const acct = await conn.getAccountInfo(pubkey);
  if (!acct || !acct.data) {
    throw new Error(`Not a valid PumpSwap pool: ${poolAddr}`);
  }
  if (acct.owner.toBase58() !== PUMP_SWAP) {
    throw new Error(`Account owner is ${acct.owner.toBase58()}, expected PumpSwap (${PUMP_SWAP})`);
  }

  const data = Buffer.from(acct.data);
  let offset = 8;
  const poolBump = data.readUInt8(offset); offset += 1;
  const index = data.readUInt16LE(offset); offset += 2;
  const creator = readPublicKey(data, offset); offset += 32;
  const baseMint = readPublicKey(data, offset); offset += 32;
  const quoteMint = readPublicKey(data, offset); offset += 32;
  const lpMint = readPublicKey(data, offset); offset += 32;
  const poolBaseTokenAccount = readPublicKey(data, offset); offset += 32;
  const poolQuoteTokenAccount = readPublicKey(data, offset); offset += 32;
  const lpSupply = readU64LE(data, offset); offset += 8;

  const [baseBal, quoteBal] = await Promise.all([
    conn.getTokenAccountBalance(new PublicKey(poolBaseTokenAccount)),
    conn.getTokenAccountBalance(new PublicKey(poolQuoteTokenAccount)),
  ]);

  const baseReserve = Number(baseBal.value.uiAmount);
  const quoteReserve = Number(quoteBal.value.uiAmount);
  const price = baseReserve > 0 ? quoteReserve / baseReserve : 0;

  return {
    dex: "PumpSwap", pool: poolAddr, index, creator,
    baseMint, quoteMint, lpMint,
    reserves: { base: baseReserve, quote: quoteReserve },
    price, lpSupply: Number(lpSupply),
  };
}

// ─── Meteora DLMM ──────────────────────────────────────────────────────────

export async function getMeteoraDlmmInfo(conn, poolAddr) {
  const pubkey = new PublicKey(poolAddr);
  const acct = await conn.getAccountInfo(pubkey);
  if (!acct || !acct.data) {
    throw new Error(`Not a valid Meteora DLMM pool: ${poolAddr}`);
  }
  if (acct.owner.toBase58() !== METEORA_DLMM) {
    throw new Error(`Account owner is ${acct.owner.toBase58()}, expected Meteora DLMM (${METEORA_DLMM})`);
  }

  const data = Buffer.from(acct.data);
  const base_offset = 8;
  const activeId = data.readInt32LE(base_offset + 68);
  const binStep = data.readUInt16LE(base_offset + 72);
  const tokenXMint = readPublicKey(data, base_offset + 80);
  const tokenYMint = readPublicKey(data, base_offset + 112);
  const reserveX = readPublicKey(data, base_offset + 144);
  const reserveY = readPublicKey(data, base_offset + 176);

  const price = Math.pow(1 + binStep / 10000, activeId);

  let reserveXAmount = null;
  let reserveYAmount = null;
  try {
    const [xBal, yBal] = await Promise.all([
      conn.getTokenAccountBalance(new PublicKey(reserveX)),
      conn.getTokenAccountBalance(new PublicKey(reserveY)),
    ]);
    reserveXAmount = Number(xBal.value.uiAmount);
    reserveYAmount = Number(yBal.value.uiAmount);
  } catch { /* vault read optional */ }

  return {
    dex: "Meteora DLMM", pool: poolAddr,
    tokenXMint, tokenYMint, reserveX, reserveY,
    activeId, binStep, price,
    reserves: reserveXAmount != null ? { tokenX: reserveXAmount, tokenY: reserveYAmount } : null,
  };
}

// ─── Meteora CP-AMM ─────────────────────────────────────────────────────────

export async function getMeteoraCpInfo(conn, poolAddr) {
  const pubkey = new PublicKey(poolAddr);
  const acct = await conn.getAccountInfo(pubkey);
  if (!acct || !acct.data) {
    throw new Error(`Not a valid Meteora CP-AMM pool: ${poolAddr}`);
  }
  if (acct.owner.toBase58() !== METEORA_CPAMM) {
    throw new Error(`Account owner is ${acct.owner.toBase58()}, expected Meteora CP-AMM (${METEORA_CPAMM})`);
  }

  const data = Buffer.from(acct.data);
  const base_offset = 8;
  const config = readPublicKey(data, base_offset);
  const creator = readPublicKey(data, base_offset + 32);
  const tokenAMint = readPublicKey(data, base_offset + 64);
  const tokenBMint = readPublicKey(data, base_offset + 96);
  const tokenAVault = readPublicKey(data, base_offset + 128);
  const tokenBVault = readPublicKey(data, base_offset + 160);

  const [aBal, bBal] = await Promise.all([
    conn.getTokenAccountBalance(new PublicKey(tokenAVault)),
    conn.getTokenAccountBalance(new PublicKey(tokenBVault)),
  ]);

  const reserveA = Number(aBal.value.uiAmount);
  const reserveB = Number(bBal.value.uiAmount);
  const price = reserveA > 0 ? reserveB / reserveA : 0;

  return {
    dex: "Meteora CP-AMM", pool: poolAddr,
    config, creator, tokenAMint, tokenBMint, tokenAVault, tokenBVault,
    reserves: { tokenA: reserveA, tokenB: reserveB }, price,
  };
}

// ─── Cross-DEX Search ───────────────────────────────────────────────────────

export async function searchSolPools(conn, tokenMint) {
  const results = [];

  const [rayCoin, rayPc, dlmmX, dlmmY, cpA, cpB] = await Promise.all([
    conn.getProgramAccounts(new PublicKey(RAYDIUM_V4), {
      filters: [{ dataSize: 752 }, { memcmp: { offset: 400, bytes: tokenMint } }],
      dataSlice: { offset: 0, length: 0 },
    }).catch(() => []),
    conn.getProgramAccounts(new PublicKey(RAYDIUM_V4), {
      filters: [{ dataSize: 752 }, { memcmp: { offset: 432, bytes: tokenMint } }],
      dataSlice: { offset: 0, length: 0 },
    }).catch(() => []),
    conn.getProgramAccounts(new PublicKey(METEORA_DLMM), {
      filters: [{ memcmp: { offset: 88, bytes: tokenMint } }],
      dataSlice: { offset: 0, length: 0 },
    }).catch(() => []),
    conn.getProgramAccounts(new PublicKey(METEORA_DLMM), {
      filters: [{ memcmp: { offset: 120, bytes: tokenMint } }],
      dataSlice: { offset: 0, length: 0 },
    }).catch(() => []),
    conn.getProgramAccounts(new PublicKey(METEORA_CPAMM), {
      filters: [{ memcmp: { offset: 72, bytes: tokenMint } }],
      dataSlice: { offset: 0, length: 0 },
    }).catch(() => []),
    conn.getProgramAccounts(new PublicKey(METEORA_CPAMM), {
      filters: [{ memcmp: { offset: 104, bytes: tokenMint } }],
      dataSlice: { offset: 0, length: 0 },
    }).catch(() => []),
  ]);

  for (const acct of [...rayCoin, ...rayPc]) {
    results.push({ dex: "Raydium AMM v4", pool: acct.pubkey.toBase58() });
  }
  for (const acct of [...dlmmX, ...dlmmY]) {
    results.push({ dex: "Meteora DLMM", pool: acct.pubkey.toBase58() });
  }
  for (const acct of [...cpA, ...cpB]) {
    results.push({ dex: "Meteora CP-AMM", pool: acct.pubkey.toBase58() });
  }

  // Pump.fun: check if bonding curve PDA exists
  try {
    const mintPubkey = new PublicKey(tokenMint);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
      new PublicKey(PUMP_FUN)
    );
    const acct = await conn.getAccountInfo(pda);
    if (acct) {
      results.push({ dex: "Pump.fun", pool: pda.toBase58(), type: "bonding-curve" });
    }
  } catch { /* not a pump token */ }

  // Deduplicate
  const seen = new Set();
  return results.filter(r => {
    const key = `${r.dex}:${r.pool}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getSolNewPools(conn, limit) {
  const programs = [
    { id: RAYDIUM_V4, name: "Raydium AMM v4" },
    { id: PUMP_SWAP, name: "PumpSwap" },
    { id: METEORA_DLMM, name: "Meteora DLMM" },
    { id: METEORA_CPAMM, name: "Meteora CP-AMM" },
  ];

  const sigArrays = await Promise.all(
    programs.map(p =>
      conn.getSignaturesForAddress(new PublicKey(p.id), { limit: limit * 2 })
        .then(sigs => sigs.map(s => ({ ...s, dex: p.name })))
        .catch(() => [])
    )
  );

  const allSigs = sigArrays.flat();
  allSigs.sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));

  return allSigs.slice(0, limit).map(s => ({
    dex: s.dex, signature: s.signature,
    blockTime: s.blockTime, slot: s.slot,
    err: s.err, memo: s.memo,
  }));
}
