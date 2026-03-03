/**
 * Polymarket Scanner v5 — real-time multi-source alpha detection.
 *
 * Data sources:
 *   1. data-api.polymarket.com/trades  — live global trade feed (seconds-fresh)
 *   2. gamma-api.polymarket.com        — market metadata + 1h/1d/1w price changes
 *   3. clob.polymarket.com             — live midpoints, spreads, orderbooks (not geo-blocked for reads)
 *
 * Pushes JSONL entries to GitHub Pages dashboard repo every cycle.
 */

import { writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GAMMA_API = "https://gamma-api.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const DEFAULT_INTERVAL_MS = 300_000;
const DEFAULT_REPO = "benjee-inc/polymarket-arb-dashboard";
const JSONL_PATH = "logs/terminal.jsonl";

const MAX_ENTRIES = 200;

let intervalId = null;
let running = false;
let cycleCount = 0;

// Cross-cycle state
let prevMidpoints = new Map(); // conditionId → midpoint
const COOLDOWN_CYCLES = 6;        // event-driven signals (flow, price shifts, movers)
const STRUCTURAL_COOLDOWN = 48;   // structural signals (deep value, wide spread, tight races) — 4h at 5min interval
let shownMarkets = new Map(); // question → { cycle, structural }
let heldConditionIds = new Set(); // conditionIds of currently held positions — skip in scanner

// Sports / entertainment noise filter — these are not tradeable alpha
const SPORTS_PATTERNS = [
  // Major leagues & tournaments
  /\bNBA\b/i, /\bNFL\b/i, /\bNHL\b/i, /\bMLB\b/i, /\bMLS\b/i, /\bUFC\b/i,
  /\bPGA\b/i, /\bATP\b/i, /\bWTA\b/i, /\bF1\b/i, /\bNASCAR\b/i,
  /\bPremier League\b/i, /\bLa Liga\b/i, /\bSerie A\b/i, /\bBundesliga\b/i,
  /\bLigue 1\b/i, /\bChampions League\b/i, /\bEuropa League\b/i,
  /\bWorld Cup\b/i, /\bEuros?\b/i, /\bSuper Bowl\b/i,
  /\bStanley Cup\b/i, /\bWorld Series\b/i, /\bMasters tournament\b/i,
  /\bRyder Cup\b/i, /\bOpen Championship\b/i,
  // Sports terms
  /\bwin the \d{4}(?:–\d{2,4})? (?:NBA|NFL|NHL|MLB|MLS)/i,
  /\bfinish in (?:1st|2nd|3rd|last|\d+th) place\b/i,
  /\bwin on \d{4}-\d{2}-\d{2}\b/i,  // "win on 2026-02-27"
  /\bRookie of the Year\b/i, /\bMVP\b/i,
  /\bplayoffs?\b/i, /\bFinals\b/i,
  // Team / match patterns
  /\bvs\.?\s/i,  // "Team A vs Team B"
  /\bGame \d+ Winner\b/i, // esports "Game 2 Winner"
  // Specific sports
  /\bgolf\b/i, /\btennis\b/i, /\bcricket\b/i, /\brugby\b/i,
  /\bboxing\b/i, /\bwrestling\b/i, /\besports?\b/i, /\bDota\b/i,
  /\bCounter-?Strike\b/i, /\bValorant\b/i, /\bLeague of Legends\b/i,
  // Common sports team indicators
  /\b(?:FC|CF|SC|AC|AS|SV|BV|SK)\b/,  // football club abbreviations
  /\bUnited\b.*\b(?:win|finish|place)\b/i,
  // Catch-all for common sports markets
  /Up or Down.*\d+.*ET\b/i,  // "Bitcoin Up or Down - February 27, 9AM ET" (binary price bets)
  // NHL/NBA/NFL team names that collide with real words
  /\b(?:Carolina|Florida)\s+Hurricanes\b/i,
  /\b(?:Oklahoma City|Golden State)\s+Thunder\b/i,
  /\bMiami\s+Heat\b/i, /\bPhoenix\s+Suns\b/i,
  /\bToronto\s+(?:Raptors|Maple Leafs|Blue Jays)\b/i,
  /\bColorado\s+(?:Avalanche|Rockies)\b/i,
  // Division/conference patterns
  /\b(?:Metropolitan|Atlantic|Central|Pacific)\s+Division\b/i,
  /\b(?:Eastern|Western|American|National)\s+(?:Conference|League)\b/i,
  /\b(?:AFC|NFC)\s+(?:East|West|North|South|Championship)\b/i,
  // Generic sports outcome patterns
  /\bwin\s+the\s+(?:division|conference|championship|title|cup|trophy|medal|ring)\b/i,
  /\bmake\s+the\s+(?:playoffs|postseason|final|finals|semis|quarterfinals)\b/i,
  // Additional international leagues
  /\bSüper Lig\b/i, /\bSuper Lig\b/i, /\bEredivisie\b/i, /\bLiga MX\b/i,
  /\bJ[\s-]?League\b/i, /\bK[\s-]?League\b/i, /\bA[\s-]?League\b/i,
  /\bPrimeira Liga\b/i, /\bScottish Premiership\b/i, /\bAllsvenskan\b/i,
  /\bEliteserien\b/i, /\bSuperliga\b/i, /\bEkstraklasa\b/i,
  /\bRSL\b/i, /\bMLS Cup\b/i, /\bCopa Libertadores\b/i,
  /\bCopa America\b/i, /\bAfcon\b/i, /\bCAF\b/i,
  // Generic "Will [team] win the [league]?" pattern
  /\bwin\s+the\s+\S+\s+(?:Lig|Liga|League|Serie|Division|Cup|Championship)\b/i,
  /\bfinish\s+in\s+the\s+top\s+\d+\b/i,
  // EPL
  /\b(?:EPL|English Premier League)\b/i,
  /\b\d{4}[–-]\d{2,4}\s+(?:season|campaign)\b/i,
];

function isSportsMarket(question) {
  return SPORTS_PATTERNS.some((re) => re.test(question));
}

// ── helpers ──────────────────────────────────────────────

function env(key, fallback) {
  return process.env[key]?.trim() || fallback;
}

function iso() { return new Date().toISOString(); }

function entry(type, message) {
  return JSON.stringify({ timestamp: iso(), type, message });
}

function fmt$(n) {
  const v = Number(n);
  if (v < 0.01) return `${(v * 100).toFixed(1)}¢`;
  return `$${v.toFixed(2)}`;
}

function fmtPct(n) { return `${(Number(n) * 100).toFixed(1)}%`; }

function fmtVol(v) {
  const n = Number(v);
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function hoursLeft(dateStr) {
  const h = (new Date(dateStr).getTime() - Date.now()) / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${h.toFixed(0)}h`;
  return `${(h / 24).toFixed(0)}d`;
}

function truncQ(q, max = 55) {
  return q.length > max ? q.slice(0, max - 1) + "…" : q;
}

function ago(ts) {
  const s = Math.floor((Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function tryJSON(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return null;
  try { return JSON.parse(v); } catch { return null; }
}

// ── Cooldown ─────────────────────────────────────────────

function isOnCooldown(q) {
  const entry = shownMarkets.get(q);
  if (!entry) return false;
  const limit = entry.structural ? STRUCTURAL_COOLDOWN : COOLDOWN_CYCLES;
  return (cycleCount - entry.cycle) < limit;
}

function markShown(q, structural = false) {
  shownMarkets.set(q, { cycle: cycleCount, structural });
}

function isHeldPosition(conditionId) {
  return conditionId && heldConditionIds.has(conditionId);
}

function pickFresh(items, structural = false) {
  for (const item of items) {
    if (isHeldPosition(item.conditionId)) continue;
    if (!isOnCooldown(item.q || item.title)) return item;
  }
  return null;
}

function pruneCooldowns() {
  for (const [q, entry] of shownMarkets) {
    const limit = entry.structural ? STRUCTURAL_COOLDOWN : COOLDOWN_CYCLES;
    if (cycleCount - entry.cycle >= limit) shownMarkets.delete(q);
  }
}

async function refreshHeldPositions() {
  try {
    const address = await getWalletAddress();
    if (!address) return;
    const res = await fetch(
      `${DATA_API}/positions?user=${address}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return;
    const positions = await res.json();
    if (!Array.isArray(positions)) return;
    const ids = new Set();
    for (const p of positions) {
      const size = parseFloat(p.size || 0);
      const curPrice = parseFloat(p.curPrice || 0);
      if (size <= 0 || size * curPrice < 0.50) continue; // skip dust
      if (p.conditionId) ids.add(p.conditionId);
    }
    heldConditionIds = ids;
  } catch (err) {
    console.error(`[scanner] held positions refresh error: ${err.message}`);
  }
}

// ── Data source 1: Live trade feed ───────────────────────

async function fetchRecentTrades() {
  // Big trades in the last cycle window
  const res = await fetch(
    `${DATA_API}/trades?limit=50&filterType=CASH&filterAmount=500`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`trades ${res.status}`);
  return res.json();
}

function analyzeTradeFlow(trades) {
  // Group by event, compute net flow (skip sports)
  const byEvent = new Map();
  for (const t of trades) {
    if (isSportsMarket(t.title || "")) continue;
    const key = t.eventSlug || t.conditionId;
    if (!byEvent.has(key)) {
      byEvent.set(key, {
        title: t.title, slug: t.slug, eventSlug: t.eventSlug,
        conditionId: t.conditionId || null,
        buys: 0, sells: 0, buyVol: 0, sellVol: 0,
        biggestTrade: 0, lastTs: 0, traders: new Set(),
      });
    }
    const ev = byEvent.get(key);
    // Track conditionId from most recent trade
    if (t.conditionId && !ev.conditionId) ev.conditionId = t.conditionId;
    const vol = t.size * t.price;
    if (t.side === "BUY") { ev.buys++; ev.buyVol += vol; }
    else { ev.sells++; ev.sellVol += vol; }
    if (vol > ev.biggestTrade) ev.biggestTrade = vol;
    if (t.timestamp > ev.lastTs) ev.lastTs = t.timestamp;
    if (t.name || t.pseudonym) ev.traders.add(t.name || t.pseudonym);
  }

  // Score by net flow imbalance + total volume
  const flows = [];
  for (const [, ev] of byEvent) {
    const total = ev.buyVol + ev.sellVol;
    const netFlow = ev.buyVol - ev.sellVol;
    const imbalance = total > 0 ? Math.abs(netFlow) / total : 0;
    flows.push({
      q: ev.title, slug: ev.slug, eventSlug: ev.eventSlug,
      conditionId: ev.conditionId,
      buys: ev.buys, sells: ev.sells,
      buyVol: ev.buyVol, sellVol: ev.sellVol,
      netFlow, imbalance, total,
      biggestTrade: ev.biggestTrade, lastTs: ev.lastTs,
      traderCount: ev.traders.size,
      score: total * (1 + imbalance),
    });
  }
  flows.sort((a, b) => b.score - a.score);
  return flows;
}

// ── Data source 2: Gamma API (market metadata) ──────────

async function fetchGammaMarkets() {
  const allMarkets = [];
  for (const offset of [0, 100]) {
    const res = await fetch(
      `${GAMMA_API}/events?active=true&closed=false&limit=100&offset=${offset}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) throw new Error(`gamma ${res.status}`);
    const events = await res.json();
    if (events.length === 0) break;
    for (const event of events) {
      if (!event.markets) continue;
      for (const m of event.markets) {
        if (m.closed || !m.active) continue;
        if (isSportsMarket(m.question || event.title || "")) continue;
        const prices = tryJSON(m.outcomePrices) || [];
        const tokenIds = tryJSON(m.clobTokenIds) || [];
        allMarkets.push({
          question: m.question || event.title,
          conditionId: m.conditionId,
          eventSlug: event.slug || null,
          tokenId: tokenIds[0] || null,
          prices: prices.map(Number),
          outcomes: tryJSON(m.outcomes) || [],
          volume: Number(m.volumeNum || 0),
          volume24h: Number(event.volume24hr || 0),
          liquidity: Number(event.liquidity || 0),
          endDate: m.endDate || event.endDate,
          spread: Number(m.spread || 0),
          bestBid: Number(m.bestBid || 0),
          bestAsk: Number(m.bestAsk || 0),
          lastPrice: Number(m.lastTradePrice || 0),
          change1h: m.oneHourPriceChange != null ? Number(m.oneHourPriceChange) : null,
          change1d: m.oneDayPriceChange != null ? Number(m.oneDayPriceChange) : null,
          change1w: m.oneWeekPriceChange != null ? Number(m.oneWeekPriceChange) : null,
          competitive: Number(event.competitive || 0),
          clobTokenIds: tokenIds,
        });
      }
    }
  }
  return allMarkets;
}

// ── Data source 3: CLOB live midpoints ───────────────────

async function fetchLiveMidpoints(tokenIds) {
  if (tokenIds.length === 0) return {};
  // Batch up to 50 at a time
  const batch = tokenIds.slice(0, 50);
  const body = batch.map((id) => ({ token_id: id }));
  const res = await fetch(`${CLOB_API}/midpoints`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return {};
  return res.json();
}

// ── Alpha detection ──────────────────────────────────────

function detectAlpha(markets) {
  const now = Date.now();
  const signals = {
    movers1h: [],    // moved in the last HOUR (not just 24h)
    movers1d: [],    // big daily moves
    volumeSpikes: [],
    catalysts: [],
    deepValue: [],
    tightRaces: [],
    wideSpread: [],
  };

  for (const m of markets) {
    const yes = m.prices[0] || 0;
    const no = m.prices[1] || 0;
    if (yes <= 0.001 || no <= 0.001) continue;

    // HOURLY movers (much more responsive than daily)
    if (m.change1h != null && Math.abs(m.change1h) >= 0.01 && m.volume24h > 3000) {
      const dir = m.change1h > 0 ? "↑" : "↓";
      signals.movers1h.push({
        q: m.question, conditionId: m.conditionId, dir, change1h: m.change1h, change1d: m.change1d,
        price: yes, volume24h: m.volume24h, liquidity: m.liquidity,
        score: Math.abs(m.change1h) * Math.log10(Math.max(m.volume24h, 1)),
      });
    }

    // Daily movers
    if (m.change1d != null && Math.abs(m.change1d) >= 0.03 && m.volume24h > 5000) {
      const dir = m.change1d > 0 ? "↑" : "↓";
      signals.movers1d.push({
        q: m.question, conditionId: m.conditionId, dir, change1d: m.change1d, change1w: m.change1w,
        price: yes, volume24h: m.volume24h, liquidity: m.liquidity,
        score: Math.abs(m.change1d) * Math.log10(Math.max(m.volume24h, 1)),
      });
    }

    // Volume spikes
    if (m.volume > 0 && m.volume24h > 10000) {
      const ratio = m.volume24h / m.volume;
      if (ratio > 0.05) {
        signals.volumeSpikes.push({
          q: m.question, conditionId: m.conditionId, ratio, volume24h: m.volume24h, totalVol: m.volume,
          price: yes, change1h: m.change1h, liquidity: m.liquidity,
          score: ratio * Math.log10(m.volume24h),
        });
      }
    }

    // Catalysts (expiring + active)
    if (m.endDate) {
      const hrsLeft = (new Date(m.endDate).getTime() - now) / 3600000;
      if (hrsLeft > 0 && hrsLeft < 72 && m.volume24h > 5000) {
        signals.catalysts.push({
          q: m.question, conditionId: m.conditionId, hrsLeft, price: yes, endDate: m.endDate,
          change1h: m.change1h, change1d: m.change1d, volume24h: m.volume24h, liquidity: m.liquidity,
          score: (m.volume24h / Math.max(hrsLeft, 1)) * (1 + Math.abs(m.change1h || 0) * 10),
        });
      }
    }

    // Deep value
    if (yes >= 0.005 && yes <= 0.10 && m.liquidity > 10000 && m.volume24h > 1000) {
      signals.deepValue.push({
        q: m.question, conditionId: m.conditionId, outcome: m.outcomes[0] || "Yes",
        price: yes, liquidity: m.liquidity, volume24h: m.volume24h,
        change1h: m.change1h, change1d: m.change1d,
        score: (m.liquidity / yes) * Math.log10(Math.max(m.volume24h, 1)),
      });
    }

    // Tight races
    if (yes >= 0.35 && yes <= 0.65 && m.competitive > 0.7 && m.volume24h > 10000) {
      signals.tightRaces.push({
        q: m.question, conditionId: m.conditionId, price: yes, competitive: m.competitive,
        volume24h: m.volume24h, change1h: m.change1h, change1d: m.change1d, liquidity: m.liquidity,
        score: m.competitive * m.volume24h,
      });
    }

    // Wide spreads (potential arb)
    if (m.spread > 0.03 && m.liquidity > 20000) {
      signals.wideSpread.push({
        q: m.question, conditionId: m.conditionId, spread: m.spread, bid: m.bestBid, ask: m.bestAsk,
        liquidity: m.liquidity, volume24h: m.volume24h,
        score: m.spread * m.liquidity,
      });
    }
  }

  for (const key of Object.keys(signals)) {
    signals[key].sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  return signals;
}

// ── News-first alpha: GDELT → market matching ───────────

const GDELT_API = "https://api.gdeltproject.org/api/v2/doc/doc";
const STOP_WORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","is","are",
  "was","were","be","been","will","would","could","should","has","have","had",
  "do","does","did","not","no","so","if","than","that","this","with","from",
  "by","as","it","its","they","them","their","he","she","his","her","we","our",
  "you","your","can","may","about","up","out","all","more","also","into",
  "over","after","before","between","under","new","said","says",
]);

function extractKeywords(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function matchScore(newsKeywords, marketQuestion) {
  const mktWords = new Set(extractKeywords(marketQuestion));
  let hits = 0;
  for (const kw of newsKeywords) {
    if (mktWords.has(kw)) hits++;
  }
  return hits;
}

async function detectNewsAlpha(markets) {
  const newsMatches = [];
  try {
    // 1. Fetch breaking news from GDELT (last 4 hours, sorted by relevance)
    const params = new URLSearchParams({
      query: "",
      mode: "ArtList",
      maxrecords: "50",
      timespan: "4h",
      format: "json",
      sort: "HybridRel",
    });
    const res = await fetch(`${GDELT_API}?${params}`, {
      headers: { Accept: "application/json", "User-Agent": "polymarket-alpha/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return newsMatches;
    const data = await res.json();
    const articles = data.articles || [];
    if (articles.length === 0) return newsMatches;

    // 2. Cluster articles by topic (group overlapping headlines)
    const topics = [];
    for (const art of articles) {
      const title = art.title || "";
      if (!title || title.length < 15) continue;
      const kws = extractKeywords(title);
      if (kws.length < 2) continue;

      // Try to merge into existing topic
      let merged = false;
      for (const topic of topics) {
        const overlap = kws.filter(k => topic.keywords.has(k)).length;
        if (overlap >= 2) {
          topic.articleCount++;
          for (const k of kws) topic.keywords.add(k);
          if (!topic.titles.includes(title)) topic.titles.push(title);
          topic.tone += Number(art.tone || 0);
          merged = true;
          break;
        }
      }
      if (!merged) {
        topics.push({
          keywords: new Set(kws),
          titles: [title],
          articleCount: 1,
          tone: Number(art.tone || 0),
          domain: art.domain || "",
        });
      }
    }

    // 3. For each topic cluster, find matching Polymarket markets
    for (const topic of topics) {
      if (topic.articleCount < 2) continue; // need 2+ articles = real story
      const topicKws = [...topic.keywords];
      const avgTone = topic.articleCount > 0 ? topic.tone / topic.articleCount : 0;

      for (const m of markets) {
        if (isSportsMarket(m.question)) continue;
        const score = matchScore(topicKws, m.question);
        if (score < 2) continue; // need 2+ keyword matches

        // Score: keyword matches × article count × liquidity factor
        const liqFactor = Math.log10(Math.max(m.liquidity, 1000));
        const finalScore = score * topic.articleCount * liqFactor;

        newsMatches.push({
          q: m.question,
          conditionId: m.conditionId,
          eventSlug: m.eventSlug,
          price: m.prices[0] || 0,
          liquidity: m.liquidity,
          volume24h: m.volume24h,
          keywordHits: score,
          articleCount: topic.articleCount,
          avgTone,
          headlines: topic.titles.slice(0, 3),
          score: finalScore,
        });
      }
    }

    newsMatches.sort((a, b) => b.score - a.score);
    // Dedup by conditionId — keep highest score
    const seen = new Set();
    const deduped = [];
    for (const nm of newsMatches) {
      if (seen.has(nm.conditionId)) continue;
      seen.add(nm.conditionId);
      deduped.push(nm);
    }
    return deduped.slice(0, 10); // top 10 news-matched markets
  } catch (err) {
    console.error(`[scanner] news-alpha error: ${err.message}`);
    return [];
  }
}

// ── Cross-cycle midpoint deltas ──────────────────────────

function detectMidpointShifts(markets, liveMids) {
  const shifts = [];
  const newMids = new Map();

  for (const m of markets) {
    if (!m.conditionId) continue;
    const mid = liveMids[m.tokenId] != null
      ? Number(liveMids[m.tokenId])
      : m.prices[0] || 0;
    if (mid <= 0.001) continue;

    newMids.set(m.conditionId, mid);
    const prev = prevMidpoints.get(m.conditionId);
    if (prev != null) {
      const diff = mid - prev;
      if (Math.abs(diff) >= 0.005 && m.volume24h > 3000) {
        shifts.push({
          q: m.question, conditionId: m.conditionId, from: prev, to: mid, diff,
          volume24h: m.volume24h,
        });
      }
    }
  }

  prevMidpoints = newMids;
  shifts.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return shifts;
}

// ── Build output entries ─────────────────────────────────

function buildEntries(markets, signals, tradeFlows, midShifts, newsMatches = []) {
  const entries = [];
  cycleCount++;
  pruneCooldowns();

  // Scan header with real stats
  const liveCount = markets.filter((m) => (m.prices[0] || 0) > 0.001).length;
  const tradeVol = tradeFlows.reduce((s, f) => s + f.total, 0);
  const heldSuffix = heldConditionIds.size > 0 ? ` | ${heldConditionIds.size} held` : "";
  entries.push(entry("scan",
    `Cycle #${cycleCount} — ${liveCount} markets | ${tradeFlows.length} active events | ${fmtVol(tradeVol)} recent flow${heldSuffix}`
  ));

  // 1. LIVE TRADE FLOW (freshest data — seconds old)
  if (tradeFlows.length > 0) {
    const flow = pickFresh(tradeFlows);
    if (flow) {
      const dir = flow.netFlow > 0 ? "NET BUY" : flow.netFlow < 0 ? "NET SELL" : "MIXED";
      const bias = flow.imbalance > 0.6 ? " (strong bias)" : "";
      entries.push(entry("think",
        `Live flow: "${truncQ(flow.q)}" — ${fmtVol(flow.total)} in ${flow.buys + flow.sells} trades, ${dir}${bias}, biggest ${fmtVol(flow.biggestTrade)}, ${ago(flow.lastTs)}`
      ));
      markShown(flow.q);
    }
  }

  // 1b. NEWS-FIRST ALPHA (breaking news → market matches)
  if (newsMatches.length > 0) {
    const nm = newsMatches.find((n) => !isOnCooldown(n.q) && !isHeldPosition(n.conditionId));
    if (nm) {
      const headline = nm.headlines[0] ? `"${nm.headlines[0].slice(0, 60)}"` : "";
      entries.push(entry("think",
        `News match: "${truncQ(nm.q)}" — ${nm.articleCount} articles, ${nm.keywordHits} keyword hits, tone ${nm.avgTone > 0 ? "+" : ""}${nm.avgTone.toFixed(1)} ${headline}`
      ));
      markShown(nm.q);
    }
  }

  // 2. REAL-TIME MIDPOINT SHIFTS (since last scan)
  if (midShifts.length > 0) {
    const shift = midShifts.find((s) => !isOnCooldown(s.q) && !isHeldPosition(s.conditionId));
    if (shift) {
      const dir = shift.diff > 0 ? "↑" : "↓";
      entries.push(entry("think",
        `${dir} Price shift: "${truncQ(shift.q)}" moved ${fmtPct(Math.abs(shift.diff))} since last scan (${fmtPct(shift.from)} → ${fmtPct(shift.to)})`
      ));
      markShown(shift.q);
    }
  }

  // 3. SIGNAL from rotating category
  // structural=true → 4h cooldown (deep value, wide spread, tight races don't change fast)
  const categories = [
    { key: "movers1h", structural: false, fmt: (m) =>
      `${m.dir} Hourly mover: "${truncQ(m.q)}" ${m.dir}${fmtPct(Math.abs(m.change1h))} in 1h (now ${fmtPct(m.price)}), 24h vol ${fmtVol(m.volume24h)}` },
    { key: "volumeSpikes", structural: false, fmt: (m) =>
      `Volume surge: "${truncQ(m.q)}" — ${fmtVol(m.volume24h)} in 24h (${(m.ratio * 100).toFixed(0)}% of lifetime), ${m.change1h != null ? (m.change1h > 0 ? "↑" : "↓") + fmtPct(Math.abs(m.change1h)) + " this hour" : `price ${fmtPct(m.price)}`}` },
    { key: "catalysts", structural: false, fmt: (m) =>
      `Catalyst: "${truncQ(m.q)}" — ${hoursLeft(m.endDate)} to resolution, ${fmtPct(m.price)} YES, ${m.change1h != null ? (m.change1h > 0 ? "↑" : "↓") + fmtPct(Math.abs(m.change1h)) + " this hour, " : ""}vol ${fmtVol(m.volume24h)}` },
    { key: "wideSpread", structural: true, fmt: (m) =>
      `Wide spread: "${truncQ(m.q)}" — bid ${fmtPct(m.bid)} / ask ${fmtPct(m.ask)} (${fmtPct(m.spread)} spread), liq ${fmtVol(m.liquidity)}` },
    { key: "deepValue", structural: true, fmt: (m) =>
      `Deep value: "${truncQ(m.q)}" — ${m.outcome} @ ${fmt$(m.price)}, liq ${fmtVol(m.liquidity)}, 24h vol ${fmtVol(m.volume24h)}${m.change1h != null ? `, ${m.change1h > 0 ? "↑" : "↓"}${fmtPct(Math.abs(m.change1h))} 1h` : ""}` },
    { key: "tightRaces", structural: true, fmt: (m) =>
      `Tight race: "${truncQ(m.q)}" — ${fmtPct(m.price)} YES, 24h vol ${fmtVol(m.volume24h)}${m.change1h != null ? `, ${m.change1h > 0 ? "↑" : "↓"}${fmtPct(Math.abs(m.change1h))} 1h` : ""}` },
    { key: "movers1d", structural: false, fmt: (m) => {
      const wk = m.change1w != null ? `, ${m.change1w > 0 ? "↑" : "↓"}${fmtPct(Math.abs(m.change1w))} 1w` : "";
      return `${m.dir} Daily mover: "${truncQ(m.q)}" ${m.dir}${fmtPct(Math.abs(m.change1d))} today${wk}, 24h vol ${fmtVol(m.volume24h)}`;
    }},
  ];

  const start = (cycleCount - 1) % categories.length;
  let emitted = 0;
  for (let i = 0; i < categories.length && emitted < 2; i++) {
    const cat = categories[(start + i) % categories.length];
    const items = signals[cat.key];
    if (!items || items.length === 0) continue;
    const item = pickFresh(items, cat.structural);
    if (!item) continue;
    entries.push(entry("think", cat.fmt(item)));
    markShown(item.q || item.title, cat.structural);
    emitted++;
  }

  if (entries.length <= 1) {
    entries.push(entry("think", "All top signals on cooldown — markets stable, no fresh alpha."));
  }

  // 4. DECISION — best actionable opportunity
  const decision = pickDecision(signals, tradeFlows);
  entries.push(entry("decision", decision));

  return entries;
}

function pickDecision(signals, flows) {
  // Priority: trade flow imbalance > hourly movers > wide spread > deep value > catalyst
  const sources = [
    { items: flows.filter((f) => f.imbalance > 0.6 && f.total > 2000), fmt: (f) => {
      const dir = f.netFlow > 0 ? "buyers dominating" : "sellers dominating";
      return `Flow signal: "${truncQ(f.q)}" — ${dir} (${fmtVol(Math.abs(f.netFlow))} net), ${f.traderCount} traders, ${ago(f.lastTs)}`;
    }},
    { items: signals.movers1h, fmt: (m) =>
      `Hourly momentum: "${truncQ(m.q)}" ${m.dir}${fmtPct(Math.abs(m.change1h))} in 1h, now ${fmtPct(m.price)}, vol ${fmtVol(m.volume24h)}` },
    { items: signals.wideSpread, fmt: (m) =>
      `Spread opportunity: "${truncQ(m.q)}" — ${fmtPct(m.spread)} spread (bid ${fmtPct(m.bid)} / ask ${fmtPct(m.ask)}), liq ${fmtVol(m.liquidity)}` },
    { items: signals.deepValue, fmt: (m) =>
      `Value bet: "${truncQ(m.q)}" — ${m.outcome} @ ${fmt$(m.price)}, liq ${fmtVol(m.liquidity)}` },
    { items: signals.catalysts, fmt: (m) =>
      `Expiring: "${truncQ(m.q)}" — ${fmtPct(m.price)} YES, ${hoursLeft(m.endDate)} left` },
  ];

  for (const { items, fmt } of sources) {
    if (!items || items.length === 0) continue;
    const item = pickFresh(items);
    if (item) {
      markShown(item.q || item.title);
      return fmt(item);
    }
  }

  return "No fresh edge — all top signals recently reported. Standing by.";
}

// ── GitHub push ──────────────────────────────────────────

async function getExistingJsonl(token, repo) {
  const url = `https://api.github.com/repos/${repo}/contents/${JSONL_PATH}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return { sha: null, entries: [] };
  if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf8");
  const entries = content.split("\n").filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return { sha: data.sha, entries };
}

async function pushJsonl(token, repo, sha, entries) {
  const url = `https://api.github.com/repos/${repo}/contents/${JSONL_PATH}`;
  const content = Buffer.from(
    entries.map((e) => typeof e === "string" ? e : JSON.stringify(e)).join("\n") + "\n",
  ).toString("base64");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
    body: JSON.stringify({ message: `scanner: cycle ${cycleCount}`, content, ...(sha ? { sha } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub PUT ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ── Write signals to disk for auto-trade CLI ─────────────

function getSignalDir() {
  if (process.env.MOON_STATE_DIR) return process.env.MOON_STATE_DIR;
  if (existsSync("/data")) return "/data/.moon";
  return join(homedir(), ".moon");
}

function writeSignalsToFile(markets, signals, tradeFlows, midShifts, newsMatches = []) {
  try {
    const dir = getSignalDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "signals.json");
    const tmp = file + ".tmp";
    const intervalMs = Number(env("SCANNER_INTERVAL_MS", String(DEFAULT_INTERVAL_MS)));
    const data = {
      cycle: cycleCount,
      timestamp: iso(),
      staleAfterMs: intervalMs * 2, // stale after 2x interval
      markets,
      signals,
      tradeFlows,
      midShifts,
      newsMatches,
    };
    writeFileSync(tmp, JSON.stringify(data), "utf-8");
    renameSync(tmp, file);
  } catch (err) {
    console.error(`[scanner] signal file write error: ${err.message}`);
  }
}

// ── Polygon USDC balance ─────────────────────────────────


let _walletAddress = null;
async function getWalletAddress() {
  if (_walletAddress) return _walletAddress;

  // 1. Explicit env var (zero-dependency, fastest)
  if (process.env.POLYMARKET_WALLET_ADDRESS) {
    _walletAddress = process.env.POLYMARKET_WALLET_ADDRESS;
    return _walletAddress;
  }

  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) return null;

  // 2. Try local import
  try {
    const ethers = await import("ethers");
    _walletAddress = new ethers.Wallet(pk).address;
    return _walletAddress;
  } catch {}

  // 3. Try global npm location via createRequire
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire("/usr/local/lib/node_modules/");
    const ethers = req("ethers");
    _walletAddress = new ethers.Wallet(pk).address;
    return _walletAddress;
  } catch {}

  // 4. Derive using Node.js crypto ECDH + keccak via global viem
  try {
    const crypto = await import("node:crypto");
    const clean = pk.startsWith("0x") ? pk.slice(2) : pk;
    const ecdh = crypto.createECDH("secp256k1");
    ecdh.setPrivateKey(Buffer.from(clean, "hex"));
    const pubUncompressed = ecdh.getPublicKey().subarray(1); // drop 0x04 prefix, 64 bytes

    // Need keccak256 (NOT sha3-256). Try loading keccak from global viem.
    const { createRequire } = await import("node:module");
    const req = createRequire("/usr/local/lib/node_modules/");
    const { keccak256 } = req("viem");
    const hash = keccak256(pubUncompressed);
    _walletAddress = "0x" + hash.slice(-40);
    return _walletAddress;
  } catch (err) {
    console.error(`[scanner] wallet address derivation failed: ${err.message}`);
    return null;
  }
}


// ── Auto-sell: take profit + stop loss ────────────────────

const TAKE_PROFIT_PCT = 30;   // take profit at +30% — lock in gains
const STOP_LOSS_PCT = -15;    // tighter stop-loss at -15% — preserve capital
const MIN_EXIT_PRICE = 0.005; // never sell below 0.5¢ — better to let it expire worthless than give away shares

async function autoTakeProfit() {
  const address = await getWalletAddress();
  if (!address) return [];
  const entries = [];

  try {
    const res = await fetch(
      `${DATA_API}/positions?user=${address}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return [];
    const positions = await res.json();
    if (!Array.isArray(positions)) return [];

    const { getMarket, placeBet, redeemPosition } = await import("./lib/polymarket.mjs");

    for (const p of positions) {
      const pnlPct = parseFloat(p.percentPnl || 0);
      const size = parseFloat(p.size || 0);
      const curPrice = parseFloat(p.curPrice || 0);
      if (size <= 0) continue;

      // Silently skip dust positions — not worth logging every cycle
      const posValue = size * curPrice;
      if (curPrice > 0 && posValue < 0.50) continue;

      const cid = p.conditionId;
      const title = (p.title || "").slice(0, 55);
      const outcome = (p.outcome || "Yes").toLowerCase();

      // Auto-redeem: if market is resolved, try to redeem winning positions
      try {
        const market = await getMarket(cid);
        if (market.closed) {
          // Check if we hold the winning outcome
          const winnerToken = (market.clobTokenIds || []).find((_, i) =>
            market.outcomes?.[i] && (market.tokens || [])[i]?.winner
          );
          // Use CLOB tokens data to check winner
          const tokens = market.tokens || [];
          const ourIdx = outcome === "yes" ? 0 : 1;
          const isWinner = tokens[ourIdx]?.winner;

          if (isWinner && size > 0) {
            const avgPrice = parseFloat(p.avgPrice || 0);
            const cost = size * avgPrice;
            const redeemValue = size; // winning shares pay $1 each
            const cashPnl = redeemValue - cost;
            console.log(`[auto-redeem] Redeeming ${size.toFixed(1)} winning ${outcome.toUpperCase()} shares of "${title}" (cost $${cost.toFixed(2)}, pnl $${cashPnl.toFixed(2)})`);
            try {
              const result = await redeemPosition(cid, market.negRisk, market.clobTokenIds || []);
              entries.push({
                timestamp: new Date().toISOString(),
                type: "redeem",
                message: `[auto-redeem] Redeemed ${outcome.toUpperCase()} ${size.toFixed(1)} shares of "${title}" → tx=${result.txHash} (P&L: +$${cashPnl.toFixed(2)})`,
                cashPnl: cashPnl.toFixed(4),
                cost: cost.toFixed(4),
                value: redeemValue.toFixed(4),
                title: p.title || "",
                outcome,
                size: size.toFixed(4),
                avgPrice: avgPrice.toFixed(4),
              });
              // Track realized P&L for daily summary
              try {
                const { recordRealizedPnl } = await import("./lib/state.mjs");
                recordRealizedPnl(cashPnl);
              } catch {}
            } catch (err) {
              console.error(`[auto-redeem] failed "${title}": ${err.message}`);
            }
          }
          // Skip further sell logic for closed markets
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
      } catch (err) {
        console.error(`[auto-redeem] market check failed "${title}": ${err.message}`);
        continue;
      }

      if (curPrice <= 0) continue;

      // Determine if we should sell: take profit OR stop loss
      const isTakeProfit = pnlPct >= TAKE_PROFIT_PCT;
      const isStopLoss = pnlPct <= STOP_LOSS_PCT;
      if (!isTakeProfit && !isStopLoss) continue;

      // Never sell too cheap — if price is below MIN_EXIT_PRICE, the spread
      // will eat most of the proceeds. Better to hold and let it resolve.
      if (curPrice < MIN_EXIT_PRICE) continue;

      const sellReason = isTakeProfit ? "TAKE PROFIT" : "STOP LOSS";

      try {
        const market = await getMarket(cid);

        const tokenIdx = outcome === "yes" ? 0 : 1;
        const tokenId = market.clobTokenIds?.[tokenIdx];
        if (!tokenId) continue;

        // Check spread before selling — don't sell into a wide spread
        const mktSpread = market.spread || 0;
        if (curPrice > 0 && mktSpread > 0 && (mktSpread / curPrice) > 0.15) {
          entries.push({
            timestamp: new Date().toISOString(),
            type: "palpha",
            message: `Holding "${title}" — spread too wide to sell right now`,
          });
          continue;
        }

        const result = await placeBet(tokenId, "SELL", size, market.negRisk, market.tickSize);

        if (result.success) {
          const proceeds = parseFloat(result.takingAmount || 0);
          const avgPrice = parseFloat(p.avgPrice || 0);
          const cost = size * avgPrice;
          const cashPnl = proceeds - cost;
          console.log(`[auto-sell] ${sellReason}: "${title}" — ${size.toFixed(1)} shares @ ${curPrice} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(0)}%) → $${proceeds.toFixed(2)} (P&L: ${cashPnl >= 0 ? "+" : ""}$${cashPnl.toFixed(2)})`);
          entries.push({
            timestamp: new Date().toISOString(),
            type: "trade",
            message: `${sellReason}: Sold "${title}" — ${size.toFixed(0)} shares @ ${(curPrice * 100).toFixed(1)}¢ (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(0)}%) for $${proceeds.toFixed(2)} (P&L: ${cashPnl >= 0 ? "+" : ""}$${cashPnl.toFixed(2)})`,
          });
          // Track realized P&L for daily summary
          try {
            const { recordRealizedPnl } = await import("./lib/state.mjs");
            recordRealizedPnl(cashPnl);
          } catch {}
        }
      } catch (err) {
        console.error(`[auto-sell] failed "${title}": ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 1500));
    }
  } catch (err) {
    console.error(`[auto-sell] error: ${err.message}`);
  }

  return entries;
}


