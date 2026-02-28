// polymarket-alpha — market categorization engine
// Weighted keyword + regex matching, no ML dependencies

import { CATEGORIES, SPORTS_PATTERNS } from "./constants.mjs";

const MIN_SCORE = 3;

/**
 * Check if a market question is sports-related.
 */
export function isSportsMarket(question) {
  return SPORTS_PATTERNS.some((re) => re.test(question));
}

/**
 * Score a market question against a single category.
 * @returns {number} score
 */
function scoreCategory(question, catDef) {
  let score = 0;
  const q = question.toLowerCase();

  for (const kw of catDef.primary) {
    if (q.includes(kw.toLowerCase())) score += 3;
  }
  for (const kw of catDef.secondary) {
    if (q.includes(kw.toLowerCase())) score += 1;
  }
  for (const re of catDef.patterns) {
    if (re.test(question)) score += 5;
  }

  return score;
}

/**
 * Classify a single market question into a category.
 * @param {string} question
 * @returns {{ category: string, score: number, scores: Record<string, number> }}
 */
export function categorize(question) {
  if (isSportsMarket(question)) {
    return { category: "sports", score: 0, scores: {} };
  }

  const scores = {};
  let bestCat = "unknown";
  let bestScore = 0;

  for (const [cat, def] of Object.entries(CATEGORIES)) {
    const s = scoreCategory(question, def);
    scores[cat] = s;
    if (s > bestScore) {
      bestScore = s;
      bestCat = cat;
    }
  }

  if (bestScore < MIN_SCORE) {
    return { category: "unknown", score: bestScore, scores };
  }

  return { category: bestCat, score: bestScore, scores };
}

/**
 * Classify an array of markets.
 * @param {Array<{question: string}>} markets
 * @returns {Map<string, Array>} category → markets[]
 */
export function categorizeAll(markets) {
  const byCategory = new Map();

  for (const m of markets) {
    const { category, score } = categorize(m.question || "");
    if (category === "sports") continue; // drop sports entirely

    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push({ ...m, _category: category, _catScore: score });
  }

  return byCategory;
}

/**
 * Get category distribution summary.
 */
export function categorySummary(byCategory) {
  const summary = {};
  for (const [cat, markets] of byCategory) {
    summary[cat] = markets.length;
  }
  return summary;
}
