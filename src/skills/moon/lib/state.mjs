// moon/lib/state.mjs -- Persistent JSON state manager
// Atomic writes (write .tmp -> rename). Auto-create on first use.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_STATE = {
  version: 1,
  config: {
    goalUsd: 1000000,
    defaultRiskPct: 2,
    defaultStopLossPct: 20,
    lastWatchCheck: 0,
  },
  journal: [],
  watchlist: [],
  narratives: {},
  scanHistory: [],
  polymarketBets: [],
  autoTrader: {
    dailyDate: null,      // "2026-03-01" — resets spend at midnight UTC
    dailySpend: 0,
    dailyTrades: 0,
    recentTrades: {},     // { conditionId: timestampMs } — 30min cooldown
    lastCycle: null,      // prevent processing same cycle twice
  },
  dailyPnl: {
    date: null,           // "2026-03-01" — resets at midnight UTC
    realizedPnl: 0,       // sum of closed trades PnL today
    realizedCount: 0,     // number of closed trades today
    lastUnrealizedPnl: 0, // snapshot of unrealized P&L from last scan
    lastPortfolioValue: 0,// total portfolio value at last check
    lastChecked: null,    // ISO timestamp of last P&L check
  },
};

// ─── Path Resolution ────────────────────────────────────────────────────────

export function getStateDir() {
  if (process.env.MOON_STATE_DIR) return process.env.MOON_STATE_DIR;
  if (existsSync("/data")) return "/data/.moon";
  return join(homedir(), ".moon");
}

function statePath() {
  return join(getStateDir(), "state.json");
}

// ─── Load / Save ────────────────────────────────────────────────────────────

