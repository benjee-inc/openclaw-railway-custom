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
