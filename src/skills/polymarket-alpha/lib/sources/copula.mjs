// polymarket-alpha — copula-based correlated outcome simulation
// Detects mispriced joint prediction market events via Gaussian & Student-t copulas.
// Pure JS, no external deps. Based on gemchange quant thread methodology.

// ── Cache ──────────────────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 5 * 60_000; // 5 min

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value) {
  _cache.set(key, { value, ts: Date.now() });
}

// ── RNG helpers ────────────────────────────────────────────

/** Box-Muller transform: returns two independent standard normals. */
function boxMuller() {
  let u1, u2;
  do { u1 = Math.random(); } while (u1 === 0);
  u2 = Math.random();
  const r = Math.sqrt(-2.0 * Math.log(u1));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

/** Generate n standard normal samples. */
function randn(n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const [a, b] = boxMuller();
    out[i] = a;
    if (i + 1 < n) out[i + 1] = b;
  }
  return out;
}

/** Chi-squared sample with df degrees of freedom (sum of squared normals). */
function chiSquaredSample(df) {
  let s = 0;
  for (let i = 0; i < df; i++) {
    const [z] = boxMuller();
    s += z * z;
  }
  return s;
}

// ── Normal CDF (Abramowitz & Stegun rational approx) ──────

function normalCDF(x) {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1.0 / (1.0 + p * Math.abs(x));
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1.0 + sign * y);
}

/** Inverse normal CDF (rational approximation, Beasley-Springer-Moro). */
function normalQuantile(p) {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  if (p === 0.5) return 0;

  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02,
    -2.759285104469687e+02, 1.383577518672690e+02,
    -3.066479806614716e+01, 2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02,
    -1.556989798598866e+02, 6.680131188771972e+01,
    -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01,
    -2.400758277161838e+00, -2.549732539343734e+00,
    4.374664141464968e+00, 2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01,
    2.445134137142996e+00, 3.754408661907416e+00,
  ];

  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

/**
 * Approximate t-CDF for nu >= 4.
 * Uses the normal approximation adjusted by kurtosis:
 *   t_nu(x) ≈ Phi(x * (1 - 1/(4*nu)))
 * Good enough for copula work where we only need the CDF to
 * map to uniform marginals.
 */
function tCDF(x, nu) {
  if (nu >= 30) return normalCDF(x);
  // Cornish-Fisher-style adjustment
  const adj = x * (1 - 1 / (4 * nu));
  return normalCDF(adj);
}

// ── Cholesky decomposition ─────────────────────────────────

/**
 * Lower-triangular Cholesky factorization for small PD matrices (max ~10x10).
 * @param {number[][]} A — symmetric positive-definite matrix
 * @returns {number[][]} L such that A = L * L^T
 */
function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        const diag = A[i][i] - sum;
        if (diag <= 0) {
          // Not positive definite — add small jitter
          L[i][j] = Math.sqrt(Math.max(1e-10, diag));
        } else {
          L[i][j] = Math.sqrt(diag);
        }
      } else {
        L[i][j] = (A[i][j] - sum) / L[j][j];
      }
    }
  }
  return L;
}

// ── Gaussian Copula ────────────────────────────────────────

/**
 * Simulate joint outcomes via Gaussian copula.
 *
 * @param {number[]} probs — marginal probabilities (each in [0,1])
 * @param {number[][]} corrMatrix — correlation matrix (n x n)
 * @param {number} [nSims=50000] — number of Monte Carlo simulations
 * @returns {{ jointProbs: number[][], sweepProb: number, allFailProb: number }}
 */
