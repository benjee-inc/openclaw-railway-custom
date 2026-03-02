// polymarket-alpha — route markets to data sources and extract query terms

import * as weather from "./sources/weather.mjs";
import * as crypto from "./sources/crypto.mjs";
import * as economics from "./sources/economics.mjs";
import * as opensky from "./sources/opensky.mjs";
import * as arxiv from "./sources/arxiv.mjs";

/**
 * For a categorized market, determine which alt data sources to query
 * and extract relevant parameters from the question.
 *
 * @param {object} market - market with _category field
 * @returns {{ sources: string[], params: object }}
 */
export function match(market) {
  const q = market.question || "";
  const cat = market._category;

  switch (cat) {
    case "weather":
      return matchWeather(q);
    case "crypto":
      return matchCrypto(q);
    case "economics":
      return matchEconomics(q);
    case "geopolitics":
      return matchGeopolitics(q);
    case "politics":
      return matchPolitics(q);
    case "tech":
      return matchTech(q);
    case "entertainment":
      return matchEntertainment(q);
    default:
      return matchGeneric(q);
  }
}

function matchWeather(q) {
  const city = weather.extractCity(q);
  const threshold = weather.extractTempThreshold(q);
  const date = weather.extractDate(q);

  const sources = [];
  const params = { city, threshold, date };

  if (city) {
    sources.push("nws");
    sources.push("ensemble"); // multi-model forecast
  }
  sources.push("montecarlo"); // MC implied probability
  sources.push("trends");  // attention proxy
  sources.push("gdelt");   // always check news for weather events
  sources.push("grok");    // X/Twitter + web search intelligence
  params.gdeltQuery = extractGdeltQuery(q, "weather");
  params.trendsKeyword = extractTrendsKeyword(q);

  return { sources, params };
}

function matchCrypto(q) {
  const coins = crypto.extractCoins(q);
  const priceTarget = crypto.extractPriceTarget(q);

  return {
    sources: ["coingecko", "fear_greed", "coinglass", "montecarlo", "trends", "gdelt", "grok"],
    params: {
      coins,
      priceTarget,
      gdeltQuery: extractGdeltQuery(q, "crypto"),
      trendsKeyword: extractTrendsKeyword(q),
    },
  };
}

function matchEconomics(q) {
  const series = economics.extractSeries(q);
  const threshold = economics.extractThreshold(q);

  const sources = ["metaculus", "montecarlo", "trends", "gdelt", "grok"];
  if (series.length > 0) sources.unshift("fred");

  return {
    sources,
    params: {
      fredSeries: series,
      threshold,
      gdeltQuery: extractGdeltQuery(q, "economics"),
      metaculusQuery: extractMetaculusQuery(q),
      trendsKeyword: extractTrendsKeyword(q),
    },
  };
}

function matchGeopolitics(q) {
  const zones = opensky.extractZones(q);

  const sources = ["metaculus", "montecarlo", "trends", "gdelt", "grok"];
  if (zones.length > 0) sources.push("opensky");

  return {
    sources,
    params: {
      zones,
      gdeltQuery: extractGdeltQuery(q, "geopolitics"),
      metaculusQuery: extractMetaculusQuery(q),
      trendsKeyword: extractTrendsKeyword(q),
    },
  };
}

function matchPolitics(q) {
  return {
    sources: ["metaculus", "montecarlo", "trends", "gdelt", "grok"],
    params: {
      gdeltQuery: extractGdeltQuery(q, "politics"),
      metaculusQuery: extractMetaculusQuery(q),
      trendsKeyword: extractTrendsKeyword(q),
    },
  };
}

function matchTech(q) {
  const topics = arxiv.extractTopics(q);
  const sources = ["metaculus", "montecarlo", "trends", "gdelt", "grok"];
  if (topics.length > 0) sources.push("arxiv");

  return {
    sources,
    params: {
      arxivTopics: topics,
      gdeltQuery: extractGdeltQuery(q, "tech"),
      metaculusQuery: extractMetaculusQuery(q),
      trendsKeyword: extractTrendsKeyword(q),
      arxivSpecificity: topics[0]?.specificity ?? 0,
    },
  };
}

function matchEntertainment(q) {
  return {
    sources: ["metaculus", "montecarlo", "trends", "gdelt", "grok"],
    params: {
      gdeltQuery: extractGdeltQuery(q, "entertainment"),
      metaculusQuery: extractMetaculusQuery(q),
      trendsKeyword: extractTrendsKeyword(q),
    },
  };
}

