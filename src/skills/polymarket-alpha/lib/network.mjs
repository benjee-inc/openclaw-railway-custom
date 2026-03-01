// polymarket-alpha — market relationship graph & network violation detection
// Lightweight directed graph (NetworkX-style) built in pure JS
// Detects structural arbitrage: related markets with contradictory pricing

// ── Graph primitives ──────────────────────────────────────────

class MarketGraph {
  constructor() {
    this.nodes = new Map(); // conditionId → market data
    this.edges = new Map(); // conditionId → Map<conditionId, edge>
    this.clusters = [];
  }

  addNode(id, data) {
    this.nodes.set(id, data);
    if (!this.edges.has(id)) this.edges.set(id, new Map());
  }

  addEdge(from, to, attrs) {
    if (!this.edges.has(from)) this.edges.set(from, new Map());
    if (!this.edges.has(to)) this.edges.set(to, new Map());
    this.edges.get(from).set(to, attrs);
    this.edges.get(to).set(from, { ...attrs, reverse: true });
  }

  neighbors(id) {
    return this.edges.has(id) ? [...this.edges.get(id).keys()] : [];
  }

  degree(id) {
    return this.edges.has(id) ? this.edges.get(id).size : 0;
  }

  getEdge(from, to) {
    return this.edges.get(from)?.get(to) || null;
  }

  nodeCount() { return this.nodes.size; }
  edgeCount() {
    let c = 0;
    for (const [, m] of this.edges) c += m.size;
    return c / 2; // undirected
  }
}

// ── Relationship detection ────────────────────────────────────

/**
 * Extract entities/topics from a market question for matching.
 * Returns normalized tokens for overlap comparison.
 */
function extractTopics(question) {
  const q = question.toLowerCase();
  const topics = new Set();

  // Named entities (capitalized words 3+ chars)
  const entities = question.match(/\b[A-Z][a-z]{2,}\b/g) || [];
  for (const e of entities) topics.add(e.toLowerCase());

  // Crypto tickers
  const tickers = q.match(/\b(btc|eth|sol|xrp|doge|ada|bnb|avax|dot|matic)\b/gi) || [];
  for (const t of tickers) topics.add(t.toLowerCase());

  // Dollar amounts (normalize to magnitude)
  const amounts = q.match(/\$[\d,.]+[kmbt]?/gi) || [];
  for (const a of amounts) topics.add(a.toLowerCase());

  // Dates
  const dates = q.match(/\b\d{4}[-/]\d{2}[-/]\d{2}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/gi) || [];
  for (const d of dates) topics.add(d.toLowerCase());

  // Key noun phrases
  const nouns = q.match(/\b(?:president|election|gdp|cpi|temperature|bitcoin|ethereum|recession|war|ceasefire|tariff|inflation|unemployment)\b/gi) || [];
  for (const n of nouns) topics.add(n.toLowerCase());

  return topics;
}

/**
 * Compute similarity between two markets based on topic overlap.
 * Returns 0–1 (Jaccard similarity of topic sets).
 */
function topicSimilarity(q1, q2) {
  const t1 = extractTopics(q1);
  const t2 = extractTopics(q2);
  if (t1.size === 0 || t2.size === 0) return 0;
  let intersection = 0;
  for (const t of t1) if (t2.has(t)) intersection++;
  return intersection / (t1.size + t2.size - intersection);
}

/**
 * Detect if two markets form a threshold pair (e.g., "BTC above $100k" vs "BTC above $150k").
 * Returns the relationship type or null.
 */
function detectThresholdRelation(q1, q2) {
  // Extract "above/below $X" patterns
  const thresholdPattern = /\b(above|below|exceed|under|over|reach|hit)\s+\$?([\d,.]+)\s*([kmbt])?/gi;
  const t1 = [...q1.matchAll(thresholdPattern)];
  const t2 = [...q2.matchAll(thresholdPattern)];

  if (t1.length === 0 || t2.length === 0) return null;

  // Parse numeric values
  const parseVal = (match) => {
    let val = Number(match[2].replace(/,/g, ""));
    const suffix = (match[3] || "").toLowerCase();
    if (suffix === "k") val *= 1e3;
    if (suffix === "m") val *= 1e6;
    if (suffix === "b") val *= 1e9;
    if (suffix === "t") val *= 1e12;
    return { direction: match[1].toLowerCase(), value: val };
  };

  const v1 = parseVal(t1[0]);
  const v2 = parseVal(t2[0]);

  if (v1.value === v2.value) return null; // same threshold

  const sameDirection = v1.direction === v2.direction ||
    (["above", "exceed", "over", "reach", "hit"].includes(v1.direction) &&
     ["above", "exceed", "over", "reach", "hit"].includes(v2.direction)) ||
    (["below", "under"].includes(v1.direction) &&
     ["below", "under"].includes(v2.direction));

  if (!sameDirection) return null;

  return {
    type: "threshold_pair",
    lowerThreshold: Math.min(v1.value, v2.value),
    upperThreshold: Math.max(v1.value, v2.value),
    direction: ["above", "exceed", "over", "reach", "hit"].includes(v1.direction) ? "above" : "below",
  };
}

