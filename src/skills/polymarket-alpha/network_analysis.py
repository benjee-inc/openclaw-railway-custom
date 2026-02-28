#!/usr/bin/env python3
"""
palpha network — Deep market network analysis using graph theory.

Builds a graph of Polymarket prediction markets connected by shared entities
(people, countries, companies, events, assets). Uses network metrics to find:
- Cross-market pricing inconsistencies (arbitrage signals)
- Conditional probability violations (if A implies B, P(A) must <= P(B))
- Market clusters driven by the same underlying factor
- Entity centrality (which events/people drive the most market value)
- Mispriced edges (related markets that should move together but diverge)
"""

import json
import re
import sys
import urllib.request
import urllib.error
from collections import defaultdict
from datetime import datetime, timezone

import networkx as nx
import community as community_louvain
import numpy as np


# ── Entity extraction ────────────────────────────────────────

# Named entities to extract from market questions
ENTITY_PATTERNS = {
    # People
    "trump": r"\bTrump\b",
    "biden": r"\bBiden\b",
    "elon_musk": r"\b(?:Elon\s+Musk|Elon|Musk)\b",
    "sam_altman": r"\bSam\s+Altman\b",
    "putin": r"\bPutin\b",
    "zelensky": r"\bZelensky\b",
    "xi_jinping": r"\bXi\s+Jinping\b",
    "starmer": r"\bStarmer\b",
    "macron": r"\bMacron\b",
    "netanyahu": r"\bNetanyahu\b",
    "desantis": r"\bDeSantis\b",

    # Countries / regions
    "usa": r"\b(?:U\.?S\.?A?|United\s+States|America)\b",
    "russia": r"\bRussia\b",
    "ukraine": r"\bUkraine\b",
    "china": r"\bChina\b",
    "taiwan": r"\bTaiwan\b",
    "israel": r"\bIsrael\b",
    "gaza": r"\bGaza\b",
    "iran": r"\bIran\b",
    "north_korea": r"\bNorth\s+Korea\b",
    "eu": r"\b(?:EU|European\s+Union)\b",
    "nato": r"\bNATO\b",

    # Companies / organizations
    "openai": r"\bOpenAI\b",
    "anthropic": r"\bAnthropic\b",
    "google": r"\bGoogle\b",
    "meta": r"\bMeta\b",
    "apple": r"\bApple\b",
    "microsoft": r"\bMicrosoft\b",
    "nvidia": r"\bNvidia\b",
    "tesla": r"\bTesla\b",
    "spacex": r"\bSpaceX\b",
    "microstrategy": r"\bMicroStrategy\b",

    # Assets
    "bitcoin": r"\b(?:Bitcoin|BTC)\b",
    "ethereum": r"\b(?:Ethereum|ETH)\b",
    "solana": r"\b(?:Solana|SOL)\b",

    # Events / concepts
    "ceasefire": r"\bceasefire\b",
    "war": r"\b(?:war|invasion|conflict)\b",
    "ipo": r"\bIPO\b",
    "election": r"\b(?:election|vote|ballot)\b",
    "recession": r"\brecession\b",
    "tariff": r"\btariff\b",
    "ai_model": r"\b(?:GPT|Claude|Gemini|LLM|AGI)\b",
    "gta_vi": r"\b(?:GTA\s*(?:VI|6)|Grand\s+Theft\s+Auto)\b",
    "nuclear": r"\bnuclear\b",
    "sanctions": r"\bsanctions?\b",
    "impeach": r"\b(?:impeach|impeachment)\b",
    "resign": r"\b(?:resign|resignation|step\s+down)\b",
    "deport": r"\b(?:deport|deportation)\b",

    # Thematic
    "crypto_market": r"\b(?:crypto|cryptocurrency|blockchain|DeFi)\b",
    "ai_tech": r"\b(?:AI|artificial\s+intelligence|machine\s+learning)\b",
    "climate": r"\b(?:climate|global\s+warming|carbon)\b",
}

