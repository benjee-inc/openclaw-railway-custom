// polymarket-alpha — Grok (xAI) real-time X/Twitter + web search analysis
// Uses the Responses API (/v1/responses) with web_search + x_search tools
// Requires XAI_API_KEY env var; silently skips if not set

import { XAI_API, TTL } from "../constants.mjs";
import * as cache from "../cache.mjs";

/**
 * Analyze a prediction market question using Grok's web_search + x_search.
 * Returns a probability estimate with confidence and reasoning.
 */
const GROK_TIMEOUT = 75_000; // 75s — Responses API with tools is slow
const MAX_RETRIES = 1;       // retry once on timeout

export async function analyzeMarket(question, category, marketPrice, signalContext = null) {
  const apiKey = process.env.XAI_API_KEY || "";
  if (!apiKey) { console.error("[grok] XAI_API_KEY not set — skipping"); return null; }

  const cacheKey = `grok:${question.slice(0, 80)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const label = attempt > 0 ? ` (retry ${attempt})` : "";
      console.log(`[grok] calling xAI for: "${question.slice(0, 60)}"${label}`);
      const res = await fetch(`${XAI_API}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "grok-4-1-fast-reasoning",
          input: [
            {
              role: "system",
              content:
                "You are a calibrated prediction market probability oracle. You will be penalized for overconfidence.\n\n" +
                "INSTRUCTIONS:\n" +
                "1. Search X and the web for the LATEST info (last 24h) before answering.\n" +
                "2. Estimate the TRUE probability (0.00–1.00) that the question resolves YES.\n" +
                "3. Provide a 95% confidence interval around your estimate.\n" +
                "4. Compare your estimate to the current market price — the EDGE is what matters.\n" +
                "5. Estimate optimal hold time (minutes, hours, or days).\n" +
                "6. List key risks that could invalidate your thesis.\n\n" +
                "CALIBRATION RULES:\n" +
                "- If your 95% CI spans more than 30 percentage points, your confidence MUST be 'low'.\n" +
                "- If you cannot find recent news (<24h) confirming the signal, confidence MUST be 'low' or 'medium'.\n" +
                "- Only use 'high' confidence when multiple independent sources confirm and CI < 15 points.\n" +
                "- Markets priced 40-60% are inherently uncertain — default to 'medium' or 'low' unless strong evidence.\n\n" +
                "Output ONLY a single valid JSON object. No other text.\n" +
                '{"probability": 0.XX, "confidence_interval": [0.XX, 0.XX], "confidence": "high"|"medium"|"low", ' +
                '"reasoning": "3-6 sentences", "key_signals": ["signal1", "signal2", "signal3"], ' +
                '"major_risks": ["risk1", "risk2"], "hold_time": "Xh"|"Xd"|"Xm", ' +
                '"market_comparison": "How and why your view differs from the market price"}',
            },
            {
              role: "user",
              content: `Category: ${category}. Current market price: ${(marketPrice * 100).toFixed(1)}% YES (implied probability).${signalContext ? `\nScanner signal: ${signalContext}` : ""}\n\nQuestion: "${question}"`,
            },
          ],
          tools: [
            { type: "web_search" },
            { type: "x_search" },
          ],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(GROK_TIMEOUT),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[grok] API error ${res.status}: ${body.slice(0, 300)}`);
        // Retry on 429 (rate limit) or 5xx
        if (attempt < MAX_RETRIES && (res.status === 429 || res.status >= 500)) {
          const backoff = (attempt + 1) * 3_000;
          console.log(`[grok] retrying in ${backoff / 1000}s...`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        return null;
      }

      const data = await res.json();

      // Responses API: output is an array of items; find the text output
      let content = null;
      if (data.output) {
        for (const item of data.output) {
          if (item.type === "message" && item.content) {
            for (const block of item.content) {
              if (block.type === "output_text" || block.type === "text") {
                content = block.text;
                break;
              }
            }
          }
        }
      }
      // Fallback: try chat completions format
      if (!content) {
        content = data.choices?.[0]?.message?.content;
      }

      if (!content) {
        console.log(`[grok] no content in response:`, JSON.stringify(data).slice(0, 400));
        return null;
      }

      // Extract JSON from response (may be wrapped in markdown code block)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.log(`[grok] no JSON in response: ${content.slice(0, 200)}`); return null; }

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
      console.log(`[grok] OK: "${question.slice(0, 40)}" → ${(result.probability * 100).toFixed(0)}% (${result.confidence})`);
      if (result.reasoning) console.log(`[grok] reasoning: ${result.reasoning}`);
      if (result.keySignals?.length > 0) console.log(`[grok] signals: ${result.keySignals.join(" | ")}`);
      return result;
    } catch (e) {
      const isTimeout = e.name === "TimeoutError" || e.name === "AbortError" || e.message?.includes("abort");
      if (isTimeout && attempt < MAX_RETRIES) {
        console.log(`[grok] timeout after ${GROK_TIMEOUT / 1000}s, retrying...`);
        continue;
      }
      console.error(`[grok] error: ${e.message}`);
      return null;
    }
  }
  return null;
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