export function loadState() {
  try {
    const raw = readFileSync(statePath(), "utf-8");
    const parsed = JSON.parse(raw);
    // Merge with defaults for forward compatibility
    return {
      ...DEFAULT_STATE,
      ...parsed,
      config: { ...DEFAULT_STATE.config, ...(parsed.config || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(state) {
  const dir = getStateDir();
  mkdirSync(dir, { recursive: true });
  const file = statePath();
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, file);
}

// ─── Journal CRUD ───────────────────────────────────────────────────────────

export function addJournalEntry(entry) {
  const state = loadState();
  const id = `j_${Date.now()}`;
  const full = { id, status: "open", exitPrice: null, exitTimestamp: null, pnl: null, pnlPct: null, ...entry, timestamp: entry.timestamp || Date.now() };
  state.journal.push(full);
  saveState(state);
  return full;
}

export function updateJournalEntry(id, updates) {
  const state = loadState();
  const idx = state.journal.findIndex(j => j.id === id);
  if (idx === -1) return null;
  state.journal[idx] = { ...state.journal[idx], ...updates };
  saveState(state);
  return state.journal[idx];
}

export function getOpenPositions() {
  const state = loadState();
  return state.journal.filter(j => j.status === "open");
}

export function getJournal(opts = {}) {
  const state = loadState();
  let entries = [...state.journal];
  if (opts.status) entries = entries.filter(j => j.status === opts.status);
  if (opts.narrative) entries = entries.filter(j => (j.narratives || []).includes(opts.narrative));
  if (opts.last) entries = entries.slice(-opts.last);
  return entries;
}

// ─── Watchlist CRUD ─────────────────────────────────────────────────────────

export function addWatchlistItem(item) {
  const state = loadState();
  // Remove existing entry for same mint if present
  state.watchlist = state.watchlist.filter(w => w.mint !== item.mint);
  state.watchlist.push({ addedAt: Date.now(), lastCheck: 0, ...item });
  saveState(state);
  return item;
}

export function removeWatchlistItem(mint) {
  const state = loadState();
  const before = state.watchlist.length;
  state.watchlist = state.watchlist.filter(w => w.mint !== mint);
  saveState(state);
  return state.watchlist.length < before;
}

export function getWatchlist() {
  const state = loadState();
  return state.watchlist;
}

// ─── Narratives ─────────────────────────────────────────────────────────────

export function addNarrative(name, mint, notes) {
  const state = loadState();
  if (!state.narratives[name]) {
    state.narratives[name] = { tokens: [], notes: notes || "" };
  }
  if (mint && !state.narratives[name].tokens.includes(mint)) {
    state.narratives[name].tokens.push(mint);
  }
  if (notes) state.narratives[name].notes = notes;
  saveState(state);
  return state.narratives[name];
}

export function getNarratives() {
  const state = loadState();
  return state.narratives;
}

// ─── Scan History ───────────────────────────────────────────────────────────

export function addScanRecord(record) {
  const state = loadState();
  state.scanHistory.push({ timestamp: Date.now(), ...record });
  if (state.scanHistory.length > 50) {
    state.scanHistory = state.scanHistory.slice(-50);
  }
  saveState(state);
}

// ─── Polymarket Bets ────────────────────────────────────────────────────

export function addPolyBet(bet) {
  const state = loadState();
  if (!state.polymarketBets) state.polymarketBets = [];
  state.polymarketBets.push({ trackedAt: Date.now(), status: "open", ...bet });
  saveState(state);
  return bet;
}

export function getPolyBets(opts = {}) {
  const state = loadState();
  let bets = state.polymarketBets || [];
  if (opts.conditionId) bets = bets.filter(b => b.conditionId === opts.conditionId);
  if (opts.status) bets = bets.filter(b => b.status === opts.status);
  return bets;
}

export function updatePolyBet(conditionId, updates) {
  const state = loadState();
  if (!state.polymarketBets) return null;
  const idx = state.polymarketBets.findIndex(b => b.conditionId === conditionId);
  if (idx === -1) return null;
  state.polymarketBets[idx] = { ...state.polymarketBets[idx], ...updates };
  saveState(state);
  return state.polymarketBets[idx];
}

// ─── Config ─────────────────────────────────────────────────────────────────

export function getConfig() {
  const state = loadState();
  return state.config;
}

export function updateConfig(updates) {
  const state = loadState();
  state.config = { ...state.config, ...updates };
  saveState(state);
  return state.config;
}

// ─── Auto-Trader State ──────────────────────────────────────────────────────

const TRADE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

export function getAutoTraderState() {
  const state = loadState();
  const at = state.autoTrader || {};
  const today = new Date().toISOString().slice(0, 10);
  // Reset daily counters if date changed
  if (at.dailyDate !== today) {
    return { dailyDate: today, dailySpend: 0, dailyTrades: 0, recentTrades: {}, lastCycle: at.lastCycle };
  }
  return at;
}

export function canAutoTrade(amount, maxPerDay = 50) {
  const at = getAutoTraderState();
  return at.dailySpend + amount <= maxPerDay;
}

export function recordAutoTrade(conditionId, amount) {
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (!state.autoTrader || state.autoTrader.dailyDate !== today) {
    state.autoTrader = { dailyDate: today, dailySpend: 0, dailyTrades: 0, recentTrades: {}, lastCycle: state.autoTrader?.lastCycle };
  }
  state.autoTrader.dailySpend += amount;
  state.autoTrader.dailyTrades += 1;
  state.autoTrader.recentTrades[conditionId] = Date.now();
  saveState(state);
}

export function setAutoTraderLastCycle(cycleId) {
  const state = loadState();
  if (!state.autoTrader) state.autoTrader = {};
  state.autoTrader.lastCycle = cycleId;
  saveState(state);
}

export function pruneAutoTraderCooldowns() {
  const state = loadState();
  if (!state.autoTrader?.recentTrades) return;
  const cutoff = Date.now() - TRADE_COOLDOWN_MS;
  let changed = false;
  for (const [id, ts] of Object.entries(state.autoTrader.recentTrades)) {
    if (ts < cutoff) {
      delete state.autoTrader.recentTrades[id];
      changed = true;
    }
  }
  if (changed) saveState(state);
}

export function isRecentlyAutoTraded(conditionId) {
  const at = getAutoTraderState();
  const ts = at.recentTrades?.[conditionId];
  if (!ts) return false;
  return (Date.now() - ts) < TRADE_COOLDOWN_MS;
}

// ─── Daily P&L Tracking ──────────────────────────────────────────────────────

export function getDailyPnl() {
  const state = loadState();
  const pnl = state.dailyPnl || {};
  const today = new Date().toISOString().slice(0, 10);
  if (pnl.date !== today) {
    return { date: today, realizedPnl: 0, realizedCount: 0, lastUnrealizedPnl: 0, lastPortfolioValue: 0, lastChecked: null };
  }
  return pnl;
}

export function recordRealizedPnl(amount) {
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (!state.dailyPnl || state.dailyPnl.date !== today) {
    state.dailyPnl = { date: today, realizedPnl: 0, realizedCount: 0, lastUnrealizedPnl: 0, lastPortfolioValue: 0, lastChecked: null };
  }
  state.dailyPnl.realizedPnl += amount;
  state.dailyPnl.realizedCount += 1;
  saveState(state);
}

// ─── News → Market Memory ────────────────────────────────────────────────────
// Records how news events affected market prices so Grok can learn patterns.
// Stored as separate JSONL file to keep state.json lean.

const MAX_NEWS_MEMORIES = 100;

function newsMemoryPath() {
  return join(getStateDir(), "news-memory.json");
}

function loadNewsMemory() {
  try {
    return JSON.parse(readFileSync(newsMemoryPath(), "utf-8"));
  } catch { return []; }
}

function saveNewsMemory(memories) {
  const dir = getStateDir();
  mkdirSync(dir, { recursive: true });
  const p = newsMemoryPath();
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(memories.slice(-MAX_NEWS_MEMORIES)), "utf-8");
  renameSync(tmp, p);
}

// Record a news→market observation when we first detect a news match
export function recordNewsObservation(obs) {
  const memories = loadNewsMemory();
  // Dedup by conditionId + headline
  const key = `${obs.conditionId}:${(obs.headline || "").slice(0, 40)}`;
  if (memories.some(m => `${m.conditionId}:${(m.headline || "").slice(0, 40)}` === key)) return;
  memories.push({
    ts: new Date().toISOString(),
    conditionId: obs.conditionId,
    question: (obs.question || "").slice(0, 80),
    headline: (obs.headline || "").slice(0, 100),
    articleCount: obs.articleCount || 0,
    tone: obs.tone || 0,
    priceAtNews: obs.priceAtNews || 0,
    priceLater: null, // filled in on follow-up cycles
    priceChange: null,
    traded: obs.traded || false,
    tradePnl: null,
    category: obs.category || "unknown",
  });
  saveNewsMemory(memories);
}

// Update prices for past observations (call each cycle)
export function updateNewsObservations(marketPrices) {
  // marketPrices: Map<conditionId, currentPrice>
  const memories = loadNewsMemory();
  let changed = false;
  const now = Date.now();
  for (const m of memories) {
    if (m.priceLater != null) continue; // already resolved
    const age = now - new Date(m.ts).getTime();
    if (age < 4 * 3600_000) continue; // wait 4h before measuring reaction
    const curPrice = marketPrices.get(m.conditionId);
    if (curPrice != null) {
      m.priceLater = curPrice;
      m.priceChange = curPrice - m.priceAtNews;
      changed = true;
    }
  }
  if (changed) saveNewsMemory(memories);
}

// Get formatted memory string for Grok
export function getNewsMemoryForGrok() {
  const memories = loadNewsMemory();
  const resolved = memories.filter(m => m.priceLater != null);
  if (resolved.length === 0) return "";

  const lines = ["\nNEWS→MARKET REACTION HISTORY (how past news moved prices):"];

  // Compute category stats
  const cats = {};
  for (const m of resolved) {
    const cat = m.category || "unknown";
    if (!cats[cat]) cats[cat] = { moves: [], count: 0 };
    cats[cat].count++;
    cats[cat].moves.push(m.priceChange);
  }
  for (const [cat, data] of Object.entries(cats)) {
    const avg = data.moves.reduce((s, v) => s + v, 0) / data.moves.length;
    const posCount = data.moves.filter(v => v > 0.01).length;
    lines.push(`${cat}: ${data.count} events, avg move ${avg > 0 ? "+" : ""}${(avg * 100).toFixed(1)}pp, ${posCount}/${data.count} moved up`);
  }

  // Show recent examples (last 10)
  lines.push("\nRecent examples:");
  for (const m of resolved.slice(-10)) {
    const dir = m.priceChange >= 0 ? "+" : "";
    lines.push(`- "${m.headline?.slice(0, 50)}" → "${m.question?.slice(0, 40)}" | was ${(m.priceAtNews * 100).toFixed(0)}% → ${(m.priceLater * 100).toFixed(0)}% (${dir}${(m.priceChange * 100).toFixed(1)}pp)${m.traded ? " [TRADED]" : ""}`);
  }
  return lines.join("\n");
}

export function updateUnrealizedPnl(unrealizedPnl, portfolioValue) {
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);
  if (!state.dailyPnl || state.dailyPnl.date !== today) {
    state.dailyPnl = { date: today, realizedPnl: 0, realizedCount: 0, lastUnrealizedPnl: 0, lastPortfolioValue: 0, lastChecked: null };
  }
  state.dailyPnl.lastUnrealizedPnl = unrealizedPnl;
  state.dailyPnl.lastPortfolioValue = portfolioValue;
  state.dailyPnl.lastChecked = new Date().toISOString();
  saveState(state);
}