# Logical implication pairs: if A is true, B must be true
# Format: (stronger_condition_pattern, weaker_condition_pattern)
IMPLICATION_PATTERNS = [
    # Price targets: above $X implies above $Y for Y < X
    (r"above\s+\$?([\d,]+)\s*([kmbt])?", "price_above"),
    (r"below\s+\$?([\d,]+)\s*([kmbt])?", "price_below"),
    (r"exceed\s+\$?([\d,]+)\s*([kmbt])?", "price_above"),
    (r"hit\s+\$?([\d,]+)\s*([kmbt])?", "price_above"),
    (r"reach\s+\$?([\d,]+)\s*([kmbt])?", "price_above"),
    # Date conditions: by DATE1 implies by DATE2 for DATE2 > DATE1
    (r"by\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s*\d{4})?)", "by_date"),
    (r"before\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s*\d{4})?)", "by_date"),
]


def extract_entities(question):
    """Extract named entities from a market question."""
    entities = set()
    for entity_id, pattern in ENTITY_PATTERNS.items():
        if re.search(pattern, question, re.IGNORECASE):
            entities.add(entity_id)
    return entities


def parse_price(match_str, suffix):
    """Parse price with k/m/b/t suffix."""
    val = float(match_str.replace(",", ""))
    suffix = (suffix or "").lower()
    multipliers = {"k": 1e3, "m": 1e6, "b": 1e9, "t": 1e12}
    return val * multipliers.get(suffix, 1)


def extract_price_target(question):
    """Extract price target and direction from question."""
    for pattern, ptype in IMPLICATION_PATTERNS:
        if ptype in ("price_above", "price_below"):
            m = re.search(pattern, question, re.IGNORECASE)
            if m:
                price = parse_price(m.group(1), m.group(2) if m.lastindex >= 2 else None)
                direction = "above" if ptype == "price_above" else "below"
                return {"price": price, "direction": direction}
    return None


def extract_date_condition(question):
    """Extract deadline date from question."""
    months = {
        "january": 1, "february": 2, "march": 3, "april": 4,
        "may": 5, "june": 6, "july": 7, "august": 8,
        "september": 9, "october": 10, "november": 11, "december": 12,
    }
    m = re.search(
        r"(?:by|before)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(\d{4}))?",
        question, re.IGNORECASE
    )
    if m:
        month = months[m.group(1).lower()]
        day = int(m.group(2))
        year = int(m.group(3)) if m.group(3) else 2026
        try:
            return datetime(year, month, day, tzinfo=timezone.utc)
        except ValueError:
            pass
    # Try ISO-like patterns
    m = re.search(r"(?:by|before)\s+(\d{4})-(\d{2})-(\d{2})", question)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


# ── Market data fetching ─────────────────────────────────────