// ── Network construction ──────────────────────────────────────

/**
 * Build a market relationship graph from a list of markets.
 * Connects markets that share topics, have threshold relationships,
 * or belong to the same category with high similarity.
 *
 * @param {object[]} markets — array of market objects with question, conditionId, etc.
 * @returns {MarketGraph}
 */
export function buildGraph(markets) {
  const graph = new MarketGraph();

  // Add all markets as nodes
  for (const m of markets) {
    graph.addNode(m.conditionId, m);
  }

  // Build edges — O(n^2) but capped by MAX_PER_CATEGORY in scan
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const m1 = markets[i];
      const m2 = markets[j];

      const sim = topicSimilarity(m1.question, m2.question);
      if (sim < 0.25) continue; // too different

      const threshold = detectThresholdRelation(m1.question, m2.question);
      const sameCategory = m1._category === m2._category;

      if (sim >= 0.4 || threshold || (sameCategory && sim >= 0.25)) {
        graph.addEdge(m1.conditionId, m2.conditionId, {
          similarity: Math.round(sim * 100) / 100,
          threshold,
          sameCategory,
          relationType: threshold ? "threshold_pair" : sim >= 0.6 ? "strong" : "related",
        });
      }
    }
  }

  return graph;
}

// ── Mutual exclusivity detection (AI-powered + fast heuristic fallback) ────

// Cache to avoid repeated LLM calls for the same pair
const _mexCache = new Map();
const _MEX_CACHE_TTL = 3600_000; // 1 hour

/**
 * AI-powered mutual exclusivity check.
 * Uses a fast/cheap model via OpenRouter to determine if two markets
 * are mutually exclusive outcomes (e.g., different teams in the same league).
 *
 * Falls back to heuristic if no API key or on error.
 */
async function areMutuallyExclusive(q1, q2) {
  // Fast heuristic first — if confident, skip LLM
  const heuristic = heuristicMutuallyExclusive(q1, q2);
  if (heuristic === true) return true;

  // Check cache
  const cacheKey = [q1, q2].sort().join("|||");
  const cached = _mexCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < _MEX_CACHE_TTL) return cached.result;

  // Try AI check
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    // No API key — rely on heuristic only
    return heuristic;
  }

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.0-flash-001",
        max_tokens: 10,
        temperature: 0,
        messages: [{
          role: "user",
          content: `Are these two prediction market questions mutually exclusive (only one can resolve YES)?\n\nQ1: "${q1}"\nQ2: "${q2}"\n\nAnswer ONLY "yes" or "no".`,
        }],
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (resp.ok) {
      const data = await resp.json();
      const answer = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();
      const result = answer.startsWith("yes");
      _mexCache.set(cacheKey, { result, ts: Date.now() });
      return result;
    }
  } catch {
    // Timeout or error — fall back to heuristic
  }

  _mexCache.set(cacheKey, { result: heuristic, ts: Date.now() });
  return heuristic;
}

/**
 * Fast heuristic fallback for mutual exclusivity.
 * Returns true if clearly mutually exclusive, false otherwise.
 */
function heuristicMutuallyExclusive(q1, q2) {
  // Pattern: "Will [SUBJECT] [verb] the [COMPETITION]?"
  const winPattern = /^Will\s+(.+?)\s+(win|finish|place|qualify|make)\s+(.+?)(?:\?|$)/i;
  const m1 = q1.match(winPattern);
  const m2 = q2.match(winPattern);

  if (m1 && m2) {
    const verb1 = m1[2].toLowerCase();
    const verb2 = m2[2].toLowerCase();
    const frame1 = m1[3].toLowerCase().replace(/[?\s]+$/, "").trim();
    const frame2 = m2[3].toLowerCase().replace(/[?\s]+$/, "").trim();
    const subject1 = m1[1].toLowerCase().trim();
    const subject2 = m2[1].toLowerCase().trim();

    if (verb1 === verb2 && subject1 !== subject2) {
      // Exact frame match
      if (frame1 === frame2) return true;
      // Fuzzy frame match (75%+ word overlap)
      const words1 = new Set(frame1.split(/\s+/));
      const words2 = new Set(frame2.split(/\s+/));
      let overlap = 0;
      for (const w of words1) if (words2.has(w)) overlap++;
      const jac = overlap / (words1.size + words2.size - overlap);
      if (jac > 0.75) return true;
    }
  }

  // Pattern: "[SUBJECT] announced as next [ROLE]?"
  const announcePattern = /^(.+?)\s+announced\s+as\s+(.+?)(?:\?|$)/i;
  const a1 = q1.match(announcePattern);
  const a2 = q2.match(announcePattern);
  if (a1 && a2) {
    const role1 = a1[2].toLowerCase().replace(/[?\s]+$/, "").trim();
    const role2 = a2[2].toLowerCase().replace(/[?\s]+$/, "").trim();
    if (role1 === role2 && a1[1].toLowerCase().trim() !== a2[1].toLowerCase().trim()) return true;
  }

  return false;
}

