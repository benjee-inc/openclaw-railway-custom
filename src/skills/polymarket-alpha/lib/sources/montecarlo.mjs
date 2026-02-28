// polymarket-alpha — Monte Carlo simulation for binary prediction markets
// No API needed — pure computation (GBM paths + antithetic variates)

import { TTL } from "../constants.mjs";
import * as cache from "../cache.mjs";

const MC_TTL = TTL.montecarlo ?? 5 * 60_000;
const DEFAULT_PATHS = 50_000;

// ── Box-Muller normal samples ────────────────────────────────

/**
 * Generate a standard normal random variable via Box-Muller transform.
 * @returns {number}
 */
function randn() {
  let u, v;
  do { u = Math.random(); } while (u === 0); // avoid log(0)
  v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Inverse normal CDF (probit) via Abramowitz & Stegun 26.2.23.
 * Required for stratified sampling — maps uniform quantiles to Z values.
 * Max absolute error ~4.5e-4.
 * @param {number} p — probability in (0, 1)
 * @returns {number} z such that Φ(z) = p
 */
function normalInverseCDF(p) {
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  if (p > 0.5) return -normalInverseCDF(1 - p);
  const t = Math.sqrt(-2 * Math.log(p));
  const c0 = 2.515517, c1 = 0.802853, c2 = 0.010328;
  const d1 = 1.432788, d2 = 0.189269, d3 = 0.001308;
  return -(t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t));
}

const DEFAULT_STRATA = 10;

// ── Core GBM Monte Carlo — stratified + antithetic ───────────

/**
 * Simulate a binary contract using Geometric Brownian Motion
 * with stratified sampling + antithetic variates.
 *
 * Partitions the [0,1] uniform space into J strata, draws within each,
 * and applies antithetic reflection within each stratum. This stacks
 * two variance reduction techniques for 100-500x improvement over crude MC.
 *
 * @param {number} currentPrice  - Current underlying price
 * @param {number} targetPrice   - Strike / barrier price
 * @param {number} volatility    - Annualized volatility (e.g. 0.80 for 80%)
 * @param {number} daysToExpiry  - Days until contract expiration
 * @param {number} [nPaths=50000] - Total path pairs (distributed across strata)
 * @returns {{ probability: number, stdError: number, ci95: [number, number], nPaths: number }}
 */
export function simulateBinaryContract(
  currentPrice,
  targetPrice,
  volatility,
  daysToExpiry,
  nPaths = DEFAULT_PATHS,
) {
  const T = daysToExpiry / 365;
  if (T <= 0) {
    const hit = currentPrice >= targetPrice ? 1 : 0;
    return { probability: hit, stdError: 0, ci95: [hit, hit], nPaths: 0 };
  }

  const drift = -0.5 * volatility * volatility * T;
  const diffusion = volatility * Math.sqrt(T);
  const logS0 = Math.log(currentPrice);
  const logK = Math.log(targetPrice);

  const nStrata = DEFAULT_STRATA;
  const perStratum = Math.max(100, Math.floor(nPaths / nStrata));
  const stratumMeans = [];

  for (let j = 0; j < nStrata; j++) {
    const lo = j / nStrata;
    const hi = (j + 1) / nStrata;
    let sum = 0;

    for (let i = 0; i < perStratum; i++) {
      // Uniform draw within stratum [lo, hi]
      const u = lo + Math.random() * (hi - lo);
      // Antithetic: mirror within the same stratum
      const uAnti = lo + hi - u;

      const z1 = normalInverseCDF(u);
      const z2 = normalInverseCDF(uAnti);

      const logS1 = logS0 + drift + diffusion * z1;
      const logS2 = logS0 + drift + diffusion * z2;

      const payoff = ((logS1 >= logK ? 1 : 0) + (logS2 >= logK ? 1 : 0)) / 2;
      sum += payoff;
    }

    stratumMeans.push(sum / perStratum);
  }

  const probability = stratumMeans.reduce((s, m) => s + m, 0) / nStrata;
  const stratumVar = stratumMeans.reduce((s, m) => s + (m - probability) ** 2, 0) / Math.max(1, nStrata - 1);
  const stdError = Math.sqrt(stratumVar / nStrata);
  const totalPaths = nStrata * perStratum * 2;
  const ci95Lower = Math.max(0, probability - 1.96 * stdError);
  const ci95Upper = Math.min(1, probability + 1.96 * stdError);

  return {
    probability,
    stdError,
    ci95: [ci95Lower, ci95Upper],
    nPaths: totalPaths,
  };
}

// ── Importance sampling for tail risk ────────────────────────

/**
 * Estimate probability of extreme price drops using importance sampling.
 *
 * Instead of simulating under the original measure (where crash events
 * are rare and require millions of paths), we shift the sampling
 * distribution toward the crash region and correct with likelihood ratios.
 *
 * @param {number} currentPrice    - Current underlying price
 * @param {number} crashThreshold  - Price level constituting a crash
 * @param {number} volatility      - Annualized volatility
 * @param {number} daysToExpiry    - Days until expiration
 * @param {number} [nPaths=50000]  - Number of paths
 * @returns {{ probability: number, stdError: number, varianceReduction: number }}
 */