function matchGeneric(q) {
  return {
    sources: ["metaculus", "montecarlo", "trends", "gdelt", "grok"],
    params: {
      gdeltQuery: extractGdeltQuery(q, "general"),
      metaculusQuery: extractMetaculusQuery(q),
      trendsKeyword: extractTrendsKeyword(q),
    },
  };
}

/**
 * Extract a good GDELT search query from a market question.
 * Removes common market phrasing to focus on the actual topic.
 */
function extractGdeltQuery(question, category) {
  let q = question
    .replace(/^Will\s+/i, "")
    .replace(/\?$/, "")
    .replace(/\b(before|by|on|in)\s+\w+\s+\d{1,2}(st|nd|rd|th)?,?\s*\d{0,4}/gi, "")
    .replace(/\b(before|by)\s+\d{4}-\d{2}-\d{2}/gi, "")
    .replace(/\b(yes|no)\b/gi, "")
    .trim();

  // Limit to first ~60 chars for API efficiency
  if (q.length > 60) q = q.slice(0, 60).replace(/\s+\S*$/, "");

  return q || category;
}

/**
 * Extract a Metaculus search query from a market question.
 */
function extractMetaculusQuery(question) {
  return question
    .replace(/^Will\s+/i, "")
    .replace(/\?$/, "")
    .replace(/\b(before|by|on|in)\s+\w+\s+\d{1,2}(st|nd|rd|th)?,?\s*\d{0,4}/gi, "")
    .replace(/\b(before|by)\s+\d{4}-\d{2}-\d{2}/gi, "")
    .replace(/\b(yes|no)\b/gi, "")
    .trim()
    .slice(0, 100);
}

/**
 * Extract a Google Trends keyword from a market question.
 */
function extractTrendsKeyword(question) {
  let q = question
    .replace(/^Will\s+/i, "")
    .replace(/\?$/, "")
    .replace(/\b(before|by|on|in)\s+\w+\s+\d{1,2}(st|nd|rd|th)?,?\s*\d{0,4}/gi, "")
    .replace(/\b(before|by)\s+\d{4}-\d{2}-\d{2}/gi, "")
    .replace(/\b(yes|no|above|below|exceed|reach|hit)\b/gi, "")
    .replace(/\$[\d,]+[kmbt]?/gi, "")
    .replace(/\d+°?[FC]/gi, "")
    .trim();

  const words = q.split(/\s+/).filter((w) => w.length > 2);
  return words.slice(0, 4).join(" ") || null;
}

/**
 * Wrap a promise with a per-source timeout.
 * If the source doesn't resolve in time, silently drop it (scorer uses fallbacks).
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => {
      console.log(`[matcher] ${label} timed out after ${ms / 1000}s`);
      resolve();
    }, ms)),
  ]).catch((err) => {
    console.error(`[matcher] ${label} error: ${err.message}`);
  });
}

const SOURCE_TIMEOUT = 8_000; // 8s per source — well under the enrichment deadline

/**
 * Fetch all alt data for a matched market.
 * Returns collected data from all matched sources.
 * Each source gets an 8s timeout so no single slow API stalls enrichment.
 */
