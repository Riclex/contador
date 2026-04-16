import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import { MongoClient } from "mongodb";
import crypto from "crypto";
import OpenAI from "openai";
import twilio from "twilio";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";
import helmet from "helmet";
import { normalize, parseTransactionRegex, parseDebtRegex, INCOME_VERBS, EXPENSE_VERBS, DEBT_VERBS_RECEBIDO, DEBT_VERBS_DEVIDO } from './lib/parsers.js';
import { hashPhone, sanitizeInput, isValidWhatsAppPhone, sanitizeForPrompt, MAX_OPENAI_INPUT_LENGTH, getAngolaMidnightUTC, ANGOLA_OFFSET_MS } from './lib/security.js';
import { getCacheKey, getCachedResponse, setCachedResponse, getCacheStats } from './lib/cache.js';

// --- Angola timezone helper (imported from lib/security.js)

// --- Command names (single source of truth for session reset logic)
const COMMANDS = new Set([
  'hoje', '/quemedeve', '/quemdevo', '/kilapi', '/stats',
  'ajuda', '/ajuda', 'comandos', '/comandos',
  'privacidade', '/privacidade', 'termos', '/termos',
  'meusdados', '/meusdados', 'apagar', '/apagar',
  'resumo', '/resumo', 'mes', '/mes'
]);

// --- Session and Onboarding State Enums (prevent typos creating dead-end states) ---
const SessionState = Object.freeze({
  IDLE: 'IDLE',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  AWAITING_DEBT_CONFIRMATION: 'AWAITING_DEBT_CONFIRMATION',
  AWAITING_DEBTOR_NAME: 'AWAITING_DEBTOR_NAME',
  AWAITING_PAGO_CONFIRM: 'AWAITING_PAGO_CONFIRM',
  AWAITING_APAGAR_CONFIRM: 'AWAITING_APAGAR_CONFIRM',
});

const OnboardingState = Object.freeze({
  AWAITING_CONSENT: 'awaiting_consent',
  COMPLETED: 'completed',
});

// --- Debt Name Validation (applied consistently to OpenAI, regex, and user-provided names) ---
function isValidDebtName(name) {
  return typeof name === 'string' &&
    name.trim().length > 0 && name.trim().length <= 30 &&
    /^[a-zA-Z\u00C0-\u00FF\s]+$/.test(name.trim());
}

// --- Rate Limiting (MongoDB-backed, persists across restarts)
const MAX_MESSAGES_PER_USER_PER_DAY = 50;
let rateLimits = null; // MongoDB collection — initialized during startup
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes (used by both app logic and MongoDB TTL index)
const processingUsers = new Set(); // Per-user lock to prevent concurrent webhook processing

// --- Stats Cache (5 minute TTL)
const STATS_CACHE_TTL_MS = 5 * 60 * 1000;
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
    }
  };

  // Update cache
  statsCache = {
    data: stats,
    timestamp: Date.now()
  };

  return stats;
}

