// polymarket-alpha helpers — output, flag parsing, fetchJSON

/**
 * Print JSON to stdout (all CLI output goes through here).
 */
export function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Parse a CLI flag value from args array.
 * @param {string[]} args
 * @param {string} flag  e.g. "--top"
 * @param {string} defaultVal
 * @returns {string}
 */
export function parseFlag(args, flag, defaultVal) {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultVal;
  return args[idx + 1] ?? defaultVal;
}

/**
 * Check if a boolean flag exists in args.
 */
export function hasFlag(args, flag) {
  return args.includes(flag);
}

/**
 * Fetch JSON with timeout and error handling.
 * Uses Node 22 built-in fetch + AbortSignal.timeout.
 * @param {string} url
 * @param {object} [opts] - fetch options
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<any>}
 */
export async function fetchJSON(url, opts = {}, timeoutMs = 15_000) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Accept: "application/json",
      "User-Agent": "polymarket-alpha/1.0",
      ...opts.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  }
  return res.json();
}

/**
 * Fetch text (for XML APIs like arXiv).
 */
export async function fetchText(url, opts = {}, timeoutMs = 15_000) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "User-Agent": "polymarket-alpha/1.0",
      ...opts.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  }
  return res.text();
}

/**
 * Safe JSON parse for Polymarket array fields.
 */
export function tryJSON(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return null;
  try { return JSON.parse(v); } catch { return null; }
}

/**
 * Format helpers.
 */
export function fmtPct(n) { return `${(Number(n) * 100).toFixed(1)}%`; }

export function fmtVol(v) {
  const n = Number(v);
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function truncQ(q, max = 60) {
  return q.length > max ? q.slice(0, max - 1) + "..." : q;
}
