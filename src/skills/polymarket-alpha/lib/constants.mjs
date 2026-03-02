// polymarket-alpha constants — API URLs, category keywords, NWS grids

// ── API endpoints ──────────────────────────────────────────
// No API needed — pure computation (montecarlo source)

export const GAMMA_API = "https://gamma-api.polymarket.com";
export const DATA_API = "https://data-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";
export const GDELT_API = "https://api.gdeltproject.org/api/v2/doc/doc";
export const NWS_API = "https://api.weather.gov";
export const COINGECKO_API = "https://api.coingecko.com/api/v3";
export const FEAR_GREED_API = "https://api.alternative.me/fng";
export const FRED_API = "https://api.stlouisfed.org/fred";
export const OPENSKY_API = "https://opensky-network.org/api";
export const ARXIV_API = "https://export.arxiv.org/api/query";
export const OPENMETEO_API = "https://api.open-meteo.com/v1/forecast";
export const COINGLASS_API = "https://open-api.coinglass.com";
export const METACULUS_API = "https://www.metaculus.com/api2";
export const XAI_API = "https://api.x.ai/v1";

// ── Cache TTLs (ms) ────────────────────────────────────────

export const TTL = {
  gdelt: 5 * 60_000,
  nws: 60 * 60_000,
  coingecko: 2 * 60_000,
  fearGreed: 5 * 60_000,
  fred: 6 * 3600_000,
  opensky: 30_000,
  arxiv: 60 * 60_000,
  gamma: 2 * 60_000,
  ensemble: 30 * 60_000,
  coinglass: 2 * 60_000,
  metaculus: 30 * 60_000,
  trends: 15 * 60_000,
  montecarlo: 5 * 60_000,
  grok: 30 * 60_000,
};

// ── Sports filter (reused from comprehensive-scanner) ──────

export const SPORTS_PATTERNS = [
  // Major leagues & tournaments
  /\bNBA\b/i, /\bNFL\b/i, /\bNHL\b/i, /\bMLB\b/i, /\bMLS\b/i, /\bUFC\b/i,
  /\bPGA\b/i, /\bATP\b/i, /\bWTA\b/i, /\bF1\b/i, /\bNASCAR\b/i,
  /\bPremier League\b/i, /\bLa Liga\b/i, /\bSerie A\b/i, /\bBundesliga\b/i,
  /\bLigue 1\b/i, /\bChampions League\b/i, /\bEuropa League\b/i,
  /\bWorld Cup\b/i, /\bEuros?\b/i, /\bSuper Bowl\b/i,
  /\bStanley Cup\b/i, /\bWorld Series\b/i, /\bMasters tournament\b/i,
  /\bwin the \d{4}(?:–\d{2,4})? (?:NBA|NFL|NHL|MLB|MLS)/i,
  /\bfinish in (?:1st|2nd|3rd|last|\d+th) place\b/i,
  /\bwin on \d{4}-\d{2}-\d{2}\b/i,
  /\bRookie of the Year\b/i, /\bMVP\b/i,
  /\bplayoffs?\b/i, /\bFinals\b/i,
  /\bvs\.?\s/i,
  /\bGame \d+ Winner\b/i,
  /\bgolf\b/i, /\btennis\b/i, /\bcricket\b/i, /\brugby\b/i,
  /\bboxing\b/i, /\bwrestling\b/i, /\besports?\b/i, /\bDota\b/i,
  /\bCounter-?Strike\b/i, /\bValorant\b/i, /\bLeague of Legends\b/i,
  /\b(?:FC|CF|SC|AC|AS|SV|BV|SK)\b/,
  /\bUnited\b.*\b(?:win|finish|place)\b/i,
  /Up or Down.*\d+.*ET\b/i,
  // NHL/NBA/NFL team names that collide with real words
  /\b(?:Carolina|Florida)\s+Hurricanes\b/i,
  /\b(?:Oklahoma City|Golden State)\s+Thunder\b/i,
  /\bMiami\s+Heat\b/i, /\bPhoenix\s+Suns\b/i,
  /\bToronto\s+(?:Raptors|Maple Leafs|Blue Jays)\b/i,
  /\bColorado\s+(?:Avalanche|Rockies)\b/i,
  // Division/conference patterns
  /\b(?:Metropolitan|Atlantic|Central|Pacific)\s+Division\b/i,
  /\b(?:Eastern|Western|American|National)\s+(?:Conference|League)\b/i,
  /\b(?:AFC|NFC)\s+(?:East|West|North|South|Championship)\b/i,
  // Generic sports outcome patterns
  /\bwin\s+the\s+(?:division|conference|championship|title|cup|trophy|medal|ring)\b/i,
  /\bmake\s+the\s+(?:playoffs|postseason|final|finals|semis|quarterfinals)\b/i,
  // Additional international leagues
  /\bSüper Lig\b/i, /\bSuper Lig\b/i, /\bEredivisie\b/i, /\bLiga MX\b/i,
  /\bJ[\s-]?League\b/i, /\bK[\s-]?League\b/i, /\bA[\s-]?League\b/i,
  /\bPrimeira Liga\b/i, /\bScottish Premiership\b/i, /\bAllsvenskan\b/i,
  /\bEliteserien\b/i, /\bSuperliga\b/i, /\bEkstraklasa\b/i,
  /\bRSL\b/i, /\bMLS Cup\b/i, /\bCopa Libertadores\b/i,
  /\bCopa America\b/i, /\bAfcon\b/i, /\bCAF\b/i,
  // Generic "Will [team] win the [league]?" pattern
  /\bwin\s+the\s+\S+\s+(?:Lig|Liga|League|Serie|Division|Cup|Championship)\b/i,
  /\bfinish\s+in\s+the\s+top\s+\d+\b/i,
  // EPL team names
  /\b(?:EPL|English Premier League)\b/i,
  /\b\d{4}[–-]\d{2,4}\s+(?:season|campaign)\b/i,
];

