// polymarket-alpha — divergence scoring engine
// Compares market price vs alternative data to find mispricings

/**
 * Score a market's divergence from alt data.
 */
export function score(market, altData, params) {
  const cat = market._category;
  const marketPrice = market.prices?.[0] || 0; // YES price

  switch (cat) {
    case "weather": return scoreWeather(market, altData, params, marketPrice);
    case "crypto": return scoreCrypto(market, altData, params, marketPrice);
    case "economics": return scoreEconomics(market, altData, params, marketPrice);
    case "geopolitics": return scoreGeopolitics(market, altData, params, marketPrice);
    case "politics": return scorePoliticsGeneric(market, altData, params, marketPrice);
    case "tech": return scoreTech(market, altData, params, marketPrice);
    case "entertainment": return scorePoliticsGeneric(market, altData, params, marketPrice);
    default: return scorePoliticsGeneric(market, altData, params, marketPrice);
  }
}

// ── Weather scoring ────────────────────────────────────────

function scoreWeather(market, altData, params, marketPrice) {
  if (!altData.nws && !altData.ensemble && !params.threshold) {
    return scoreFromGdelt(altData, marketPrice, ["nws"], 0.4);
  }

  // If we have NWS data but no threshold, try to score from forecast text
  if (!params.threshold && altData.nws) {
    return scoreWeatherFromForecastText(market, altData, marketPrice);
  }

  if (!params.threshold) {
    return scoreFromGdelt(altData, marketPrice, ["nws"], 0.4);
  }

  const { threshold, direction } = params.threshold;
  const sources = [];
  let impliedProb = null;
  let confidence = 0.85;
  let detail = "";

  // Primary: NWS forecast
  if (altData.nws && (altData.nws.high != null || altData.nws.low != null)) {
    sources.push("nws");
    const forecastTemp = altData.nws.high ?? altData.nws.low;
    impliedProb = computeWeatherImplied(forecastTemp, threshold, direction);
    const unit = altData.nws.unit || "F";
    detail = `NWS forecast: ${forecastTemp}${unit}. Threshold: ${direction} ${threshold}${unit}. Implied: ${(impliedProb * 100).toFixed(0)}%, Market: ${(marketPrice * 100).toFixed(0)}%.`;
  }

  // Ensemble modifier: adjust confidence based on model agreement
  if (altData.ensemble) {
    sources.push("ensemble");
    const ens = altData.ensemble;

    if (ens.agreement === "high") {
      confidence = Math.min(0.95, confidence + 0.05);
      detail += ` Ensemble: models agree (spread ${ens.spread?.avgHigh || 0}F) — high confidence.`;
    } else if (ens.agreement === "very_low") {
      confidence = Math.max(0.4, confidence - 0.20);
      detail += ` Ensemble: models DISAGREE (spread ${ens.spread?.avgHigh || 0}F) — low confidence.`;
    } else if (ens.agreement === "low") {
      confidence = Math.max(0.5, confidence - 0.10);
      detail += ` Ensemble: moderate disagreement (spread ${ens.spread?.avgHigh || 0}F).`;
    }

    // If we have ensemble day forecasts but no NWS, use ensemble average
    if (impliedProb === null && ens.days?.[0]?.forecasts?.length > 0) {
      const forecasts = ens.days[0].forecasts;
      const avgHigh = forecasts.reduce((s, f) => s + (f.high || 0), 0) / forecasts.length;
      impliedProb = computeWeatherImplied(avgHigh, threshold, direction);
      detail = `Ensemble avg forecast: ${avgHigh.toFixed(0)}F. Threshold: ${direction} ${threshold}F. Agreement: ${ens.agreement}.`;
    }
  }

  // Monte Carlo implied probability modifier
  if (altData.montecarlo?.mcImplied != null) {
    sources.push("montecarlo");
    const mcImpl = altData.montecarlo.mcImplied;
    if (impliedProb != null) {
      // Blend MC estimate at 40% — stratified sampling provides tighter CI
      impliedProb = impliedProb * 0.60 + mcImpl * 0.40;
    } else {
      impliedProb = mcImpl;
    }
    confidence = Math.min(0.75, confidence + 0.05);
    detail += ` MC sim: ${(mcImpl * 100).toFixed(1)}% (${altData.montecarlo.method}).`;
  }

  if (impliedProb === null) {
    if (altData.nws?.periods?.length > 0) {
      return { divergence: 0, direction: "NEUTRAL", confidence: 0.3, alpha: 0,
        detail: "NWS forecast available but could not extract specific temperature match.",
        sources, altDataImplied: null };
    }
    return scoreFromGdelt(altData, marketPrice, sources, 0.4);
  }

  // Trends modifier: breakout search interest on weather event
  if (altData.trends?.isBreakout) {
    sources.push("trends");
    detail += ` Google Trends: breakout interest detected.`;
  }

  const divergence = impliedProb - marketPrice;
  const alpha = Math.abs(divergence) * confidence;
  const dir = divergence > 0 ? "UNDERPRICED_YES" : "OVERPRICED_YES";

  return { divergence, direction: dir, confidence, alpha, detail, sources, altDataImplied: impliedProb };
}

