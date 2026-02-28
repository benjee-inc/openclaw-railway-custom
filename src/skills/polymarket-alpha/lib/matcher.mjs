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
  sources.push("trends");  // attention proxy
  sources.push("gdelt");   // always check news for weather events
  params.gdeltQuery = extractGdeltQuery(q, "weather");
  params.trendsKeyword = extractTrendsKeyword(q);

  return { sources, params };
}

function matchCrypto(q) {
  const coins = crypto.extractCoins(q);
  const priceTarget = crypto.extractPriceTarget(q);

  return {
    sources: ["coingecko", "fear_greed", "coinglass", "trends", "gdelt"],
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

  const sources = ["metaculus", "trends", "gdelt"];
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

  const sources = ["metaculus", "trends", "gdelt"];
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
    sources: ["metaculus", "trends", "gdelt"],
    params: {
      gdeltQuery: extractGdeltQuery(q, "politics"),
      metaculusQuery: extractMetaculusQuery(q),
      trendsKeyword: extractTrendsKeyword(q),
    },
  };
}

function matchTech(q) {
  const topics = arxiv.extractTopics(q);
  const sources = ["metaculus", "trends", "gdelt"];
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
    sources: ["metaculus", "trends", "gdelt"],
    params: {
      gdeltQuery: extractGdeltQuery(q, "entertainment"),
      metaculusQuery: extractMetaculusQuery(q),
      trendsKeyword: extractTrendsKeyword(q),
    },
  };
}

function matchGeneric(q) {
  return {
    sources: ["metaculus", "trends", "gdelt"],
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
 * Fetch all alt data for a matched market.
 * Returns collected data from all matched sources.
 */
export async function fetchAltData(market, matchResult) {
  const { sources, params } = matchResult;
  const data = {};
  const promises = [];

  for (const src of sources) {
    switch (src) {
      case "nws":
        if (params.city) {
          if (params.date) {
            promises.push(
              import("./sources/weather.mjs")
                .then((w) => w.temperatureOnDate(params.city, params.date))
                .then((r) => { data.nws = r; }),
            );
          } else {
            promises.push(
              import("./sources/weather.mjs")
                .then((w) => w.forecast(params.city))
                .then((r) => { data.nws = r; }),
            );
          }
        }
        break;

      case "ensemble":
        if (params.city) {
          promises.push(
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
          );
        }
        break;

      case "coingecko":
        if (params.coins?.length > 0) {
          promises.push(
            import("./sources/crypto.mjs")
              .then((c) => c.prices(params.coins))
              .then((r) => { data.coingecko = r; }),
          );
        }
        break;

      case "fear_greed":
        promises.push(
          import("./sources/crypto.mjs")
            .then((c) => c.fearGreed())
            .then((r) => { data.fearGreed = r; }),
        );
        break;

      case "coinglass":
        if (params.coins?.length > 0) {
          promises.push(
            import("./sources/coinglass.mjs")
              .then((cg) => cg.fundingRates(params.coins))
              .then((r) => { if (r && Object.keys(r).length > 0) data.funding = r; }),
          );
        }
        break;

      case "fred":
        if (params.fredSeries?.length > 0) {
          promises.push(
            import("./sources/economics.mjs")
              .then((e) => Promise.all(params.fredSeries.map((s) => e.latestObservation(s))))
              .then((results) => { data.fred = results.filter(Boolean); }),
          );
        }
        break;

      case "opensky":
        if (params.zones?.length > 0) {
          promises.push(
            import("./sources/opensky.mjs")
              .then((o) => Promise.all(params.zones.map((z) => o.zoneDensity(z))))
              .then((results) => { data.opensky = results.filter(Boolean); }),
          );
        }
        break;

      case "arxiv":
        if (params.arxivTopics?.length > 0) {
          const topic = params.arxivTopics[0];
          promises.push(
            import("./sources/arxiv.mjs")
              .then((a) => a.velocity(topic.query || topic))
              .then((r) => {
                data.arxiv = r;
                data.arxiv.specificity = topic.specificity ?? 0.5;
                data.arxiv.query = topic.query || topic;
              }),
          );
        }
        break;

      case "metaculus":
        if (params.metaculusQuery) {
          promises.push(
            import("./sources/metaculus.mjs")
              .then((m) => m.searchQuestion(params.metaculusQuery))
              .then((r) => { if (r) data.metaculus = r; }),
          );
        }
        break;

      case "trends":
        if (params.trendsKeyword) {
          promises.push(
            import("./sources/trends.mjs")
              .then((t) => t.searchInterest(params.trendsKeyword))
              .then((r) => { if (r) data.trends = r; }),
          );
        }
        break;

      case "gdelt":
        if (params.gdeltQuery) {
          promises.push(
            import("./sources/gdelt.mjs")
              .then((g) => g.volumeTrend(params.gdeltQuery))
              .then((r) => { data.gdelt = r; }),
          );
        }
        break;
    }
  }

  await Promise.allSettled(promises);
  return data;
}