def fetch_markets():
    """Fetch all active markets from Polymarket Gamma API."""
    markets = []
    offset = 0
    limit = 100

    # Sports filter patterns (skip sports markets)
    sports_patterns = [
        r"\bNBA\b", r"\bNFL\b", r"\bNHL\b", r"\bMLB\b", r"\bMLS\b", r"\bUFC\b",
        r"\bPGA\b", r"\bATP\b", r"\bWTA\b", r"\bF1\b", r"\bNASCAR\b",
        r"\bPremier League\b", r"\bLa Liga\b", r"\bSerie A\b", r"\bBundesliga\b",
        r"\bChampions League\b", r"\bWorld Cup\b", r"\bSuper Bowl\b",
        r"\bStanley Cup\b", r"\bWorld Series\b", r"\bvs\.?\s",
        r"\bplayoffs?\b", r"\bFinals\b", r"\bMVP\b", r"\bRookie of the Year\b",
        r"\bgolf\b", r"\btennis\b", r"\bcricket\b", r"\brugby\b",
        r"\bboxing\b", r"\bwrestling\b", r"\besports?\b",
        r"\bGame \d+ Winner\b", r"Up or Down.*\d+.*ET\b",
        r"\b(?:Carolina|Florida)\s+Hurricanes\b",
    ]
    sports_re = re.compile("|".join(sports_patterns), re.IGNORECASE)

    while True:
        url = f"https://gamma-api.polymarket.com/events?closed=false&limit={limit}&offset={offset}&active=true"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "palpha-network/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                events = json.loads(resp.read())
        except Exception as e:
            print(f"  [warn] Fetch error at offset {offset}: {e}", file=sys.stderr)
            break

        if not events:
            break

        for event in events:
            for mkt in event.get("markets", []):
                q = mkt.get("question", "")
                if sports_re.search(q):
                    continue

                yes_price = 0
                try:
                    prices = json.loads(mkt.get("outcomePrices", "[]"))
                    yes_price = float(prices[0]) if prices else 0
                except (json.JSONDecodeError, IndexError, ValueError):
                    pass

                vol24h = 0
                try:
                    vol24h = float(mkt.get("volume24hr", 0))
                except (TypeError, ValueError):
                    pass

                liquidity = 0
                try:
                    liquidity = float(mkt.get("liquidityClob", 0))
                except (TypeError, ValueError):
                    pass

                markets.append({
                    "id": mkt.get("conditionId", ""),
                    "question": q,
                    "yes_price": yes_price,
                    "no_price": 1.0 - yes_price,
                    "volume24h": vol24h,
                    "liquidity": liquidity,
                    "end_date": mkt.get("endDate"),
                    "event_id": event.get("id"),
                    "event_title": event.get("title", ""),
                    "change_1h": 0,
                    "change_1d": 0,
                })

        offset += limit
        if len(events) < limit:
            break

    # Parse 1h/1d changes from event-level data
    return markets


# ── Graph construction ───────────────────────────────────────

def build_market_graph(markets, min_volume=500):
    """
    Build a NetworkX graph where:
    - Nodes = markets (filtered by minimum volume)
    - Edges = shared entities between markets
    - Edge weight = number of shared entities * volume overlap factor
    """
    G = nx.Graph()

    # Filter markets
    active = [m for m in markets if m["volume24h"] >= min_volume and m["yes_price"] > 0.001]

    # Extract entities for each market
    for m in active:
        entities = extract_entities(m["question"])
        price_target = extract_price_target(m["question"])
        date_cond = extract_date_condition(m["question"])

        G.add_node(m["id"], **{
            "question": m["question"],
            "yes_price": m["yes_price"],
            "volume24h": m["volume24h"],
            "liquidity": m["liquidity"],
            "entities": entities,
            "price_target": price_target,
            "date_condition": date_cond,
            "end_date": m["end_date"],
            "event_id": m["event_id"],
            "event_title": m["event_title"],
        })

    # Build edges from shared entities
    nodes = list(G.nodes(data=True))
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            id_a, data_a = nodes[i]
            id_b, data_b = nodes[j]

            shared = data_a["entities"] & data_b["entities"]
            if not shared:
                continue

            # Weight by number of shared entities and log volume
            vol_factor = np.log1p(min(data_a["volume24h"], data_b["volume24h"])) / 10
            weight = len(shared) * (1 + vol_factor)

            # Boost weight for markets in the same event
            if data_a["event_id"] and data_a["event_id"] == data_b["event_id"]:
                weight *= 3.0

            G.add_edge(id_a, id_b, weight=weight, shared_entities=list(shared))

    return G


# ── Analysis functions ───────────────────────────────────────

def find_communities(G):
    """Detect market communities using Louvain algorithm."""
    if len(G.nodes) < 2:
        return {}

    # Only run on connected components
    partition = community_louvain.best_partition(G, weight="weight", resolution=1.2)
    return partition