async function checkRateLimit(userPhone) {
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

// --- Response Cache (imported from lib/cache.js)

// --- Main module guard — server only starts when index.js is run directly, not when imported by tests
const __filename = fileURLToPath(import.meta.url);
const isMainModule = pathToFileURL(process.argv[1] || '').href === import.meta.url;

const app = express();
app.use(helmet()); // Security headers (CSP, X-Frame-Options, etc.)

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
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// Admin phone numbers for /stats command (optional, defaults provided)
// Format: ADMIN_NUMBERS=whatsapp:+244912756717,whatsapp:+351936123127
const ADMIN_NUMBERS = process.env.ADMIN_NUMBERS
  ? process.env.ADMIN_NUMBERS.split(',').map(s => s.trim())
  : ['whatsapp:+244912756717', 'whatsapp:+351936123127'];

function isAdmin(phone) {
  return ADMIN_NUMBERS.includes(phone);
}

// --- Clients
const mongo = new MongoClient(process.env.MONGODB_URI);

// MongoDB connection retry with exponential backoff
let mongoConnected = false;
let mongoRetryCount = 0;
const MAX_MONGO_RETRIES = 10;

async function connectWithRetry() {
  while (mongoRetryCount < MAX_MONGO_RETRIES) {
    try {
      await mongo.connect();
      mongoConnected = true;
      mongoRetryCount = 0;
      console.log("Connected to MongoDB");
      return;
    } catch (err) {
      mongoRetryCount++;
      const backoff = Math.min(1000 * Math.pow(2, mongoRetryCount - 1), 30000);
      console.error(`MongoDB connection attempt ${mongoRetryCount}/${MAX_MONGO_RETRIES} failed: ${err.message}`);
      console.log(`Retrying in ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
  // After fast retries exhausted, switch to slow indefinite retry
  console.error("Failed to connect to MongoDB after fast retries. Switching to slow retry (60s interval)...");
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 60000));
    try {
      await mongo.connect();
      mongoConnected = true;
      mongoRetryCount = 0;
      console.log("Connected to MongoDB (slow retry)");
      return;
    } catch (err) {
      console.error(`MongoDB slow retry failed: ${err.message}`);
    }
  }
}

await connectWithRetry();

// Monitor connection health
let reconnectInProgress = false;
mongo.on('close', () => {
  mongoConnected = false;
  console.warn('MongoDB connection closed. Attempting reconnection...');
  // Prevent concurrent reconnection attempts
  if (!reconnectInProgress) {
    reconnectInProgress = true;
    connectWithRetry().then(() => {
      // Clear potentially stale in-memory session cache after reconnect
      for (const key of Object.keys(sessions)) {
        delete sessions[key];
      }
    }).finally(() => { reconnectInProgress = false; });
  }
});

const db = mongo.db();
const transactions = db.collection("transactions");
const debts = db.collection("debts");
const events = db.collection("events");
rateLimits = db.collection("rate_limits");

// Rate limit TTL index — expired entries auto-deleted by MongoDB
try { await rateLimits.createIndex({ resetAt: 1 }, { expireAfterSeconds: 0 }); } catch (err) { if (err.code !== 86) throw err; }

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

    // Also log to console in JSON format for easy parsing
    console.log(JSON.stringify({
      type: 'event',
      event: eventName,
      user_hash: userHash,
      timestamp: new Date().toISOString(),
      metadata
    }));
  } catch (err) {
    // Fail silently - don't break user experience if logging fails
    console.error('Event logging error:', err.message);
  }
}

// --- User Onboarding
const ONBOARDING_STATE_KEY = 'onboarding_state';

async function isNewUser(userPhone) {
  const userHash = hashPhone(userPhone);
  const onboardingDoc = await db.collection('onboarding').findOne({ user_hash: userHash });
  return !onboardingDoc;
}

async function hasGivenConsent(userPhone) {
  const userHash = hashPhone(userPhone);
  const userEvents = await events.findOne({
    user_hash: userHash,
    event_name: 'consent_given'
  });
  return !!userEvents;
}

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

  await reply(userPhone, welcomeMessage);
}

async function setOnboardingState(userPhone, state) {
  const userHash = hashPhone(userPhone);
  await db.collection('onboarding').updateOne(
    { user_hash: userHash },
    { $set: { state, updated_at: new Date() } },
    { upsert: true }
  );
}

async function getOnboardingState(userPhone) {
  const userHash = hashPhone(userPhone);
  const doc = await db.collection('onboarding').findOne({ user_hash: userHash });
  return doc?.state || OnboardingState.COMPLETED;
}

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
      console.log(`[MIGRATE] Backfilled user_hash for ${count} ${collection.collectionName} records.`);
    }
    console.log(`[MIGRATE] ${collection.collectionName} migration complete.`);
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
      console.log(`[MIGRATE] Removed user_phone from ${result.modifiedCount} ${collection.collectionName} records.`);
    }
  };
  await removeUserPhone(transactions);
  await removeUserPhone(debts);
  await removeUserPhone(db.collection('onboarding'));
  await removeUserPhone(db.collection('sessions'));

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
    console.log(`[MIGRATE] Backfilled creditor_lower/debtor_lower for ${debtsCount} debt records.`);
    console.log('[MIGRATE] Debt normalized fields migration complete.');
  }
  await markMigrationDone('backfill_user_hash');
  } else {
    console.log('[MIGRATE] Skipping backfill_user_hash — already done');
  }
} catch (err) {
  console.error('[MIGRATE] Migration error (non-fatal):', err.message);
}

// Migration: Re-hash from 16-char to 32-char hashes
try {
  if (!(await isMigrationDone('hash_16_to_32'))) {
    console.log('[MIGRATE] Checking for 16-char user_hash values...');
    const collections = [transactions, debts, db.collection('onboarding'), db.collection('sessions')];
    for (const collection of collections) {
      const field = collection.collectionName === 'sessions' ? 'phone_hash' : 'user_hash';
      const shortHashDocs = await collection.find({
        $expr: { $eq: [{ $strLenCP: `$${field}` }, 16] }
      }).limit(1).toArray();
      if (shortHashDocs.length > 0) {
        console.log(`[MIGRATE] WARNING: Found 16-char ${field} values in ${collection.collectionName}. Users with old hashes will appear as new and need to re-onboard.`);
      }
    }
    await markMigrationDone('hash_16_to_32');
    console.log('[MIGRATE] hash_16_to_32 migration check complete');
  } else {
    console.log('[MIGRATE] Skipping hash_16_to_32 — already done');
  }
} catch (err) {
  console.error('[MIGRATE] hash_16_to_32 migration error (non-fatal):', err.message);
}

// Create indexes on sessions collection (phone_hash replaces phone for privacy)
try {
  await db.collection('sessions').createIndex({ phone_hash: 1 }, { unique: true });
} catch (err) {
  if (err.code !== 86) throw err;
}
try {
  await db.collection('sessions').createIndex({ updatedAt: 1 }, { expireAfterSeconds: SESSION_TTL_MS / 1000 });
} catch (err) {
  // 86 = index spec conflict, 67 = immutable option (e.g., changed TTL on existing index)
  if (err.code !== 86 && err.code !== 67) throw err;
  console.warn(`[DB] sessions TTL index already exists (code ${err.code}), skipping`);
}

// Pre-populate dedup set from recent records (catches Twilio retries after restart)
try {
  const recentTxSids = await transactions.find({}, { projection: { message_sid: 1 } }).sort({ date: -1 }).limit(MAX_PROCESSED_MESSAGES).toArray();
  recentTxSids.forEach(doc => processedMessages.add(doc.message_sid));
  const recentDebtSids = await debts.find({}, { projection: { message_sid: 1 } }).sort({ date: -1 }).limit(MAX_PROCESSED_MESSAGES).toArray();
  recentDebtSids.forEach(doc => processedMessages.add(doc.message_sid));
  console.log(`[DB] Pre-populated dedup set with ${processedMessages.size} recent MessageSids`);
} catch (err) {
  console.error('[DB] Dedup set pre-population failed (non-fatal):', err.message);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const OPENAI_TIMEOUT_MS = 10000; // 10 second timeout

// --- OpenAI System Prompts ---
const DEBT_SYSTEM_PROMPT = "You are a strict debt tracking message parser. \
Your task is to extract a single debt transaction from a Portuguese sentence. \
You MUST output a JSON object with exactly these keys:\
type: 'recebido' or 'devido'\
creditor: string (who is owed money)\
debtor: string (who owes money)\
amount: number (integer, no currency symbols)\
description: short string from the sentence.\
Rules (MANDATORY): \
1. Type mapping: \
- 'recebido' = someone owes the user (e.g., 'João me deve', 'O João deve')\
- 'devido' = user owes someone (e.g., 'eu devo', 'devo')\
2. Amount: \
- Extract numeric amount, ignore currency (Kz, kz, KZ, paus)\
3. Description: \
- Use relevant words from the sentence\
4. Ambiguity: \
- ONLY output {'error':'ambiguous'} if no debt relationship can be determined. \
- DO NOT parse 'transferi' or 'enviei' as debts - they are transactions.\
- DO NOT parse 'paguei' or 'pago' as debts - they are expenses.\
5. Output: \
- Output ONLY valid JSON. \
- No explanations. \
- No extra keys. \
Examples: \
Input: 'O João me deve 2000kz'\
Output: {'type':'recebido','creditor':'user','debtor':'João','amount':2000,'description':'O João me deve'}\
Input: 'Eu devo 1500 a Maria'\
Output: {'type':'devido','creditor':'Maria','debtor':'user','amount':1500,'description':'Eu devo 1500'}\
Input: 'Maria deve-me 3000'\
Output: {'type':'recebido','creditor':'user','debtor':'Maria','amount':3000,'description':'Maria deve-me'}\
Input: 'Emprestei 500 ao João'\
Output: {'type':'recebido','creditor':'user','debtor':'João','amount':500,'description':'Emprestei 500'}\
Input: 'Devo 200 a Ana'\
Output: {'type':'devido','creditor':'Ana','debtor':'user','amount':200,'description':'Devo 200'}\
Input: 'Transferi 200000 para Hugo'\
Output: {'error':'ambiguous'}\
Input: 'Enviei 1000 para a minha conta'\
Output: {'error':'ambiguous'}\
";

const TRANSACTION_SYSTEM_PROMPT = "You are a strict financial message parser. \
Your task is to extract a single financial transaction from a Portuguese sentence. \
You MUST output a JSON object with exactly these keys:\
type: 'income' or 'expense'\
amount: number (integer, no currency symbols)\
description: short string taken from the sentence.\
Rules (MANDATORY): \
1. Verb mapping: \
- Any sentence containing verbs like 'gastei', 'paguei', 'comprei', 'gasto', 'pagamento' → type = 'expense'.\
- Any sentence containing verbs like 'recebi', 'vendi', 'ganhei', 'paiei', 'biolo', 'fezada'→ type = 'income' \
2. Amount: \
- If a numeric amount is present, extract it. \
- Ignore currency case (Kz, kz, KZ, AKZ, akz, paus are the same)\
3. Description: \
- Use the words after 'de', 'do', 'da' when present.\
- If description is generic (e.g. 'saldo'), it is STILL VALID.\
4. Ambiguity: \
- ONLY output {'error':'ambiguous'} if: \
- No numeric amount exists \
- OR no verb exists \
- OR transaction type cannot be determined. \
5. Output: \
- Output ONLY valid JSON. \
- No explanations. \
- No extra keys. \
Examples: \
Input: 'Gastei 1500 Kz de saldo'\
Output: {'type':'expense','amount':1500,'description':'saldo'}\
Input: 'Comprei 1000 kz de fuba'\
Output: {'type':'expense','amount':1000,'description':'fuba'}\
Input: 'Recebi 2000 Kz do João'\
Output: {'type':'income','amount':2000,'description':'do João'}\
Input: 'Comprei pão'\
Output: {'error':'ambiguous'}\
Input: 'Pus saldo'\
Output: {'error':'ambiguous'}\
Input: 'Emprestei 500 kz'\
Output: {'type':'expense','amount':500,'description':'divida'}\
Input: 'Fezade de 3000 kz'\
Output: {'type':'income','amount':3000,'description':'fezada'}\
Input: 'Biolo 2500 kz'\
Output: {'type':'income','amount':2500,'description':'biolo'}\
Input: 'Paiei 3000 paus num wi'\
Output: {'type':'income','amount':3000,'description':'wi'}\
Input: 'Gastei 7000kz em compras'\
Output: {'type':'expense','amount':7000,'description':'compras'}\
Input: 'Recebi 1000 kz em dinheiro'\
Output: {'type':'income','amount':1000,'description':'dinheiro'}\
Input: 'Paguei 500 em saldo'\
Output: {'type':'expense','amount':500,'description':'saldo'}\
";

// --- Shared OpenAI caller (deduplicates timeout/error-handling boilerplate) ---
async function callOpenAI(systemPrompt, userPrompt, { temperature = 0 } = {}) {
  openaiHealthy = true;
  let timeoutId;
  const openaiPromise = openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });
  try {
    const response = await Promise.race([
      openaiPromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('OpenAI timeout')), OPENAI_TIMEOUT_MS);
      })
    ]);
    clearTimeout(timeoutId);
    openaiHealthy = true;
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    clearTimeout(timeoutId);
    openaiPromise.catch(() => {}); // Neutralize losing promise rejection
    openaiHealthy = false;
    console.error('OpenAI API error:', error.message);
    if (error.message === 'OpenAI timeout') return { error: 'service_unavailable' };
    if (error instanceof SyntaxError) return { error: 'ambiguous' };
    return { error: 'service_unavailable' };
  }
}
let openaiHealthy = true; // Track OpenAI connectivity for health check

// --- Proactive OpenAI health check (prevents stale "connected" status between calls) ---
const OPENAI_HEALTH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const OPENAI_HEALTH_TIMEOUT_MS = 5000; // 5 second timeout
const openaiHealthTimer = setInterval(async () => {
  try {
    await Promise.race([
      openai.models.list().next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), OPENAI_HEALTH_TIMEOUT_MS))
    ]);
    openaiHealthy = true;
  } catch (err) {
    openaiHealthy = false;
    console.warn('[OPENAI-HEALTH] Check failed:', err.message);
  }
}, OPENAI_HEALTH_INTERVAL_MS);
openaiHealthTimer.unref(); // Don't prevent process exit

async function parseDebtOpenAI(text) {
  const result = await callOpenAI(
    DEBT_SYSTEM_PROMPT,
    `Extrai uma dívida desta frase:\n"${sanitizeForPrompt(text)}"`,
    { temperature: 0 }
  );
  if (result.error) return result;
  if (!result.type || !result.creditor || !result.debtor || typeof result.amount !== 'number') {
    console.error('[OpenAI] Malformed debt response:', JSON.stringify(result));
    return { error: 'ambiguous' };
  }
  return result;
}

async function parseDebt(text) {
  // Check cache first
  const cached = getCachedResponse(text, 'debt');
  if (cached) {
    console.log('Cache hit for debt');
    return cached;
  }

  // Try regex first (fast, free)
  const regexResult = parseDebtRegex(text);
  if (regexResult.error !== 'ambiguous') {
    setCachedResponse(text, 'debt', regexResult);
    return regexResult;
  }

  // Fallback to OpenAI for ambiguous cases
  console.log('Cache miss - calling OpenAI for debt');
  const result = await parseDebtOpenAI(text);
  if (!result.error) {
    setCachedResponse(text, 'debt', result);
  }
  return result;
}

// --- Session Management (MongoDB-based persistence)
// State types: IDLE, AWAITING_CONFIRMATION, AWAITING_DEBT_CONFIRMATION, AWAITING_DEBTOR_NAME, AWAITING_PAGO_CONFIRM, AWAITING_APAGAR_CONFIRM

async function getSession(phone) {
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

async function setSession(phone, sessionData) {
  const phoneHash = hashPhone(phone);
  if (!mongoConnected) {
    // Fallback to in-memory if MongoDB is not connected
    sessions[phoneHash] = { ...sessionData, updatedAt: Date.now() };
    return;
  }

  await db.collection('sessions').updateOne(
    { phone_hash: phoneHash },
    { $set: { ...sessionData, phone_hash: phoneHash, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function deleteSession(phone) {
  const phoneHash = hashPhone(phone);
  if (!mongoConnected) {
    delete sessions[phoneHash];
    return;
  }

  await db.collection('sessions').deleteOne({ phone_hash: phoneHash });
}

// Keep in-memory fallback for speed
const sessions = {};

// --- Helpers

async function parseTransaction(text) {
  // Check cache first
  const cached = getCachedResponse(text, 'transaction');
  if (cached) {
    console.log('Cache hit for transaction');
    return cached;
  }

  // Try regex first (fast, free)
  const regexResult = parseTransactionRegex(text);
  if (regexResult.error !== 'ambiguous') {
    setCachedResponse(text, 'transaction', regexResult);
    return regexResult;
  }

  // Fallback to OpenAI for ambiguous cases
  console.log('Cache miss - calling OpenAI for transaction');
  const result = await callOpenAI(
    TRANSACTION_SYSTEM_PROMPT,
    `Extrai uma transação financeira desta frase:\n"${sanitizeForPrompt(text)}"`,
    { temperature: 0 }
  );
  if (result.error) return result;
  if (!result.type || typeof result.amount !== 'number') {
    console.error('[OpenAI] Malformed transaction response:', JSON.stringify(result));
    return { error: 'ambiguous' };
  }
  setCachedResponse(text, 'transaction', result);
  return result;
}

const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";

async function reply(to, body) {
  try {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to,
      body
    });
  } catch (err) {
    console.error('Failed to send WhatsApp message:', err.message);
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
        console.warn(`[REPLY] Retry ${attempt + 1} for ${hashPhone(to)}:`, err.message);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      } else {
        console.error(`[REPLY] All ${retries + 1} attempts failed for ${hashPhone(to)}:`, err.message);
      }
    }
  }
}

// --- Routes
// Wrap async handlers to forward rejected promises to Express error handler
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.post("/webhook", asyncHandler(async (req, res) => {
  // Webhook timeout — Twilio times out at ~15s; fail fast if we can't respond in time
  const WEBHOOK_TIMEOUT_MS = 12000;
  const webhookTimeout = setTimeout(() => {
    if (!res.headersSent) {
      console.error('[WEBHOOK] Request timed out after 12s');
      res.status(504).send('Gateway Timeout');
    }
  }, WEBHOOK_TIMEOUT_MS);
  res.on('finish', () => clearTimeout(webhookTimeout));

  // Webhook Signature Verification (Sprint 9 - Security)
  // Generate request ID for tracking logs
  const reqId = Math.random().toString(36).substring(2, 8);
  req.reqId = reqId;
  // Signature verification logged below - no raw body logging (privacy)

  const twilioSignature = req.headers['x-twilio-signature'];
  if (!twilioSignature) {
    console.error(`[WEBHOOK:${reqId}] Missing signature header from:`, req.ip);
    return res.status(401).send('Missing signature');
  }

  // WEBHOOK_URL preferred for reliable signature verification; falls back to header-based URL
  const url = process.env.WEBHOOK_URL || `${req.protocol}://${req.get('host')}/webhook`;

  // Use Twilio's official validateRequest function
  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    url,
    req.body  // Parsed body object
  );

  if (!isValid) {
    console.error(`[WEBHOOK:${reqId}] Invalid webhook signature from:`, req.ip);
    console.error(`[WEBHOOK:${reqId}] URL:`, url);
    return res.status(401).send('Invalid signature');
  }

  console.log(`[WEBHOOK:${reqId}] Signature verified successfully`);

  const from = req.body.From;
  const rawText = req.body.Body || "";
  const userHash = hashPhone(from);

  // Validate phone number format (prevent NoSQL injection)
  if (!isValidWhatsAppPhone(from)) {
    console.error(`[WEBHOOK:${reqId}] Invalid phone number format:`, hashPhone(from));
    return res.status(400).send('Invalid phone number');
  }

  // Input sanitization
  const text = normalize(sanitizeInput(rawText));
  const messageSid = req.body.MessageSid;

  // Prevent concurrent processing of the same user (race condition on session state)
  if (processingUsers.has(userHash)) return res.sendStatus(204);
  processingUsers.add(userHash);

  try {
  // Rate limiting — check before logging events to avoid inflating stats
  const rateLimit = await checkRateLimit(from);
  if (!rateLimit.allowed) {
    if (rateLimit.sendNotice) {
      await reply(from, `Limite diário de mensagens atingido. Tente novamente amanhã.`);
    }
    return res.sendStatus(204);
  }

  // Parallelize: check onboarding state and load session simultaneously
  const [onboardingState, mongoSession] = await Promise.all([
    getOnboardingState(from),
    getSession(from)
  ]);

  // Handle consent flow (short-circuits for non-consenting users)
  if (onboardingState === OnboardingState.AWAITING_CONSENT) {
    if (text === 'sim') {
      await logEvent('first_use', from, { source: 'whatsapp' });
      await logEvent('consent_given', from, {});
      await setOnboardingState(from, OnboardingState.COMPLETED);
      await reply(from, `Perfeito! Podes começar a usar o Contador.

Experimenta mandar algo como:
• "vendi 5000 de pão"
• "comprei 1000 de saldo"
• "hoje" (para ver o saldo)`);
      return res.sendStatus(204);
    } else {
      await reply(from, `Preciso do teu consentimento para guardar os dados. Responde "sim" para continuar.`);
      return res.sendStatus(204);
    }
  }

  // Check if this is a new user
  const userIsNew = await isNewUser(from);
  if (userIsNew) {
    await setOnboardingState(from, OnboardingState.AWAITING_CONSENT);
    await sendWelcomeMessage(from);
    return res.sendStatus(204);
  }

  // Log message_sent event (after consent check — only for consenting users)
  await logEvent('message_sent', from, { message_length: rawText.length, message_type: 'unknown' });

  // Retry protection
  if (!messageSid) {
    return res.sendStatus(204);
  }

  if (processedMessages.has(messageSid)) {
    return res.sendStatus(204);
  }

  processedMessages.add(messageSid);

  while (processedMessages.size > MAX_PROCESSED_MESSAGES) {
    const first = processedMessages.values().next().value;
    processedMessages.delete(first);
  }

  // Load session (already fetched in parallel above)
  const sessionKey = hashPhone(from); // Use hash as key — raw phone numbers never stored in memory
  let session = sessions[sessionKey];
  let sessionDirty = false; // Track whether session state changed (reduces MongoDB writes)

  function markSessionDirty() {
    sessionDirty = true;
  }

  async function saveSessionIfDirty() {
    if (sessionDirty) {
      try {
        await setSession(from, sessions[sessionKey]);
        sessionDirty = false;
      } catch (err) {
        console.error('[SESSION] Failed to save session to MongoDB:', err.message);
        // Keep sessionDirty = true so next request retries the write
      }
    }
  }
  if (session && Date.now() - new Date(session.updatedAt).getTime() > SESSION_TTL_MS) {
    delete sessions[sessionKey];
    session = null;
  }
  if (!session) {
    session = mongoSession || { state: SessionState.IDLE };
    sessions[sessionKey] = session;
  }

  // Reset session if user typed a command during an active confirmation flow
  if (session.state !== SessionState.IDLE && text !== "sim" && text !== "nao" && text !== "não") {
    const isCommand = COMMANDS.has(text) || /^\/\w+\s+/.test(text);
    if (isCommand) {
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      session = sessions[sessionKey];
    }
  }

  // Command: hoje
  if (text === "hoje") {
    await logEvent('command_used', from, { command: 'hoje' });

    const utcStart = getAngolaMidnightUTC();

    const aggResult = await transactions.aggregate([
      { $match: { user_hash: userHash, date: { $gte: utcStart } } },
      { $group: {
        _id: null,
        income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
        expense: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } }
      }}
    ]).toArray();

    const income = Number(aggResult[0]?.income) || 0;
    const expense = Number(aggResult[0]?.expense) || 0;
    const total = Number.isFinite(income) && Number.isFinite(expense) ? income - expense : 0;

    await replyWithRetry(from, `Total de hoje: ${total} Kz`);
    return res.sendStatus(204);
  }

  // Command: /quemedeve - Who owes user (with pagination)
  const quemedeveMatch = text.match(/^\/quemedeve(?:\s+(\d+))?$/i);
  if (quemedeveMatch) {
    await logEvent('command_used', from, { command: 'quemedeve' });
    const page = Math.max(1, parseInt(quemedeveMatch[1] || '1', 10));
    const pageSize = 50;
    const skip = (page - 1) * pageSize;
    const docs = await debts.find({
      user_hash: userHash,
      type: "recebido",
      settled: { $ne: true }
    }).sort({ date: -1 }).skip(skip).limit(pageSize).toArray();

    if (docs.length === 0) {
      await reply(from, page > 1 ? "Sem mais dívidas nesta página." : "Ninguém te deve dinheiro.");
      return res.sendStatus(204);
    }

    let message = `Quem te deve dinheiro (pág. ${page}):\n`;
    for (const d of docs) {
      const amt = Number(d.amount);
      if (!Number.isFinite(amt)) continue;
      message += `- ${d.debtor}: ${amt} Kz\n`;
    }
    if (docs.length === pageSize) message += `\n(mostrando ${pageSize} por página, /quemedeve ${page + 1} para mais)`;
    await replyWithRetry(from, message);
    return res.sendStatus(204);
  }

  // Command: /quemdevo - Who user owes (with pagination)
  const quemdevoMatch = text.match(/^\/quemdevo(?:\s+(\d+))?$/i);
  if (quemdevoMatch) {
    await logEvent('command_used', from, { command: 'quemdevo' });
    const page = Math.max(1, parseInt(quemdevoMatch[1] || '1', 10));
    const pageSize = 50;
    const skip = (page - 1) * pageSize;
    const docs = await debts.find({
      user_hash: userHash,
      type: "devido",
      settled: { $ne: true }
    }).sort({ date: -1 }).skip(skip).limit(pageSize).toArray();

    if (docs.length === 0) {
      await reply(from, page > 1 ? "Sem mais dívidas nesta página." : "Tu não deves dinheiro a ninguém.");
      return res.sendStatus(204);
    }

    let message = `Tu deves dinheiro a (pág. ${page}):\n`;
    for (const d of docs) {
      const amt = Number(d.amount);
      if (!Number.isFinite(amt)) continue;
      message += `- ${d.creditor}: ${amt} Kz\n`;
    }
    if (docs.length === pageSize) message += `\n(mostrando ${pageSize} por página, /quemdevo ${page + 1} para mais)`;
    await replyWithRetry(from, message);
    return res.sendStatus(204);
  }

  // Command: /kilapi - All debts (with pagination)
  const kilapiMatch = text.match(/^\/kilapi(?:\s+(\d+))?$/i);
  if (kilapiMatch) {
    await logEvent('command_used', from, { command: 'kilapi' });
    const page = Math.max(1, parseInt(kilapiMatch[1] || '1', 10));
    const pageSize = 50;
    const skip = (page - 1) * pageSize;
    const docs = await debts.find({
      user_hash: userHash,
      settled: { $ne: true }
    }).sort({ date: -1 }).skip(skip).limit(pageSize).toArray();

    if (docs.length === 0) {
      await reply(from, page > 1 ? "Sem mais dívidas nesta página." : "Não tens dívidas ativas.");
      return res.sendStatus(204);
    }

    let message = `Dívidas ativas (pág. ${page}):\n`;
    for (const d of docs) {
      const amt = Number(d.amount);
      if (!Number.isFinite(amt)) continue;
      if (d.type === "recebido") {
        message += `- ${d.debtor} te deve: ${amt} Kz\n`;
      } else {
        message += `- Tu deves a ${d.creditor}: ${amt} Kz\n`;
      }
    }
    if (docs.length === pageSize) message += `\n(mostrando ${pageSize} por página, /kilapi ${page + 1} para mais)`;
    await replyWithRetry(from, message);
    return res.sendStatus(204);
  }

  // Command: /pago - Mark debt as paid (requires confirmation)
  const pagoMatch = text.match(/^\/pago\s+(.+)/i);
  if (pagoMatch) {
    await logEvent('command_used', from, { command: 'pago' });
    const name = pagoMatch[1].trim();
    // Exact match on pre-normalized lowercase fields (index-friendly)
    const nameLower = name.toLowerCase();
    const doc = await debts.findOne({
      user_hash: userHash,
      settled: { $ne: true },
      $or: [
        { creditor_lower: nameLower },
        { debtor_lower: nameLower }
      ]
    }, { sort: { date: 1 } });

    if (!doc) {
      await reply(from, "Não encontrei esta dívida. Use /kilapi para ver as dívidas ativas.");
      return res.sendStatus(204);
    }

    // Count matching debts for disambiguation info
    const totalDebts = await debts.countDocuments({
      user_hash: userHash,
      settled: { $ne: true },
      $or: [{ creditor_lower: nameLower }, { debtor_lower: nameLower }]
    });
    const extraDebts = totalDebts - 1;

    // Ask for confirmation before settling
    markSessionDirty(); sessions[sessionKey] = {
      state: SessionState.AWAITING_PAGO_CONFIRM,
      pendingPago: { debtId: doc._id, name, type: doc.type, debtor: doc.debtor, creditor: doc.creditor, amount: doc.amount }
    };
    await saveSessionIfDirty();
    const who = doc.type === "recebido" ? `${doc.debtor} te deve` : `tu deves a ${doc.creditor}`;
    const suffix = extraDebts > 0 ? ` (mais ${extraDebts} dívida${extraDebts > 1 ? 's' : ''})` : '';
    await reply(from, `Marcar como paga: ${who} ${doc.amount} Kz${suffix}?\nResponde: Sim ou Não`);
    return res.sendStatus(204);
  }

  // Command: /stats - Admin only statistics
  if (text === "/stats") {
    if (!isAdmin(from)) {
      await reply(from, "Comando reservado para administradores.");
      return res.sendStatus(204);
    }
    await logEvent('command_used', from, { command: 'stats' });
    const stats = await getEnhancedStats();
    const message = `📊 Contador Stats

Hoje:
• Novos usuários: ${stats.today.newUsers}
• Usuários ativos: ${stats.today.activeUsers}
• Mensagens: ${stats.today.totalMessages}
• Confirmações: ${stats.today.confirmedTransactions}
• Dívidas: ${stats.today.debtsCreated}

Cache:
• Hit rate: ${stats.cache.hitRate}
• Entries: ${stats.cache.size}

Sistema:
• Uptime: ${stats.system.uptime}
• MongoDB: ${stats.system.mongodb}`;
    await reply(from, message);
    return res.sendStatus(204);
  }

  // Command: ajuda - Show help menu
  if (text === "ajuda" || text === "/ajuda" || text === "comandos" || text === "/comandos") {
    await logEvent('command_used', from, { command: 'ajuda' });
    const helpMessage = `📚 Comandos do Contador

📊 SALDO:
• hoje - Saldo do dia
• resumo - Últimos 7 dias
• mes - Este mês

💰 DÍVIDAS:
• /quemedeve - Quem te deve
• /quemdevo - A quem deves
• /kilapi - Todas as dívidas
• /pago <nome> - Marcar como paga

📝 REGISTRAR:
• "vendi 1000 de pão" ou "biolo 5000"
• "comprei 500 kz de saldo" ou "gastei 200 paus"
• "João me deve 2000" ou "fezada de 3000"
• "eu devo 1000 a Maria"

🔒 PRIVACIDADE:
• /meusdados - Ver teus dados
• /apagar - Apagar tudo
• /privacidade - Política de privacidade
• /termos - Termos de uso`;
    await reply(from, helpMessage);
    return res.sendStatus(204);
  }

  // Command: privacidade - Show privacy policy summary
  if (text === "privacidade" || text === "/privacidade") {
    await logEvent('command_used', from, { command: 'privacidade' });
    const privacyMessage = `🔒 PRIVACIDADE

O Contador guarda:
• Teu número (com hash SHA-256)
• Transações (vendas, gastos)
• Dívidas (quem deve, quem deve)

Base legal (Lei 22/11):
• Consentimento explícito
• Dados armazenados na UE (Frankfurt/Zurique)

Teus direitos:
• /meusdados - Ver teus dados
• /apagar - Apagar tudo

Política completa: https://riclex.github.io/contador/PRIVACY.html`;
    await reply(from, privacyMessage);
    return res.sendStatus(204);
  }

  // Command: termos - Show terms of use summary
  if (text === "termos" || text === "/termos") {
    await logEvent('command_used', from, { command: 'termos' });
    const termosMessage = `📄 TERMOS DE USO

O Contador é um assistente financeiro via WhatsApp.

Importante:
• Serviço "como está" (sem garantias)
• Tu és responsável pelos dados
• Não é instituição financeira
• Limite: 50 mensagens/dia

Preço:
• Gratuito (fase MVP)

Termos completos: https://riclex.github.io/contador/TERMS.html`;
    await reply(from, termosMessage);
    return res.sendStatus(204);
  }

  // Command: meusdados - Show user data (Lei 22/11 right to access)
  if (text === "meusdados" || text === "/meusdados") {
    await logEvent('command_used', from, { command: 'meusdados' });

    // Get user data (limit transactions to avoid memory issues)
    const userTransactions = await transactions.find({ user_hash: userHash }).sort({ date: -1 }).limit(100).toArray();
    const totalTransactions = await transactions.countDocuments({ user_hash: userHash });
    const activeDebts = await debts.countDocuments({ user_hash: userHash, settled: { $ne: true } });
    const userEvents = await events.find({ user_hash: userHash }, { projection: { event_name: 1, timestamp: 1 } }).sort({ timestamp: -1 }).limit(100).toArray();
    const totalEvents = await events.countDocuments({ user_hash: userHash });

    const totalIncome = userTransactions.filter(t => t.type === "income").reduce((sum, t) => {
      const amt = Number(t.amount);
      return sum + (Number.isFinite(amt) ? amt : 0);
    }, 0);
    const totalExpenses = userTransactions.filter(t => t.type === "expense").reduce((sum, t) => {
      const amt = Number(t.amount);
      return sum + (Number.isFinite(amt) ? amt : 0);
    }, 0);

    const message = `📄 TEUS DADOS

👤 Usuário: ${(() => { const num = from.replace('whatsapp:', ''); return '•'.repeat(num.length - 4) + num.slice(-4); })()}

📊 RESUMO:
• Transações: ${userTransactions.length}${totalTransactions > 100 ? ` (últimas 100 de ${totalTransactions})` : ''}
• Receitas: ${totalIncome.toFixed(2)} Kz
• Despesas: ${totalExpenses.toFixed(2)} Kz
• Saldo: ${(totalIncome - totalExpenses).toFixed(2)} Kz
• Dívidas ativas: ${activeDebts}

🔒 EVENTOS (auditoria):
• Total: ${totalEvents}${totalEvents > 100 ? ' (últimos 100)' : ''}

Para apagar todos os teus dados: /apagar`;
    await replyWithRetry(from, message);
    return res.sendStatus(204);
  }

  // Command: apagar - Delete all user data (Lei 22/11 right to be forgotten)
  if (text === "apagar" || text === "/apagar") {
    await logEvent('command_used', from, { command: 'apagar' });

    // Check if user has data to delete
    const userTransactions = await transactions.countDocuments({ user_hash: userHash });
    const userDebts = await debts.countDocuments({ user_hash: userHash });
    const userEvents = await events.countDocuments({ user_hash: userHash });

    if (userTransactions === 0 && userDebts === 0 && userEvents === 0) {
      await reply(from, "Não tens dados armazenados para apagar.");
      return res.sendStatus(204);
    }

    // Ask for confirmation
    markSessionDirty(); sessions[sessionKey] = { state: SessionState.AWAITING_APAGAR_CONFIRM };
    await saveSessionIfDirty();

    const message = `⚠️ CONFIRMAÇÃO

Tens os seguintes dados armazenados:
• Transações: ${userTransactions}
• Dívidas: ${userDebts}
• Eventos: ${userEvents}

Esta ação é PERMANENTE e não pode ser desfeita.

Responde "sim" para apagar TODOS os teus dados ou "não" para cancelar.`;
    await reply(from, message);
    return res.sendStatus(204);
  }

  // Command: resumo - Last 7 days summary
  if (text === "resumo" || text === "/resumo") {
    await logEvent('command_used', from, { command: 'resumo' });

    const sevenDaysAgo = new Date(getAngolaMidnightUTC().getTime() - 7 * 24 * 60 * 60 * 1000);
    const matchStage = { $match: { user_hash: userHash, date: { $gte: sevenDaysAgo } } };

    const [totalsAgg, dailyAgg] = await Promise.all([
      transactions.aggregate([
        matchStage,
        { $group: {
          _id: null,
          income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
          expense: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } }
        }}
      ]).toArray(),
      transactions.aggregate([
        matchStage,
        { $group: {
          _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, type: '$type' },
          total: { $sum: '$amount' }
        }},
        { $group: {
          _id: '$_id.day',
          income: { $sum: { $cond: [{ $eq: ['$_id.type', 'income'] }, '$total', 0] } },
          expense: { $sum: { $cond: [{ $eq: ['$_id.type', 'expense'] }, '$total', 0] } }
        }},
        { $sort: { _id: 1 } }
      ]).toArray()
    ]);

    const income = Number(totalsAgg[0]?.income) || 0;
    const expenses = Number(totalsAgg[0]?.expense) || 0;

    if (!totalsAgg.length || (income === 0 && expenses === 0)) {
      await reply(from, "Sem transações nos últimos 7 dias.");
      return res.sendStatus(204);
    }

    const balance = Number.isFinite(income) && Number.isFinite(expenses) ? income - expenses : 0;

    let message = `📊 Resumo (Últimos 7 dias)

💰 Entradas: ${income.toFixed(2)} Kz
💸 Saídas: ${expenses.toFixed(2)} Kz
📈 Saldo: ${balance.toFixed(2)} Kz

--- Por dia:`;

    for (const day of dailyAgg) {
      const dayIncome = Number(day.income) || 0;
      const dayExpense = Number(day.expense) || 0;
      const dayBalance = Number.isFinite(dayIncome) && Number.isFinite(dayExpense)
        ? dayIncome - dayExpense : 0;
      const signal = dayBalance >= 0 ? '+' : '';
      message += `\n${day._id}: ${signal}${dayBalance.toFixed(2)} Kz`;
    }

    await replyWithRetry(from, message);
    return res.sendStatus(204);
  }

  // Command: mes - Monthly summary
  if (text === "mes" || text === "/mes") {
    await logEvent('command_used', from, { command: 'mes' });

    const angolaMidnight = getAngolaMidnightUTC();
    // Start of month in Angola time: get Angola date components, build UTC timestamp
    const angolaDate = new Date(angolaMidnight.getTime() + ANGOLA_OFFSET_MS);
    const utcStartOfMonth = new Date(Date.UTC(
      angolaDate.getUTCFullYear(), angolaDate.getUTCMonth(), 1, 0, 0, 0
    ) - ANGOLA_OFFSET_MS);
    const matchStage = { $match: { user_hash: userHash, date: { $gte: utcStartOfMonth } } };

    const [totalsAgg, categoryAgg] = await Promise.all([
      transactions.aggregate([
        matchStage,
        { $group: {
          _id: null,
          income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
          expense: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } }
        }}
      ]).toArray(),
      transactions.aggregate([
        matchStage,
        { $group: {
          _id: { category: { $toLower: '$description' }, type: '$type' },
          total: { $sum: '$amount' }
        }},
        { $group: {
          _id: '$_id.category',
          income: { $sum: { $cond: [{ $eq: ['$_id.type', 'income'] }, '$total', 0] } },
          expense: { $sum: { $cond: [{ $eq: ['$_id.type', 'expense'] }, '$total', 0] } }
        }},
        { $sort: { _id: 1 } }
      ]).toArray()
    ]);

    const income = Number(totalsAgg[0]?.income) || 0;
    const expenses = Number(totalsAgg[0]?.expense) || 0;

    if (!totalsAgg.length || (income === 0 && expenses === 0)) {
      await reply(from, "Sem transações neste mês.");
      return res.sendStatus(204);
    }

    const balance = Number.isFinite(income) && Number.isFinite(expenses) ? income - expenses : 0;
    const monthName = angolaDate.toLocaleDateString('pt-AO', { month: 'long', year: 'numeric' });

    let message = `📊 ${monthName.charAt(0).toUpperCase() + monthName.slice(1)}

💰 Entradas: ${income.toFixed(2)} Kz
💸 Saídas: ${expenses.toFixed(2)} Kz
📈 Saldo: ${balance.toFixed(2)} Kz

--- Por categoria:`;

    for (const cat of categoryAgg) {
      const catIncome = Number(cat.income) || 0;
      const catExpense = Number(cat.expense) || 0;
      const catBalance = Number.isFinite(catIncome) && Number.isFinite(catExpense)
        ? catIncome - catExpense : 0;
      const signal = catBalance >= 0 ? '+' : '';
      const displayName = cat._id.charAt(0).toUpperCase() + cat._id.slice(1);
      message += `\n${displayName}: ${signal}${catBalance.toFixed(2)} Kz`;
    }

    await replyWithRetry(from, message);
    return res.sendStatus(204);
  }

  // --- Session state handlers (switch for explicit dispatch) ---
  switch (session.state) {

  case SessionState.AWAITING_CONFIRMATION: {
    if (text === "sim") {
      const amount = Number(session.pending.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
        await reply(from, "Valor inválido. Tenta novamente.");
        markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
        await saveSessionIfDirty();
        return res.sendStatus(204);
      }
      try {
        await transactions.insertOne({
          message_sid: messageSid,
          user_hash: userHash,
          type: session.pending.type,
          amount: amount,
          description: session.pending.description,
          date: new Date()
        });
        await logEvent('transaction_confirmed', from, {
          type: session.pending.type
        });
      } catch (e) {
        if (e.code !== 11000) throw e;
      }
      await replyWithRetry(from, "Registado.");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      return res.sendStatus(204);
    } else if (text === "nao" || text === "não") {
      await reply(from, "Cancelado.");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      return res.sendStatus(204);
    } else {
      // Cancel pending, but try to parse the new input
      await reply(from, "Cancelado.");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      // Fall through to parse the new input
    }
    break;
  }

  case SessionState.AWAITING_DEBT_CONFIRMATION: {
    if (text === "sim") {
      const amount = Number(session.pendingDebt.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
        await reply(from, "Valor inválido. Tenta novamente.");
        markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
        await saveSessionIfDirty();
        return res.sendStatus(204);
      }
      try {
        await debts.insertOne({
          message_sid: messageSid,
          user_hash: userHash,
          type: session.pendingDebt.type,
          creditor: session.pendingDebt.creditor,
          debtor: session.pendingDebt.debtor,
          creditor_lower: session.pendingDebt.creditor.toLowerCase(),
          debtor_lower: session.pendingDebt.debtor.toLowerCase(),
          amount: amount,
          description: session.pendingDebt.description,
          date: new Date(),
          settled: false,
          settled_date: null
        });
        await logEvent('debt_created', from, {
          type: session.pendingDebt.type
        });
        await replyWithRetry(from, "Dívida registada.");
      } catch (e) {
        if (e.code !== 11000) throw e;
        // Duplicate key = already recorded by a previous request, no action needed
      }
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      return res.sendStatus(204);
    } else if (text === "nao" || text === "não") {
      await reply(from, "Cancelado.");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      return res.sendStatus(204);
    } else {
      // Cancel pending, but try to parse the new input
      await reply(from, "Cancelado.");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      // Fall through to parse the new input
    }
    break;
  }

  case SessionState.AWAITING_PAGO_CONFIRM: {
    if (text === "sim") {
      await debts.updateOne(
        { _id: session.pendingPago.debtId, user_hash: userHash },
        { $set: { settled: true, settled_date: new Date() } }
      );
      const p = session.pendingPago;
      const who = p.type === "recebido" ? `${p.debtor} te deve` : `tu deves a ${p.creditor}`;
      await replyWithRetry(from, `Dívida de ${who} ${p.amount} Kz marcada como paga.`);

      // Check for remaining debts with same name
      const nameLower = p.name.toLowerCase();
      const remaining = await debts.countDocuments({
        user_hash: userHash,
        settled: { $ne: true },
        _id: { $ne: p.debtId },
        $or: [{ creditor_lower: nameLower }, { debtor_lower: nameLower }]
      });
      if (remaining > 0) {
        await reply(from, `Mais ${remaining} dívida(s) com este nome. Manda /pago ${p.name} de novo.`);
      }
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      return res.sendStatus(204);
    } else if (text === "nao" || text === "não") {
      await reply(from, "Operação cancelada.");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      return res.sendStatus(204);
    } else {
      // Cancel pending, but try to parse the new input
      await reply(from, "Operação cancelada.");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      // Fall through to parse the new input
    }
    break;
  }

  case SessionState.AWAITING_DEBTOR_NAME: {
    const pendingDebt = session.pendingDebt;

    if (text === "nao" || text === "não") {
      await reply(from, "Cancelado.");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      return res.sendStatus(204);
    }

    // Update the name based on debt type
    const name = text.trim();

    // Validate name: max 30 chars, letters/accented chars/spaces only, no commands
    if (name.length === 0 || name.length > 30 || !/^[a-zA-Z\u00C0-\u00FF\s]+$/.test(name)) {
      await reply(from, "Nome inválido. Usa só letras e espaços (máximo 30 caracteres).");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      return res.sendStatus(204);
    }

    // For "recebido" (someone owes user): debtor="user" (unknown), need debtor name
    if (pendingDebt.type === "recebido" && pendingDebt.debtor === "user") {
      pendingDebt.debtor = name;
    // For "devido" (user owes someone): creditor="user" (unknown), need creditor name
    } else if (pendingDebt.type === "devido" && pendingDebt.creditor === "user") {
      pendingDebt.creditor = name;
    }

    const amount = Number(pendingDebt.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
      await reply(from, "Valor inválido. Tenta novamente.");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      return res.sendStatus(204);
    }

    // Go to confirmation instead of inserting directly (consistent with other flows)
    markSessionDirty(); sessions[sessionKey] = {
      state: SessionState.AWAITING_DEBT_CONFIRMATION,
      pendingDebt: pendingDebt
    };
    await saveSessionIfDirty();
    const who = pendingDebt.type === "recebido" ? `${name} te deve` : `tu deves a ${name}`;
    await reply(from, `Registar que ${who} ${pendingDebt.amount} Kz?\nResponde: Sim ou Não`);
    return res.sendStatus(204);
    break;
  }

  case SessionState.AWAITING_APAGAR_CONFIRM: {
    if (text === "sim") {
      // Record erasure intent first — if process crashes mid-deletion, this proves the request existed
      // Use a double-hash so the audit record cannot be linked back to the original phone number
      const auditId = crypto.randomUUID();
      const auditHash = hashPhone(userHash); // one-way anonymized key
      await db.collection('events').insertOne({
        _id: auditId,
        event_name: 'data_deletion_started',
        audit_hash: auditHash,
        timestamp: new Date()
      });

      try {
        // Delete all user data atomically via MongoDB transaction
        const clientSession = mongo.startSession();
        let deleteCounts = { transactions: 0, debts: 0, events: 0 };
        try {
          await clientSession.withTransaction(async () => {
            const dt = await transactions.deleteMany({ user_hash: userHash }, { session: clientSession });
            const dd = await debts.deleteMany({ user_hash: userHash }, { session: clientSession });
            const de = await events.deleteMany({ user_hash: userHash }, { session: clientSession });
            await db.collection('sessions').deleteOne({ phone_hash: hashPhone(from) }, { session: clientSession });
            await db.collection('onboarding').deleteOne({ user_hash: userHash }, { session: clientSession });
            // Delete rate_limits using hashed key (consistent with other collections)
            const normalizedPhone = hashPhone(from);
            await rateLimits.deleteMany({
              _id: { $gte: `${normalizedPhone}:`, $lt: `${normalizedPhone}:\uffff` }
            }, { session: clientSession });
            deleteCounts = {
              transactions: dt.deletedCount,
              debts: dd.deletedCount,
              events: de.deletedCount
            };
          });
        } finally {
          await clientSession.endSession();
        }

        // Replace the intent record with a completion record
        await db.collection('events').updateOne(
          { _id: auditId },
          {
            $set: {
              event_name: 'data_deleted',
              metadata: {
                transactions_deleted: deleteCounts.transactions,
                debts_deleted: deleteCounts.debts,
                events_deleted: deleteCounts.events
              }
            }
          }
        );

        await replyWithRetry(from, "✅ Todos os teus dados foram apagados permanentemente.");
        delete sessions[sessionKey];
      } catch (error) {
        console.error('[/APAGAR] Error during deletion:', error.message);
        await reply(from, "Erro ao apagar dados. Tenta novamente mais tarde.");
        markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
        await saveSessionIfDirty();
      }
    } else {
      await reply(from, "Operação cancelada. Os teus dados permanecem armazenados.");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
    }
    return res.sendStatus(204);
    break;
  }

  case SessionState.IDLE:
  default:
    // Safety: catch unexpected state values and reset to IDLE
    if (session.state !== SessionState.IDLE) {
      console.warn(`[SESSION] Unexpected state ${session.state}, resetting to IDLE`);
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
    }
    break;

  } // end switch

  // If session is not IDLE after the switch, a non-IDLE case returned without
  // resetting (shouldn't happen). Skip parsing to avoid stale-state bugs.
  if (session.state !== SessionState.IDLE) {
    return res.sendStatus(204);
  }

  // Check for debt pattern first (before transaction parsing)
  try {
    const parsedDebt = await parseDebt(text);

    if (
      parsedDebt &&
      !parsedDebt.error &&
      ["recebido", "devido"].includes(parsedDebt.type) &&
      Number.isFinite(parsedDebt.amount) &&
      parsedDebt.amount > 0 &&
      parsedDebt.amount <= 1_000_000_000 &&
      typeof parsedDebt.creditor === "string" &&
      parsedDebt.creditor.trim().length > 0 &&
      typeof parsedDebt.debtor === "string" &&
      parsedDebt.debtor.trim().length > 0
    ) {
      // Validate counterparty names against injection/garbage from OpenAI or regex
      if (parsedDebt.type === "recebido" && !isValidDebtName(parsedDebt.debtor)) {
        parsedDebt.debtor = "user"; // Trigger AWAITING_DEBTOR_NAME for valid name
      }
      if (parsedDebt.type === "devido" && !isValidDebtName(parsedDebt.creditor)) {
        parsedDebt.creditor = "user"; // Trigger AWAITING_DEBTOR_NAME for valid name
      }
      // Check if we need user input to fill in the counterparty name
      // Only enter AWAITING_DEBTOR_NAME when the COUNTERPARTY is "user" (unknown),
      // not when the self-party is "user" (which is always true for regex parses)
      if (
        (parsedDebt.type === "recebido" && parsedDebt.debtor === "user") ||
        (parsedDebt.type === "devido" && parsedDebt.creditor === "user")
      ) {
        markSessionDirty(); sessions[sessionKey] = {
          state: SessionState.AWAITING_DEBTOR_NAME,
          pendingDebt: {
            type: parsedDebt.type,
            creditor: parsedDebt.creditor,
            debtor: parsedDebt.debtor,
            amount: parsedDebt.amount,
            description: parsedDebt.description
          }
        };
        await saveSessionIfDirty();
        if (parsedDebt.type === "recebido") {
          await reply(from, "Quem te deve? Escreve o nome.");
        } else {
          await reply(from, "Tu deves a quem? Escreve o nome.");
        }
        return res.sendStatus(204);
      }

      // Full info available, ask for confirmation
      markSessionDirty(); sessions[sessionKey] = {
        state: SessionState.AWAITING_DEBT_CONFIRMATION,
        pendingDebt: {
          type: parsedDebt.type,
          creditor: parsedDebt.creditor,
          debtor: parsedDebt.debtor,
          amount: parsedDebt.amount,
          description: parsedDebt.description
        }
      };
      await saveSessionIfDirty();

      const whoOwes = parsedDebt.type === "recebido" ? parsedDebt.debtor : parsedDebt.creditor;
      const debtText = parsedDebt.type === "recebido"
        ? `${whoOwes} te deve ${parsedDebt.amount}`
        : `tu deves ${parsedDebt.amount} a ${whoOwes}`;
      await reply(
        from,
        `Registar que ${debtText} Kz?\nResponde: Sim ou Não`
      );
      return res.sendStatus(204);
    }
  } catch (err) {
    console.error("Debt parsing error:", err);
    // Fall through to transaction parsing
  }

  // New transaction
  try {
    const parsed = await parseTransaction(text);

    if (
      !parsed ||
      parsed.error ||
      !["income", "expense"].includes(parsed.type) ||
      !Number.isFinite(parsed.amount) ||
      typeof parsed.description !== "string" ||
      parsed.description.trim().length === 0
    ) {
      await reply(from, "Não percebi. Reescreve a frase.");
      return res.sendStatus(204);
    }

    parsed.amount = Number(parsed.amount);
    parsed.description = parsed.description.trim();

    // Validate amount before presenting confirmation prompt
    if (parsed.amount <= 0 || parsed.amount > 1_000_000_000) {
      await reply(from, "Valor inválido. Tenta novamente.");
      return res.sendStatus(204);
    }

    markSessionDirty(); sessions[sessionKey] = {
      state: SessionState.AWAITING_CONFIRMATION,
      pending: parsed
    };
    await saveSessionIfDirty();

    await reply(
      from,
      `Registar ${parsed.type === "income" ? "entrada" : "saída"} de ${parsed.amount} Kz (${parsed.description})?\nResponde: Sim ou Não`
    );

    return res.sendStatus(204);
  } catch (err) {
    console.error(err);
    await reply(from, "Erro ao processar. Tenta novamente.");
    return res.sendStatus(204);
  }
  } finally {
    processingUsers.delete(userHash);
  }

}));