function scoreWeatherFromForecastText(market, altData, marketPrice) {
  const sources = ["nws"];
  const q = (market.question || "").toLowerCase();
  const periods = altData.nws?.periods || [];
  if (periods.length === 0) return scoreFromGdelt(altData, marketPrice, sources, 0.4);

  const forecasts = periods.map(p => (p.detailedForecast || p.shortForecast || "").toLowerCase()).join(" ");
  let impliedProb = null;
  let detail = "";
  let confidence = 0.55;

  // Snow detection
  if (q.includes("snow")) {
    const hasSnow = /snow|blizzard|wintry mix|ice storm/.test(forecasts);
    const heavySnow = /heavy snow|significant snow|blizzard|6.* inches|8.* inches|\d{2}.* inches/.test(forecasts);
    if (heavySnow) { impliedProb = 0.85; detail = "NWS: heavy snow in forecast."; }
    else if (hasSnow) { impliedProb = 0.65; detail = "NWS: snow mentioned in forecast."; }
    else { impliedProb = 0.10; detail = "NWS: no snow in forecast."; confidence = 0.6; }
  }
  // Rain detection
  else if (q.includes("rain") || q.includes("precipitation")) {
    const hasRain = /rain|showers|thunderstorm|precipitation/.test(forecasts);
    if (hasRain) { impliedProb = 0.70; detail = "NWS: rain/precipitation in forecast."; }
    else { impliedProb = 0.15; detail = "NWS: no precipitation in forecast."; confidence = 0.6; }
  }
  // Generic severe weather
  else if (q.includes("tornado") || q.includes("hurricane") || q.includes("storm")) {
    const hasSevere = /tornado|hurricane|tropical storm|severe thunderstorm|damaging wind/.test(forecasts);
    if (hasSevere) { impliedProb = 0.60; detail = "NWS: severe weather signals in forecast."; confidence = 0.45; }
    else { impliedProb = 0.10; detail = "NWS: no severe weather in forecast."; confidence = 0.5; }
  }

  if (impliedProb === null) {
    return scoreFromGdelt(altData, marketPrice, sources, 0.4);
  }

  if (altData.ensemble) { sources.push("ensemble"); confidence = Math.min(0.7, confidence + 0.05); }
  if (altData.montecarlo?.mcImplied != null) {
    sources.push("montecarlo");
    impliedProb = impliedProb * 0.6 + altData.montecarlo.mcImplied * 0.4;
    confidence = Math.min(0.75, confidence + 0.05);
  }

  const divergence = impliedProb - marketPrice;
  const alpha = Math.abs(divergence) * confidence;
  const dir = divergence > 0 ? "UNDERPRICED_YES" : "OVERPRICED_YES";
  return { divergence, direction: dir, confidence, alpha, detail, sources, altDataImplied: impliedProb };
}

function computeWeatherImplied(forecastTemp, threshold, direction) {
  const delta = forecastTemp - threshold;
  if (direction === "above") {
    if (delta > 10) return 0.95;
    if (delta > 5) return 0.85;
    if (delta > 2) return 0.70;
    if (delta > 0) return 0.55;
    if (delta > -2) return 0.40;
    if (delta > -5) return 0.20;
    return 0.05;
  }
  if (delta < -10) return 0.95;
  if (delta < -5) return 0.85;
  if (delta < -2) return 0.70;
  if (delta < 0) return 0.55;
  if (delta < 2) return 0.40;
  if (delta < 5) return 0.20;
  return 0.05;
}

// ── Crypto scoring ─────────────────────────────────────────