def analyze_entity_centrality(G):
    """Find which entities drive the most market value."""
    entity_stats = defaultdict(lambda: {
        "markets": [],
        "total_volume": 0,
        "total_liquidity": 0,
        "avg_price": 0,
        "price_range": [1.0, 0.0],
    })

    for node_id, data in G.nodes(data=True):
        for entity in data.get("entities", set()):
            stats = entity_stats[entity]
            stats["markets"].append({
                "id": node_id,
                "question": data["question"][:80],
                "yes_price": data["yes_price"],
                "volume24h": data["volume24h"],
            })
            stats["total_volume"] += data["volume24h"]
            stats["total_liquidity"] += data["liquidity"]
            stats["price_range"][0] = min(stats["price_range"][0], data["yes_price"])
            stats["price_range"][1] = max(stats["price_range"][1], data["yes_price"])

    # Calculate avg price and sort by total volume
    for entity, stats in entity_stats.items():
        if stats["markets"]:
            stats["avg_price"] = sum(m["yes_price"] for m in stats["markets"]) / len(stats["markets"])
            stats["market_count"] = len(stats["markets"])

    # Sort by total volume
    ranked = sorted(entity_stats.items(), key=lambda x: x[1]["total_volume"], reverse=True)
    return ranked


def find_conditional_violations(G):
    """
    Find conditional probability violations:
    - If market A implies market B (e.g., "BTC above $200K" implies "BTC above $100K"),
      then P(A) must be <= P(B). Violations = arbitrage.
    - If markets in the same event are mutually exclusive,
      their prices must sum to <= 1.0.
    """
    violations = []

    nodes = list(G.nodes(data=True))

    # 1. Price target ordering violations
    # Group markets by (asset, direction)
    price_groups = defaultdict(list)
    for node_id, data in nodes:
        pt = data.get("price_target")
        if not pt:
            continue
        # Find which asset this is about
        entities = data.get("entities", set())
        for asset in ["bitcoin", "ethereum", "solana"]:
            if asset in entities:
                key = (asset, pt["direction"])
                price_groups[key].append({
                    "id": node_id,
                    "question": data["question"],
                    "target_price": pt["price"],
                    "yes_price": data["yes_price"],
                    "end_date": data.get("end_date"),
                })

    for (asset, direction), group in price_groups.items():
        # Sort by target price
        group.sort(key=lambda x: x["target_price"])

        if direction == "above":
            # P(above $200K) <= P(above $100K) — higher target = lower probability
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    lower_target = group[i]  # easier condition (lower price)
                    higher_target = group[j]  # harder condition (higher price)

                    # Higher target should have lower or equal probability
                    if higher_target["yes_price"] > lower_target["yes_price"] + 0.02:
                        violations.append({
                            "type": "price_ordering",
                            "severity": higher_target["yes_price"] - lower_target["yes_price"],
                            "asset": asset,
                            "direction": direction,
                            "overpriced": {
                                "id": higher_target["id"],
                                "question": higher_target["question"][:80],
                                "target": higher_target["target_price"],
                                "price": higher_target["yes_price"],
                            },
                            "underpriced": {
                                "id": lower_target["id"],
                                "question": lower_target["question"][:80],
                                "target": lower_target["target_price"],
                                "price": lower_target["yes_price"],
                            },
                            "detail": (
                                f"{asset} above ${higher_target['target_price']:,.0f} at "
                                f"{higher_target['yes_price']:.1%} but above "
                                f"${lower_target['target_price']:,.0f} at only "
                                f"{lower_target['yes_price']:.1%}. "
                                f"The harder condition is priced HIGHER — arbitrage."
                            ),
                        })

        elif direction == "below":
            # P(below $50K) <= P(below $100K) — lower target = harder condition
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    lower = group[i]  # harder (lower target)
                    higher = group[j]  # easier (higher target)
                    if lower["yes_price"] > higher["yes_price"] + 0.02:
                        violations.append({
                            "type": "price_ordering",
                            "severity": lower["yes_price"] - higher["yes_price"],
                            "asset": asset,
                            "direction": direction,
                            "overpriced": lower,
                            "underpriced": higher,
                            "detail": (
                                f"{asset} below ${lower['target_price']:,.0f} at "
                                f"{lower['yes_price']:.1%} but below "
                                f"${higher['target_price']:,.0f} at only "
                                f"{higher['yes_price']:.1%}."
                            ),
                        })

    # 2. Date ordering violations (same event, different deadlines)
    date_groups = defaultdict(list)
    for node_id, data in nodes:
        dc = data.get("date_condition")
        if not dc:
            continue
        # Group by shared entities (rough event identity)
        entities_key = tuple(sorted(data.get("entities", set())))
        if entities_key:
            # Use question stem (remove date part) as grouping key
            stem = re.sub(r"(?:by|before)\s+\w+\s+\d{1,2}(?:,?\s*\d{4})?", "BY_DATE", data["question"])
            stem = re.sub(r"(?:by|before)\s+\d{4}-\d{2}-\d{2}", "BY_DATE", stem)
            date_groups[(entities_key, stem)].append({
                "id": node_id,
                "question": data["question"],
                "date": dc,
                "yes_price": data["yes_price"],
            })

    for key, group in date_groups.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda x: x["date"])

        # Later deadline should have >= probability (more time = more likely)
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                earlier = group[i]
                later = group[j]
                if earlier["yes_price"] > later["yes_price"] + 0.02:
                    violations.append({
                        "type": "date_ordering",
                        "severity": earlier["yes_price"] - later["yes_price"],
                        "earlier": {
                            "id": earlier["id"],
                            "question": earlier["question"][:80],
                            "date": earlier["date"].isoformat(),
                            "price": earlier["yes_price"],
                        },
                        "later": {
                            "id": later["id"],
                            "question": later["question"][:80],
                            "date": later["date"].isoformat(),
                            "price": later["yes_price"],
                        },
                        "detail": (
                            f"Earlier deadline ({earlier['date'].strftime('%b %d')}) at "
                            f"{earlier['yes_price']:.1%} > later deadline "
                            f"({later['date'].strftime('%b %d')}) at {later['yes_price']:.1%}. "
                            f"More time should mean higher probability."
                        ),
                    })

    # 3. Same-event mutual exclusivity check
    event_groups = defaultdict(list)
    for node_id, data in nodes:
        eid = data.get("event_id")
        if eid:
            event_groups[eid].append({
                "id": node_id,
                "question": data["question"][:80],
                "yes_price": data["yes_price"],
                "event_title": data.get("event_title", ""),
            })

    for eid, group in event_groups.items():
        if len(group) < 2:
            continue
        total_prob = sum(m["yes_price"] for m in group)
        # If it looks like mutually exclusive outcomes (many low-prob markets summing > 1)
        if total_prob > 1.05 and len(group) >= 3:
            non_binary = [m for m in group if 0.01 < m["yes_price"] < 0.95]
            if len(non_binary) >= 3:
                violations.append({
                    "type": "mutual_exclusivity",
                    "severity": total_prob - 1.0,
                    "event_id": eid,
                    "event_title": group[0]["event_title"],
                    "market_count": len(group),
                    "total_probability": round(total_prob, 3),
                    "markets": sorted(group, key=lambda x: -x["yes_price"])[:5],
                    "detail": (
                        f"Event '{group[0]['event_title'][:60]}' has {len(group)} outcomes "
                        f"summing to {total_prob:.1%} (should be ~100%). "
                        f"Overpriced by {(total_prob - 1) * 100:.1f}pp."
                    ),
                })

    violations.sort(key=lambda x: x["severity"], reverse=True)
    return violations


