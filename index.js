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
import rateLimit from 'express-rate-limit';
import { normalize, parseTransactionRegex, parseDebtRegex, INCOME_VERBS, EXPENSE_VERBS, DEBT_VERBS_RECEBIDO, DEBT_VERBS_DEVIDO } from './lib/parsers.js';
import { hashPhone, sanitizeInput, isValidWhatsAppPhone, sanitizeForPrompt, MAX_OPENAI_INPUT_LENGTH, getAngolaMidnightUTC, ANGOLA_OFFSET_MS, MAX_AMOUNT, isAffirmative, isNegative, isConfirmationWord, formatKz, SessionState, OnboardingState, isValidDebtName, validateTransactionResponse, validateDebtResponse } from './lib/security.js';
import { getCacheKey, getCachedResponse, setCachedResponse, getCacheStats } from './lib/cache.js';
import { COMMANDS, MAX_WHATSAPP_CHARS, handleHoje, handleQuemedeve, handleQuemdevo, handleKilapi, handlePago, handleStats, handleAjuda, handlePrivacidade, handleTermos, handleMeusdados, handleApagar, handleDesfazer, handleResumo, handleMes, handleAwaitingConfirmation, handleAwaitingDebtConfirmation, handleAwaitingPagoConfirm, handleAwaitingDebtorName, handleAwaitingApagarConfirm, handleAwaitingDesfazerConfirm, handleDebtParse, handleTransactionParse } from './lib/commands.js';

// --- Angola timezone helper (imported from lib/security.js)


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

// --- Response Cache (imported from lib/cache.js)

// --- Main module guard — server only starts when index.js is run directly, not when imported by tests
const __filename = fileURLToPath(import.meta.url);
const isMainModule = pathToFileURL(process.argv[1] || '').href === import.meta.url;

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
    return res.status(503).json({ status: "starting", mongodb: "disconnected" });
  }
  if (!mongoConnected) {
    return res.status(503).json({ status: "unhealthy", mongodb: "disconnected" });
  }
  res.json({ status: "ok", mongodb: "connected" });
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
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

// Admin phone numbers for /stats command (required, no defaults)
// Format: ADMIN_NUMBERS=whatsapp:+244912756717,whatsapp:+351936123127
const ADMIN_NUMBERS = process.env.ADMIN_NUMBERS
  ? process.env.ADMIN_NUMBERS.split(',').map(s => s.trim())
  : [];

function isAdmin(phone) {
  return ADMIN_NUMBERS.includes(phone);
}

// --- Clients and startup state
const mongo = new MongoClient(process.env.MONGODB_URI);

// MongoDB connection retry with exponential backoff
let mongoConnected = false;
let serverReady = false; // Set true after all startup completes
let transactionsSupported = false; // Set true if MongoDB supports transactions (replica set)
let db = null;
let transactions = null;
let debts = null;
let events = null;
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

// --- OpenAI / Twilio clients (initialized before routes; used by helpers below)
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
Output: {'error':'ambiguous'}\
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


async function parseDebtOpenAI(text) {
  const result = await callOpenAI(
    DEBT_SYSTEM_PROMPT,
    `Extrai uma dívida desta frase:\n"${sanitizeForPrompt(text)}"`,
    { temperature: 0 }
  );
  if (result.error) return result;
  const validated = validateDebtResponse(result);
  if (validated.error) {
    console.error('[OpenAI] Malformed debt response:', JSON.stringify(result));
    return validated;
  }
  return validated;
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
  const validated = validateTransactionResponse(result);
  if (validated.error) {
    console.error('[OpenAI] Malformed transaction response:', JSON.stringify(result));
    return validated;
  }
  setCachedResponse(text, 'transaction', validated);
  return validated;
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
}

async function getOnboardingState(userPhone) {
  const userHash = hashPhone(userPhone);
  const doc = await db.collection('onboarding').findOne({ user_hash: userHash });
  return doc?.state || null;
}