app.get("/health", (_, res) => {
  if (!mongoConnected) {
    return res.status(503).json({ status: "unhealthy", mongodb: "disconnected" });
  }
  res.json({ status: "ok", mongodb: "connected", openai: openaiHealthy ? "connected" : "degraded" });
});

// Global error handler - catches unhandled errors from async route handlers
app.use((err, req, res, next) => {
  console.error(`[ERROR] Unhandled error on ${req.method} ${req.path}:`, err.message);
  if (!res.headersSent) {
    res.status(500).send('Internal Server Error');
  }
});

const server = app.listen(process.env.PORT || 3000);

// --- Graceful shutdown
let serverClosing = false;

async function gracefulShutdown() {
  if (serverClosing) return;
  serverClosing = true;
  console.log('Shutting down gracefully...');

  // Stop accepting new connections, wait for in-flight requests to drain
  server.close(async () => {
    try {
      await mongo.close();
      console.log('MongoDB connection closed');
    } catch (err) {
      console.error('Error closing MongoDB:', err.message);
    }
    process.exit(0);
  });

  // Force exit after 10s if in-flight requests don't drain
  setTimeout(() => {
    console.error('Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

} // end if (isMainModule)

// --- Export pure functions for testing (no server side effects when imported)
// Note: checkRateLimit is async and requires MongoDB — not exported for unit testing
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
  ANGOLA_OFFSET_MS
} from './lib/security.js';

export {
  getCacheKey,
  getCachedResponse,
  setCachedResponse,
  getCacheStats
} from './lib/cache.js';

export { SessionState, OnboardingState, isValidDebtName };