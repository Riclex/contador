import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import { MongoClient } from "mongodb";
import twilio from "twilio";
import { pathToFileURL } from "url";
import helmet from "helmet";
import rateLimit from 'express-rate-limit';
import { normalize } from './lib/parsers.js';
import { hashPhone, sanitizeInput, isValidWhatsAppPhone, getAngolaMidnightUTC, ANGOLA_OFFSET_MS, isAffirmative, isConfirmationWord, SessionState, OnboardingState } from './lib/security.js';
import { getCacheStats } from './lib/cache.js';
import { COMMANDS, handleHoje, handleQuemedeve, handleQuemdevo, handleKilapi, handlePago, handleStats, handleRetencao, handleAnunciar, handleAjuda, handlePrivacidade, handleTermos, handleMeusdados, handleApagar, handleDesfazer, handleResumo, handleMes, handleFeedback, handleExportar, handleMetricas } from './lib/handlers/commands.js';
import { handleAwaitingConfirmation, handleAwaitingDebtConfirmation, handleAwaitingPagoConfirm, handleAwaitingDebtorName, handleAwaitingApagarConfirm, handleAwaitingDesfazerConfirm } from './lib/handlers/session.js';
import { handleDebtParse, handleTransactionParse } from './lib/handlers/parsers.js';
import { computeDailyMetrics, getOrCreateSnapshot, getRecentSnapshots } from './lib/metrics.js';
import { parseDebt, parseTransaction, isOpenaiHealthy, startOpenaiHealthCheck } from './lib/openai.js';
import { getSession, setSession, SESSION_TTL_MS, sessions } from './lib/session.js';
import { createWebhookHandler } from './lib/webhook.js';
import logger from './lib/logger.js';
import { WebhookBodySchema } from './lib/schemas.js';

// --- Angola timezone helper (imported from lib/security.js)


// --- Rate Limiting (MongoDB-backed, persists across restarts)
const MAX_MESSAGES_PER_USER_PER_DAY = 50;

// --- MongoDB collections (declared before functions that reference them) ---
let rateLimits;
let dailyMetrics;
let db;
let transactions;
let debts;
let events;

const processingUsers = new Set(); // Per-user lock to prevent concurrent webhook processing

// --- Mutable state container for webhook handler ---
// serverReady/mongoConnected are read LIVE via deps.serverReady / deps.mongoConnected
// in lib/webhook.js (not destructured at handler creation time).
const deps = {
  serverReady: false,
  mongoConnected: false,
};

// SESSION_TTL_MS imported from lib/session.js
// openaiHealthy managed by lib/openai.js (use isOpenaiHealthy() to read)

// --- Stats Cache (5 minute TTL)
const STATS_CACHE_TTL_MS = 60 * 1000; // 1 minute — balances freshness vs. repeated aggregation
let statsCache = {
  data: null,
  timestamp: 0
};

async function getDailyMetrics() {
  const today = getAngolaMidnightUTC();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const timeRange = { $gte: today, $lt: tomorrow };

  // Run all 5 independent queries in parallel
  const [newUsers, activeUsersAgg, totalMessages, confirmedTransactions, debtsCreated] = await Promise.all([
    events.countDocuments({ event_name: 'first_use', timestamp: timeRange }),
    events.aggregate([
      { $match: { timestamp: timeRange } },
      { $group: { _id: '$user_hash' } },
      { $count: 'count' }
    ]).toArray(),
    events.countDocuments({ event_name: 'message_sent', timestamp: timeRange }),
    events.countDocuments({ event_name: 'transaction_confirmed', timestamp: timeRange }),
    events.countDocuments({ event_name: 'debt_created', timestamp: timeRange })
  ]);
  const activeUsers = activeUsersAgg[0]?.count || 0;

  return {
    newUsers,
    activeUsers,
    totalMessages,
    confirmedTransactions,
    debtsCreated
  };
}

async function getEnhancedStats() {
  // Check cache
  if (statsCache.data && Date.now() - statsCache.timestamp < STATS_CACHE_TTL_MS) {
    return statsCache.data;
  }

  const [dailyMetrics, cacheStats] = await Promise.all([
    getDailyMetrics(),
    getCacheStats()
  ]);

  // Calculate uptime
  const uptime = process.uptime();
  const uptimeDays = Math.floor(uptime / 86400);
  const uptimeHours = Math.floor((uptime % 86400) / 3600);
  const uptimeMins = Math.floor((uptime % 3600) / 60);

  const stats = {
    today: dailyMetrics,
    cache: cacheStats,
    system: {
      uptime: `${uptimeDays}d ${uptimeHours}h ${uptimeMins}m`,
      mongodb: mongoConnected ? '✅' : '❌',
      timestamp: new Date().toISOString()
    },
    auditTrail: { logEventFailures }
  };

  // Update cache
  statsCache = {
    data: stats,
    timestamp: Date.now()
  };

  return stats;
}