// ── Category keyword dictionaries ──────────────────────────

export const CATEGORIES = {
  weather: {
    primary: [ // +3 each
      "tornado", "typhoon", "cyclone", "flood", "drought",
      "blizzard", "heatwave", "heat wave", "wildfire", "earthquake",
      "temperature", "rainfall", "snowfall", "weather",
    ],
    secondary: [ // +1 each
      "degrees", "fahrenheit", "celsius", "storm", "wind", "rain",
      "snow", "ice", "cold", "hot", "warm", "forecast", "climate",
      "NOAA", "NWS", "meteorological",
    ],
    patterns: [ // +5 each
      /temperature.*(?:exceed|above|below|reach)\s+\d+/i,
      /(?:high|low)\s+(?:of\s+)?\d+\s*°?[FC]/i,
      /(?:category|cat)\s*[1-5]\s*hurricane/i,
      /\binches?\s+(?:of\s+)?(?:rain|snow)/i,
      /record\s+(?:high|low|heat|cold)/i,
      // Require "hurricane" with weather context, not team names
      /hurricane\s+(?:season|warning|watch|landfall|path|damage)/i,
      /(?:category|major|tropical)\s+(?:hurricane|storm)/i,
    ],
  },
  crypto: {
    primary: [
      "bitcoin", "ethereum", "BTC", "ETH", "solana", "SOL",
      "cryptocurrency", "crypto", "blockchain", "defi",
      "dogecoin", "DOGE", "XRP", "cardano", "ADA",
    ],
    secondary: [
      "halving", "mining", "staking", "wallet", "exchange",
      "altcoin", "token", "NFT", "web3", "decentralized",
      "bull run", "market cap", "ATH", "all-time high",
      "MicroStrategy", "Coinbase", "Binance", "Kraken",
    ],
    patterns: [
      /\b(?:BTC|ETH|SOL|XRP|ADA|DOGE|BNB|AVAX|DOT|MATIC)\b.*(?:price|reach|hit|above|below)\b/i,
      /\$\d[\d,]*\s*(?:bitcoin|BTC|ethereum|ETH)/i,
      /(?:bitcoin|ethereum|crypto).*(?:\$\d|\d+k|\d+K)/i,
      /(?:bitcoin|BTC|ETH|ethereum).*(?:hit|reach|exceed|above|below)\s+\$?\d/i,
    ],
  },
  economics: {
    primary: [
      "GDP", "inflation", "CPI", "unemployment", "recession",
      "federal reserve", "interest rate", "Fed", "treasury",
      "tariff", "trade deficit", "jobs report",
      "revenue", "budget", "spending", "debt",
    ],
    secondary: [
      "economy", "economic", "fiscal", "monetary", "deficit",
      "surplus", "growth", "contraction", "housing", "mortgage",
      "S&P", "Dow", "NASDAQ", "stock market", "bond",
      "yield", "debt ceiling", "stimulus", "DOGE cuts",
      "government spending", "government revenue", "tax",
      "import", "export", "trade war", "subsidy", "bailout",
      "IPO", "bankruptcy", "default",
    ],
    patterns: [
      /(?:GDP|CPI|PPI|PCE)\s*(?:exceed|above|below|growth|decline)/i,
      /(?:interest|fed\s*funds?)\s*rate.*(?:cut|hike|raise|lower)/i,
      /unemployment.*(?:below|above|reach)\s*\d/i,
      /recession\s*(?:in|by|before|during)\s*\d{4}/i,
      /U\.?S\.?\s+(?:collect|revenue|budget|spend|deficit|debt)/i,
      /\$\d+[btm]\s+(?:in\s+)?(?:revenue|spending|budget|debt|deficit|surplus)/i,
      /tariff.*(?:\d+%|increase|decrease|impose|remove)/i,
    ],
  },
  geopolitics: {
    primary: [
      "war", "invasion", "military", "NATO", "sanctions",
      "ceasefire", "peace deal", "nuclear", "missile",
      "troops", "conflict", "coup", "regime",
      "Ukraine", "Russia", "China", "Taiwan", "Iran",
      "Israel", "Gaza", "North Korea",
    ],
    secondary: [
      "diplomacy", "ambassador", "summit", "treaty", "alliance",
      "border", "territory", "occupation", "humanitarian",
      "refugee", "embargo", "espionage", "intelligence",
      "drone", "airspace", "navy", "army",
      "Zelensky", "Putin", "Xi Jinping", "Khamenei",
      "annexation", "blockade", "escalation",
      "leave NATO", "join NATO", "withdraw",
    ],
    patterns: [
      /(?:Russia|China|Iran|North Korea|Ukraine|Taiwan|Israel|Gaza|Palestine|Syria|Yemen).*(?:attack|invade|strike|war|conflict|ceasefire|peace|negotiat)/i,
      /military.*(?:deploy|withdraw|mobilize|escalat)/i,
      /nuclear.*(?:test|weapon|deal|program)/i,
      /(?:any\s+)?country\s+(?:leave|join|exit)\s+(?:NATO|EU|UN)/i,
      /(?:Russia|Ukraine|Israel|Gaza).*(?:by|before|in)\s+\w+\s+\d/i,
    ],
  },
  politics: {
    primary: [
      "election", "president", "congress", "senate", "vote",
      "impeach", "legislation", "bill", "law", "governor",
      "democrat", "republican", "nominee", "primary",
      "Trump", "Biden",
    ],
    secondary: [
      "poll", "approval", "campaign", "party", "candidate",
      "swing state", "electoral", "ballot", "midterm",
      "cabinet", "supreme court", "executive order",
      "veto", "filibuster", "caucus", "pardon",
      "resign", "indicted", "convicted", "guilty",
      "Speaker", "Attorney General", "Secretary",
      "deport", "deportation", "immigration",
      "Prime Minister", "chancellor", "parliament",
      "nominate", "nomination", "confirm", "confirmation",
    ],
    patterns: [
      /(?:win|lose|lead)\s+(?:the\s+)?(?:\d{4}\s+)?(?:election|primary|caucus|race)/i,
      /(?:approval|favorability)\s*(?:rating|poll).*(?:above|below|exceed)\s*\d/i,
      /(?:democrat|republican|independent).*(?:win|control|majority)/i,
      /(?:Trump|Biden|DeSantis|Newsom|Haley)\s+(?:win|lose|nominate|resign|indicted|pardon)/i,
      /(?:next|new)\s+(?:President|Prime Minister|Chancellor|Governor|Senator|Mayor)\b/i,
      /\b\w+\s+out\s+by\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|\d{4})/i,
      /\b(?:resign|impeach|remove|oust|step down)\b.*(?:by|before|in)\s+\d/i,
      /\b(?:win|lose)\s+the\s+\d{4}\b/i,
    ],
  },
  tech: {
    primary: [
      "AI", "artificial intelligence", "GPT", "LLM", "AGI",
      "machine learning", "neural network", "OpenAI", "Google",
      "Apple", "Microsoft", "Tesla", "SpaceX",
      "Anthropic", "Meta", "Amazon", "Nvidia",
    ],
    secondary: [
      "launch", "release", "patent", "chip", "semiconductor",
      "quantum", "robot", "autonomous", "self-driving",
      "startup", "IPO", "acquisition", "merger",
      "algorithm", "model", "benchmark", "parameter",
      "Elon Musk", "Sam Altman", "Zuckerberg",
      "GTA", "video game", "app", "software",
    ],
    patterns: [
      /(?:GPT|Claude|Gemini|Llama)\s*[-\s]?\d/i,
      /(?:launch|release|announce).*(?:AI|chip|model|product)/i,
      /(?:Apple|Google|Meta|Microsoft|Amazon|Tesla|SpaceX|Nvidia|OpenAI|Anthropic).*(?:launch|release|announce|acquire|IPO)/i,
      /(?:GTA|Grand Theft Auto)\s*(?:VI|6|V|5)/i,
    ],
  },
  entertainment: {
    primary: [
      "Oscar", "Grammy", "Emmy", "Golden Globe", "box office",
      "movie", "film", "album", "streaming", "Netflix",
      "Billboard", "chart", "award", "celebrity",
      "Drake", "Taylor Swift", "Beyonce", "Kanye",
      "Kendrick Lamar", "Travis Scott",
    ],
    secondary: [
      "premiere", "sequel", "franchise", "ratings", "viewer",
      "concert", "tour", "ticket", "reality TV",
      "Hollywood", "Spotify", "Disney", "HBO",
      "YouTube", "TikTok", "influencer", "podcast",
      "rapper", "singer", "artist", "musician", "band",
      "music", "song", "single", "EP", "mixtape", "track",
      "studio album", "release date",
    ],
    patterns: [
      /(?:win|nominated|receive).*(?:Oscar|Grammy|Emmy|Golden Globe)/i,
      /box\s*office.*(?:\$\d|million|billion|exceed|reach)/i,
      /#1\s+(?:on|at)\s+(?:Billboard|box\s*office|charts?)/i,
      /(?:album|single|song|EP|mixtape)\s+(?:release|drop|chart|sell|before)/i,
      /(?:Drake|Taylor Swift|Beyonce|Kanye|Kendrick|Travis Scott)\s+(?:release|drop|announce|perform|tour)/i,
      /release\s+(?:\w+\s+)?(?:album|EP|single|mixtape|track|song)\b/i,
    ],
  },
};