function scoreCrypto(market, altData, params, marketPrice) {
  const sources = [];
  let impliedProb = null;
  let confidence = 0.5;
  let detail = "";

  // Case 1: Price-target market (e.g., "BTC above $150k")
  if (altData.coingecko && params.priceTarget && params.coins?.length > 0) {
    const coinId = params.coins[0];
    const coinData = altData.coingecko[coinId];

    if (coinData?.usd) {
      sources.push("coingecko");
      const currentPrice = coinData.usd;
      const target = params.priceTarget.target;
      const direction = params.priceTarget.direction;
      const change24h = coinData.usd_24h_change || 0;
      const ratio = currentPrice / target;

      const daysRemaining = getDaysRemaining(market.endDate);

      if (direction === "above") {
        let baseProb;
        if (ratio > 1.05) baseProb = 0.85;
        else if (ratio > 1.0) baseProb = 0.70;
        else if (ratio > 0.95) baseProb = 0.45;
        else if (ratio > 0.90) baseProb = 0.25;
        else if (ratio > 0.80) baseProb = 0.12;
        else if (ratio > 0.50) baseProb = 0.05;
        else if (ratio > 0.20) baseProb = 0.02;
        else baseProb = 0.005;

        if (ratio < 1.0 && daysRemaining !== null) {
          const timeBoost = computeTimeBoost(ratio, daysRemaining);
          baseProb = Math.min(0.80, baseProb + timeBoost);
        }
        if (ratio < 0.90 && daysRemaining !== null && daysRemaining < 30) {
          baseProb *= 0.5;
        }

        impliedProb = baseProb;

        if (change24h > 5) impliedProb = Math.min(0.95, impliedProb + 0.10);
        else if (change24h < -5) impliedProb = Math.max(0.005, impliedProb - 0.10);
      } else {
        if (ratio < 0.95) impliedProb = 0.85;
        else if (ratio < 1.0) impliedProb = 0.70;
        else if (ratio < 1.05) impliedProb = 0.45;
        else impliedProb = 0.15;

        if (ratio > 1.0 && daysRemaining !== null) {
          const timeBoost = computeTimeBoost(1 / ratio, daysRemaining) * 0.7;
          impliedProb = Math.min(0.80, impliedProb + timeBoost);
        }
      }

      // Fear & Greed modifier
      if (altData.fearGreed) {
        sources.push("fear_greed");
        const fng = altData.fearGreed.value;
        if (direction === "above" && fng > 75) impliedProb = Math.min(0.95, impliedProb + 0.05);
        if (direction === "above" && fng < 25) impliedProb = Math.max(0.005, impliedProb - 0.05);
        confidence = 0.55;
      }

      // Coinglass funding rate modifier
      if (altData.funding?.[coinId]) {
        sources.push("coinglass");
        const funding = altData.funding[coinId];
        const rate = funding.rate || 0;

        // Positive funding = longs crowded = bearish pressure
        // Negative funding = shorts crowded = bullish pressure
        if (direction === "above") {
          if (rate > 0.03) impliedProb = Math.max(0.005, impliedProb - 0.06);
          else if (rate > 0.01) impliedProb = Math.max(0.005, impliedProb - 0.03);
          else if (rate < -0.03) impliedProb = Math.min(0.95, impliedProb + 0.06);
          else if (rate < -0.01) impliedProb = Math.min(0.95, impliedProb + 0.03);
        } else {
          if (rate > 0.03) impliedProb = Math.min(0.95, impliedProb + 0.06);
          else if (rate > 0.01) impliedProb = Math.min(0.95, impliedProb + 0.03);
          else if (rate < -0.03) impliedProb = Math.max(0.005, impliedProb - 0.06);
          else if (rate < -0.01) impliedProb = Math.max(0.005, impliedProb - 0.03);
        }
        confidence = Math.min(0.65, confidence + 0.05);
        detail += ` Funding: ${(rate * 100).toFixed(3)}%.`;
      }

      // Monte Carlo implied probability modifier
      if (altData.montecarlo?.mcImplied != null) {
        sources.push("montecarlo");
        const mcImpl = altData.montecarlo.mcImplied;
        // Blend MC estimate at 40% — stratified sampling provides tighter CI
        impliedProb = impliedProb * 0.60 + mcImpl * 0.40;
        confidence = Math.min(0.70, confidence + 0.03);
        detail += ` MC sim: ${(mcImpl * 100).toFixed(1)}% (${altData.montecarlo.method}).`;
      }

      detail = `${coinId}: $${currentPrice.toLocaleString()} (${change24h > 0 ? "+" : ""}${change24h.toFixed(1)}% 24h). Target: ${direction} $${target.toLocaleString()}.` + detail;
      if (daysRemaining !== null) {
        detail += ` Expires: ${daysRemaining}d.`;
      }
      if (altData.fearGreed) {
        detail += ` Fear/Greed: ${altData.fearGreed.value} (${altData.fearGreed.classification}).`;
      }
    }
  }

  // Case 2: Non-price-target crypto market — use sentiment/momentum
  if (impliedProb === null && altData.coingecko && params.coins?.length > 0) {
    const coinId = params.coins[0];
    const coinData = altData.coingecko[coinId];

    if (coinData?.usd) {
      sources.push("coingecko");
      const change24h = coinData.usd_24h_change || 0;
      let sentimentShift = 0;

      if (change24h > 10) sentimentShift = 0.08;
      else if (change24h > 5) sentimentShift = 0.05;
      else if (change24h > 2) sentimentShift = 0.02;
      else if (change24h < -10) sentimentShift = -0.08;
      else if (change24h < -5) sentimentShift = -0.05;
      else if (change24h < -2) sentimentShift = -0.02;

      if (altData.fearGreed) {
        sources.push("fear_greed");
        const fng = altData.fearGreed.value;
        if (fng > 80) sentimentShift += 0.03;
        else if (fng < 20) sentimentShift -= 0.03;
        confidence = 0.4;
      } else {
        confidence = 0.35;
      }

      // Funding rate for non-price-target markets
      if (altData.funding?.[coinId]) {
        sources.push("coinglass");
        const rate = altData.funding[coinId].rate || 0;
        if (rate > 0.02) sentimentShift -= 0.04;
        else if (rate < -0.02) sentimentShift += 0.04;
        confidence = Math.min(0.45, confidence + 0.05);
      }

      if (Math.abs(sentimentShift) > 0.01) {
        impliedProb = Math.max(0.01, Math.min(0.99, marketPrice + sentimentShift));
        detail = `${coinId}: $${coinData.usd.toLocaleString()} (${change24h > 0 ? "+" : ""}${change24h.toFixed(1)}% 24h).`;
        if (altData.fearGreed) {
          detail += ` Fear/Greed: ${altData.fearGreed.value} (${altData.fearGreed.classification}).`;
        }
        if (altData.funding?.[coinId]) {
          detail += ` Funding: ${(altData.funding[coinId].rate * 100).toFixed(3)}%.`;
        }
        detail += ` Sentiment ${sentimentShift > 0 ? "bullish" : "bearish"} shift.`;
      }
    }
  }

  if (impliedProb === null) {
    return scoreFromGdelt(altData, marketPrice, sources, 0.3);
  }

  const divergence = impliedProb - marketPrice;
  const dir = divergence > 0 ? "UNDERPRICED_YES" : "OVERPRICED_YES";
  const alpha = Math.abs(divergence) * confidence;

  return { divergence, direction: dir, confidence, alpha, detail, sources, altDataImplied: impliedProb };
}