async function getRetentionData() {
  const today = getAngolaMidnightUTC();
  const ninetyDaysAgo = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Use server-side aggregation to avoid loading all events into memory
  // Step 1: Group first_use events by Angola-date cohort (limited to last 90 days)
  const cohortAgg = await events.aggregate([
    { $match: { event_name: 'first_use', timestamp: { $gte: ninetyDaysAgo } } },
    { $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: 'Africa/Luanda' } },
      users: { $addToSet: '$user_hash' },
      size: { $sum: 1 }
    }},
    { $sort: { _id: 1 } }
  ]).toArray();

  if (cohortAgg.length === 0) return { totalUsers: 0, cohorts: [] };

  // Step 2: Get last activity per user (limited to last 90 days for scalability)
  const allActivity = await events.aggregate([
    { $match: { timestamp: { $gte: ninetyDaysAgo } } },
    { $group: { _id: '$user_hash', lastActive: { $max: '$timestamp' } } }
  ]).toArray();
  const userActivity = new Map(allActivity.map(u => [u._id, u.lastActive]));

  const cohortDays = [1, 7, 30];
  const totalUsers = cohortAgg.reduce((sum, c) => sum + c.size, 0);

  const cohortResults = cohortAgg.map(cohort => {
    const cohortDate = new Date(cohort._id + 'T00:00:00Z');
    const retention = { date: cohort._id, size: cohort.size };

    for (const n of cohortDays) {
      const targetDate = new Date(cohortDate.getTime() + n * 24 * 60 * 60 * 1000);
      if (targetDate > today) {
        retention[`d${n}`] = null;
      } else {
        const returned = cohort.users.filter(hash => {
          const lastActive = userActivity.get(hash);
          return lastActive && lastActive >= targetDate;
        }).length;
        retention[`d${n}`] = cohort.size > 0 ? Math.round((returned / cohort.size) * 100) : 0;
      }
    }
    return retention;
  });

  // Sort by date descending, keep last 30
  cohortResults.sort((a, b) => b.date.localeCompare(a.date));

  return {
    totalUsers,
    cohorts: cohortResults.slice(0, 30)
  };
}

async function checkRateLimit(userPhone) {
  // If MongoDB is disconnected, rate limiting cannot function — block the request
  if (!mongoConnected) return { allowed: false, remaining: 0, resetTime: Date.now() + 86400000, sendNotice: false };
  // Use Angola timezone for day boundary so rate limit resets at Angola midnight
  const angolaDate = new Date(Date.now() + ANGOLA_OFFSET_MS);
  const year = angolaDate.getUTCFullYear();
  const month = String(angolaDate.getUTCMonth() + 1).padStart(2, '0'); // 0-indexed → pad
  const day = String(angolaDate.getUTCDate()).padStart(2, '0');
  const today = `${year}-${month}-${day}`;
  // Normalize phone number for rate limiting (hashed for privacy consistency)
  const normalizedPhone = hashPhone(userPhone);
  const key = `${normalizedPhone}:${today}`;
  const resetAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h from now

  const doc = await rateLimits.findOneAndUpdate(
    { _id: key },
    { $inc: { count: 1 }, $setOnInsert: { resetAt } },
    { upsert: true, returnDocument: 'after' }
  );

  // Cap count at limit + 1 to prevent unbounded growth from attackers
  if (doc.count > MAX_MESSAGES_PER_USER_PER_DAY + 1) {
    await rateLimits.updateOne({ _id: key }, { $set: { count: MAX_MESSAGES_PER_USER_PER_DAY + 1 } });
    doc.count = MAX_MESSAGES_PER_USER_PER_DAY + 1;
  }

  if (doc.count > MAX_MESSAGES_PER_USER_PER_DAY) {
    // Only send the rate limit message once per day (avoid burning Twilio credits)
    if (!doc.notified) {
      await rateLimits.updateOne({ _id: key }, { $set: { notified: true } });
      return { allowed: false, remaining: 0, resetTime: doc.resetAt.getTime(), sendNotice: true };
    }
    return { allowed: false, remaining: 0, resetTime: doc.resetAt.getTime(), sendNotice: false };
  }

  return { allowed: true, remaining: MAX_MESSAGES_PER_USER_PER_DAY - doc.count, resetTime: doc.resetAt.getTime() };
}

