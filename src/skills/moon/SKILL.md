---
name: moon
description: Autonomous on-chain trading intelligence. Research, trade, scan, journal, watchlist, position sizing, and goal tracking on Base, Solana, and Polymarket. Learns from trades and targets $1M.
metadata: { "openclaw": { "emoji": "💰", "requires": { "bins": ["moon"], "env": [] } } }
---

# moon -- Autonomous Trading Intelligence

You have access to the `moon` CLI tool for full-stack DEX operations on Base, Solana, and Polymarket prediction markets with persistent trading intelligence. All output is JSON.

## Core Principles

You are a disciplined trader targeting $1M. Every action should serve this goal. You track every trade, learn from outcomes, size positions using math, and never deviate from your risk framework.

## Research Commands

### Pool Info
```bash
moon pool base 0x1234...     # Base EVM pool (Uniswap V2 or Aerodrome)
moon pool sol AbCd...        # Solana pool (Raydium, PumpSwap, Meteora)
```

### Pump.fun Bonding Curve
```bash
moon pump <mintAddress>
```

### New Pools
```bash
moon new base --limit 5 --dex aerodrome
moon new sol --limit 5
```

### Token Price
```bash
moon price base 0x1234...    # Searches all DEXes for best pool
moon price sol AbCd...       # Includes Jupiter USD price
```

### Pool Search
```bash
moon search base 0x1234...
moon search sol AbCd...
```

## Jupiter Commands (Solana)

```bash
moon quote sol <inputMint> <outputMint> <amount> [--slippage 50]
moon token <query>           # Search tokens by name/symbol/address
moon safety <mint>           # Rug/scam check via Jupiter Shield
```

## Helius Commands (Solana, requires HELIUS_API_KEY)

```bash
moon meta sol <mint>         # Full DAS metadata
moon holders sol <mint> --limit 10    # Top holders + concentration
moon history sol <address> --limit 5  # Decoded transaction history
```

## Trading Commands (self-custody)

Trades execute directly — Jupiter swap on Solana, Uniswap V2 Router on Base. No third-party custody.

```bash
moon wallet [base|sol]       # Wallet address + balance + tokens (default: sol)
moon positions [base|sol]    # Current token holdings (default: sol)

# Solana (requires SOLANA_PRIVATE_KEY)
moon buy sol <token> <solAmt> [--slippage N] [--note TEXT] [--narrative TAG]
moon sell sol <token> <amt|all> [--slippage N] [--note TEXT]

# Base (requires BASE_PRIVATE_KEY)
moon buy base <token> <ethAmt> [--slippage N] [--note TEXT] [--narrative TAG]
moon sell base <token> <amt|all> [--slippage N] [--note TEXT]
```

- Amount for `buy` is in **SOL** (Solana) or **ETH** (Base), e.g. `0.1`
- Amount for `sell` is in **tokens** (or `all` to sell entire balance)
- Default slippage is 100 bps (1%). Use `--slippage 200` for volatile tokens.
- Buy and sell **auto-journal** trades. Sells automatically close the matching open position.
- Base sells auto-approve the Uniswap V2 Router if allowance is insufficient.

## Scanner (Solana, requires HELIUS_API_KEY)

```bash
moon scan sol --limit 10
```

Scores tokens 0.0-1.0: Liquidity (25%), Volume (20%), Holders (20%), Safety (20%), Age (15%).

## Trading Journal

```bash
moon journal                          # Show all entries
moon journal --last 5                 # Last 5 entries
moon journal --status open            # Only open positions
moon journal --narrative AI           # Filter by narrative
moon journal add buy sol <mint> 0.5 0.000006 --note "reason" --narrative "AI"
moon journal review                   # Full analysis: win rate, Kelly, P&L
moon journal review --narrative AI    # Analysis for specific narrative
```

## Watchlist

```bash
moon watch add <mint> --target-buy 0.000005 --target-sell 0.00001 --narrative meme
moon watch remove <mint>
moon watch list                       # Current prices + change %
moon watch check                      # Alerts: target hits, big moves, holder drops
```

## Position Calculator

```bash
moon calc target 0.000006 88000000000 1000000    # Tokens needed for $1M
moon calc mcap 50000000 88000000000 1000000      # Required mcap for bag = $1M
moon calc size 10000 2 0.000006 --stop-loss 0.000004  # Position size with Kelly
```

## Portfolio Review

```bash
moon review    # Full view: positions, P&L, goal progress, watchlist status, narratives
```

## Pre-Trade Checklist

Before EVERY buy, run this sequence:

1. **Safety**: `moon safety <mint>` — abort if critical risks
2. **Holders**: `moon holders sol <mint>` — abort if top 10 > 50%
3. **Calc size**: `moon calc size <portfolio> <risk%> <price>` — respect Kelly
4. **Calc target**: `moon calc mcap <held> <supply> 1000000` — is $1M realistic?
5. **Journal review**: `moon journal review` — check narrative performance
6. **Execute**: `moon buy sol <token> <amount> --narrative <tag>`

Never skip steps 1-2. Never exceed the position size from step 3.

## Position Sizing Rules

- **Never risk more than 5% of portfolio on a single trade**
- **Use half-Kelly** — `moon calc size` includes Kelly from your trade history
- **Mcap tiers**:
  - Under $50K mcap: max 2% risk (extremely volatile)
  - $50K - $500K mcap: max 3% risk
  - $500K - $5M mcap: max 4% risk
  - Above $5M mcap: max 5% risk
- **Jupiter has ~0.1-0.5% price impact** — check `priceImpactPct` in swap results

