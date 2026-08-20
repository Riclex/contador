import { hashPhone } from './security.js';

// --- Session TTL ---
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

// --- In-memory session cache (also fallback when MongoDB is disconnected) ---
// Uses Map for LRU-like eviction: Map preserves insertion order, so keys().next()
// gives the least-recently-set entry, which we evict first when cache is full.
const MAX_SESSIONS = 10000;
const sessions = new Map();

// Evict oldest entries when cache exceeds max size
function evictIfNeeded() {
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (!oldest) break;
    sessions.delete(oldest);
  }
}

async function getSession(db, mongoConnected, phone) {
  if (!mongoConnected) return null;

  const phoneHash = hashPhone(phone);
  const doc = await db.collection('sessions').findOne({ phone_hash: phoneHash });
  if (!doc) return null;

  // Check if session has expired (based on last state change, not last read)
  if (Date.now() - doc.updatedAt > SESSION_TTL_MS) {
    await db.collection('sessions').deleteOne({ phone_hash: phoneHash });
    return null;
  }

  return doc;
}

async function setSession(db, mongoConnected, phone, sessionData) {
  const phoneHash = hashPhone(phone);
  if (!mongoConnected) {
    // Fallback to in-memory if MongoDB is not connected
    sessions.set(phoneHash, { ...sessionData, updatedAt: Date.now() });
    evictIfNeeded();
    return { modifiedCount: 1 };
  }

  // No optimistic-lock `version` filter here: the webhook's per-user `processingUsers`
  // lock already serializes concurrent requests from the same phone, so a plain upsert
  // by phone_hash is race-free. (A previous version-based filter was dead code — handlers
  // replace the session object without carrying `version`, so the filter always matched 0
  // and every save after the first failed with a duplicate-key error.)
  const result = await db.collection('sessions').updateOne(
    { phone_hash: phoneHash },
    { $set: { ...sessionData, phone_hash: phoneHash, updatedAt: new Date() } },
    { upsert: true }
  );
  return result;
}

export {
  getSession,
  setSession,
  SESSION_TTL_MS,
  sessions
};