// ── Economics scoring ──────────────────────────────────────

function scoreEconomics(market, altData, params, marketPrice) {
  const sources = [];
  let impliedProb = null;
  let confidence = 0.5;
  let detail = "";

  if (altData.fred?.length > 0 && params.threshold) {
    const obs = altData.fred[0];
    sources.push("fred");
    const current = obs.value;
    const target = params.threshold.threshold;
    const direction = params.threshold.direction;
    const ratio = current / target;

    if (direction === "above") {
      if (ratio > 1.05) impliedProb = 0.80;
      else if (ratio > 1.0) impliedProb = 0.60;
      else if (ratio > 0.98) impliedProb = 0.45;
      else if (ratio > 0.95) impliedProb = 0.30;
      else impliedProb = 0.15;
    } else {
      if (ratio < 0.95) impliedProb = 0.80;
      else if (ratio < 1.0) impliedProb = 0.60;
      else if (ratio < 1.02) impliedProb = 0.45;
      else impliedProb = 0.15;
    }

    detail = `FRED ${obs.series}: ${current} (as of ${obs.date}). Target: ${direction} ${target}.`;
    confidence = 0.55;
  }

  // Monte Carlo implied probability modifier
  if (altData.montecarlo?.mcImplied != null) {
    sources.push("montecarlo");
    const mcImpl = altData.montecarlo.mcImplied;
    if (impliedProb != null) {
      impliedProb = impliedProb * 0.60 + mcImpl * 0.40;
    } else {
      impliedProb = mcImpl;
    }
    confidence = Math.min(0.75, confidence + 0.05);
    detail += ` MC sim: ${(mcImpl * 100).toFixed(1)}% (${altData.montecarlo.method}).`;
  }

  // Metaculus cross-reference
  const metaculusResult = applyMetaculusModifier(altData, marketPrice, sources, impliedProb);
  if (metaculusResult.applied) {
    impliedProb = metaculusResult.impliedProb;
    confidence = Math.min(0.70, confidence + metaculusResult.confidenceBoost);
    detail += metaculusResult.detail;
  }

  if (impliedProb === null) {
    return scoreFromGdelt(altData, marketPrice, sources, 0.35);
  }

  const divergence = impliedProb - marketPrice;
  const dir = divergence > 0 ? "UNDERPRICED_YES" : "OVERPRICED_YES";
  const alpha = Math.abs(divergence) * confidence;
  return { divergence, direction: dir, confidence, alpha, detail, sources, altDataImplied: impliedProb };
}

