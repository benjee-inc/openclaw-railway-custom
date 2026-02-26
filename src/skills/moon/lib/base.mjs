// moon/lib/base.mjs -- Base EVM functions (Uniswap V2, Aerodrome)

import { createPublicClient, http, formatUnits, getAddress } from "viem";
import { base } from "viem/chains";
import {
  BASE_RPC, UNISWAP_V2_FACTORY, AERODROME_FACTORY, BASE_WETH, BASE_USDC,
  ERC20_ABI, PAIR_ABI, FACTORY_ABI, AERO_FACTORY_ABI,
  PAIR_CREATED_TOPIC, POOL_CREATED_TOPIC,
} from "./constants.mjs";

export function getBaseClient() {
  return createPublicClient({ chain: base, transport: http(BASE_RPC) });
}

export async function getBaseTokenMeta(client, addr) {
  const address = getAddress(addr);
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: ERC20_ABI, functionName: "name" }).catch(() => "Unknown"),
    client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "???"),
    client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
  ]);
  return { address, name, symbol, decimals: Number(decimals) };
}

export async function getBasePairInfo(client, pairAddr) {
  const address = getAddress(pairAddr);
  const [token0, token1, reserves, factory] = await Promise.all([
    client.readContract({ address, abi: PAIR_ABI, functionName: "token0" }),
    client.readContract({ address, abi: PAIR_ABI, functionName: "token1" }),
    client.readContract({ address, abi: PAIR_ABI, functionName: "getReserves" }),
    client.readContract({ address, abi: PAIR_ABI, functionName: "factory" }).catch(() => null),
  ]);

  const [meta0, meta1] = await Promise.all([
    getBaseTokenMeta(client, token0),
    getBaseTokenMeta(client, token1),
  ]);

  const r0 = Number(formatUnits(reserves[0], meta0.decimals));
  const r1 = Number(formatUnits(reserves[1], meta1.decimals));
  const price = r0 > 0 ? r1 / r0 : 0;
  const priceInverse = r1 > 0 ? r0 / r1 : 0;

  let dex = "Unknown";
  if (factory) {
    const f = factory.toLowerCase();
    if (f === UNISWAP_V2_FACTORY.toLowerCase()) dex = "Uniswap V2";
    else if (f === AERODROME_FACTORY.toLowerCase()) dex = "Aerodrome";
  }

  return {
    dex, pair: address,
    token0: meta0, token1: meta1,
    reserves: { token0: r0, token1: r1 },
    price: { [`${meta1.symbol}/${meta0.symbol}`]: price, [`${meta0.symbol}/${meta1.symbol}`]: priceInverse },
    lastUpdate: Number(reserves[2]),
  };
}

export async function getBaseNewPairs(client, limit, dexFilter) {
  const blockNum = await client.getBlockNumber();
  const fromBlock = blockNum - 2000n;

  const topics = [];
  if (!dexFilter || dexFilter === "uniswap" || dexFilter === "uniswapv2" || dexFilter === "uniswap v2") {
    topics.push({ address: getAddress(UNISWAP_V2_FACTORY), topics: [PAIR_CREATED_TOPIC], fromBlock, toBlock: blockNum });
  }
  if (!dexFilter || dexFilter === "aerodrome" || dexFilter === "aero") {
    topics.push({ address: getAddress(AERODROME_FACTORY), topics: [POOL_CREATED_TOPIC], fromBlock, toBlock: blockNum });
  }

  const logArrays = await Promise.all(topics.map(t => client.getLogs(t).catch(() => [])));
  const allLogs = logArrays.flat();
  allLogs.sort((a, b) => Number(b.blockNumber - a.blockNumber));

  const results = [];
  for (const log of allLogs.slice(0, limit)) {
    const isAero = log.address.toLowerCase() === AERODROME_FACTORY.toLowerCase();
    const dex = isAero ? "Aerodrome" : "Uniswap V2";
    const token0 = "0x" + log.topics[1].slice(26);
    const token1 = "0x" + log.topics[2].slice(26);
    const pairAddr = "0x" + log.data.slice(26, 66);

    results.push({
      dex, pair: getAddress(pairAddr),
      token0: getAddress(token0), token1: getAddress(token1),
      block: Number(log.blockNumber), txHash: log.transactionHash,
    });
  }
  return results;
}

export async function searchBasePools(client, tokenAddr) {
  const token = getAddress(tokenAddr);
  const quoteTokens = [getAddress(BASE_WETH), getAddress(BASE_USDC)];
  const results = [];

  const calls = [];
  for (const quote of quoteTokens) {
    calls.push(
      client.readContract({
        address: getAddress(UNISWAP_V2_FACTORY), abi: FACTORY_ABI,
        functionName: "getPair", args: [token, quote],
      }).then(addr => ({ dex: "Uniswap V2", pair: addr, quote })).catch(() => null)
    );
    calls.push(
      client.readContract({
        address: getAddress(AERODROME_FACTORY), abi: AERO_FACTORY_ABI,
        functionName: "getPool", args: [token, quote, false],
      }).then(addr => ({ dex: "Aerodrome (volatile)", pair: addr, quote })).catch(() => null)
    );
    calls.push(
      client.readContract({
        address: getAddress(AERODROME_FACTORY), abi: AERO_FACTORY_ABI,
        functionName: "getPool", args: [token, quote, true],
      }).then(addr => ({ dex: "Aerodrome (stable)", pair: addr, quote })).catch(() => null)
    );
  }

  const settled = await Promise.all(calls);
  const ZERO = "0x0000000000000000000000000000000000000000";
  for (const r of settled) {
    if (r && r.pair && r.pair !== ZERO) {
      results.push({ dex: r.dex, pair: r.pair, quoteToken: r.quote });
    }
  }
  return results;
}