// --- Input Sanitization (imported from lib/security.js)
// --- Message Deduplication
// NOTE: In-memory Set with FIFO eviction (10,000 entry limit). Oldest entry is removed
// when the Set exceeds MAX_PROCESSED_MESSAGES. Resets on server restart. Duplicate inserts
// are caught by MongoDB unique indexes on message_sid (error code 11000 silently ignored),
// so this is a performance optimization (avoids a MongoDB round-trip for retried webhooks),
// not a correctness requirement. For horizontal scaling, this would need to move to a shared
// store (Redis or MongoDB).
const MAX_PROCESSED_MESSAGES = 10000;
const processedMessages = new Set();

// --- Rate limiting state (available at module level for health endpoint)
let mongoConnected = false;
let serverReady = false;
let transactionsSupported = false;
let serverInstance = null; // Exposed for tests via getServerPort()

// --- Audit trail monitoring
let logEventFailures = 0; // Counter for failed event logging (exposed in /health and /stats)

// --- Response Cache (imported from lib/cache.js)

// --- Main module guard — server only starts when index.js is run directly, or in test mode
const isMainModule = pathToFileURL(process.argv[1] || '').href === import.meta.url || process.env.NODE_ENV === 'test';

const app = express();
app.use(helmet()); // Security headers (CSP, X-Frame-Options, etc.)

// IP-based rate limiting — protects all endpoints from DDoS before reaching app logic
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, error: 'Too many requests' },
  skip: (req) => req.path === '/health' // /health has its own limiter below
});
app.use(globalLimiter);

// Stricter rate limit for /health (prevent probing/abuse)
const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 health checks per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.get("/health", healthLimiter, (_, res) => {
  if (!serverReady) {
    return res.status(503).json({ status: "starting", mongodb: "disconnected", openai: isOpenaiHealthy() ? "unknown" : "degraded" });
  }
  if (!mongoConnected) {
    return res.status(503).json({ status: "unhealthy", mongodb: "disconnected", openai: isOpenaiHealthy() ? "unknown" : "degraded" });
  }
  res.json({ status: "ok", mongodb: "connected", openai: isOpenaiHealthy() ? "connected" : "degraded", logEventFailures });
});