// ── Geopolitics scoring ────────────────────────────────────

function scoreGeopolitics(market, altData, params, marketPrice) {
  const sources = [];
  const details = [];
  let confidence = 0.35;
  let impliedProb = null;

  // GDELT news volume + tone
  if (altData.gdelt && altData.gdelt.recent > 0) {
    sources.push("gdelt");
    const gd = altData.gdelt;

    if (gd.ratio > 2.0 && gd.currentTone < -2) {
      impliedProb = Math.min(0.80, marketPrice + 0.15);
      details.push(`GDELT: ${gd.recent} articles (${gd.ratio.toFixed(1)}x surge), tone ${gd.currentTone.toFixed(1)} (negative).`);
    } else if (gd.ratio > 1.5) {
      impliedProb = Math.min(0.75, marketPrice + 0.10);
      details.push(`GDELT: ${gd.recent} articles (${gd.ratio.toFixed(1)}x normal), tone ${gd.currentTone.toFixed(1)}.`);
    } else {
      details.push(`GDELT: ${gd.recent} articles, tone ${gd.currentTone.toFixed(1)}. Baseline volume.`);
    }
  }

  // OpenSky flight density
  const ZONE_BASELINES = {
    ukraine:     { normal: 100, low: 50, critical: 20, label: "Ukraine" },
    taiwan:      { normal: 50,  low: 20, critical: 5,  label: "Taiwan Strait" },
    korea:       { normal: 40,  low: 15, critical: 5,  label: "Korean Peninsula" },
    middle_east: { normal: 80,  low: 30, critical: 10, label: "Middle East" },
    baltic:      { normal: 50,  low: 20, critical: 8,  label: "Baltic" },
  };

  if (altData.opensky?.length > 0) {
    sources.push("opensky");
    for (const flights of altData.opensky) {
      if (!flights) continue;
      const baseline = ZONE_BASELINES[flights.zone];
      if (!baseline) {
        details.push(`OpenSky: ${flights.count} aircraft over ${flights.zone}.`);
        continue;
      }

      const count = flights.count;
      const ratio = count / baseline.normal;
      const zoneLabel = baseline.label;
      details.push(`OpenSky: ${count} aircraft over ${zoneLabel} (baseline ~${baseline.normal}, ratio ${ratio.toFixed(2)}x).`);

      let shift = 0;
      let conf = 0.38;

      if (count <= baseline.critical) {
        shift = 0.15;
        conf = 0.48;
        details.push(`CRITICAL: Near-empty airspace (${count}/${baseline.normal}) — strong escalation signal.`);
      } else if (count <= baseline.low) {
        shift = 0.08 + 0.07 * (1 - (count - baseline.critical) / (baseline.low - baseline.critical));
        conf = 0.42;
        details.push(`ELEVATED: Reduced traffic (${count}/${baseline.normal}) — tension signal.`);
      } else if (count < baseline.normal * 0.7) {
        shift = 0.04;
        conf = 0.38;
        details.push(`Below-normal traffic (${(ratio * 100).toFixed(0)}% of baseline) — mild concern.`);
      } else if (count > baseline.normal * 1.3) {
        shift = -0.03;
        conf = 0.35;
        details.push(`Above-normal traffic (${(ratio * 100).toFixed(0)}% of baseline) — possible normalization.`);
      } else {
        details.push(`Normal airspace activity (${(ratio * 100).toFixed(0)}% of baseline).`);
      }

      if (Math.abs(shift) > 0.01) {
        impliedProb = impliedProb != null
          ? Math.max(0.01, Math.min(0.90, impliedProb + shift))
          : Math.max(0.01, Math.min(0.90, marketPrice + shift));
        confidence = Math.max(confidence, conf);
      } else if (impliedProb === null) {
        impliedProb = marketPrice;
        confidence = Math.max(confidence, 0.32);
      }
    }
  }

  // Monte Carlo implied probability
  if (altData.montecarlo?.mcImplied != null) {
    sources.push("montecarlo");
    const mcImpl = altData.montecarlo.mcImplied;
    if (impliedProb != null) {
      impliedProb = impliedProb * 0.60 + mcImpl * 0.40;
    } else {
      impliedProb = mcImpl;
    }
    confidence = Math.min(0.75, confidence + 0.05);
    details.push(`MC sim: ${(mcImpl * 100).toFixed(1)}% (${altData.montecarlo.method}).`);
  }

  // Metaculus cross-reference
  const metaculusResult = applyMetaculusModifier(altData, marketPrice, sources, impliedProb);
  if (metaculusResult.applied) {
    impliedProb = metaculusResult.impliedProb;
    confidence = Math.min(0.55, confidence + metaculusResult.confidenceBoost);
    details.push(metaculusResult.detail);
  }

  // Trends modifier
  if (altData.trends?.isBreakout) {
    sources.push("trends");
    details.push(`Google Trends: breakout search interest on "${altData.trends.keyword}".`);
    if (impliedProb != null) {
      impliedProb = Math.min(0.90, impliedProb + 0.03);
      confidence = Math.min(0.55, confidence + 0.03);
    }
  }

  if (impliedProb === null) {
    return {
      divergence: 0, direction: "NEUTRAL", confidence,
      alpha: 0, detail: details.join(" ") || "No alt data signal available.",
      sources, altDataImplied: null,
    };
  }

  const divergence = impliedProb - marketPrice;
  const dir = divergence > 0 ? "UNDERPRICED_YES" : divergence < 0 ? "OVERPRICED_YES" : "NEUTRAL";
  const alpha = Math.abs(divergence) * confidence;
  return { divergence, direction: dir, confidence, alpha, detail: details.join(" "), sources, altDataImplied: impliedProb };
}