// ── Network violation detection ───────────────────────────────

/**
 * Detect network violations — markets that contradict each other structurally.
 *
 * Types of violations:
 * 1. **Threshold monotonicity**: "BTC > $100k" should be priced higher than "BTC > $150k"
 *    If "BTC > $150k" is priced HIGHER, that's a violation.
 * 2. **Complement violation**: YES + NO should sum to ~1.0. Large deviations = arb.
 * 3. **Correlation violation**: Strongly related markets moving in opposite directions.
 * 4. **Liquidity imbalance**: One side of a related pair has 10x more liquidity.
 *
 * @param {MarketGraph} graph
 * @returns {object[]} array of violations
 */
export function detectViolations(graph) {
  const violations = [];
  const seen = new Set();

  for (const [id, neighbors] of graph.edges) {
    const m1 = graph.nodes.get(id);
    if (!m1) continue;

    for (const [nid, edge] of neighbors) {
      if (edge.reverse) continue; // skip reverse edges
      const pairKey = [id, nid].sort().join("|");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const m2 = graph.nodes.get(nid);
      if (!m2) continue;

      const p1 = m1.prices?.[0] || 0; // YES price
      const p2 = m2.prices?.[0] || 0;

      // 1. Threshold monotonicity violation
      if (edge.threshold) {
        const { lowerThreshold, upperThreshold, direction } = edge.threshold;
        // Which market has the lower threshold?
        const m1HasLower = m1.question.includes(String(lowerThreshold)) ||
          m1.question.match(new RegExp(`\\$?${lowerThreshold.toLocaleString().replace(/,/g, ",?")}`, "i"));

        if (direction === "above") {
          // "above lower" should be priced >= "above upper"
          const lowerPrice = m1HasLower ? p1 : p2;
          const upperPrice = m1HasLower ? p2 : p1;
          const lowerMarket = m1HasLower ? m1 : m2;
          const upperMarket = m1HasLower ? m2 : m1;

          if (upperPrice > lowerPrice + 0.02) {
            violations.push({
              type: "threshold_monotonicity",
              severity: Math.round((upperPrice - lowerPrice) * 100) / 100,
              detail: `"${truncQ(upperMarket.question)}" (${fmtPct(upperPrice)}) priced HIGHER than "${truncQ(lowerMarket.question)}" (${fmtPct(lowerPrice)}). Impossible: reaching ${upperThreshold} implies reaching ${lowerThreshold}.`,
              markets: [lowerMarket.conditionId, upperMarket.conditionId],
              lowerThreshold,
              upperThreshold,
              lowerPrice,
              upperPrice,
              arbitrage: Math.round((upperPrice - lowerPrice) * 10000) / 10000,
            });
          }
        }
      }

      // 2. Complement check (YES + NO should be ~1.0)
      if (m1.prices?.length >= 2) {
        const complement = m1.prices[0] + m1.prices[1];
        if (Math.abs(complement - 1.0) > 0.03) {
          violations.push({
            type: "complement_deviation",
            severity: Math.round(Math.abs(complement - 1.0) * 100) / 100,
            detail: `"${truncQ(m1.question)}" YES+NO = ${fmtPct(complement)} (expected ~100%). Spread arb: ${fmtPct(Math.abs(complement - 1.0))}.`,
            markets: [m1.conditionId],
            yesPrice: m1.prices[0],
            noPrice: m1.prices[1],
            deviation: Math.round((complement - 1.0) * 10000) / 10000,
          });
        }
      }

      // 3. Correlation violation: highly similar markets with divergent prices
      //    Candidates are collected here; mutual exclusivity is checked async in detectViolationsAsync()
      if (edge.similarity >= 0.6 && !edge.threshold) {
        const priceDiff = Math.abs(p1 - p2);
        if (priceDiff > 0.15) {
          // Quick heuristic pre-filter — skip if clearly mutually exclusive
          if (!heuristicMutuallyExclusive(m1.question, m2.question)) {
            violations.push({
              type: "correlation_divergence",
              severity: Math.round(priceDiff * 100) / 100,
              detail: `Highly similar markets (${(edge.similarity * 100).toFixed(0)}% overlap) with ${fmtPct(priceDiff)} price gap. "${truncQ(m1.question)}" (${fmtPct(p1)}) vs "${truncQ(m2.question)}" (${fmtPct(p2)}).`,
              markets: [m1.conditionId, m2.conditionId],
              similarity: edge.similarity,
              prices: [p1, p2],
              _q1: m1.question,
              _q2: m2.question,
            });
          }
        }
      }
    }
  }

  // Sort by severity
  violations.sort((a, b) => b.severity - a.severity);
  return violations;
}