def find_cluster_insights(G, partition):
    """
    Analyze each community cluster for internal consistency and insights.
    """
    if not partition:
        return []

    clusters = defaultdict(list)
    for node_id, comm_id in partition.items():
        data = G.nodes[node_id]
        clusters[comm_id].append({"id": node_id, **data})

    insights = []
    for comm_id, members in clusters.items():
        if len(members) < 2:
            continue

        # Get shared entities across cluster
        all_entities = defaultdict(int)
        for m in members:
            for e in m.get("entities", set()):
                all_entities[e] += 1

        # Core entities (appear in >50% of cluster)
        threshold = len(members) * 0.5
        core_entities = [e for e, count in all_entities.items() if count >= threshold]

        prices = [m["yes_price"] for m in members]
        volumes = [m["volume24h"] for m in members]

        # Price dispersion within cluster
        price_std = np.std(prices) if len(prices) > 1 else 0
        price_range = max(prices) - min(prices)

        # Find the highest and lowest priced markets in cluster
        sorted_by_price = sorted(members, key=lambda x: x["yes_price"])
        cheapest = sorted_by_price[0]
        priciest = sorted_by_price[-1]

        total_vol = sum(volumes)

        insight = {
            "cluster_id": comm_id,
            "size": len(members),
            "core_entities": core_entities,
            "total_volume_24h": round(total_vol, 2),
            "price_range": round(price_range, 4),
            "price_std": round(price_std, 4),
            "avg_price": round(np.mean(prices), 4),
            "cheapest": {
                "question": cheapest["question"][:80],
                "price": cheapest["yes_price"],
                "id": cheapest["id"],
            },
            "priciest": {
                "question": priciest["question"][:80],
                "price": priciest["yes_price"],
                "id": priciest["id"],
            },
            "all_markets": [
                {"question": m["question"][:80], "price": m["yes_price"], "vol": round(m["volume24h"], 0)}
                for m in sorted(members, key=lambda x: -x["volume24h"])[:10]
            ],
        }

        # Flag high-dispersion clusters (potentially mispriced)
        if price_range > 0.3 and len(members) >= 3:
            insight["flag"] = "HIGH_DISPERSION"
            insight["signal"] = (
                f"Cluster driven by {', '.join(core_entities[:3])} has {len(members)} markets "
                f"with price range {price_range:.0%}. Cheapest: \"{cheapest['question'][:50]}\" "
                f"at {cheapest['yes_price']:.1%}, priciest at {priciest['yes_price']:.1%}."
            )

        insights.append(insight)

    insights.sort(key=lambda x: x["total_volume_24h"], reverse=True)
    return insights


