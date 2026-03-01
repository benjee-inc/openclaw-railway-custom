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
const COOLDOWN_CYCLES = 6;
let shownMarkets = new Map(); // question → lastShownCycle

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
  const last = shownMarkets.get(q);
  return last != null && (cycleCount - last) < COOLDOWN_CYCLES;
}

function markShown(q) { shownMarkets.set(q, cycleCount); }

function pickFresh(items) {
  for (const item of items) {
    if (!isOnCooldown(item.q || item.title)) return item;
  }
  return null;
}

function pruneCooldowns() {
  for (const [q, cycle] of shownMarkets) {
    if (cycleCount - cycle >= COOLDOWN_CYCLES) shownMarkets.delete(q);
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
          q: m.question, from: prev, to: mid, diff,
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

function buildEntries(markets, signals, tradeFlows, midShifts) {
  const entries = [];
  cycleCount++;
  pruneCooldowns();

  // Scan header with real stats
  const liveCount = markets.filter((m) => (m.prices[0] || 0) > 0.001).length;
  const tradeVol = tradeFlows.reduce((s, f) => s + f.total, 0);
  entries.push(entry("scan",
    `Cycle #${cycleCount} — ${liveCount} markets | ${tradeFlows.length} active events | ${fmtVol(tradeVol)} recent flow`
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

  // 2. REAL-TIME MIDPOINT SHIFTS (since last scan)
  if (midShifts.length > 0) {
    const shift = midShifts.find((s) => !isOnCooldown(s.q));
    if (shift) {
      const dir = shift.diff > 0 ? "↑" : "↓";
      entries.push(entry("think",
        `${dir} Price shift: "${truncQ(shift.q)}" moved ${fmtPct(Math.abs(shift.diff))} since last scan (${fmtPct(shift.from)} → ${fmtPct(shift.to)})`
      ));
      markShown(shift.q);
    }
  }

  // 3. SIGNAL from rotating category
  const categories = [
    { key: "movers1h", fmt: (m) =>
      `${m.dir} Hourly mover: "${truncQ(m.q)}" ${m.dir}${fmtPct(Math.abs(m.change1h))} in 1h (now ${fmtPct(m.price)}), 24h vol ${fmtVol(m.volume24h)}` },
    { key: "volumeSpikes", fmt: (m) =>
      `Volume surge: "${truncQ(m.q)}" — ${fmtVol(m.volume24h)} in 24h (${(m.ratio * 100).toFixed(0)}% of lifetime), ${m.change1h != null ? (m.change1h > 0 ? "↑" : "↓") + fmtPct(Math.abs(m.change1h)) + " this hour" : `price ${fmtPct(m.price)}`}` },
    { key: "catalysts", fmt: (m) =>
      `Catalyst: "${truncQ(m.q)}" — ${hoursLeft(m.endDate)} to resolution, ${fmtPct(m.price)} YES, ${m.change1h != null ? (m.change1h > 0 ? "↑" : "↓") + fmtPct(Math.abs(m.change1h)) + " this hour, " : ""}vol ${fmtVol(m.volume24h)}` },
    { key: "wideSpread", fmt: (m) =>
      `Wide spread: "${truncQ(m.q)}" — bid ${fmtPct(m.bid)} / ask ${fmtPct(m.ask)} (${fmtPct(m.spread)} spread), liq ${fmtVol(m.liquidity)}` },
    { key: "deepValue", fmt: (m) =>
      `Deep value: "${truncQ(m.q)}" — ${m.outcome} @ ${fmt$(m.price)}, liq ${fmtVol(m.liquidity)}, 24h vol ${fmtVol(m.volume24h)}${m.change1h != null ? `, ${m.change1h > 0 ? "↑" : "↓"}${fmtPct(Math.abs(m.change1h))} 1h` : ""}` },
    { key: "tightRaces", fmt: (m) =>
      `Tight race: "${truncQ(m.q)}" — ${fmtPct(m.price)} YES, 24h vol ${fmtVol(m.volume24h)}${m.change1h != null ? `, ${m.change1h > 0 ? "↑" : "↓"}${fmtPct(Math.abs(m.change1h))} 1h` : ""}` },
    { key: "movers1d", fmt: (m) => {
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
    const item = pickFresh(items);
    if (!item) continue;
    entries.push(entry("think", cat.fmt(item)));
    markShown(item.q || item.title);
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

function writeSignalsToFile(markets, signals, tradeFlows, midShifts) {
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
    };
    writeFileSync(tmp, JSON.stringify(data), "utf-8");
    renameSync(tmp, file);
  } catch (err) {
    console.error(`[scanner] signal file write error: ${err.message}`);
  }
}

// ── Scan cycle ───────────────────────────────────────────

async function runScanCycle() {
  const token = env("GITHUB_TOKEN");
  const repo = env("SCANNER_REPO", DEFAULT_REPO);
  if (!token) return;

  let newEntries = [];

  try {
    // Fetch all data sources in parallel
    const [trades, markets] = await Promise.all([
      fetchRecentTrades().catch((e) => { console.error(`[scanner] trades error: ${e.message}`); return []; }),
      fetchGammaMarkets().catch((e) => { throw e; }), // gamma is critical
    ]);

    // Get live midpoints for top markets by volume
    const topTokens = markets
      .filter((m) => m.tokenId && m.volume24h > 5000)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, 50)
      .map((m) => m.tokenId);
    const liveMids = await fetchLiveMidpoints(topTokens).catch(() => ({}));

    // Analyze
    const tradeFlows = analyzeTradeFlow(trades);
    const signals = detectAlpha(markets);
    const midShifts = detectMidpointShifts(markets, liveMids);

    newEntries = buildEntries(markets, signals, tradeFlows, midShifts);

    // Write structured signals to disk for moon auto-trade
    writeSignalsToFile(markets, signals, tradeFlows, midShifts);
  } catch (err) {
    console.error(`[scanner] cycle error: ${err.message}`);
    newEntries = [entry("scan", `Error: ${err.message}`)];
  }

  // Push to GitHub (scanner entries only)
  try {
    const { sha, entries: existing } = await getExistingJsonl(token, repo);
    const parsedNew = newEntries.map((e) => typeof e === "string" ? JSON.parse(e) : e);
    const combined = [...existing, ...parsedNew];
    const trimmed = combined.slice(-MAX_ENTRIES);
    await pushJsonl(token, repo, sha, trimmed);
    console.log(`[scanner] pushed ${newEntries.length} scan entries (total: ${trimmed.length})`);
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