// ── Daily P&L computation ─────────────────────────────────

async function computeDailyPnlSummary() {
  const address = await getWalletAddress();
  if (!address) return null;

  try {
    const { getDailyPnl, updateUnrealizedPnl } = await import("./lib/state.mjs");

    // Fetch live positions for unrealized P&L
    const res = await fetch(
      `${DATA_API}/positions?user=${address}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const positions = await res.json();
    if (!Array.isArray(positions)) return null;

    let totalCost = 0;
    let totalValue = 0;
    let unrealizedPnl = 0;
    let posCount = 0;

    for (const p of positions) {
      const size = parseFloat(p.size || 0);
      const curPrice = parseFloat(p.curPrice || 0);
      const avgPrice = parseFloat(p.avgPrice || 0);
      if (size <= 0) continue;

      const posValue = size * curPrice;
      if (posValue < 0.50) continue; // skip dust

      const posCost = size * avgPrice;
      totalCost += posCost;
      totalValue += posValue;
      unrealizedPnl += posValue - posCost;
      posCount++;
    }

    // Fetch USDC balance
    let usdcBalance = 0;
    try {
      const balRes = await fetch(`${DATA_API}/balance?user=${address}`, { signal: AbortSignal.timeout(5_000) });
      if (balRes.ok) {
        const balData = await balRes.json();
        usdcBalance = parseFloat(balData?.balance || balData?.usdc || 0);
      }
    } catch {}

    const portfolioValue = usdcBalance + totalValue;

    // Update state with unrealized snapshot
    updateUnrealizedPnl(unrealizedPnl, portfolioValue);

    // Get realized P&L from today's closed trades
    const daily = getDailyPnl();
    const totalPnl = daily.realizedPnl + unrealizedPnl;
    const pnlPct = portfolioValue > 0 ? (totalPnl / (portfolioValue - totalPnl)) * 100 : 0;

    return {
      date: daily.date,
      realizedPnl: daily.realizedPnl,
      realizedCount: daily.realizedCount,
      unrealizedPnl,
      totalPnl,
      pnlPct,
      portfolioValue,
      usdcBalance,
      positionsValue: totalValue,
      positionsCost: totalCost,
      posCount,
    };
  } catch (err) {
    console.error(`[pnl] error computing daily P&L: ${err.message}`);
    return null;
  }
}

// ── Scan cycle ───────────────────────────────────────────

async function runScanCycle() {
  const token = env("GITHUB_TOKEN");
  const repo = env("SCANNER_REPO", DEFAULT_REPO);
  if (!token) return;

  let newEntries = [];
  let autoTradeEntries = [];
  let trades = [];
  let markets = [];
  let liveMids = {};
  let tradeFlows = [];
  let signals = {};
  let midShifts = [];
  let tradeOutput = null;
  let newsMatches = [];

  try {
    // Refresh held positions so we skip markets we already own
    await refreshHeldPositions();

    // Fetch all data sources in parallel
    [trades, markets] = await Promise.all([
      fetchRecentTrades().catch((e) => { console.error(`[scanner] trades error: ${e.message}`); return []; }),
      fetchGammaMarkets().catch((e) => { throw e; }), // gamma is critical
    ]);

    // Get live midpoints for top markets by volume
    const topTokens = markets
      .filter((m) => m.tokenId && m.volume24h > 5000)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 50)
      .map((m) => m.tokenId);
    liveMids = await fetchLiveMidpoints(topTokens).catch(() => ({}));

    // Analyze
    tradeFlows = analyzeTradeFlow(trades);
    signals = detectAlpha(markets);
    midShifts = detectMidpointShifts(markets, liveMids);

    // News-first alpha: fetch breaking news → match to markets
    newsMatches = await detectNewsAlpha(markets).catch((e) => {
      console.error(`[scanner] news-alpha error: ${e.message}`);
      return [];
    });

    newEntries = buildEntries(markets, signals, tradeFlows, midShifts, newsMatches);

    // Write structured signals to disk for moon auto-trade
    writeSignalsToFile(markets, signals, tradeFlows, midShifts, newsMatches);

    // Run auto-trade inline (no cron agent needed)
    try {
      const { cmdAutoTrade } = await import("./lib/auto-trade-cmd.mjs");
      // Suppress stdout output — capture via monkey-patch
      const origLog = console.log;
      console.log = (...a) => {
        // Capture the JSON output from out()
        if (a.length === 1 && typeof a[0] === "string" && a[0].startsWith("{")) {
          try { tradeOutput = JSON.parse(a[0]); } catch { /* not JSON */ }
        }
      };
      await cmdAutoTrade([], { skipDashboardPush: true });
      console.log = origLog;
      if (tradeOutput) {
        const tradeCount = tradeOutput.tradesExecuted?.length || 0;
        const vetoed = tradeOutput.vetoed || 0;
        console.log(`[scanner] auto-trade: ${tradeCount} executed, ${vetoed} vetoed, daily=$${(tradeOutput.dailySpend || 0).toFixed(2)}`);
        if (tradeOutput.dashEntries) autoTradeEntries = tradeOutput.dashEntries;
      }
    } catch (err) {
      console.error(`[scanner] auto-trade error: ${err.message}`);
    }
  } catch (err) {
    console.error(`[scanner] cycle error: ${err.message}`);
    newEntries = [entry("scan", `Error: ${err.message}`)];
  }

  // Build pipeline stats entry for DATA tab
  let pipelineEntry = null;
  try {
    // Collect top signals across all types
    const topSignals = [];
    if (typeof signals === "object" && signals) {
      const sigTypes = ["movers1h", "movers1d", "volumeSpikes", "catalysts", "deepValue", "tightRaces", "wideSpread"];
      for (const st of sigTypes) {
        for (const s of (signals[st] || []).slice(0, 2)) {
          topSignals.push({
            q: (s.q || "").slice(0, 80),
            type: st,
            score: s.score || 0,
            change: s.change1h != null ? `${s.change1h > 0 ? "+" : ""}${(s.change1h * 100).toFixed(1)}%`
              : s.change1d != null ? `${s.change1d > 0 ? "+" : ""}${(s.change1d * 100).toFixed(1)}%`
              : null,
          });
        }
      }
      topSignals.sort((a, b) => b.score - a.score);
    }

    const tradeVol = Array.isArray(tradeFlows)
      ? tradeFlows.reduce((s, f) => s + (f.total || 0), 0)
      : 0;
    const avgImbalance = Array.isArray(tradeFlows) && tradeFlows.length > 0
      ? tradeFlows.reduce((s, f) => s + (f.imbalance || 0), 0) / tradeFlows.length
      : 0;
    const avgMidMag = Array.isArray(midShifts) && midShifts.length > 0
      ? midShifts.reduce((s, ms) => s + Math.abs(ms.diff || 0), 0) / midShifts.length
      : 0;

    pipelineEntry = {
      type: "pipeline",
      timestamp: iso(),
      cycle: cycleCount,
      ingestion: {
        markets: Array.isArray(markets) ? markets.length : 0,
        trades: Array.isArray(trades) ? trades.length : 0,
        tradeVolume: Math.round(tradeVol),
        midpointsFetched: Object.keys(liveMids || {}).length,
      },
      signals: {
        movers1h: signals?.movers1h?.length || 0,
        movers1d: signals?.movers1d?.length || 0,
        volumeSpikes: signals?.volumeSpikes?.length || 0,
        catalysts: signals?.catalysts?.length || 0,
        deepValue: signals?.deepValue?.length || 0,
        tightRaces: signals?.tightRaces?.length || 0,
        wideSpread: signals?.wideSpread?.length || 0,
      },
      tradeFlows: {
        count: Array.isArray(tradeFlows) ? tradeFlows.length : 0,
        totalVolume: Math.round(tradeVol),
        avgImbalance: parseFloat(avgImbalance.toFixed(3)),
      },
      midShifts: {
        count: Array.isArray(midShifts) ? midShifts.length : 0,
        avgMagnitude: parseFloat(avgMidMag.toFixed(4)),
      },
      enrichment: {
        rawOpportunities: tradeOutput?.opportunities || 0,
        enriched: tradeOutput?.enriched || 0,
        vetoed: tradeOutput?.vetoed || 0,
        vetoReasons: tradeOutput?.vetoReasons || {},
        grokCalls: tradeOutput?.enriched || 0, // approximate: 1 Grok call per enriched opp
        recommendations: tradeOutput?.recommendations || {},
      },
      execution: {
        tradesExecuted: tradeOutput?.tradesExecuted?.length || 0,
        skipped: tradeOutput?.skipped?.length || 0,
        skipReasons: tradeOutput?.skipReasons || {},
        dailySpend: tradeOutput?.dailySpend || 0,
        openPositions: tradeOutput?.openPositions || 0,
      },
      topSignals: topSignals.slice(0, 5),
    };
  } catch (err) {
    console.error(`[scanner] pipeline entry error: ${err.message}`);
  }

  // Auto-sell positions that hit profit target
  let profitEntries = [];
  try {
    profitEntries = await autoTakeProfit();
  } catch (err) {
    console.error(`[scanner] auto-sell error: ${err.message}`);
  }

  // Daily P&L summary — compute and add to dashboard entries
  let pnlEntries = [];
  try {
    const pnl = await computeDailyPnlSummary();
    if (pnl) {
      const sign = pnl.totalPnl >= 0 ? "+" : "";
      const target2pct = pnl.portfolioValue * 0.02;
      const progressPct = target2pct > 0 ? ((pnl.totalPnl / target2pct) * 100).toFixed(0) : "0";
      const pnlMsg = `Daily P&L: ${sign}$${pnl.totalPnl.toFixed(2)} (${sign}${pnl.pnlPct.toFixed(1)}%) | Realized: ${sign}$${pnl.realizedPnl.toFixed(2)} (${pnl.realizedCount} trades) | Unrealized: ${pnl.unrealizedPnl >= 0 ? "+" : ""}$${pnl.unrealizedPnl.toFixed(2)} (${pnl.posCount} positions) | Portfolio: $${pnl.portfolioValue.toFixed(2)} (USDC: $${pnl.usdcBalance.toFixed(2)} + positions: $${pnl.positionsValue.toFixed(2)}) | 2% target: ${progressPct}%`;
      pnlEntries.push({ timestamp: new Date().toISOString(), type: "pnl", message: pnlMsg });
      console.log(`[scanner] ${pnlMsg}`);
    }
  } catch (err) {
    console.error(`[scanner] P&L error: ${err.message}`);
  }

  // Push to GitHub (scanner + auto-trade + auto-sell + P&L entries combined — single write to avoid SHA race)
  try {
    const { sha, entries: existing } = await getExistingJsonl(token, repo);
    const parsedNew = newEntries.map((e) => typeof e === "string" ? JSON.parse(e) : e);
    const pipelineEntries = pipelineEntry ? [pipelineEntry] : [];
    const combined = [...existing, ...parsedNew, ...pipelineEntries, ...profitEntries, ...pnlEntries, ...autoTradeEntries];
    const trimmed = combined.slice(-MAX_ENTRIES);
    await pushJsonl(token, repo, sha, trimmed);
    console.log(`[scanner] pushed ${newEntries.length} scan + ${autoTradeEntries.length} trade entries (total: ${trimmed.length})`);
  } catch (err) {
    console.error(`[scanner] GitHub push error: ${err.message}`);
  }

}

// ── Public API ───────────────────────────────────────────

export function startScanner() {
  const token = env("GITHUB_TOKEN");
  const enabled = env("SCANNER_ENABLED", token ? "true" : "false");
  if (enabled.toLowerCase() === "false") {
    console.log("[scanner] disabled"); return;
  }
  if (!token) {
    console.warn("[scanner] GITHUB_TOKEN not set — scanner will not start"); return;
  }
  if (running) { console.warn("[scanner] already running"); return; }

  const intervalMs = Number(env("SCANNER_INTERVAL_MS", String(DEFAULT_INTERVAL_MS)));
  running = true;
  console.log(`[scanner] v5 started — interval ${intervalMs}ms, repo ${env("SCANNER_REPO", DEFAULT_REPO)}`);
  console.log(`[scanner] sources: gamma-api + data-api/trades + clob/midpoints`);

  runScanCycle().catch((err) => console.error(`[scanner] first cycle error: ${err.message}`));
  intervalId = setInterval(() => {
    runScanCycle().catch((err) => console.error(`[scanner] cycle error: ${err.message}`));
  }, intervalMs);
}

export function stopScanner() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  running = false;
  console.log("[scanner] stopped");
}
