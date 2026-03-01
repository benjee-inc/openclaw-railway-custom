// polymarket-alpha — Grok (xAI) real-time X/Twitter + web search analysis
// Requires X_API_KEY env var; silently skips if not set

import { XAI_API, TTL } from "../constants.mjs";
import * as cache from "../cache.mjs";

const API_KEY = process.env.X_API_KEY || "";

/**
 * Analyze a prediction market question using Grok's x_search + web_search.
 * Returns a probability estimate with confidence and reasoning.
 *
 * @param {string} question - the market question
 * @param {string} category - market category (weather, crypto, etc.)
 * @param {number} marketPrice - current YES price (0-1)
 * @returns {Promise<{probability: number, confidence: string, reasoning: string}|null>}
 */
export async function analyzeMarket(question, category, marketPrice) {
  if (!API_KEY) return null;

  const cacheKey = `grok:${question.slice(0, 80)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`${XAI_API}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "grok-4-1-fast-reasoning",
        messages: [
          {
            role: "system",
            content:
              "You are Grok, doing high-signal analysis for prediction markets. " +
              "Use X posts and web search to assess the current probability of the following market question resolving YES. " +
              "Cross-reference latest X posts, news, and real-time data. " +
              'Output ONLY valid JSON: {"probability": <0-1>, "confidence": "high"|"medium"|"low", "reasoning": "<1-2 sentences>"}',
          },
          {
            role: "user",
            content: `Category: ${category}. Current market price: ${(marketPrice * 100).toFixed(1)}% YES. Question: "${question}"`,
          },
        ],
        tools: [{ type: "x_search" }, { type: "web_search" }],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.probability == null || isNaN(parsed.probability)) return null;

    const result = {
      probability: Math.max(0, Math.min(1, Number(parsed.probability))),
      confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low",
      reasoning: String(parsed.reasoning || "").slice(0, 200),
    };

    cache.set(cacheKey, result, TTL.grok);
    return result;
  } catch {
    return null;
  }
}

/**
 * Source status check.
 */
export async function status() {
  if (!API_KEY) return { name: "grok", ok: false, error: "X_API_KEY not set" };
  try {
    const res = await fetch(`${XAI_API}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(5_000),
    });
    return { name: "grok", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "grok", ok: false, error: e.message };
  }
}