if (isMainModule) {
app.set('trust proxy', 1); // Trust Railway/reverse proxy headers for signature verification

app.use(bodyParser.urlencoded({
  extended: false,
  limit: '10kb'
}));

// --- Environment Validation
const requiredEnvVars = ["MONGODB_URI", "OPENAI_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];
const missing = requiredEnvVars.filter((key) => !process.env[key]);
if (missing.length > 0) {
  logger.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// Auto-construct WEBHOOK_URL on Railway (injected automatically by the platform)
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_SERVICE_DOMAIN || process.env.RAILWAY_STATIC_URL;
if (!process.env.WEBHOOK_URL && railwayDomain) {
  process.env.WEBHOOK_URL = `https://${railwayDomain}/webhook`;
  logger.info(`[ENV] Auto-configured WEBHOOK_URL from Railway domain: ${process.env.WEBHOOK_URL}`);
}

// WEBHOOK_URL is strongly recommended for correct Twilio signature verification.
// Without it, the app falls back to header-based URL reconstruction which may fail
// behind reverse proxies. The app will still start — this is a warning, not fatal.
if (!process.env.WEBHOOK_URL) {
  logger.warn('[WARN] WEBHOOK_URL not set — Twilio signature verification will use header-based URL reconstruction. Set WEBHOOK_URL for production deployments.');
}

// Admin phone numbers for /stats command (required, no defaults)
// Format: ADMIN_NUMBERS=whatsapp:+244912756717,whatsapp:+351936123127
const ADMIN_NUMBERS = process.env.ADMIN_NUMBERS
  ? process.env.ADMIN_NUMBERS.split(',').map(s => s.trim())
  : [];

// --- Clients and startup state
const mongo = new MongoClient(process.env.MONGODB_URI);

// MongoDB connection retry with exponential backoff
// (mongoConnected, serverReady, transactionsSupported, db, transactions, debts, events declared at module level above)
let mongoRetryCount = 0;
const MAX_MONGO_RETRIES = 10;

async function connectWithRetry() {
  while (mongoRetryCount < MAX_MONGO_RETRIES) {
    try {
      await mongo.connect();
      mongoConnected = true;
      deps.mongoConnected = true;
      mongoRetryCount = 0;
      logger.info("Connected to MongoDB");
      return;
    } catch (err) {
      mongoRetryCount++;
      const backoff = Math.min(1000 * Math.pow(2, mongoRetryCount - 1), 30000);
      logger.error(err, `MongoDB connection attempt ${mongoRetryCount}/${MAX_MONGO_RETRIES} failed`);
      logger.info(`Retrying in ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
  // After fast retries exhausted, switch to slow indefinite retry
  logger.error("Failed to connect to MongoDB after fast retries. Switching to slow retry (60s interval)...");
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 60000));
    try {
      await mongo.connect();
      mongoConnected = true;
      deps.mongoConnected = true;
      mongoRetryCount = 0;
      logger.info("Connected to MongoDB (slow retry)");
      return;
    } catch (err) {
      logger.error(err, 'MongoDB slow retry failed');
    }
  }
}

// --- Twilio client (initialized before routes; used by helpers below)
// OpenAI client managed by lib/openai.js (lazy initialization)

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// OpenAI and session management imported from lib/
//   - parseDebt, parseTransaction, isOpenaiHealthy from lib/openai.js
//   - getSession, setSession, deleteSession, SESSION_TTL_MS, sessions from lib/session.js

const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";

async function reply(to, body) {
  try {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to,
      body
    });
  } catch (err) {
    logger.error(err, 'Failed to send WhatsApp message');
  }
}

// Retry wrapper for critical confirmations (after DB writes where user must know the outcome)
async function replyWithRetry(to, body, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to,
        body
      });
      return;
    } catch (err) {
      if (attempt < retries) {
        logger.warn(err, `[REPLY] Retry ${attempt + 1} for ${hashPhone(to)}`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      } else {
        logger.error(err, `[REPLY] All ${retries + 1} attempts failed for ${hashPhone(to)}`);
      }
    }
  }
}

// --- Migration Guard — prevent redundant migrations on every startup
async function isMigrationDone(name) {
  const doc = await db.collection('_migrations').findOne({ _id: name });
  return doc !== null;
}

async function markMigrationDone(name) {
  await db.collection('_migrations').insertOne({ _id: name, timestamp: new Date() });
}

async function logEvent(eventName, userPhone, metadata = {}) {
  try {
    const userHash = hashPhone(userPhone);

    const eventDoc = {
      event_name: eventName,
      user_hash: userHash,
      timestamp: new Date(),
      metadata: metadata
    };

    // Store in MongoDB
    await events.insertOne(eventDoc);

    // Also log to structured logger
    logger.info({ type: 'event', event: eventName, user_hash: userHash, timestamp: new Date().toISOString(), metadata }, 'event logged');
  } catch (err) {
    logEventFailures++;
    logger.error(err, `[AUDIT-TRAIL-GAP] Event "${eventName}" failed to log`);
  }
}

// --- User Onboarding

async function sendWelcomeMessage(userPhone) {
  const welcomeMessage = `Boas! 👋 Sou o Contador, o teu assistente financeiro no WhatsApp.

Regista vendas, gastos e kilapis só mandando mensagens.

Exemplos:
• "vendi 5000 de pão"
• "João me deve 2000"
• "hoje" (vê saldo)

📄 Termos: /termos
🔒 Privacidade: /privacidade

Aceitas que guardemos os teus dados para fazer os cálculos? Responde "sim" para continuar.`;

  await replyWithRetry(userPhone, welcomeMessage);
}

async function setOnboardingState(userPhone, state) {
  const userHash = hashPhone(userPhone);
  await db.collection('onboarding').updateOne(
    { user_hash: userHash },
    { $set: { state, updated_at: new Date() } },
    { upsert: true }
  );
  // Maintain broadcast list for /anunciar (separate from onboarding to keep PII isolated)
  if (state === OnboardingState.COMPLETED) {
    await db.collection('broadcast_list').updateOne(
      { user_hash: userHash },
      { $set: { phone: userPhone, updated_at: new Date() } },
      { upsert: true }
    );
  }
}

function normalizeOnboardingState(state) {
  // Backward compatibility: old documents used lowercase values
  if (state === 'awaiting_consent') return 'AWAITING_CONSENT';
  if (state === 'completed') return 'COMPLETED';
  return state;
}

async function getOnboardingState(userPhone) {
  const userHash = hashPhone(userPhone);
  const doc = await db.collection('onboarding').findOne({ user_hash: userHash });
  return normalizeOnboardingState(doc?.state) || null;
}

// --- Routes
// Wrap async handlers to forward rejected promises to Express error handler
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Global error handler - catches unhandled errors from async route handlers
app.use((err, req, res, _next) => {
  logger.error(err, `[ERROR] Unhandled error on ${req.method} ${req.path}`);
  if (!res.headersSent) {
    res.status(500).send('Internal Server Error');
  }
});

// --- Bind HTTP port BEFORE MongoDB (Railway kills containers that don't bind quickly)
serverInstance = app.listen(process.env.PORT || 3000, () => {
  logger.info(`HTTP server listening on port ${serverInstance.address().port}`);
});

// --- MongoDB connection (after port is bound — slow connects won't kill the container)
await connectWithRetry();

db = mongo.db();
transactions = db.collection("transactions");
debts = db.collection("debts");
events = db.collection("events");
rateLimits = db.collection("rate_limits");
dailyMetrics = db.collection("daily_metrics");

// Monitor connection health
let reconnectInProgress = false;
mongo.on('close', () => {
  mongoConnected = false;
  deps.mongoConnected = false;
  logger.warn('MongoDB connection closed. Attempting reconnection...');
  // Prevent concurrent reconnection attempts
  if (!reconnectInProgress) {
    reconnectInProgress = true;
    connectWithRetry().then(() => {
      // Clear potentially stale in-memory session cache after reconnect
      sessions.clear();
    }).finally(() => { reconnectInProgress = false; });
  }
});

// --- Database indexes
// Rate limit TTL index — expired entries auto-deleted by MongoDB
try { await rateLimits.createIndex({ resetAt: 1 }, { expireAfterSeconds: 0 }); } catch (err) { if (err.code !== 86) throw err; }

// Daily metrics collection — _id index is auto-created by MongoDB (inherently unique)

// --- Event Tracking System
try { await events.createIndex({ event_name: 1, timestamp: -1 }); } catch (err) { if (err.code !== 86) throw err; }
try { await events.createIndex({ user_hash: 1, timestamp: -1 }); } catch (err) { if (err.code !== 86) throw err; }
// Audit retention: auto-delete data_deleted records after 2 years (Lei 22/11 compliance)
try {
  await events.createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: 2 * 365 * 24 * 60 * 60, partialFilterExpression: { event_name: 'data_deleted' } }
  );
} catch (err) { if (err.code !== 86) throw err; }

// Auto-delete stale data_deletion_started records after 7 days (crash recovery markers)
try {
  await events.createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: 7 * 24 * 60 * 60, partialFilterExpression: { event_name: 'data_deletion_started' } }
  );
} catch (err) { if (err.code !== 86) throw err; }

// Auto-delete non-critical events after 1 year (PII-adjacent data retention)
try {
  await events.createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: 365 * 24 * 60 * 60, partialFilterExpression: { event_name: { $nin: ['data_deleted', 'data_deletion_started'] } } }
  );
} catch (err) { if (err.code !== 86 && err.code !== 67) throw err; }

// Create indexes on debts collection (user_hash replaces user_phone for privacy)
try { await debts.createIndex({ user_hash: 1, settled: 1 }); } catch (err) { if (err.code !== 86) throw err; }
try { await debts.createIndex({ user_hash: 1, creditor: 1, debtor: 1 }); } catch (err) { if (err.code !== 86) throw err; }
try { await debts.createIndex({ user_hash: 1, creditor_lower: 1 }); } catch (err) { if (err.code !== 86) throw err; }
try { await debts.createIndex({ user_hash: 1, debtor_lower: 1 }); } catch (err) { if (err.code !== 86) throw err; }
try {
  await debts.createIndex({ message_sid: 1 }, { unique: true });
} catch (err) {
  if (err.code !== 86) throw err;
}

// Create indexes on transactions collection (user_hash replaces user_phone for privacy)
try { await transactions.createIndex({ user_hash: 1, date: -1 }); } catch (err) { if (err.code !== 86) throw err; }
try {
  await transactions.createIndex({ message_sid: 1 }, { unique: true });
} catch (err) {
  if (err.code !== 86) throw err;
}

// Migrate existing records: backfill user_hash from user_phone
try {
  if (!(await isMigrationDone('backfill_user_hash'))) {
  const migrateCollection = async (collection) => {
    let count = 0;
    const cursor = collection.find({ user_phone: { $exists: true }, user_hash: { $exists: false } }).batchSize(100);
    for await (const doc of cursor) {
      await collection.updateOne(
        { _id: doc._id },
        { $set: { user_hash: hashPhone(doc.user_phone) } }
      );
      count++;
    }
    if (count > 0) {
      logger.info(`[MIGRATE] Backfilled user_hash for ${count} ${collection.collectionName} records.`);
    }
    logger.info(`[MIGRATE] ${collection.collectionName} migration complete.`);
  };
  await migrateCollection(transactions);
  await migrateCollection(debts);
  await migrateCollection(db.collection('onboarding'));
  await migrateCollection(db.collection('sessions'));

  // Remove raw phone numbers from documents now that user_hash is backfilled
  const removeUserPhone = async (collection) => {
    const result = await collection.updateMany(
      { user_phone: { $exists: true }, user_hash: { $exists: true } },
      { $unset: { user_phone: "" } }
    );
    if (result.modifiedCount > 0) {
      logger.info(`[MIGRATE] Removed user_phone from ${result.modifiedCount} ${collection.collectionName} records.`);
    }
  };
  await removeUserPhone(transactions);
  await removeUserPhone(debts);
  await removeUserPhone(db.collection('onboarding'));
  await removeUserPhone(db.collection('sessions'));

  // Migrate onboarding phone numbers to broadcast_list, then remove from onboarding
  const onboardingWithPhone = db.collection('onboarding').find({ phone: { $exists: true } });
  let broadcastMigrated = 0;
  for await (const doc of onboardingWithPhone) {
    if (doc.phone && doc.user_hash && (doc.state === OnboardingState.COMPLETED || doc.state === 'completed')) {
      await db.collection('broadcast_list').updateOne(
        { user_hash: doc.user_hash },
        { $set: { phone: doc.phone, updated_at: new Date() } },
        { upsert: true }
      );
      broadcastMigrated++;
    }
    await db.collection('onboarding').updateOne(
      { _id: doc._id },
      { $unset: { phone: "" } }
    );
  }
  if (broadcastMigrated > 0) {
    logger.info(`[MIGRATE] Migrated ${broadcastMigrated} phone numbers from onboarding to broadcast_list`);
  }

  // Backfill creditor_lower/debtor_lower for existing debt records (index-friendly queries)
  let debtsCount = 0;
  const debtsCursor = debts.find({
    $or: [
      { creditor_lower: { $exists: false } },
      { debtor_lower: { $exists: false } }
    ]
  }).batchSize(100);
  for await (const doc of debtsCursor) {
    const update = {};
    if (doc.creditor && !doc.creditor_lower) update.creditor_lower = doc.creditor.toLowerCase();
    if (doc.debtor && !doc.debtor_lower) update.debtor_lower = doc.debtor.toLowerCase();
    if (Object.keys(update).length > 0) {
      await debts.updateOne({ _id: doc._id }, { $set: update });
      debtsCount++;
    }
  }
  if (debtsCount > 0) {
    logger.info(`[MIGRATE] Backfilled creditor_lower/debtor_lower for ${debtsCount} debt records.`);
    logger.info('[MIGRATE] Debt normalized fields migration complete.');
  }
  await markMigrationDone('backfill_user_hash');
  } else {
    logger.info('[MIGRATE] Skipping backfill_user_hash — already done');
  }
} catch (err) {
  logger.error(err, '[MIGRATE] Migration error (non-fatal)');
}

// Migration: Re-hash from 16-char to 32-char hashes
try {
  if (!(await isMigrationDone('hash_16_to_32'))) {
    logger.info('[MIGRATE] Checking for 16-char user_hash values...');
    const collections = [transactions, debts, db.collection('onboarding'), db.collection('sessions')];
    for (const collection of collections) {
      const field = collection.collectionName === 'sessions' ? 'phone_hash' : 'user_hash';
      const shortHashDocs = await collection.find({
        $expr: { $eq: [{ $strLenCP: `$${field}` }, 16] }
      }).limit(1).toArray();
      if (shortHashDocs.length > 0) {
        logger.warn(`[MIGRATE] Found 16-char ${field} values in ${collection.collectionName}. Users with old hashes will appear as new and need to re-onboard.`);
      }
    }
    await markMigrationDone('hash_16_to_32');
    logger.info('[MIGRATE] hash_16_to_32 migration check complete');
  } else {
    logger.info('[MIGRATE] Skipping hash_16_to_32 — already done');
  }
} catch (err) {
  logger.error(err, '[MIGRATE] hash_16_to_32 migration error (non-fatal)');
}

// Create indexes on sessions collection (phone_hash replaces phone for privacy)
try {
  await db.collection('sessions').createIndex({ phone_hash: 1 }, { unique: true });
} catch (err) {
  if (err.code !== 86) throw err;
}

// Create indexes on broadcast_list collection
try {
  await db.collection('broadcast_list').createIndex({ user_hash: 1 }, { unique: true });
} catch (err) {
  if (err.code !== 86) throw err;
}
try {
  await db.collection('sessions').createIndex({ updatedAt: 1 }, { expireAfterSeconds: SESSION_TTL_MS / 1000 });
} catch (err) {
  // 86 = index spec conflict, 67 = immutable option (e.g., changed TTL on existing index)
  if (err.code !== 86 && err.code !== 67) throw err;
  logger.warn(`[DB] sessions TTL index already exists (code ${err.code}), skipping`);
}

// Pre-populate dedup set from recent records (catches Twilio retries after restart)
try {
  const recentTxSids = await transactions.find({}, { projection: { message_sid: 1 } }).sort({ date: -1 }).limit(MAX_PROCESSED_MESSAGES).toArray();
  recentTxSids.forEach(doc => processedMessages.add(doc.message_sid));
  const recentDebtSids = await debts.find({}, { projection: { message_sid: 1 } }).sort({ date: -1 }).limit(MAX_PROCESSED_MESSAGES).toArray();
  recentDebtSids.forEach(doc => processedMessages.add(doc.message_sid));
  logger.info(`[DB] Pre-populated dedup set with ${processedMessages.size} recent MessageSids`);
} catch (err) {
  logger.error(err, '[DB] Dedup set pre-population failed (non-fatal)');
}

// Detect MongoDB transaction support (requires replica set)
try {
  const adminDb = mongo.db('admin');
  const serverInfo = await adminDb.command({ isMaster: 1 });
  transactionsSupported = !!(serverInfo.setName);
  if (transactionsSupported) {
    logger.info('[DB] MongoDB replica set detected — transactions enabled');
  } else {
    logger.warn('[DB] MongoDB standalone detected — transactions disabled, /apagar will use sequential deletion');
  }
} catch (err) {
  logger.warn(err, '[DB] Could not detect MongoDB transaction support');
}

// --- Populate deps and register webhook route (after all init is complete) ---
Object.assign(deps, {
  db, transactions, debts, events, rateLimits, dailyMetrics,
  sessions, processingUsers, processedMessages, MAX_PROCESSED_MESSAGES,
  SESSION_TTL_MS, ADMIN_NUMBERS, TWILIO_WHATSAPP_NUMBER,
  mongo, transactionsSupported,
  checkRateLimit, reply, replyWithRetry, logEvent,
  getOnboardingState, setOnboardingState, sendWelcomeMessage,
  getSession, setSession,
  commandHandlers: {
    handleHoje, handleQuemedeve, handleQuemdevo, handleKilapi, handlePago,
    handleStats, handleRetencao, handleAnunciar, handleAjuda, handlePrivacidade,
    handleTermos, handleMeusdados, handleApagar, handleDesfazer, handleResumo,
    handleMes, handleFeedback, handleExportar, handleMetricas,
  },
  stateHandlers: {
    handleAwaitingConfirmation, handleAwaitingDebtConfirmation,
    handleAwaitingPagoConfirm, handleAwaitingDebtorName,
    handleAwaitingApagarConfirm, handleAwaitingDesfazerConfirm,
  },
  parseHandlers: {
    handleDebtParse, handleTransactionParse,
  },
  parseTransaction, parseDebt, COMMANDS,
  getEnhancedStats, getRetentionData,
  computeDailyMetrics, getOrCreateSnapshot, getRecentSnapshots,
  twilioClient, twilio,
  hashPhone, sanitizeInput, isValidWhatsAppPhone, normalize,
  isAffirmative, isConfirmationWord, SessionState, OnboardingState,
  logEventFailures,
});
deps.mongoConnected = mongoConnected; // Sync live mutable state

function validateWebhookBody(req, res, next) {
  const result = WebhookBodySchema.safeParse(req.body);
  if (!result.success) {
    const issues = result.error.issues.map(i => i.message).join(', ');
    logger.error(`Webhook validation failed: ${issues}`);
    return res.status(400).send('Invalid request');
  }
  next();
}

const webhookHandler = createWebhookHandler(deps);
app.post("/webhook", validateWebhookBody, asyncHandler(webhookHandler));

// --- All startup complete — server is now ready to handle requests
serverReady = true;
deps.serverReady = true;
logger.info('Server ready — all startup complete');

// Proactive OpenAI health check (managed by lib/openai.js)
startOpenaiHealthCheck();

// --- Graceful shutdown
let serverClosing = false;

async function gracefulShutdown(forceExitDelayMs = 10000) {
  if (serverClosing) return;
  serverClosing = true;
  logger.info('Shutting down gracefully...');

  // Stop accepting new connections, wait for in-flight requests to drain
  serverInstance.close(async () => {
    try {
      await mongo.close();
      logger.info('MongoDB connection closed');
    } catch (err) {
      logger.error(err, 'Error closing MongoDB');
    }
    process.exit(0);
  });

  // Force exit after timeout if in-flight requests don't drain
  setTimeout(() => {
    logger.error(`Forced shutdown after ${forceExitDelayMs}ms timeout`);
    process.exit(1);
  }, forceExitDelayMs);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Prevent unhandled rejections and exceptions from crashing the process silently
process.on('unhandledRejection', (reason) => {
  logger.error(reason, '[FATAL] Unhandled promise rejection');
  // Unhandled rejections can leave the process in an inconsistent state.
  // Exit gracefully after a short delay to allow in-flight operations to complete.
  gracefulShutdown(5000);
});
process.on('uncaughtException', (error) => {
  logger.error(error, '[FATAL] Uncaught exception');
  // Per Node.js docs: process state is undefined after uncaughtException.
  // Always exit gracefully to prevent data corruption and undefined behavior.
  // Railway/container runtime will restart the process.
  gracefulShutdown();
});

} // end if (isMainModule)

// --- Export pure functions for testing (no server side effects when imported)
// Note: checkRateLimit is async and requires MongoDB — not exported for unit testing
export function getServerPort() {
  return serverInstance ? serverInstance.address().port : null;
}

// Test helpers: reset in-memory state between test runs
export function clearInMemorySessions() {
  sessions.clear();
}
export function clearProcessedMessages() {
  processedMessages.clear();
}

// Re-exports from lib/ modules
export {
  normalize,
  parseTransactionRegex,
  parseDebtRegex,
  INCOME_VERBS,
  EXPENSE_VERBS,
  DEBT_VERBS_RECEBIDO,
  DEBT_VERBS_DEVIDO
} from './lib/parsers.js';

export {
  hashPhone,
  sanitizeInput,
  isValidWhatsAppPhone,
  sanitizeForPrompt,
  MAX_OPENAI_INPUT_LENGTH,
  getAngolaMidnightUTC,
  ANGOLA_OFFSET_MS,
  MAX_AMOUNT,
  isAffirmative,
  isNegative,
  isConfirmationWord,
  formatKz,
  SessionState,
  OnboardingState,
  RESERVED_DEBT_NAMES,
  isValidDebtName
} from './lib/security.js';

export {
  getCacheKey,
  getCachedResponse,
  setCachedResponse,
  getCacheStats
} from './lib/cache.js';

export { COMMANDS, MAX_WHATSAPP_CHARS, handleHoje, handleQuemedeve, handleQuemdevo, handleKilapi, handlePago, handleStats, handleRetencao, handleAnunciar, handleAjuda, handlePrivacidade, handleTermos, handleMeusdados, handleApagar, handleDesfazer, handleResumo, handleMes, handleFeedback, handleExportar } from './lib/handlers/commands.js';
export { handleAwaitingConfirmation, handleAwaitingDebtConfirmation, handleAwaitingPagoConfirm, handleAwaitingDebtorName, handleAwaitingApagarConfirm, handleAwaitingDesfazerConfirm } from './lib/handlers/session.js';
export { handleDebtParse, handleTransactionParse } from './lib/handlers/parsers.js';