## $1M Goal Framework

Always think in terms of the goal:

1. Run `moon calc mcap` for every position — what mcap makes your bag worth $1M?
2. If required mcap > $100M, this token alone won't do it. Size appropriately.
3. If required mcap < $10M and the token is quality, this is a high-conviction play. Size up (within rules).
4. Run `moon review` to see total goal progress across all positions.
5. Track which narratives are driving you toward the goal.

## Narrative Tracking

Tag every trade with a narrative (AI, meme, defi, gaming, infra, etc.):

- `moon buy sol <token> 0.5 --narrative AI`
- `moon watch add <mint> --narrative meme`
- `moon journal review --narrative AI` — see per-narrative performance
- **Double down** on narratives with >60% win rate
- **Cut** narratives with <40% win rate after 5+ trades

## Learning Loop

After every 5 closed trades:

1. Run `moon journal review` — report win rate trends
2. Check narrative performance — which are working?
3. Note Kelly criterion changes — is your edge growing or shrinking?
4. If win rate < 50%, tighten stops and reduce position sizes
5. If win rate > 60%, you can increase to full Kelly (still capped at 25%)

## Proactive Monitoring

At the start of each conversation:

1. Check watchlist staleness: if `moon review` shows `stale: true`, run `moon watch check`
2. Report any alerts (target hits, big moves, holder drops)
3. If targets are hit, present the trade opportunity with pre-trade checklist
4. Review open positions for unrealized P&L changes

## Prediction Markets (Polymarket)

Polymarket runs on Polygon. All bets are in USDC. The CLOB (order book) handles order matching.

### Market Research

```bash
moon market search "bitcoin"             # Search active prediction markets
moon market <conditionId>                # Full market details + order book
moon odds <conditionId>                  # Quick YES/NO prices + spread
```

### Placing Bets

```bash
moon bet <conditionId> yes 50            # Market order: $50 USDC on YES
moon bet <conditionId> no 25 --limit 0.35  # Limit order: buy NO at $0.35
moon bet <id> yes 10 --narrative politics --note "midterm hedge"
```

- Amount is always in USDC
- Market orders fill instantly (FOK — Fill or Kill)
- Limit orders stay open until filled or cancelled (GTC)
- Auto-journals every bet with `type: "bet"`, compatible with all journal commands

### Position & Order Management

```bash
moon market positions                    # Active Polymarket positions + tracked bets
moon market orders                       # Open limit orders
moon market cancel <orderId>             # Cancel one order
moon market cancel all                   # Cancel all open orders
moon market trades --last 10             # Recent trade history
```

### Redemption & P&L

```bash
moon redeem list                         # All tracked bets with current market status
moon redeem <conditionId>                # Check resolution + update journal P&L
```

When a market resolves:
- Winning shares pay out $1.00 each automatically on-chain
- `moon redeem` updates the journal entry with exit price and P&L
- P&L = (shares * $1.00) - cost for wins, -cost for losses

### Polymarket Sizing Rules

- Prediction markets are binary outcomes — apply same risk framework
- Use half-Kelly: `moon calc size <portfolio> <risk%> <price>` still applies
- Price = probability. A YES at $0.65 means 65% implied probability.
- Max bet sizing: same tier rules as token trading (2-5% portfolio)
- Never bet more than 5% of portfolio on a single market

### First-Time Setup

1. Wallet needs a small MATIC balance on Polygon for the initial USDC approval transaction (one-time gas fee)
2. API credentials are derived from your wallet signature automatically and cached
3. If auth fails, credentials are re-derived on next attempt

## Environment Variables

| Variable | Required for | Description |
|----------|-------------|-------------|
| `SOLANA_PRIVATE_KEY` | Solana wallet, buy, sell, positions | Self-custody wallet (base58 or JSON array) |
| `BASE_PRIVATE_KEY` | Base wallet, buy, sell, positions | EVM private key (hex, 0x prefix optional) |
| `POLYMARKET_PRIVATE_KEY` | Polymarket market, bet, odds, redeem | Polygon wallet key (hex, 0x prefix) |
| `HELIUS_API_KEY` | meta, holders, history, scan | Enhanced Solana RPC + DAS API |
| `JUPITER_API_KEY` | -- (optional) | Improves Jupiter rate limits |
| `BASE_RPC_URL` | -- (optional) | Custom Base RPC endpoint |
| `SOLANA_RPC_URL` | -- (optional) | Custom Solana RPC (auto-upgraded by Helius) |
| `MOON_STATE_DIR` | -- (optional) | Custom state directory |

## Guidelines

1. **Run `safety` before trading.** Always check Jupiter Shield before buying unknown tokens.
2. **Check `holders` for concentration.** If top 10 holders own >50%, it's high risk.
3. **Use `scan` for discovery, not as buy signals.** Scores indicate research priority, not investment advice.
4. **Trades execute via Jupiter direct swap.** No custody fees. Only network fees + Jupiter routing.
5. **Public RPCs have rate limits.** Set `HELIUS_API_KEY` for reliable Solana access.
6. **Pump.fun tokens** that show `complete: true` have graduated to PumpSwap.
7. **SOL-denominated prices** are returned for Solana pools paired with SOL/WSOL. Jupiter USD price is added when available.
8. **Do not trade without user confirmation.** Always present trade details, sizing, and risk before executing buy/sell.
9. **Journal everything.** Auto-journaling handles buy/sell, but manually add off-platform trades with `journal add`.
10. **Trust the math.** Position sizing and Kelly criterion exist to protect the portfolio. Never override them on gut feeling.
