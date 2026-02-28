// polymarket-alpha — Sequential Monte Carlo (particle filter) for probability estimation
// Pure computation, no external dependencies or API calls

import * as cache from "../cache.mjs";

const CACHE_TTL = 120_000; // 2 minutes

// --- Math helpers ---

function logit(p) {
  const clamped = Math.max(1e-8, Math.min(1 - 1e-8, p));
  return Math.log(clamped / (1 - clamped));
}

function expit(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Box-Muller transform: generate a standard normal random variate.
 */
function randn() {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// --- ParticleFilter class ---

/**
 * Sequential Monte Carlo particle filter for 1D probability estimation.
 * State space is logit(probability); observations are market prices.
 */
export class ParticleFilter {
  /**
   * @param {number} priorProb - initial probability estimate (0,1)
   * @param {number} nParticles - number of particles
   * @param {number} processVol - volatility of the logit random walk
   * @param {number} obsNoise - observation noise std dev (in probability space)
   */
  constructor(priorProb = 0.5, nParticles = 2000, processVol = 0.05, obsNoise = 0.03) {
    this.n = nParticles;
    this.processVol = processVol;
    this.obsNoise = obsNoise;
    this.nUpdates = 0;

    // Initialize particles around prior in logit space
    const priorLogit = logit(priorProb);
    this.particles = new Float64Array(this.n);
    this.weights = new Float64Array(this.n);
    const initW = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      this.particles[i] = priorLogit + randn() * 0.1;
      this.weights[i] = initW;
    }
  }

  /**
   * Incorporate a new observed price. Propagate, reweight, resample if needed.
   * @param {number} observedPrice - market price in (0,1)
   */
  update(observedPrice) {
    const obs = Math.max(1e-8, Math.min(1 - 1e-8, observedPrice));

    // 1. Propagate: logit random walk
    for (let i = 0; i < this.n; i++) {
      this.particles[i] += randn() * this.processVol;
    }

    // 2. Reweight: Gaussian likelihood in probability space
    const twoSigmaSq = 2 * this.obsNoise * this.obsNoise;
    let sumW = 0;
    for (let i = 0; i < this.n; i++) {
      const predicted = expit(this.particles[i]);
      const diff = predicted - obs;
      const likelihood = Math.exp(-(diff * diff) / twoSigmaSq);
      this.weights[i] *= likelihood;
      sumW += this.weights[i];
    }

    // Normalize weights
    if (sumW > 0) {
      for (let i = 0; i < this.n; i++) {
        this.weights[i] /= sumW;
      }
    } else {
      // Degenerate case: reset to uniform
      const w = 1 / this.n;
      for (let i = 0; i < this.n; i++) {
        this.weights[i] = w;
      }
    }

    // 3. Resample if ESS < N/2
    const ess = this._effectiveSampleSize();
    if (ess < this.n / 2) {
      this._systematicResample();
    }

    this.nUpdates++;
  }

  /**
   * Weighted mean probability estimate.
   * @returns {number}
   */
  estimate() {
    let sum = 0;
    for (let i = 0; i < this.n; i++) {
      sum += this.weights[i] * expit(this.particles[i]);
    }
    return sum;
  }

  /**
   * Weighted quantile credible interval.
   * @param {number} alpha - significance level (default 0.05 for 95% CI)
   * @returns {{ lower: number, upper: number }}
   */
  credibleInterval(alpha = 0.05) {
    // Build sorted (prob, weight) pairs
    const pairs = [];
    for (let i = 0; i < this.n; i++) {
      pairs.push({ prob: expit(this.particles[i]), w: this.weights[i] });
    }
    pairs.sort((a, b) => a.prob - b.prob);

    const lowerTarget = alpha / 2;
    const upperTarget = 1 - alpha / 2;
    let cumW = 0;
    let lower = pairs[0].prob;
    let upper = pairs[pairs.length - 1].prob;

    for (const { prob, w } of pairs) {
      cumW += w;
      if (cumW >= lowerTarget && lower === pairs[0].prob) {
        lower = prob;
      }
      if (cumW >= upperTarget) {
        upper = prob;
        break;
      }
    }

    return { lower, upper };
  }

  /**
   * Return serializable state summary.
   * @returns {{ estimate: number, ci95: { lower: number, upper: number }, nEffective: number, nUpdates: number }}
   */
  getState() {
    return {
      estimate: this.estimate(),
      ci95: this.credibleInterval(0.05),
      nEffective: Math.round(this._effectiveSampleSize()),
      nUpdates: this.nUpdates,
    };
  }

  // --- Internal helpers ---

  /**
   * Effective sample size: 1 / sum(w_i^2).
   */
  _effectiveSampleSize() {
    let sumSq = 0;
    for (let i = 0; i < this.n; i++) {
      sumSq += this.weights[i] * this.weights[i];
    }
    return sumSq > 0 ? 1 / sumSq : 0;
  }

  /**
   * Systematic resampling (lower variance than multinomial).
   */
  _systematicResample() {
    const newParticles = new Float64Array(this.n);
    const cumWeights = new Float64Array(this.n);

    cumWeights[0] = this.weights[0];
    for (let i = 1; i < this.n; i++) {
      cumWeights[i] = cumWeights[i - 1] + this.weights[i];
    }

    const step = 1 / this.n;
    let u = Math.random() * step;
    let j = 0;

    for (let i = 0; i < this.n; i++) {
      while (j < this.n - 1 && u > cumWeights[j]) {
        j++;
      }
      newParticles[i] = this.particles[j];
      u += step;
    }

    this.particles = newParticles;
    const w = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      this.weights[i] = w;
    }
  }
}