export function simulateGaussianCopula(probs, corrMatrix, nSims = 50_000) {
  const cacheKey = `gcop:${probs.map(p => p.toFixed(4)).join(",")}:${nSims}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const n = probs.length;
  const L = cholesky(corrMatrix);

  // Pre-compute thresholds: market resolves YES if uniform < prob
  const thresholds = probs.map((p) => normalQuantile(p));

  let sweepCount = 0;
  let allFailCount = 0;
  // Joint probability matrix: jointProbs[i][j] = P(market_i=YES AND market_j=YES)
  const jointCounts = Array.from({ length: n }, () => new Float64Array(n));

  for (let s = 0; s < nSims; s++) {
    // Generate independent normals
    const z = randn(n);

    // Correlate via Cholesky: x = L * z
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += L[i][j] * z[j];
      x[i] = sum;
    }

    // Determine outcomes: market resolves YES if x[i] < threshold[i]
    const outcomes = new Uint8Array(n);
    let allYes = true, allNo = true;
    for (let i = 0; i < n; i++) {
      outcomes[i] = x[i] < thresholds[i] ? 1 : 0;
      if (outcomes[i] === 0) allYes = false;
      if (outcomes[i] === 1) allNo = false;
    }

    if (allYes) sweepCount++;
    if (allNo) allFailCount++;

    // Count joint occurrences
    for (let i = 0; i < n; i++) {
      if (!outcomes[i]) continue;
      for (let j = i; j < n; j++) {
        if (outcomes[j]) {
          jointCounts[i][j]++;
          if (i !== j) jointCounts[j][i]++;
        }
      }
    }
  }

  const jointProbs = jointCounts.map((row) =>
    Array.from(row, (c) => Math.round((c / nSims) * 10000) / 10000),
  );

  const result = {
    jointProbs,
    sweepProb: Math.round((sweepCount / nSims) * 100000) / 100000,
    allFailProb: Math.round((allFailCount / nSims) * 100000) / 100000,
  };

  cacheSet(cacheKey, result);
  return result;
}

// ── Student-t Copula ───────────────────────────────────────

/**
 * Simulate joint outcomes via Student-t copula (captures tail dependence).
 *
 * @param {number[]} probs — marginal probabilities
 * @param {number[][]} corrMatrix — correlation matrix
 * @param {number} [nu=5] — degrees of freedom (lower = heavier tails)
 * @param {number} [nSims=50000]
 * @returns {{ jointProbs: number[][], sweepProb: number, allFailProb: number, tailDependence: number }}
 */
export function simulateTCopula(probs, corrMatrix, nu = 5, nSims = 50_000) {
  const cacheKey = `tcop:${probs.map(p => p.toFixed(4)).join(",")}:${nu}:${nSims}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const n = probs.length;
  const L = cholesky(corrMatrix);
  const thresholds = probs.map((p) => normalQuantile(p));

  let sweepCount = 0;
  let allFailCount = 0;
  const jointCounts = Array.from({ length: n }, () => new Float64Array(n));

  // For tail dependence estimation: count joint extremes
  let jointExtremeCount = 0;
  let extremeCount = 0;
  const extremeThreshold = 0.05; // 5th percentile

  for (let s = 0; s < nSims; s++) {
    // Generate correlated normals
    const z = randn(n);
    const correlated = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += L[i][j] * z[j];
      correlated[i] = sum;
    }

    // Generate chi-squared / nu for t-distribution scaling
    const w = chiSquaredSample(nu) / nu;
    const sqrtW = Math.sqrt(w);

    // Scale to t-distributed: t = correlated / sqrt(w)
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = correlated[i] / sqrtW;
    }

    // Map through t-CDF to get uniform marginals, then to outcomes
    const outcomes = new Uint8Array(n);
    let allYes = true, allNo = true;
    for (let i = 0; i < n; i++) {
      const u = tCDF(t[i], nu);
      // Market resolves YES if u < prob (same logic as Gaussian but via t-CDF)
      outcomes[i] = u < probs[i] ? 1 : 0;
      if (outcomes[i] === 0) allYes = false;
      if (outcomes[i] === 1) allNo = false;
    }

    if (allYes) sweepCount++;
    if (allNo) allFailCount++;

    // Tail dependence: check if first two markets are both in lower tail
    if (n >= 2) {
      const u0 = tCDF(t[0], nu);
      const u1 = tCDF(t[1], nu);
      if (u0 < extremeThreshold) {
        extremeCount++;
        if (u1 < extremeThreshold) jointExtremeCount++;
      }
    }

    for (let i = 0; i < n; i++) {
      if (!outcomes[i]) continue;
      for (let j = i; j < n; j++) {
        if (outcomes[j]) {
          jointCounts[i][j]++;
          if (i !== j) jointCounts[j][i]++;
        }
      }
    }
  }

  const jointProbs = jointCounts.map((row) =>
    Array.from(row, (c) => Math.round((c / nSims) * 10000) / 10000),
  );

  const tailDep = extremeCount > 0
    ? Math.round((jointExtremeCount / extremeCount) * 10000) / 10000
    : 0;

  const result = {
    jointProbs,
    sweepProb: Math.round((sweepCount / nSims) * 100000) / 100000,
    allFailProb: Math.round((allFailCount / nSims) * 100000) / 100000,
    tailDependence: tailDep,
  };

  cacheSet(cacheKey, result);
  return result;
}