/**
 * Async version of detectViolations — runs AI mutual exclusivity check
 * on correlation divergence candidates that passed the heuristic filter.
 * Use this from auto-trade; use sync detectViolations() for fast analysis.
 */
export async function detectViolationsAsync(graph) {
  const violations = detectViolations(graph);

  // AI-check correlation divergence candidates
  const corrDivs = violations.filter(v => v.type === "correlation_divergence" && v._q1 && v._q2);
  const others = violations.filter(v => v.type !== "correlation_divergence");

  const checked = await Promise.allSettled(
    corrDivs.map(async (v) => {
      const mex = await areMutuallyExclusive(v._q1, v._q2);
      return mex ? null : v; // null = mutually exclusive, skip it
    })
  );

  const validCorrDivs = checked
    .filter(r => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value);

  const combined = [...others, ...validCorrDivs];
  combined.sort((a, b) => b.severity - a.severity);
  return combined;
}

/**
 * Compute network-level statistics.
 */
export function graphStats(graph) {
  const degrees = [];
  const components = findComponents(graph);

  for (const [id] of graph.nodes) {
    degrees.push(graph.degree(id));
  }

  const avgDegree = degrees.length > 0 ? degrees.reduce((a, b) => a + b, 0) / degrees.length : 0;
  const maxDegree = degrees.length > 0 ? Math.max(...degrees) : 0;
  const isolated = degrees.filter((d) => d === 0).length;

  // Hub markets (highest degree centrality)
  const hubs = [...graph.nodes.entries()]
    .map(([id, m]) => ({ conditionId: id, question: m.question, degree: graph.degree(id) }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 5);

  return {
    nodes: graph.nodeCount(),
    edges: graph.edgeCount(),
    components: components.length,
    largestComponent: Math.max(0, ...components.map((c) => c.length)),
    avgDegree: Math.round(avgDegree * 100) / 100,
    maxDegree,
    isolatedNodes: isolated,
    hubs,
  };
}

/**
 * Find connected components via BFS.
 */
function findComponents(graph) {
  const visited = new Set();
  const components = [];

  for (const [id] of graph.nodes) {
    if (visited.has(id)) continue;
    const component = [];
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const n of graph.neighbors(current)) {
        if (!visited.has(n)) queue.push(n);
      }
    }
    components.push(component);
  }

  return components;
}

/**
 * Deep research summary for a single market — all network context.
 * Returns the market's neighbors, relationship types, and any violations it's involved in.
 */
export function marketNetworkProfile(graph, conditionId, violations) {
  const market = graph.nodes.get(conditionId);
  if (!market) return null;

  const neighbors = graph.neighbors(conditionId).map((nid) => {
    const n = graph.nodes.get(nid);
    const edge = graph.getEdge(conditionId, nid);
    return {
      conditionId: nid,
      question: n?.question,
      price: n?.prices?.[0],
      relationship: edge?.relationType,
      similarity: edge?.similarity,
      threshold: edge?.threshold,
    };
  });

  const relatedViolations = violations.filter((v) => v.markets.includes(conditionId));

  return {
    conditionId,
    question: market.question,
    price: market.prices?.[0],
    category: market._category,
    degree: graph.degree(conditionId),
    neighbors,
    violations: relatedViolations,
    isHub: graph.degree(conditionId) >= 3,
    riskLevel: relatedViolations.length > 0
      ? relatedViolations.some((v) => v.severity > 0.10) ? "HIGH" : "MEDIUM"
      : "LOW",
  };
}

// Helpers
function truncQ(q, max = 70) {
  return q && q.length > max ? q.slice(0, max - 1) + "..." : (q || "");
}
function fmtPct(n) { return `${(Number(n) * 100).toFixed(1)}%`; }