// ── Tech scoring ───────────────────────────────────────────

function scoreTech(market, altData, params, marketPrice) {
  const sources = [];
  const details = [];
  let confidence = 0.3;
  let impliedProb = null;

  // arXiv paper velocity
  if (altData.arxiv) {
    sources.push("arxiv");
    const av = altData.arxiv;
    const specificity = av.specificity ?? 0.5;
    const totalR = av.totalResults || 0;
    details.push(`arXiv "${av.query || "?"}" (spec ${(specificity * 100).toFixed(0)}%, ${totalR.toLocaleString()} total): ${av.papersPerWeek} papers/week (${av.acceleration > 1 ? "accelerating" : "stable"}).`);

    let baseShift = 0;
    let baseConf = 0.30;

    const isNiche = totalR < 20_000;
    const isBroad = totalR > 200_000;
    const ppw = av.papersPerWeek;
    const accel = av.acceleration;
    const saturated = ppw >= 190;

    if (isNiche && !saturated && accel > 1.5 && ppw > 5) {
      baseShift = 0.10;
      baseConf = 0.42;
      details.push(`Niche research (${totalR.toLocaleString()} papers) acceleration ${accel.toFixed(1)}x — strong momentum.`);
    } else if (isNiche && !saturated && ppw < 3) {
      baseShift = -0.05;
      baseConf = 0.38;
      details.push(`Low niche activity (${ppw} papers/week of ${totalR.toLocaleString()} total) — fading interest.`);
    } else if (isNiche && !saturated && accel < 0.7 && ppw > 0) {
      baseShift = -0.03;
      baseConf = 0.35;
      details.push(`Niche research decelerating (${accel.toFixed(1)}x).`);
    } else if (isBroad || saturated) {
      details.push(`Established field (${totalR.toLocaleString()} papers) — arXiv signal non-discriminating.`);
    } else if (!saturated && accel > 1.5 && ppw > 10) {
      baseShift = 0.05;
      baseConf = 0.35;
      details.push(`Research acceleration ${accel.toFixed(1)}x in medium field.`);
    }

    if (Math.abs(baseShift) > 0) {
      const scaledShift = baseShift * specificity;
      impliedProb = Math.max(0.01, Math.min(0.85, marketPrice + scaledShift));
      confidence = baseConf * (0.6 + 0.4 * specificity);
    }
  }

  // GDELT supplements
  if (altData.gdelt && altData.gdelt.recent > 0) {
    sources.push("gdelt");
    const gd = altData.gdelt;
    details.push(`GDELT: ${gd.recent} articles (${gd.ratio.toFixed(1)}x volume), tone ${gd.currentTone.toFixed(1)}.`);

    let shift = 0;
    if (gd.ratio > 3.0) shift += 0.06;
    else if (gd.ratio > 2.0) shift += 0.03;
    if (gd.currentTone > 2) shift += 0.03;
    else if (gd.currentTone < -2) shift -= 0.03;

    if (Math.abs(shift) > 0.01) {
      impliedProb = impliedProb != null
        ? Math.max(0.01, Math.min(0.99, impliedProb + shift))
        : Math.max(0.01, Math.min(0.99, marketPrice + shift));
      confidence = Math.min(0.45, confidence + 0.05);
    }
  }

  // Monte Carlo implied probability
  if (altData.montecarlo?.mcImplied != null) {
    sources.push("montecarlo");
    const mcImpl = altData.montecarlo.mcImplied;
    if (impliedProb != null) {
      impliedProb = impliedProb * 0.60 + mcImpl * 0.40;
    } else {
      impliedProb = mcImpl;
    }
    confidence = Math.min(0.75, confidence + 0.05);
    details.push(`MC sim: ${(mcImpl * 100).toFixed(1)}% (${altData.montecarlo.method}).`);
  }

  // Metaculus cross-reference
  const metaculusResult = applyMetaculusModifier(altData, marketPrice, sources, impliedProb);
  if (metaculusResult.applied) {
    impliedProb = metaculusResult.impliedProb;
    confidence = Math.min(0.55, confidence + metaculusResult.confidenceBoost);
    details.push(metaculusResult.detail);
  }

  // Trends modifier
  if (altData.trends?.isBreakout) {
    sources.push("trends");
    details.push(`Google Trends: breakout search interest on "${altData.trends.keyword}".`);
  }

  if (impliedProb === null) {
    return {
      divergence: 0, direction: "NEUTRAL", confidence,
      alpha: 0, detail: details.join(" ") || "Insufficient data.",
      sources, altDataImplied: null,
    };
  }

  const divergence = impliedProb - marketPrice;
  const dir = divergence > 0 ? "UNDERPRICED_YES" : divergence < 0 ? "OVERPRICED_YES" : "NEUTRAL";
  const alpha = Math.abs(divergence) * confidence;
  return { divergence, direction: dir, confidence, alpha, detail: details.join(" "), sources, altDataImplied: impliedProb };
}