// ── Keyword-overlap correlation estimation ─────────────────

/**
 * Estimate pairwise correlations from question text similarity.
 * Uses simple keyword overlap (Jaccard index scaled to [-0.2, 0.8]).
 */
function estimateCorrelations(markets) {
  const n = markets.length;
  const tokenSets = markets.map((m) => {
    const q = (m.question || "").toLowerCase();
    const tokens = q
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    return new Set(tokens);
  });

  const corr = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));

  for (let i = 0; i < n; i++) {
    corr[i][i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const setA = tokenSets[i];
      const setB = tokenSets[j];
      let intersection = 0;
      for (const w of setA) {
        if (setB.has(w)) intersection++;
      }
      const union = setA.size + setB.size - intersection;
      const jaccard = union > 0 ? intersection / union : 0;
      // Scale jaccard [0,1] to correlation [-0.2, 0.8]
      const rho = Math.max(-0.2, Math.min(0.8, jaccard * 1.0 - 0.2));
      corr[i][j] = rho;
      corr[j][i] = rho;
    }
  }

  return corr;
}

const STOP_WORDS = new Set([
  "the", "will", "this", "that", "and", "for", "are", "but", "not",
  "you", "all", "can", "her", "was", "one", "our", "out", "has",
  "have", "been", "from", "with", "they", "its", "than", "more",
  "before", "after", "above", "below", "yes", "what", "when",
]);

// ── Main analysis function ─────────────────────────────────

/**
 * Analyze a set of related markets for correlated outcome mispricing.
 *
 * @param {Array<{question: string, price: number}>} markets
 * @returns {{ markets: Array<{question: string, price: number}>, sweepProb: object, tailDependence: number, mispricing: boolean }}
 */
export function analyzeCorrelatedMarkets(markets) {
  if (!markets || markets.length < 2) {
    return { markets: markets || [], sweepProb: null, tailDependence: 0, mispricing: false };
  }

  // Cap at 10 markets for performance
  const subset = markets.slice(0, 10);
  const probs = subset.map((m) => Math.max(0.01, Math.min(0.99, m.price || 0.5)));

  const cacheKey = `corr:${probs.map(p => p.toFixed(3)).join(",")}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const corrMatrix = estimateCorrelations(subset);

  // Independent assumption: P(all YES) = product of marginals
  const independentSweep = probs.reduce((acc, p) => acc * p, 1);

  // Gaussian copula
  const gaussian = simulateGaussianCopula(probs, corrMatrix, 50_000);

  // Student-t copula (nu=5 for moderate tail dependence)
  const tCopulaResult = simulateTCopula(probs, corrMatrix, 5, 50_000);

  // Mispricing flag: t-copula joint prob differs > 20% from independent
  const tSweep = tCopulaResult.sweepProb;
  const relDiff = independentSweep > 0
    ? Math.abs(tSweep - independentSweep) / independentSweep
    : 0;
  const mispricing = relDiff > 0.20 && Math.abs(tSweep - independentSweep) > 0.005;

  const result = {
    markets: subset.map((m) => ({ question: m.question, price: m.price })),
    correlationMatrix: corrMatrix,
    sweepProb: {
      independent: Math.round(independentSweep * 100000) / 100000,
      gaussian: gaussian.sweepProb,
      tCopula: tSweep,
    },
    allFailProb: {
      independent: Math.round(probs.reduce((acc, p) => acc * (1 - p), 1) * 100000) / 100000,
      gaussian: gaussian.allFailProb,
      tCopula: tCopulaResult.allFailProb,
    },
    tailDependence: tCopulaResult.tailDependence,
    mispricing,
    mispricingDetail: mispricing
      ? `t-copula sweep prob ${(tSweep * 100).toFixed(3)}% vs independent ${(independentSweep * 100).toFixed(3)}% (${(relDiff * 100).toFixed(1)}% relative diff)`
      : null,
  };

  cacheSet(cacheKey, result);
  return result;
}

// ── Status (always ok — pure computation) ──────────────────

export function status() {
  return { ok: true, source: "copula", type: "computation", note: "Pure JS copula simulation, no external API" };
}