def find_edge_mispricing(G):
    """
    Find pairs of connected markets where prices diverge unexpectedly.
    If two markets share many entities and are in the same event,
    large price differences may indicate mispricing.
    """
    mispricings = []

    for u, v, edge_data in G.edges(data=True):
        u_data = G.nodes[u]
        v_data = G.nodes[v]
        shared = edge_data.get("shared_entities", [])

        if len(shared) < 2:
            continue

        price_diff = abs(u_data["yes_price"] - v_data["yes_price"])
        if price_diff < 0.15:
            continue

        # High entity overlap + large price difference = potential signal
        overlap_ratio = len(shared) / max(
            len(u_data.get("entities", set())),
            len(v_data.get("entities", set())),
            1
        )

        if overlap_ratio < 0.5:
            continue

        combined_vol = u_data["volume24h"] + v_data["volume24h"]

        mispricings.append({
            "market_a": {
                "id": u,
                "question": u_data["question"][:80],
                "price": u_data["yes_price"],
                "volume24h": u_data["volume24h"],
            },
            "market_b": {
                "id": v,
                "question": v_data["question"][:80],
                "price": v_data["yes_price"],
                "volume24h": v_data["volume24h"],
            },
            "shared_entities": shared,
            "price_difference": round(price_diff, 4),
            "entity_overlap": round(overlap_ratio, 2),
            "combined_volume": round(combined_vol, 2),
            "signal": (
                f"Markets share {len(shared)} entities ({', '.join(shared[:4])}) "
                f"but prices differ by {price_diff:.0%}. "
                f"A: \"{u_data['question'][:50]}\" at {u_data['yes_price']:.1%}, "
                f"B: \"{v_data['question'][:50]}\" at {v_data['yes_price']:.1%}."
            ),
        })

    mispricings.sort(key=lambda x: x["price_difference"] * x["entity_overlap"], reverse=True)
    return mispricings[:20]