// ── NWS grid lookups for US cities ─────────────────────────
// Format: { office, gridX, gridY, lat, lon }

export const NWS_GRIDS = {
  "new york":    { office: "OKX", gridX: 33, gridY: 37, lat: 40.71, lon: -74.01 },
  "nyc":         { office: "OKX", gridX: 33, gridY: 37, lat: 40.71, lon: -74.01 },
  "los angeles": { office: "LOX", gridX: 154, gridY: 44, lat: 34.05, lon: -118.24 },
  "la":          { office: "LOX", gridX: 154, gridY: 44, lat: 34.05, lon: -118.24 },
  "chicago":     { office: "LOT", gridX: 65, gridY: 76, lat: 41.88, lon: -87.63 },
  "houston":     { office: "HGX", gridX: 65, gridY: 97, lat: 29.76, lon: -95.37 },
  "phoenix":     { office: "PSR", gridX: 159, gridY: 57, lat: 33.45, lon: -112.07 },
  "philadelphia": { office: "PHI", gridX: 49, gridY: 75, lat: 39.95, lon: -75.17 },
  "san antonio": { office: "EWX", gridX: 51, gridY: 76, lat: 29.42, lon: -98.49 },
  "san diego":   { office: "SGX", gridX: 56, gridY: 18, lat: 32.72, lon: -117.16 },
  "dallas":      { office: "FWD", gridX: 80, gridY: 108, lat: 32.78, lon: -96.80 },
  "austin":      { office: "EWX", gridX: 56, gridY: 98, lat: 30.27, lon: -97.74 },
  "miami":       { office: "MFL", gridX: 75, gridY: 68, lat: 25.76, lon: -80.19 },
  "atlanta":     { office: "FFC", gridX: 50, gridY: 86, lat: 33.75, lon: -84.39 },
  "boston":       { office: "BOX", gridX: 71, gridY: 90, lat: 42.36, lon: -71.06 },
  "seattle":     { office: "SEW", gridX: 124, gridY: 67, lat: 47.61, lon: -122.33 },
  "denver":      { office: "BOU", gridX: 62, gridY: 60, lat: 39.74, lon: -104.99 },
  "washington":  { office: "LWX", gridX: 97, gridY: 71, lat: 38.91, lon: -77.04 },
  "dc":          { office: "LWX", gridX: 97, gridY: 71, lat: 38.91, lon: -77.04 },
  "nashville":   { office: "OHX", gridX: 54, gridY: 33, lat: 36.16, lon: -86.78 },
  "detroit":     { office: "DTX", gridX: 65, gridY: 33, lat: 42.33, lon: -83.05 },
  "portland":    { office: "PQR", gridX: 95, gridY: 87, lat: 45.52, lon: -122.68 },
  "las vegas":   { office: "VEF", gridX: 122, gridY: 97, lat: 36.17, lon: -115.14 },
  "memphis":     { office: "MEG", gridX: 54, gridY: 67, lat: 35.15, lon: -90.05 },
  "minneapolis": { office: "MPX", gridX: 107, gridY: 71, lat: 44.98, lon: -93.27 },
  "san francisco": { office: "MTR", gridX: 85, gridY: 105, lat: 37.77, lon: -122.42 },
  "sf":          { office: "MTR", gridX: 85, gridY: 105, lat: 37.77, lon: -122.42 },
  "tampa":       { office: "TBW", gridX: 68, gridY: 49, lat: 27.95, lon: -82.46 },
  "orlando":     { office: "MLB", gridX: 25, gridY: 69, lat: 28.54, lon: -81.38 },
  "st louis":    { office: "LSX", gridX: 84, gridY: 74, lat: 38.63, lon: -90.20 },
};

