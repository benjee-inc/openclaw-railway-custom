// polymarket-alpha — simple in-memory TTL cache

const store = new Map();

/**
 * Get a cached value, or null if expired/missing.
 * @param {string} key
 * @returns {any|null}
 */
export function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

/**
 * Set a value with TTL in milliseconds.
 * @param {string} key
 * @param {any} value
 * @param {number} ttlMs
 */
export function set(key, value, ttlMs) {
  store.set(key, { value, expires: Date.now() + ttlMs });
}

/**
 * Check if a key exists and is not expired.
 */
export function has(key) {
  return get(key) !== null;
}

/**
 * Clear all cache entries.
 */
export function clear() {
  store.clear();
}

/**
 * Get cache stats.
 */
export function stats() {
  let valid = 0;
  let expired = 0;
  const now = Date.now();
  for (const [, entry] of store) {
    if (now > entry.expires) expired++;
    else valid++;
  }
  return { valid, expired, total: store.size };
}