def compute_network_stats(G, partition):
    """Compute high-level network statistics."""
    if len(G.nodes) == 0:
        return {}

    # Degree centrality
    degree_cent = nx.degree_centrality(G)
    top_degree = sorted(degree_cent.items(), key=lambda x: x[1], reverse=True)[:10]

    # Betweenness centrality (which markets bridge different clusters)
    betweenness = nx.betweenness_centrality(G, weight="weight")
    top_betweenness = sorted(betweenness.items(), key=lambda x: x[1], reverse=True)[:10]

    # Connected components
    components = list(nx.connected_components(G))

    # Community count
    n_communities = len(set(partition.values())) if partition else 0

    return {
        "nodes": len(G.nodes),
        "edges": len(G.edges),
        "density": round(nx.density(G), 4),
        "connected_components": len(components),
        "largest_component_size": max(len(c) for c in components) if components else 0,
        "communities": n_communities,
        "avg_clustering": round(nx.average_clustering(G, weight="weight"), 4),
        "most_connected_markets": [
            {"id": nid, "question": G.nodes[nid]["question"][:80], "degree_centrality": round(score, 4)}
            for nid, score in top_degree
        ],
        "bridge_markets": [
            {"id": nid, "question": G.nodes[nid]["question"][:80], "betweenness": round(score, 4)}
            for nid, score in top_betweenness if score > 0
        ][:5],
    }


# ── Main analysis pipeline ───────────────────────────────────

def run_analysis(min_volume=500):
    """Run full network analysis pipeline."""
    print("Fetching markets...", file=sys.stderr)
    markets = fetch_markets()
    print(f"  {len(markets)} non-sports markets fetched", file=sys.stderr)

    print("Building market graph...", file=sys.stderr)
    G = build_market_graph(markets, min_volume=min_volume)
    print(f"  {len(G.nodes)} nodes, {len(G.edges)} edges", file=sys.stderr)

    print("Detecting communities...", file=sys.stderr)
    partition = find_communities(G) if len(G.nodes) > 1 else {}

    print("Analyzing entity centrality...", file=sys.stderr)
    entity_ranking = analyze_entity_centrality(G)

    print("Finding conditional probability violations...", file=sys.stderr)
    violations = find_conditional_violations(G)

    print("Analyzing cluster insights...", file=sys.stderr)
    cluster_insights = find_cluster_insights(G, partition)

    print("Finding edge mispricings...", file=sys.stderr)
    mispricings = find_edge_mispricing(G)

    print("Computing network statistics...", file=sys.stderr)
    net_stats = compute_network_stats(G, partition)

    # Build output
    result = {
        "analysis_time": datetime.now(timezone.utc).isoformat(),
        "markets_analyzed": len(G.nodes),
        "total_markets_fetched": len(markets),
        "network": net_stats,
        "entity_centrality": [
            {
                "entity": entity,
                "market_count": stats["market_count"],
                "total_volume_24h": round(stats["total_volume"], 0),
                "total_liquidity": round(stats["total_liquidity"], 0),
                "avg_price": round(stats["avg_price"], 4),
                "price_range": [round(stats["price_range"][0], 4), round(stats["price_range"][1], 4)],
                "top_markets": [
                    {"question": m["question"][:60], "price": m["yes_price"], "vol": round(m["volume24h"], 0)}
                    for m in sorted(stats["markets"], key=lambda x: -x["volume24h"])[:3]
                ],
            }
            for entity, stats in entity_ranking[:20]
        ],
        "violations": violations[:15],
        "cluster_insights": cluster_insights[:15],
        "edge_mispricings": mispricings[:10],
    }

    return result


# ── CLI ─────────────────────────────────────────────────────

if __name__ == "__main__":
    min_vol = 500
    if "--min-vol" in sys.argv:
        idx = sys.argv.index("--min-vol")
        if idx + 1 < len(sys.argv):
            min_vol = int(sys.argv[idx + 1])

    result = run_analysis(min_volume=min_vol)
    print(json.dumps(result, indent=2, default=str))