// --- Routes
// Wrap async handlers to forward rejected promises to Express error handler
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.post("/webhook", asyncHandler(async (req, res) => {
  // Reject requests while server is still initializing (MongoDB not ready yet)
  if (!serverReady) return res.sendStatus(503);
  // Reject requests when MongoDB is disconnected after startup (prevents 500s and Twilio retry storms)
  if (!mongoConnected) return res.sendStatus(503);

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

  // Reject excessively long messages (WhatsApp max is ~65K chars — no legitimate use case exceeds 2000)
  const MAX_MESSAGE_LENGTH = 2000;
  if (rawText.length > MAX_MESSAGE_LENGTH) {
    console.warn(`[WEBHOOK:${reqId}] Message too long: ${rawText.length} chars from ${hashPhone(from)}`);
    return res.sendStatus(413);
  }

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
    if (isAffirmative(text)) {
      await logEvent('first_use', from, { source: 'whatsapp' });
      await logEvent('consent_given', from, {});
      await setOnboardingState(from, OnboardingState.COMPLETED);
      await replyWithRetry(from, `Perfeito! Podes começar a usar o Contador.

Experimenta mandar algo como:
• "vendi 5000 de pão"
• "comprei 1000 de saldo"
• "hoje" (para ver o saldo)`);
      return res.sendStatus(204);
    } else {
      await replyWithRetry(from, `Preciso do teu consentimento para guardar os dados. Responde "sim" para continuar.`);
      return res.sendStatus(204);
    }
  }

  // Check if this is a new user (onboardingState is null when no record exists)
  if (onboardingState === null) {
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
  if (session.state !== SessionState.IDLE && !isConfirmationWord(text)) {
    const isCommand = COMMANDS.has(text) || /^\/\w+\s+/.test(text);
    if (isCommand) {
      await reply(from, "Operação cancelada.");
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
      session = sessions[sessionKey];
    }
  }

  // --- Construct context for command/state handlers ---
  const ctx = {
    from,
    text,
    userHash,
    messageSid,
    sessionKey,
    session,
    sessions,
    db,
    transactions,
    debts,
    events,
    rateLimits,
    mongoClient: mongo,
    transactionsSupported,
    reply: (body) => reply(from, body),
    replyWithRetry: (body) => replyWithRetry(from, body),
    logEvent: (eventName, metadata) => logEvent(eventName, from, metadata),
    markSessionDirty,
    saveSessionIfDirty,
    parseTransaction,
    parseDebt,
    adminNumbers: ADMIN_NUMBERS,
    getEnhancedStats,
  };

  // --- Command dispatch ---
  if (text === "hoje" || text === "/hoje") {
    await handleHoje(ctx);
    return res.sendStatus(204);
  }

  const quemedeveMatch = text.match(/^\/quemedeve(?:\s+(\d+))?$/i);
  if (quemedeveMatch) {
    const page = parseInt(quemedeveMatch[1] || '1', 10);
    await handleQuemedeve(ctx, page);
    return res.sendStatus(204);
  }

  const quemdevoMatch = text.match(/^\/quemdevo(?:\s+(\d+))?$/i);
  if (quemdevoMatch) {
    const page = parseInt(quemdevoMatch[1] || '1', 10);
    await handleQuemdevo(ctx, page);
    return res.sendStatus(204);
  }

  const kilapiMatch = text.match(/^\/kilapi(?:\s+(\d+))?$/i);
  if (kilapiMatch) {
    const page = parseInt(kilapiMatch[1] || '1', 10);
    await handleKilapi(ctx, page);
    return res.sendStatus(204);
  }

  const pagoMatch = text.match(/^\/pago\s+(.+)/i);
  if (pagoMatch) {
    const name = pagoMatch[1].trim();
    await handlePago(ctx, name);
    return res.sendStatus(204);
  }

  if (text === "/stats") {
    await handleStats(ctx);
    return res.sendStatus(204);
  }

  if (text === "ajuda" || text === "/ajuda" || text === "comandos" || text === "/comandos") {
    await handleAjuda(ctx);
    return res.sendStatus(204);
  }

  if (text === "privacidade" || text === "/privacidade") {
    await handlePrivacidade(ctx);
    return res.sendStatus(204);
  }

  if (text === "termos" || text === "/termos") {
    await handleTermos(ctx);
    return res.sendStatus(204);
  }

  if (text === "meusdados" || text === "/meusdados") {
    await handleMeusdados(ctx);
    return res.sendStatus(204);
  }

  if (text === "apagar" || text === "/apagar") {
    await handleApagar(ctx);
    return res.sendStatus(204);
  }

  if (text === "desfazer" || text === "/desfazer") {
    await handleDesfazer(ctx);
    return res.sendStatus(204);
  }

  if (text === "resumo" || text === "/resumo") {
    await handleResumo(ctx);
    return res.sendStatus(204);
  }

  if (text === "mes" || text === "/mes") {
    await handleMes(ctx);
    return res.sendStatus(204);
  }

  // --- Session state dispatch ---
  switch (session.state) {

  case SessionState.AWAITING_CONFIRMATION:
    await handleAwaitingConfirmation(ctx);
    return res.sendStatus(204);

  case SessionState.AWAITING_DEBT_CONFIRMATION:
    await handleAwaitingDebtConfirmation(ctx);
    return res.sendStatus(204);

  case SessionState.AWAITING_PAGO_CONFIRM:
    await handleAwaitingPagoConfirm(ctx);
    return res.sendStatus(204);

  case SessionState.AWAITING_DEBTOR_NAME:
    await handleAwaitingDebtorName(ctx);
    return res.sendStatus(204);

  case SessionState.AWAITING_APAGAR_CONFIRM:
    await handleAwaitingApagarConfirm(ctx);
    return res.sendStatus(204);

  case SessionState.AWAITING_DESFAZER_CONFIRM:
    await handleAwaitingDesfazerConfirm(ctx);
    return res.sendStatus(204);

  case SessionState.IDLE:
  default:
    // Safety: catch unexpected state values and reset to IDLE
    if (session.state !== SessionState.IDLE) {
      console.warn(`[SESSION] Unexpected state ${session.state}, resetting to IDLE`);
      markSessionDirty(); sessions[sessionKey] = { state: SessionState.IDLE };
      await saveSessionIfDirty();
    }
    // Try debt parsing first, then transaction parsing
    const debtHandled = await handleDebtParse(ctx);
    if (!debtHandled) {
      await handleTransactionParse(ctx);
    }
    return res.sendStatus(204);
  }
  } finally {
    processingUsers.delete(userHash);
  }

}));