// ── Crypto coin ID mappings (CoinGecko IDs) ───────────────

export const COIN_IDS = {
  bitcoin: "bitcoin", btc: "bitcoin",
  ethereum: "ethereum", eth: "ethereum",
  solana: "solana", sol: "solana",
  dogecoin: "dogecoin", doge: "dogecoin",
  cardano: "cardano", ada: "cardano",
  xrp: "ripple",
  polkadot: "polkadot", dot: "polkadot",
  avalanche: "avalanche-2", avax: "avalanche-2",
  polygon: "matic-network", matic: "matic-network",
  chainlink: "chainlink", link: "chainlink",
  litecoin: "litecoin", ltc: "litecoin",
  bnb: "binancecoin",
};

// ── FRED series IDs ────────────────────────────────────────

export const FRED_SERIES = {
  cpi: "CPIAUCSL",
  unemployment: "UNRATE",
  gdp: "GDP",
  fed_funds: "FEDFUNDS",
  treasury_10y: "GS10",
  treasury_2y: "GS2",
  housing_starts: "HOUST",
  retail_sales: "RSXFS",
  industrial_production: "INDPRO",
  pce: "PCEPI",
};

// ── OpenSky bounding boxes for conflict/interest zones ─────

export const OPENSKY_ZONES = {
  ukraine:     { lamin: 44.0, lomin: 22.0, lamax: 52.5, lomax: 40.5 },
  taiwan:      { lamin: 21.5, lomin: 119.0, lamax: 26.0, lomax: 123.0 },
  middle_east: { lamin: 28.0, lomin: 34.0, lamax: 37.5, lomax: 50.0 },
  korea:       { lamin: 33.0, lomin: 124.0, lamax: 43.0, lomax: 131.0 },
  baltic:      { lamin: 53.0, lomin: 20.0, lamax: 60.0, lomax: 29.0 },
};
