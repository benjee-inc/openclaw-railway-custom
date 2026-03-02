// polymarket-alpha — Grok (xAI) real-time X/Twitter + web search analysis
// Requires XAI_API_KEY env var; silently skips if not set

import { XAI_API, TTL } from "../constants.mjs";
import * as cache from "../cache.mjs";

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
  // Read at call time, not import time — env var may not be set yet at module load
  const apiKey = process.env.XAI_API_KEY || "";
  if (!apiKey) { console.error("[grok] XAI_API_KEY not set — skipping all Grok analysis"); return null; }

  const cacheKey = `grok:${question.slice(0, 80)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    console.log(`[grok] calling xAI for: "${question.slice(0, 60)}"`);
    const res = await fetch(`${XAI_API}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4-1-fast-reasoning",
        messages: [
          {
            role: "system",
            content:
              "You are Grok, an elite high-signal forecaster specialized in prediction markets and real-time event probability assessment.\n\n" +
              "Task: Determine the most accurate probability (0.00–1.00) that the market question resolves YES. Use x_search and web_search tools aggressively and in parallel before reasoning.\n\n" +
              "Mandatory internal process (always follow):\n" +
              "1. Immediately search for the latest data (focus on last 24–72 hours, key accounts, official statements, news, on-the-ground reports).\n" +
              "2. Actively gather evidence for BOTH YES and NO outcomes.\n" +
              "3. Evaluate source credibility, timing, resolution criteria, base rates, and edge cases.\n" +
              "4. Identify major upcoming catalysts and risks.\n" +
              "5. Compare your independent view to the current market price and note any crowd over/under-reaction.\n\n" +
              "Output ONLY a single valid JSON object. No other text, no markdown, no explanations.\n\n" +
              '{"probability": 0.XX, "confidence": "high"|"medium"|"low", "reasoning": "3–6 sentence high-signal synthesis of the strongest evidence, your logic, and why you chose this number", ' +
              '"key_signals": ["bullet 1", "bullet 2", "bullet 3", "bullet 4"], ' +
              '"market_comparison": "One sentence on how/why your probability differs from the current market price", ' +
              '"major_catalysts": ["near-term catalyst 1", "catalyst 2"], ' +
              '"major_risks": ["biggest risk 1", "risk 2"]}',
          },
          {
            role: "user",
            content: `Category: ${category}. Current market price: ${(marketPrice * 100).toFixed(1)}% YES. Question: "${question}"`,
          },
        ],
        tools: [{ type: "x_search" }, { type: "web_search" }],
        temperature: 0,
      }),
      signal: AbortSignal.timeout(50_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(`[grok] API error ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.log(`[grok] no content in response:`, JSON.stringify(data).slice(0, 300));
      return null;
    }

    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.probability == null || isNaN(parsed.probability)) return null;

    const result = {
      probability: Math.max(0, Math.min(1, Number(parsed.probability))),
      confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low",
      reasoning: String(parsed.reasoning || "").slice(0, 400),
      keySignals: Array.isArray(parsed.key_signals) ? parsed.key_signals.slice(0, 6) : [],
      marketComparison: String(parsed.market_comparison || "").slice(0, 200),
      majorCatalysts: Array.isArray(parsed.major_catalysts) ? parsed.major_catalysts.slice(0, 4) : [],
      majorRisks: Array.isArray(parsed.major_risks) ? parsed.major_risks.slice(0, 4) : [],
    };

    cache.set(cacheKey, result, TTL.grok);
    return result;
  } catch (e) {
    console.log(`[grok] error: ${e.message}`);
    return null;
  }
}

/**
 * Source status check.
 */
export async function status() {
  const apiKey = process.env.XAI_API_KEY || "";
  if (!apiKey) return { name: "grok", ok: false, error: "XAI_API_KEY not set" };
  try {
    const res = await fetch(`${XAI_API}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    return { name: "grok", ok: res.ok, status: res.status };
  } catch (e) {
    return { name: "grok", ok: false, error: e.message };
  }
}
