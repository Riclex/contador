// --- Response Cache ---
// NOTE: In-memory LRU Map — resets on server restart, causing cold cache (extra OpenAI calls
// until cache warms up). This is a performance optimization only; no correctness impact.
// For horizontal scaling, this would need to move to a shared store (Redis or MongoDB).
const CACHE_SIZE = 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const responseCache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

function getCacheKey(text, type) {
  return `${type}:${text.toLowerCase().trim()}`;
}

function getCachedResponse(text, type) {
  const key = getCacheKey(text, type);
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    cacheHits++;
    // Move to end for true LRU behavior
    responseCache.delete(key);
    responseCache.set(key, entry);
    return entry.data;
  }
  // Remove expired entry
  if (entry) responseCache.delete(key);
  cacheMisses++;
  return null;
}

function setCachedResponse(text, type, data) {
  const key = getCacheKey(text, type);
  // LRU eviction if cache is full
  if (responseCache.size >= CACHE_SIZE) {
    const firstKey = responseCache.keys().next().value;
    responseCache.delete(firstKey);
  }
  responseCache.set(key, {
    data,
    timestamp: Date.now()
  });
}

function getCacheStats() {
  const total = cacheHits + cacheMisses;
  return {
    size: responseCache.size,
    hits: cacheHits,
    misses: cacheMisses,
    hitRate: total > 0 ? ((cacheHits / total) * 100).toFixed(1) + '%' : '0%'
  };
}

function resetCache() {
  responseCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

export {
  getCacheKey,
  getCachedResponse,
  setCachedResponse,
  getCacheStats,
  resetCache
};