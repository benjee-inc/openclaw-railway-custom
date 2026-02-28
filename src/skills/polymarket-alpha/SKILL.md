---
name: polymarket-alpha
description: Alternative data alpha scanner for Polymarket. Detects mispricings by comparing prediction market prices against external data sources (weather forecasts, crypto prices, economic indicators, news sentiment, flight tracking, research papers).
metadata: { "openclaw": { "emoji": "🔬", "requires": { "bins": ["palpha"], "env": [] } } }
---

# palpha -- Polymarket Alternative Data Alpha Scanner

You have access to the `palpha` CLI tool for detecting mispricings in Polymarket prediction markets using external "alternative data" sources. All output is JSON.

## What It Does

The Polymarket scanner (`moon`) tells you *what's moving*. `palpha` tells you *what SHOULD be moving but isn't* — markets where the price diverges from what real-world data suggests.

It bridges the information gap across 7 categories:
- **Weather**: NWS forecasts vs temperature/storm markets (highest confidence — NWS is 85-90% accurate for 1-3 day)
- **Crypto**: CoinGecko prices + Fear & Greed vs price-target markets
- **Economics**: FRED indicators vs GDP/CPI/unemployment markets (requires FRED_API_KEY)
- **Geopolitics**: GDELT news volume + tone + OpenSky flight density vs conflict markets
- **Politics**: GDELT news sentiment as event-likelihood proxy
- **Tech/AI**: arXiv paper velocity + news sentiment
- **Entertainment**: News volume + tone

## Commands

### Full Scan
```bash
palpha scan                          # Scan all markets, rank by alpha score
palpha scan --category weather       # Filter to one category
palpha scan --top 10                 # Top N results (default 20)
```

Returns ranked alerts with:
- `alpha` — divergence score (higher = stronger mispricing signal)
- `divergence` — market price vs alt-data implied probability
- `direction` — UNDERPRICED_YES or OVERPRICED_YES
- `confidence` — how reliable the alt data source is
- `recommendation` — ACTIONABLE, NOTABLE, MONITOR, or NOISE
- `detail` — human-readable explanation of the signal

### Deep Dive
```bash
palpha lookup <conditionId>          # Full analysis of one market
```

Shows market data, category classification, all matched alt data sources, raw alt data, and scoring breakdown.

### Debug Classification
```bash
palpha categorize                    # Show how markets are classified
```

Displays category distribution and sample markets per category with their classification scores.

### Orderbook Depth
```bash
palpha depth <conditionId>           # Live orderbook depth + alpha cross-check
```

Shows CLOB orderbook (bids/asks), slippage estimates ($100/$500/$1K), liquidity scoring, and a combined verdict (STRONG_BUY / BUY / MONITOR / WATCH / SKIP) based on alpha signal strength vs actual executable depth.

### Network Analysis
```bash
palpha network                       # Build market graph, detect violations
palpha network --category crypto     # Filter to one category
```

Builds a relationship graph across all active markets. Detects **network violations**:
- **Threshold monotonicity**: "BTC > $100k" priced lower than "BTC > $150k" (impossible)
- **Complement deviation**: YES + NO prices not summing to ~100% (spread arb)
- **Correlation divergence**: Highly similar markets with contradictory prices

Returns graph statistics (nodes, edges, components, hub markets) and ranked violations.

### Full Cross-Reference
```bash
palpha crossref                      # Alpha + depth + network combined
palpha crossref --top 10             # Top N results
palpha crossref --category weather   # Filter by category
```

The most powerful command. For each alpha signal:
1. Scores the divergence (alt data vs market price)
2. Fetches live orderbook depth (slippage, liquidity)
3. Checks network context (related markets, violations, hub status)
4. Produces a **composite score** and **verdict**

Composite score weights: alpha signal (50%), depth executability (30%), network context (20%).

### Source Status
```bash
palpha sources                       # List all data sources
palpha sources --test                # Test API connectivity for all sources
```

## Data Sources (all free, no required API keys)

| Source | Coverage | Confidence | Note |
|--------|----------|-----------|------|
| NWS (weather.gov) | US weather | Very High (85-90%) | 30 US cities |
| CoinGecko | Crypto prices | Medium (50-55%) | Extrapolation-based |
| Fear & Greed | Crypto sentiment | Low (modifier only) | Adjusts crypto scores |
| FRED | Economic indicators | Medium-High (55%) | Requires FRED_API_KEY |
| GDELT | Global news | Low-Medium (25-40%) | Volume + tone proxy |
| OpenSky | Flight tracking | Low (modifier only) | Conflict zone density |
| arXiv | Research papers | Low (modifier only) | Publication velocity |

## Interpreting Results

### Alpha Score
- **> 0.15 + confidence > 0.6**: ACTIONABLE — strong mispricing signal, alt data strongly disagrees with market
- **> 0.08 + confidence > 0.4**: NOTABLE — meaningful divergence, worth investigating
- **> 0.03**: MONITOR — mild signal, could develop
- **< 0.03**: NOISE — no meaningful divergence detected

### Best Categories
1. **Weather** markets have the highest alpha potential — NWS forecasts are very accurate and free, while many market participants don't check them
2. **Crypto** price-target markets can be scored against live prices
3. **Economics** with FRED data provides strong signals for CPI/GDP/unemployment markets

### Lower Confidence Categories
- Politics, entertainment, and generic markets use GDELT news volume as a proxy — this is a weak signal and should be treated as supplementary information only

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FRED_API_KEY` | Optional | FRED API key for economic data (free at fred.stlouisfed.org) |

## Workflow

1. Run `palpha crossref` for the full pipeline (alpha + depth + network)
2. For STRONG_BUY verdicts, review the composite breakdown
3. Run `palpha depth <conditionId>` for detailed orderbook inspection
4. Run `palpha network` to check for structural arbitrage (network violations)
5. Use `moon bet` to act on high-conviction, executable signals

### Legacy Workflow
1. Run `palpha scan` to find top mispricings
2. For ACTIONABLE alerts, run `palpha lookup <conditionId>` for full analysis
3. Cross-reference with `moon market <conditionId>` for order book depth
4. Use `moon bet` to act on high-conviction signals

## PMXT Data Archive

Historical orderbook snapshots are available from the [PMXT archive](https://archive.pmxt.dev/Polymarket) as hourly Parquet files (~500MB each, 26K+ markets). The `depth` command references the latest snapshot URL. For historical analysis, use DuckDB:

```sql
-- Query specific market depth from PMXT archive
SELECT data FROM parquet_scan('https://r2.pmxt.dev/polymarket_orderbook_2026-02-28T16.parquet')
WHERE market_id = '0x...' AND update_type = 'book_snapshot'
ORDER BY timestamp_received DESC LIMIT 2;
```

Schema: `timestamp_received`, `timestamp_created_at`, `market_id` (= conditionId), `update_type` (book_snapshot | price_change), `data` (JSON with bids/asks arrays).

## Guidelines

1. **Weather markets are the highest-edge category.** NWS data is extremely accurate for short-term forecasts and most market participants don't check it.
2. **ACTIONABLE does not mean guaranteed.** Even high-confidence signals can be wrong. Always consider what the alt data might be missing.
3. **Low-confidence GDELT signals are directional only.** News volume surges indicate something is happening, but don't tell you the probability precisely.
4. **Run `sources --test` first** to verify all APIs are accessible before trusting scan results.
5. **FRED_API_KEY is optional but valuable.** Without it, economics markets get lower-quality GDELT-only scoring.
6. **Combine with moon scanner.** Use `palpha` for "what's mispriced" and `moon` scanner for "what's moving" — they complement each other.