export async function fetchAltData(market, matchResult, opts = {}) {
  const { sources, params } = matchResult;
  const skipSources = opts.skipSources || null; // Set of source names to skip
  const data = {};
  const promises = [];

  for (const src of sources) {
    if (skipSources && skipSources.has(src)) continue;
    switch (src) {
      case "nws":
        if (params.city) {
          if (params.date) {
            promises.push(withTimeout(
              import("./sources/weather.mjs")
                .then((w) => w.temperatureOnDate(params.city, params.date))
                .then((r) => { data.nws = r; }),
              SOURCE_TIMEOUT, "nws",
            ));
          } else {
            promises.push(withTimeout(
              import("./sources/weather.mjs")
                .then((w) => w.forecast(params.city))
                .then((r) => { data.nws = r; }),
              SOURCE_TIMEOUT, "nws",
            ));
          }
        }
        break;

      case "ensemble":
        if (params.city) {
          promises.push(withTimeout(
            Promise.all([
              import("./sources/weather.mjs"),
              import("./sources/ensemble.mjs"),
              import("../constants.mjs"),
            ]).then(([, ensembleMod, constants]) => {
              const grid = constants.NWS_GRIDS[params.city.toLowerCase().trim()];
              if (!grid) return;
              if (params.date) {
                return ensembleMod.forecastOnDate(grid.lat, grid.lon, params.date)
                  .then((r) => { if (r) data.ensemble = r; });
              }
              return ensembleMod.forecast(grid.lat, grid.lon)
                .then((r) => { if (r) data.ensemble = r; });
            }),
            SOURCE_TIMEOUT, "ensemble",
          ));
        }
        break;

      case "coingecko":
        if (params.coins?.length > 0) {
          promises.push(withTimeout(
            import("./sources/crypto.mjs")
              .then((c) => c.prices(params.coins))
              .then((r) => { data.coingecko = r; }),
            SOURCE_TIMEOUT, "coingecko",
          ));
        }
        break;

      case "fear_greed":
        promises.push(withTimeout(
          import("./sources/crypto.mjs")
            .then((c) => c.fearGreed())
            .then((r) => { data.fearGreed = r; }),
          SOURCE_TIMEOUT, "fear_greed",
        ));
        break;

      case "coinglass":
        if (params.coins?.length > 0) {
          promises.push(withTimeout(
            import("./sources/coinglass.mjs")
              .then((cg) => cg.fundingRates(params.coins))
              .then((r) => { if (r && Object.keys(r).length > 0) data.funding = r; }),
            SOURCE_TIMEOUT, "coinglass",
          ));
        }
        break;

      case "fred":
        if (params.fredSeries?.length > 0) {
          promises.push(withTimeout(
            import("./sources/economics.mjs")
              .then((e) => Promise.all(params.fredSeries.map((s) => e.latestObservation(s))))
              .then((results) => { data.fred = results.filter(Boolean); }),
            SOURCE_TIMEOUT, "fred",
          ));
        }
        break;

      case "opensky":
        if (params.zones?.length > 0) {
          promises.push(withTimeout(
            import("./sources/opensky.mjs")
              .then((o) => Promise.all(params.zones.map((z) => o.zoneDensity(z))))
              .then((results) => { data.opensky = results.filter(Boolean); }),
            SOURCE_TIMEOUT, "opensky",
          ));
        }
        break;

      case "arxiv":
        if (params.arxivTopics?.length > 0) {
          const topic = params.arxivTopics[0];
          promises.push(withTimeout(
            import("./sources/arxiv.mjs")
              .then((a) => a.velocity(topic.query || topic))
              .then((r) => {
                data.arxiv = r;
                data.arxiv.specificity = topic.specificity ?? 0.5;
                data.arxiv.query = topic.query || topic;
              }),
            SOURCE_TIMEOUT, "arxiv",
          ));
        }
        break;

      case "metaculus":
        if (params.metaculusQuery) {
          promises.push(withTimeout(
            import("./sources/metaculus.mjs")
              .then((m) => m.searchQuestion(params.metaculusQuery))
              .then((r) => { if (r) data.metaculus = r; }),
            SOURCE_TIMEOUT, "metaculus",
          ));
        }
        break;

      case "trends":
        if (params.trendsKeyword) {
          promises.push(withTimeout(
            import("./sources/trends.mjs")
              .then((t) => t.searchInterest(params.trendsKeyword))
              .then((r) => { if (r) data.trends = r; }),
            SOURCE_TIMEOUT, "trends",
          ));
        }
        break;

      case "montecarlo":
        promises.push(withTimeout(
          import("./sources/montecarlo.mjs")
            .then((mc) => mc.computeImpliedFromMC(market))
            .then((r) => { if (r) data.montecarlo = r; }),
          SOURCE_TIMEOUT, "montecarlo",
        ));
        break;

      case "gdelt":
        if (params.gdeltQuery) {
          promises.push(withTimeout(
            import("./sources/gdelt.mjs")
              .then((g) => g.volumeTrend(params.gdeltQuery))
              .then((r) => { data.gdelt = r; }),
            SOURCE_TIMEOUT, "gdelt",
          ));
        }
        break;

      case "grok":
        promises.push(withTimeout(
          import("./sources/grok.mjs")
            .then((g) => g.analyzeMarket(market.question, market._category, market.prices?.[0] || 0.5, market._signalContext || null))
            .then((r) => { if (r) data.grok = r; }),
          160_000, "grok",  // 160s — allows 75s×2 attempts + backoff
        ));
        break;
    }
  }

  await Promise.allSettled(promises);
  return data;
}