// ── Generic scoring (politics, entertainment, unknown) ─────

function scorePoliticsGeneric(market, altData, params, marketPrice) {
  const sources = [];
  const details = [];
  let impliedProb = null;
  let confidence = 0.25;

  // Monte Carlo implied probability
  if (altData.montecarlo?.mcImplied != null) {
    sources.push("montecarlo");
    const mcImpl = altData.montecarlo.mcImplied;
    impliedProb = mcImpl;
    confidence = Math.min(0.75, confidence + 0.05);
    details.push(`MC sim: ${(mcImpl * 100).toFixed(1)}% (${altData.montecarlo.method}).`);
  }

  // Metaculus is now the primary signal for politics/entertainment
  const metaculusResult = applyMetaculusModifier(altData, marketPrice, sources, impliedProb);
  if (metaculusResult.applied) {
    impliedProb = metaculusResult.impliedProb;
    confidence = Math.max(0.40, metaculusResult.confidenceBoost + 0.25);
    details.push(metaculusResult.detail);
  }

  // Trends modifier
  if (altData.trends?.isBreakout) {
    sources.push("trends");
    details.push(`Google Trends: breakout search interest on "${altData.trends.keyword}".`);
    if (impliedProb != null) {
      // Don't shift probability for trends alone — it's directionally ambiguous
      confidence = Math.min(0.50, confidence + 0.03);
    }
  }

  // GDELT supplements
  if (altData.gdelt && altData.gdelt.recent > 0) {
    sources.push("gdelt");
    const gd = altData.gdelt;
    let gdeltShift = 0;

    if (gd.ratio > 3.0) gdeltShift += 0.10;
    else if (gd.ratio > 2.0) gdeltShift += 0.05;

    if (gd.currentTone > 2) gdeltShift += 0.05;
    else if (gd.currentTone < -2) gdeltShift -= 0.05;

    if (gd.toneDelta > 1) gdeltShift += 0.03;
    else if (gd.toneDelta < -1) gdeltShift -= 0.03;

    if (impliedProb != null) {
      impliedProb = Math.max(0.01, Math.min(0.99, impliedProb + gdeltShift * 0.5));
    } else if (Math.abs(gdeltShift) > 0.01) {
      impliedProb = Math.max(0.01, Math.min(0.99, marketPrice + gdeltShift));
    }

    details.push(`GDELT: ${gd.recent} articles (${gd.ratio.toFixed(1)}x volume), tone ${gd.currentTone.toFixed(1)} (delta ${gd.toneDelta > 0 ? "+" : ""}${gd.toneDelta.toFixed(1)}).`);
  }

  if (impliedProb === null) {
    return {
      divergence: 0, direction: "NEUTRAL", confidence,
      alpha: 0, detail: details.join(" ") || "No alt data signal available.",
      sources, altDataImplied: null,
    };
  }

  const divergence = impliedProb - marketPrice;
  const direction = divergence > 0 ? "UNDERPRICED_YES" : divergence < 0 ? "OVERPRICED_YES" : "NEUTRAL";
  const alpha = Math.abs(divergence) * confidence;

  return { divergence, direction, confidence, alpha, detail: details.join(" "), sources, altDataImplied: impliedProb };
}

