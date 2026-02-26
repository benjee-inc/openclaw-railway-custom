// moon/lib/helpers.mjs -- Shared utility functions

import { PublicKey } from "@solana/web3.js";

export function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

export function parseFlag(args, flag, defaultVal) {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultVal;
  return args[idx + 1] ?? defaultVal;
}

export function normalizeChain(c) {
  if (!c) return null;
  const lc = c.toLowerCase();
  if (lc === "base") return "base";
  if (lc === "sol" || lc === "solana") return "sol";
  return null;
}

export function readU64LE(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

export function readPublicKey(buf, offset) {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
}

export function shortAddr(addr) {
  if (!addr) return "???";
  if (addr.length <= 12) return addr;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

export function requireEnv(name, hint) {
  const val = process.env[name];
  if (!val) {
    const msg = hint
      ? `Missing required env var ${name}. ${hint}`
      : `Missing required env var ${name}.`;
    console.error(JSON.stringify({ error: true, message: msg }, null, 2));
    process.exit(1);
  }
  return val;
}

export function hasFlag(args, flag) {
  return args.includes(flag);
}

export function jupiterHeaders() {
  const h = { "Accept": "application/json" };
  if (process.env.JUPITER_API_KEY) {
    h["x-api-key"] = process.env.JUPITER_API_KEY;
  }
  return h;
}