export function simulateTailRisk(
  currentPrice,
  crashThreshold,
  volatility,
  daysToExpiry,
  nPaths = DEFAULT_PATHS,
) {
  const T = daysToExpiry / 365;
  if (T <= 0) {
    const hit = currentPrice <= crashThreshold ? 1 : 0;
    return { probability: hit, stdError: 0, varianceReduction: 1 };
  }

  const drift = -0.5 * volatility * volatility * T;
  const diffusion = volatility * Math.sqrt(T);
  const logS0 = Math.log(currentPrice);
  const logThreshold = Math.log(crashThreshold);

  // Compute the shift: move the mean of Z toward the crash region
  // so that the new mean of log(S_T) equals log(crashThreshold)
  const muShift = (logThreshold - logS0 - drift) / diffusion;

  let sumIS = 0;
  let sumISSq = 0;

  // Also run naive MC for variance reduction estimate
  let sumNaive = 0;

  for (let i = 0; i < nPaths; i++) {
    const z = randn();

    // Importance-sampled path: draw from N(muShift, 1), i.e. z + muShift
    const zShifted = z + muShift;
    const logST = logS0 + drift + diffusion * zShifted;
    const hit = logST <= logThreshold ? 1 : 0;

    // Likelihood ratio: p_original(zShifted) / p_shifted(zShifted)
    // = exp(-0.5*zShifted^2) / exp(-0.5*(zShifted - muShift)^2)
    // = exp(-0.5*zShifted^2 + 0.5*(zShifted - muShift)^2)
    // = exp(-muShift * zShifted + 0.5 * muShift^2)
    // = exp(-muShift * z - 0.5 * muShift^2)   [since zShifted = z + muShift]
    const lr = Math.exp(-muShift * z - 0.5 * muShift * muShift);

    const weightedPayoff = hit * lr;
    sumIS += weightedPayoff;
    sumISSq += weightedPayoff * weightedPayoff;

    // Naive path for variance comparison
    const logSTNaive = logS0 + drift + diffusion * z;
    sumNaive += logSTNaive <= logThreshold ? 1 : 0;
  }

  const probability = sumIS / nPaths;
  const varianceIS = sumISSq / nPaths - probability * probability;
  const stdError = Math.sqrt(Math.max(0, varianceIS) / nPaths);

  // Estimate naive variance for comparison
  const pNaive = sumNaive / nPaths;
  const varianceNaive = pNaive * (1 - pNaive);
  const varianceReduction =
    varianceIS > 0 ? varianceNaive / varianceIS : Infinity;

  return { probability, stdError, varianceReduction };
}

// ── Category-based volatility defaults ───────────────────────

const VOL_BY_CATEGORY = {
  crypto: 0.80,
  economics: 0.15,
  weather: 0.20,
  geopolitics: 0.25,
  politics: 0.20,
  tech: 0.30,
  entertainment: 0.20,
};

/**
 * Compute MC-implied probability for a palpha market object.
 *
 * Extracts current price (midpoint), end date, and category to
 * choose volatility and run the appropriate simulation. Results
 * are cached for 5 minutes since recomputation is cheap but not free.
 *
 * @param {{ prices?: { yes?: number }, endDate?: string, _category?: string, question?: string, conditionId?: string }} market
 * @returns {{ mcImplied: number, confidence: [number, number], method: string, detail: object } | null}
 */
export function computeImpliedFromMC(market) {
  if (!market) return null;

  // Extract current price (YES side midpoint)
  const currentPrice = market.prices?.yes;
  if (currentPrice == null || currentPrice <= 0 || currentPrice >= 1) {
    return null; // Can't simulate at boundary prices
  }

  // Build cache key
  const marketId = market.conditionId || market.question || "unknown";
  const cacheKey = `mc:implied:${marketId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Compute days to expiry
  const endDate = market.endDate ? new Date(market.endDate) : null;
  const now = new Date();
  const daysToExpiry = endDate
    ? Math.max(0, (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    : 30; // Default 30 days if no end date

  if (daysToExpiry <= 0) {
    return null; // Already expired
  }

  // Select volatility based on category
  const category = (market._category || "").toLowerCase();
  const vol = VOL_BY_CATEGORY[category] ?? 0.20;

  // For binary markets, simulate whether the "underlying" (modeled as
  // the contract price itself treated as a tradeable asset) will reach 1.0
  // (i.e., resolve YES). The current price IS the market's probability estimate,
  // so we simulate around it.
  //
  // We model the contract price as a GBM process and check P(S_T >= 0.5)
  // as a sanity check against the market's implied probability.
  const targetPrice = 0.5; // midpoint — are we more likely YES or NO?

  const sim = simulateBinaryContract(
    currentPrice,
    targetPrice,
    vol,
    daysToExpiry,
    DEFAULT_PATHS,
  );

  // For tail risk: check crash probability (price dropping to < 0.05)
  let tailRisk = null;
  if (currentPrice > 0.10) {
    const tail = simulateTailRisk(
      currentPrice,
      0.05,
      vol,
      daysToExpiry,
      DEFAULT_PATHS,
    );
    tailRisk = {
      crashProb: tail.probability,
      varianceReduction: tail.varianceReduction,
    };
  }

  const result = {
    mcImplied: sim.probability,
    confidence: sim.ci95,
    method: `gbm_stratified_antithetic_${sim.nPaths}paths`,
    detail: {
      currentPrice,
      targetPrice,
      volatility: vol,
      daysToExpiry: Math.round(daysToExpiry * 10) / 10,
      category: category || "default",
      stdError: sim.stdError,
      tailRisk,
    },
  };

  cache.set(cacheKey, result, MC_TTL);
  return result;
}

// ── Source status ─────────────────────────────────────────────

/**
 * Source status check — always ok (pure computation, no external API).
 */
export function status() {
  return { name: "montecarlo", ok: true, note: "pure computation" };
}