// ── GDELT-based generic scoring ────────────────────────────

function scoreFromGdelt(altData, marketPrice, existingSources, baseConfidence) {
  if (!altData.gdelt || altData.gdelt.recent === 0) {
    return {
      divergence: 0, direction: "NEUTRAL", confidence: baseConfidence,
      alpha: 0, detail: "No alt data signal available.",
      sources: existingSources, altDataImplied: null,
    };
  }

  const gd = altData.gdelt;
  const sources = [...existingSources, "gdelt"];
  let impliedShift = 0;

  if (gd.ratio > 3.0) impliedShift += 0.10;
  else if (gd.ratio > 2.0) impliedShift += 0.05;

  if (gd.currentTone > 2) impliedShift += 0.05;
  else if (gd.currentTone < -2) impliedShift -= 0.05;

  if (gd.toneDelta > 1) impliedShift += 0.03;
  else if (gd.toneDelta < -1) impliedShift -= 0.03;

  const impliedProb = Math.max(0.01, Math.min(0.99, marketPrice + impliedShift));
  const divergence = impliedProb - marketPrice;
  const direction = divergence > 0 ? "UNDERPRICED_YES" : divergence < 0 ? "OVERPRICED_YES" : "NEUTRAL";
  const alpha = Math.abs(divergence) * baseConfidence;
  const detail = `GDELT: ${gd.recent} articles (${gd.ratio.toFixed(1)}x volume), tone ${gd.currentTone.toFixed(1)} (delta ${gd.toneDelta > 0 ? "+" : ""}${gd.toneDelta.toFixed(1)}).`;

  return { divergence, direction, confidence: baseConfidence, alpha, detail, sources, altDataImplied: impliedProb };
}

// ── Metaculus modifier (shared across categories) ─────────

function applyMetaculusModifier(altData, marketPrice, sources, currentImplied) {
  if (!altData.metaculus) {
    return { applied: false, impliedProb: currentImplied, confidenceBoost: 0, detail: "" };
  }

  const mc = altData.metaculus;
  const mcPred = mc.communityPrediction;
  if (mcPred == null || isNaN(mcPred)) {
    return { applied: false, impliedProb: currentImplied, confidenceBoost: 0, detail: "" };
  }

  sources.push("metaculus");
  const divergence = mcPred - marketPrice;
  const absDivergence = Math.abs(divergence);

  let significance;
  if (absDivergence > 0.20) significance = "high";
  else if (absDivergence > 0.10) significance = "notable";
  else if (absDivergence > 0.05) significance = "mild";
  else significance = "negligible";

  const confidenceBoost = mc.numForecasters > 100 ? 0.10
    : mc.numForecasters > 30 ? 0.06
    : mc.numForecasters > 10 ? 0.03
    : 0.01;

  // Blend Metaculus prediction with existing implied probability
  let newImplied;
  if (currentImplied != null) {
    // Weight Metaculus at 30-50% depending on forecaster count
    const mcWeight = mc.numForecasters > 100 ? 0.40 : mc.numForecasters > 30 ? 0.30 : 0.20;
    newImplied = currentImplied * (1 - mcWeight) + mcPred * mcWeight;
  } else {
    // Metaculus is the primary signal
    newImplied = mcPred;
  }

  const detail = ` Metaculus: ${(mcPred * 100).toFixed(0)}% (${mc.numForecasters} forecasters, ${significance} divergence from Polymarket).`;

  return { applied: true, impliedProb: newImplied, confidenceBoost, detail };
}

/**
 * Classify alpha score into recommendation.
 */
export function recommendation(alpha, confidence) {
  if (alpha >= 0.15 && confidence >= 0.5) return "ACTIONABLE";
  if (alpha >= 0.08 && confidence >= 0.35) return "NOTABLE";
  if (alpha >= 0.03) return "MONITOR";
  return "NOISE";
}

// ── Helpers ──────────────────────────────────────────────────

function getDaysRemaining(endDate) {
  if (!endDate) return null;
  try {
    const end = new Date(endDate).getTime();
    if (isNaN(end)) return null;
    const days = Math.max(0, Math.round((end - Date.now()) / (24 * 3600_000)));
    return days;
  } catch {
    return null;
  }
}

function computeTimeBoost(ratio, days) {
  const gap = Math.max(0, 1 - ratio);
  const timeFactor = Math.sqrt(days / 30);
  const expectedRange = 0.05 * Math.sqrt(days);

  if (expectedRange < gap * 0.5) {
    return 0.01 * timeFactor;
  }

  const coverage = Math.min(3, expectedRange / Math.max(0.01, gap));
  return Math.min(0.25, 0.03 * coverage * timeFactor);
}
