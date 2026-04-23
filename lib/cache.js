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

// --- OpenAI Call Tracking (in-memory, resets on restart) ---
let openaiCallsToday = 0;
let openaiCacheHitsToday = 0;
let openaiCountersDate = null;

function trackOpenAICall(wasCacheHit) {
  // Compute Angola date string for daily reset
  const ANGOLA_OFFSET_MS = 60 * 60 * 1000; // UTC+1
  const angolaTime = new Date(Date.now() + ANGOLA_OFFSET_MS);
  const today = `${angolaTime.getUTCFullYear()}-${String(angolaTime.getUTCMonth() + 1).padStart(2, '0')}-${String(angolaTime.getUTCDate()).padStart(2, '0')}`;
  if (openaiCountersDate !== today) {
    openaiCallsToday = 0;
    openaiCacheHitsToday = 0;
    openaiCountersDate = today;
  }
  if (wasCacheHit) {
    openaiCacheHitsToday++;
  } else {
    openaiCallsToday++;
  }
}

function getOpenAIStats() {
  return { calls: openaiCallsToday, cacheHits: openaiCacheHitsToday };
}

// --- OpenAI Daily Cost Cap
const DAILY_OPENAI_CAP = 500; // Max OpenAI calls per day (safety valve)

function isOpenAICapReached() {
  const ANGOLA_OFFSET_MS = 60 * 60 * 1000; // UTC+1
  const angolaTime = new Date(Date.now() + ANGOLA_OFFSET_MS);
  const today = `${angolaTime.getUTCFullYear()}-${String(angolaTime.getUTCMonth() + 1).padStart(2, '0')}-${String(angolaTime.getUTCDate()).padStart(2, '0')}`;
  if (openaiCountersDate !== today) return false; // Counters reset, cap not reached
  return openaiCallsToday >= DAILY_OPENAI_CAP;
}

export {
  getCacheKey,
  getCachedResponse,
  setCachedResponse,
  getCacheStats,
  resetCache,
  trackOpenAICall,
  getOpenAIStats,
  isOpenAICapReached
};