// Global error handler - catches unhandled errors from async route handlers
app.use((err, req, res, next) => {
  console.error(`[ERROR] Unhandled error on ${req.method} ${req.path}:`, err.message);
  if (!res.headersSent) {
    res.status(500).send('Internal Server Error');
  }
});

// --- Bind HTTP port BEFORE MongoDB (Railway kills containers that don't bind quickly)
const server = app.listen(process.env.PORT || 3000);
console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);

// --- MongoDB connection (after port is bound — slow connects won't kill the container)
await connectWithRetry();

db = mongo.db();
transactions = db.collection("transactions");
debts = db.collection("debts");
events = db.collection("events");
rateLimits = db.collection("rate_limits");

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

// --- Database indexes
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

// Auto-delete stale data_deletion_started records after 7 days (crash recovery markers)
try {
  await events.createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: 7 * 24 * 60 * 60, partialFilterExpression: { event_name: 'data_deletion_started' } }
  );
} catch (err) { if (err.code !== 86) throw err; }

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

// Detect MongoDB transaction support (requires replica set)
try {
  const adminDb = mongo.db('admin');
  const serverInfo = await adminDb.command({ isMaster: 1 });
  transactionsSupported = !!(serverInfo.setName);
  if (transactionsSupported) {
    console.log('[DB] MongoDB replica set detected — transactions enabled');
  } else {
    console.warn('[DB] MongoDB standalone detected — transactions disabled, /apagar will use sequential deletion');
  }
} catch (err) {
  console.warn('[DB] Could not detect MongoDB transaction support:', err.message);
}

// --- All startup complete — server is now ready to handle requests
serverReady = true;
console.log('Server ready — all startup complete');

// Proactive OpenAI health check (only in server mode, not during tests)
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

// Prevent unhandled rejections and exceptions from crashing the process silently
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  // unhandledRejection: log and continue. These are typically from background operations
  // (health checks, reconnects) where losing the process is worse than logging the error.
  // Route-level rejections are caught by asyncHandler.
});
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error);
  // Per Node.js docs: process state is undefined after uncaughtException.
  // Always exit gracefully to prevent data corruption and undefined behavior.
  // Railway/container runtime will restart the process.
  gracefulShutdown();
});

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

export { COMMANDS, MAX_WHATSAPP_CHARS, handleHoje, handleQuemedeve, handleQuemdevo, handleKilapi, handlePago, handleStats, handleAjuda, handlePrivacidade, handleTermos, handleMeusdados, handleApagar, handleDesfazer, handleResumo, handleMes, handleAwaitingConfirmation, handleAwaitingDebtConfirmation, handleAwaitingPagoConfirm, handleAwaitingDebtorName, handleAwaitingApagarConfirm, handleAwaitingDesfazerConfirm, handleDebtParse, handleTransactionParse } from './lib/commands.js';