// --- Module-level functions ---

/**
 * Run particle filter over a price history and return filtered estimate.
 * Results are cached per conditionId for 2 minutes.
 *
 * @param {number[]} priceHistory - array of observed prices in (0,1)
 * @param {string} [conditionId] - optional market ID for caching
 * @returns {{ filteredProb: number, ci95: { lower: number, upper: number }, smoothness: number, trend: string, nObservations: number }}
 */
export function filterMarketHistory(priceHistory, conditionId) {
  if (!priceHistory || priceHistory.length === 0) {
    return { filteredProb: 0.5, ci95: { lower: 0.5, upper: 0.5 }, smoothness: 1, trend: "stable", nObservations: 0 };
  }

  // Check cache
  if (conditionId) {
    const cacheKey = `pf:${conditionId}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }

  const pf = new ParticleFilter(priceHistory[0]);

  const filteredEstimates = [];
  for (const price of priceHistory) {
    pf.update(price);
    filteredEstimates.push(pf.estimate());
  }

  const filteredProb = filteredEstimates[filteredEstimates.length - 1];
  const ci95 = pf.credibleInterval(0.05);

  // Smoothness: ratio of filtered volatility to raw volatility
  const rawVol = _stddev(priceHistory);
  const filteredVol = _stddev(filteredEstimates);
  const smoothness = rawVol > 1e-12 ? filteredVol / rawVol : 1;

  // Trend: based on last N filtered estimates
  const trendWindow = Math.min(10, filteredEstimates.length);
  const recentSlice = filteredEstimates.slice(-trendWindow);
  const trend = _detectTrend(recentSlice);

  const result = {
    filteredProb,
    ci95,
    smoothness: Math.round(smoothness * 1000) / 1000,
    trend,
    nObservations: priceHistory.length,
  };

  if (conditionId) {
    cache.set(`pf:${conditionId}`, result, CACHE_TTL);
  }

  return result;
}

/**
 * Detect regime changes (sharp jumps) in filtered probability.
 *
 * @param {number[]} priceHistory - array of observed prices in (0,1)
 * @returns {Array<{ index: number, magnitude: number, direction: string }>}
 */
export function detectRegimeChange(priceHistory) {
  if (!priceHistory || priceHistory.length < 3) return [];

  const pf = new ParticleFilter(priceHistory[0]);
  const estimates = [];

  for (const price of priceHistory) {
    pf.update(price);
    estimates.push(pf.estimate());
  }

  const jumps = [];
  for (let i = 1; i < estimates.length; i++) {
    const delta = estimates[i] - estimates[i - 1];
    const magnitude = Math.abs(delta);
    if (magnitude > 0.05) { // > 5 percentage points
      jumps.push({
        index: i,
        magnitude: Math.round(magnitude * 10000) / 10000,
        direction: delta > 0 ? "up" : "down",
      });
    }
  }

  return jumps;
}

/**
 * Source status check. Always OK since this is pure computation.
 * @returns {{ name: string, ok: boolean }}
 */
export function status() {
  return { name: "particlefilter", ok: true };
}

// --- Private helpers ---

function _stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function _detectTrend(estimates) {
  if (estimates.length < 2) return "stable";

  // Simple linear regression slope
  const n = estimates.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += estimates[i];
    sumXY += i * estimates[i];
    sumXX += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);

  // Threshold: slope per step > 0.5pp = trending
  if (slope > 0.005) return "rising";
  if (slope < -0.005) return "falling";
  return "stable";
}
