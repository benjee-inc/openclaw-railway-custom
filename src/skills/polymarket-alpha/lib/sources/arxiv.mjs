// polymarket-alpha — arXiv paper velocity
// Free, no API key required

import { ARXIV_API, TTL } from "../constants.mjs";
import { fetchText } from "../helpers.mjs";
import * as cache from "../cache.mjs";

/**
 * Search arXiv for papers matching a query.
 * Returns paper count and recent publication velocity.
 *
 * @param {string} query - search terms
 * @param {number} [maxResults=20]
 * @returns {Promise<{count: number, papers: Array, recentCount: number, totalResults: number}>}
 */
export async function search(query, maxResults = 20) {
  const cacheKey = `arxiv:${query}:${maxResults}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      search_query: `all:${query}`,
      start: "0",
      max_results: String(maxResults),
      sortBy: "submittedDate",
      sortOrder: "descending",
    });

    const xml = await fetchText(`${ARXIV_API}?${params}`, {}, 20_000);

    // Extract totalResults from OpenSearch metadata
    const totalMatch = xml.match(/<opensearch:totalResults[^>]*>(\d+)/);
    const totalResults = totalMatch ? Number(totalMatch[1]) : 0;

    // Simple XML parsing without dependencies
    const entries = xml.split("<entry>").slice(1);
    const papers = [];
    const now = Date.now();
    let recentCount = 0; // papers in last 7 days

    for (const entry of entries) {
      const title = extractTag(entry, "title")?.replace(/\s+/g, " ").trim();
      const published = extractTag(entry, "published");
      const summary = extractTag(entry, "summary")?.replace(/\s+/g, " ").trim();
      const id = extractTag(entry, "id");

      if (published) {
        const age = now - new Date(published).getTime();
        if (age < 7 * 24 * 3600_000) recentCount++;
      }

      papers.push({
        title: title?.slice(0, 120),
        published,
        id,
        summary: summary?.slice(0, 200),
      });
    }

    const result = { count: papers.length, papers, recentCount, totalResults };
    cache.set(cacheKey, result, TTL.arxiv);
    return result;
  } catch {
    return { count: 0, papers: [], recentCount: 0, totalResults: 0 };
  }
}

/**
 * Extract publication velocity — papers per week for a topic.
 * Uses 200-result sample for accurate weekly counts.
 */
export async function velocity(query) {
  const result = await search(query, 200);
  if (result.count === 0) return { papersPerWeek: 0, previousWeek: 0, acceleration: 0, total: 0, totalResults: 0 };

  // Count papers in different time windows
  const now = Date.now();
  let week1 = 0;
  let week2 = 0;
  for (const p of result.papers) {
    if (!p.published) continue;
    const age = now - new Date(p.published).getTime();
    if (age < 7 * 24 * 3600_000) week1++;
    else if (age < 14 * 24 * 3600_000) week2++;
  }

  return {
    papersPerWeek: week1,
    previousWeek: week2,
    acceleration: week2 > 0 ? week1 / week2 : week1 > 0 ? 2.0 : 0,
    total: result.count,
    totalResults: result.totalResults,
  };
}

/**
 * Simple XML tag extractor (no dependencies).
 */
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Extract tech/AI topic references from market question.
 * Returns array of { query, specificity } where specificity 0-1
 * indicates how precisely the arXiv query matches the market topic.
 */
export function extractTopics(question) {
  const q = question.toLowerCase();

  // High-specificity keyword mappings (these are well-defined arXiv topics)
  const mappings = [
    { keywords: ["gpt-5", "gpt5"], query: "GPT-5 language model", specificity: 0.9 },
    { keywords: ["gpt-4", "gpt4"], query: "GPT-4 language model", specificity: 0.85 },
    { keywords: ["gpt", "openai", "chatgpt"], query: "GPT large language model OpenAI", specificity: 0.7 },
    { keywords: ["claude", "anthropic"], query: "Anthropic Claude AI alignment", specificity: 0.75 },
    { keywords: ["gemini", "google ai", "google deepmind"], query: "Gemini multimodal Google", specificity: 0.7 },
    { keywords: ["llama", "meta ai"], query: "LLaMA open source language model", specificity: 0.7 },
    { keywords: ["agi", "artificial general intelligence"], query: "artificial general intelligence", specificity: 0.8 },
    { keywords: ["quantum computing", "quantum computer", "quantum supremacy"], query: "quantum computing", specificity: 0.85 },
    { keywords: ["self-driving", "autonomous vehicle", "self driving", "driverless"], query: "autonomous driving vehicle", specificity: 0.8 },
    { keywords: ["fusion", "nuclear fusion", "iter"], query: "nuclear fusion energy", specificity: 0.85 },
    { keywords: ["crispr", "gene editing", "gene therapy"], query: "CRISPR gene editing", specificity: 0.85 },
    { keywords: ["neuralink", "brain computer interface", "bci"], query: "brain computer interface neural", specificity: 0.8 },
    { keywords: ["spacex", "starship"], query: "SpaceX reusable rocket", specificity: 0.75 },
    { keywords: ["robotaxi", "robo-taxi", "waymo"], query: "autonomous taxi robotaxi", specificity: 0.8 },
  ];

  for (const m of mappings) {
    if (m.keywords.some((kw) => q.includes(kw))) {
      return [{ query: m.query, specificity: m.specificity }];
    }
  }

  // No fallback — arXiv's full-text search is too noisy for generic queries.
  // Only use arXiv when we have a high-confidence research topic match.
  return [];
}

/**
 * Source status check.
 */
export async function status() {
  try {
    const params = new URLSearchParams({
      search_query: "all:test",
      max_results: "1",
    });
    const res = await fetch(`${ARXIV_API}?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    return { name: "arxiv", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "arxiv", ok: false, error: e.message };
  }
}
