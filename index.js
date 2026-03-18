import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import { MongoClient } from "mongodb";
import crypto from "crypto";
import OpenAI from "openai";
import twilio from "twilio";

// --- Regex-based transaction parser constants
const INCOME_VERBS = ['vendi', 'recebi', 'ganhei', 'paiei', 'biolo', 'fezada'];
const EXPENSE_VERBS = ['comprei', 'gastei', 'paguei', 'gasto', 'pagamento', 'emprestei', 'transferi', 'enviei'];

// Safe regex for amount extraction (no catastrophic backtracking)
const AMOUNT_REGEX = /(\d[\d\s]*?)\s*(?:kz|paus)?$/i;

// --- Webhook Signature Verification
function computeWebhookSignature(url, rawBody, reqId = 'none') {
  if (!process.env.TWILIO_AUTH_TOKEN) return null;

  // Parse raw body WITHOUT decoding - Twilio signs the exact URL-encoded string
  const params = {};
  for (const pair of (rawBody || '').split('&')) {
    const [key, ...valueParts] = pair.split('=');
    if (key) {
      params[key] = valueParts.join('='); // Keep value exactly as-is
    }
  }

  // Sort keys alphabetically
  const sortedKeys = Object.keys(params).sort();

  // Build signature string: url + key1value1 + key2value2 + ...
  // Handle empty/undefined values (e.g., "key=" or "key" with no =)
  let sortedParams = '';
  for (const key of sortedKeys) {
    sortedParams += `${key}${params[key] || ''}`;
  }

  const urlAndParams = url + sortedParams;
  return crypto
    .createHmac('sha256', process.env.TWILIO_AUTH_TOKEN)
    .update(urlAndParams)
    .digest('base64');
}

function verifyWebhookSignature(signature, url, rawBody) {
  if (!signature || !process.env.TWILIO_AUTH_TOKEN) {
    return false;
  }
  return signature === computeWebhookSignature(url, rawBody);
}

// --- Rate Limiting
const MAX_MESSAGES_PER_USER_PER_DAY = 50;
const rateLimitStore = new Map();

// --- Stats Cache (5 minute TTL)
const STATS_CACHE_TTL_MS = 5 * 60 * 1000;
let statsCache = {
  data: null,
  timestamp: 0
};

async function getDailyMetrics() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // New users (first_use events today)
  const newUsers = await events.countDocuments({
    event_name: 'first_use',
    timestamp: { $gte: today, $lt: tomorrow }
  });

  // Active users (unique users with events today)
  const activeUsersAgg = await events.aggregate([
    { $match: { timestamp: { $gte: today, $lt: tomorrow } } },
    { $group: { _id: '$user_hash' } },
    { $count: 'count' }
  ]).toArray();
  const activeUsers = activeUsersAgg[0]?.count || 0;

  // Total messages (message_sent events today)
  const totalMessages = await events.countDocuments({
    event_name: 'message_sent',
    timestamp: { $gte: today, $lt: tomorrow }
  });

  // Confirmed transactions today
  const confirmedTransactions = await events.countDocuments({
    event_name: 'transaction_confirmed',
    timestamp: { $gte: today, $lt: tomorrow }
  });

  // Debts created today
  const debtsCreated = await events.countDocuments({
    event_name: 'debt_created',
    timestamp: { $gte: today, $lt: tomorrow }
  });

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
    Promise.resolve(getCacheStats())
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

function checkRateLimit(userPhone) {
  const today = new Date().toDateString();
  const key = `${userPhone}:${today}`;
  const record = rateLimitStore.get(key) || { count: 0, resetTime: new Date(today).setDate(new Date().getDate() + 1) };

  if (record.count >= MAX_MESSAGES_PER_USER_PER_DAY) {
    return { allowed: false, remaining: 0, resetTime: record.resetTime };
  }

  record.count++;
  rateLimitStore.set(key, record);

  return { allowed: true, remaining: MAX_MESSAGES_PER_USER_PER_DAY - record.count, resetTime: record.resetTime };
}

// Clean up old rate limit entries
setInterval(() => {
  const now = new Date();
  for (const [key, record] of rateLimitStore.entries()) {
    if (now.getTime() > record.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Check every minute

// --- Input Sanitization
function sanitizeInput(text) {
  if (typeof text !== 'string') {
    return '';
  }
  // Remove control characters except newline and tab
  return text.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F]/g, '');
}

function parseTransactionRegex(text) {
  const normalized = text.toLowerCase().trim();

  // Detect type by verbs
  let type = null;

  for (const verb of INCOME_VERBS) {
    if (normalized.includes(verb)) {
      type = 'income';
      break;
    }
  }

  // Special case: "enviei para a minha conta" = income (money coming into user's account)
  if (normalized.includes('enviei') && normalized.includes('minha conta')) {
    type = 'income';
  }

  if (!type) {
    for (const verb of EXPENSE_VERBS) {
      if (normalized.includes(verb)) {
        type = 'expense';
        break;
      }
    }
  }

  if (!type) return { error: 'ambiguous' };

  // Extract amount (number, optionally followed by Kz or paus)
  // Pattern: digits with optional spaces, optionally followed by Kz/paus
  // Use non-greedy match that stops before a word boundary followed by letters
  const amountMatch = normalized.match(/(\d+(?:[\s]\d+)*)\s*(?:kz|paus)?/i);
  let amount = null;
  if (amountMatch) {
    amount = parseInt(amountMatch[1].replace(/[\s]/g, ''), 10);
  }

  if (!amount || isNaN(amount) || amount <= 0) return { error: 'ambiguous' };

  // Extract description - try multiple patterns in order
  let description = '';

  // Pattern 1: "para X" (for transfers: "transferi 200000 para Hugo")
  const paraMatch = normalized.match(/para\s+([\w\u00C0-\u00FF]+)/iu);
  if (paraMatch) {
    description = normalized.includes('minha conta') ? 'transferência para conta' : `transferência para ${paraMatch[1]}`;
  } else {
    // Pattern 2: "de/do/da X" (e.g., "vendi 1000 de fuba")
    const descMatch = normalized.match(/(?:de|do|da)\s+(.+?)(?:\b|$)/);
    if (descMatch) {
      description = descMatch[1].trim();
    } else {
      // Pattern 3: "em X" (e.g., "gastei 1000 em compras", "recebi 500 em dinheiro")
      const emMatch = normalized.match(/em\s+(.+?)(?:\b|$)/);
      if (emMatch) {
        description = emMatch[1].trim();
      } else {
        // Pattern 4: "com X" (e.g., "gastei 1000 com farinha")
        const comMatch = normalized.match(/com\s+([a-zA-Z\u00C0-\u00FF][\w\u00C0-\u00FF\s]*)(?:\s|$)/);
        if (comMatch) {
          description = comMatch[1].trim();
        } else {
          // Pattern 5: direct noun after amount (e.g., "gastei 3000 farinha")
          const directMatch = normalized.match(/\d+\s*(?:kz|paus)?\s+([a-zA-Z\u00C0-\u00FF][\w\u00C0-\u00FF\s]*)$/i);
          if (directMatch) {
            description = directMatch[1].trim();
          }
        }
      }
    }
  }

  return { type, amount, description };
}

// --- Regex-based debt parser constants
const DEBT_VERBS_RECEBIDO = ['me deve', 'me deve', 'deve-me'];
const DEBT_VERBS_DEVIDO = ['eu devo', 'devo', 'emprestei a'];

function parseDebtRegex(text) {
  const normalized = text.toLowerCase().trim();

  // Pattern 1: "O João me deve 2000kz" or "João me deve 2000kz" - Someone owes user
  const pattern1 = /(?:o\s+)?([\w\u00C0-\u00FF]+)\s+me\s+deve\s+(\d+)\s*(kz)?/iu;
  const match1 = normalized.match(pattern1);
  if (match1) {
    return {
      type: "recebido",
      creditor: "user",
      debtor: match1[1],
      amount: parseInt(match1[2]),
      description: `O ${match1[1]} me deve`
    };
  }

  // Pattern 2: "Me deve 2000 ao João" - Someone owes user (name after 'ao' or 'a')
  const pattern2 = /me\s+deve\s+(\d+)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match2 = normalized.match(pattern2);
  if (match2) {
    return {
      type: "recebido",
      creditor: "user",
      debtor: match2[3],
      amount: parseInt(match2[1]),
      description: `Me deve ${match2[1]}`
    };
  }

  // Pattern 3: "Eu devo 1500 a Maria" - User owes someone (name after 'ao' or 'a')
  const pattern3 = /eu\s+devo\s+(\d+)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match3 = normalized.match(pattern3);
  if (match3) {
    return {
      type: "devido",
      creditor: match3[3],
      debtor: "user",
      amount: parseInt(match3[1]),
      description: `Eu devo ${match3[1]}`
    };
  }

  // Pattern 4: "Devo 1500 a Maria" - User owes someone (name after 'ao' or 'a')
  const pattern4 = /devo\s+(\d+)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match4 = normalized.match(pattern4);
  if (match4) {
    return {
      type: "devido",
      creditor: match4[3],
      debtor: "user",
      amount: parseInt(match4[1]),
      description: `Devo ${match4[1]}`
    };
  }

  // Pattern 5: "Emprestei 500 ao João" - User lent money (expects return)
  const pattern5 = /emprestei\s+(\d+)\s*(kz)?\s+(?:a|ao)\s+([\w\u00C0-\u00FF]+)/iu;
  const match5 = normalized.match(pattern5);
  if (match5) {
    return {
      type: "recebido",
      creditor: "user",
      debtor: match5[3],
      amount: parseInt(match5[1]),
      description: `Emprestei ${match5[1]}`
    };
  }

  return { error: 'ambiguous' };
}

const MAX_PROCESSED_MESSAGES = 10000;
const processedMessages = new Set();

// --- Response Cache
const CACHE_SIZE = 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const responseCache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

// Admin phone numbers for /stats command - REQUIRED environment variable
// Format: ADMIN_NUMBERS=whatsapp:+244912756717,whatsapp:+351936123127
const ADMIN_NUMBERS = process.env.ADMIN_NUMBERS
  ? process.env.ADMIN_NUMBERS.split(',').map(s => s.trim())
  : [];

// Validate ADMIN_NUMBERS is set at startup
if (ADMIN_NUMBERS.length === 0) {
  console.error('[FATAL] ADMIN_NUMBERS environment variable is required');
  process.exit(1);
}

function isAdmin(phone) {
  return ADMIN_NUMBERS.includes(phone);
}

function getCacheKey(text, type) {
  return `${type}:${text.toLowerCase().trim()}`;
}

function getCachedResponse(text, type) {
  const key = getCacheKey(text, type);
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    cacheHits++;
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

const app = express();

// body-parser with raw body capture for Twilio signature verification
app.use(bodyParser.urlencoded({
  extended: false,
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// --- Environment Validation
const requiredEnvVars = ["MONGODB_URI", "OPENAI_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];
const missing = requiredEnvVars.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
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
  console.error("Failed to connect to MongoDB after max retries");
  process.exit(1);
}

await connectWithRetry();

// Monitor connection health
mongo.on('close', () => {
  mongoConnected = false;
  console.warn('MongoDB connection closed. Attempting reconnection...');
  connectWithRetry();
});

const db = mongo.db();
const transactions = db.collection("transactions");
const debts = db.collection("debts");
const events = db.collection("events");

// --- Event Tracking System
events.createIndex({ event_name: 1, timestamp: -1 });
events.createIndex({ user_hash: 1, timestamp: -1 });

async function logEvent(eventName, userPhone, metadata = {}) {
  try {
    // Create hash of phone for privacy
    const userHash = crypto.createHash('sha256').update(userPhone).digest('hex').substring(0, 16);

    const eventDoc = {
      event_name: eventName,
      user_hash: userHash,
      user_phone: userPhone, // Keep raw for internal use, could be removed for stricter privacy
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
      ...metadata
    }));
  } catch (err) {
    // Fail silently - don't break user experience if logging fails
    console.error('Event logging error:', err.message);
  }
}

// --- User Onboarding
const ONBOARDING_STATE_KEY = 'onboarding_state';

async function isNewUser(userPhone) {
  // Check if user has any previous transactions or events
  const userEvents = await events.findOne({ user_phone: userPhone });
  return !userEvents;
}

async function hasGivenConsent(userPhone) {
  const userEvents = await events.findOne({
    user_phone: userPhone,
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
  await db.collection('onboarding').updateOne(
    { user_phone: userPhone },
    { $set: { state, updated_at: new Date() } },
    { upsert: true }
  );
}

async function getOnboardingState(userPhone) {
  const doc = await db.collection('onboarding').findOne({ user_phone: userPhone });
  return doc?.state || 'completed';
}

// Create indexes on debts collection
await debts.createIndex({ user_phone: 1, settled: 1 });
await debts.createIndex({ user_phone: 1, creditor: 1, debtor: 1 });
try {
  await debts.createIndex({ message_sid: 1 }, { unique: true });
} catch (err) {
  // Index already exists (IndexKeySpecsConflict code: 86)
  if (err.code !== 86) throw err;
}

// Create indexes on transactions collection
await transactions.createIndex({ user_phone: 1, date: -1 });
try {
  await transactions.createIndex({ message_sid: 1 }, { unique: true });
} catch (err) {
  // Index already exists (IndexKeySpecsConflict code: 86)
  if (err.code !== 86) throw err;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function parseDebtOpenAI(text) {
  try {
    const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a strict debt tracking message parser. \
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
          "
      },
      {
        role: "user",
        content: `Extrai uma dívida desta frase:\n"${text}"`
      }
    ]
  });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error('OpenAI debt parsing error:', error.message);
    return { error: 'service_unavailable', message: 'Failed to parse debt' };
  }
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
  setCachedResponse(text, 'debt', result);
  return result;
}

// --- Session Management (MongoDB-based persistence)
// State types: IDLE, AWAITING_CONFIRMATION, AWAITING_DEBT_CONFIRMATION, AWAITING_DEBTOR_NAME
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function getSession(phone) {
  if (!mongoConnected) return null;

  const doc = await db.collection('sessions').findOne({ phone });
  if (!doc) return null;

  // Check if session has expired
  if (Date.now() - doc.updatedAt > SESSION_TTL_MS) {
    await db.collection('sessions').deleteOne({ phone });
    return null;
  }

  // Update last activity time
  await db.collection('sessions').updateOne(
    { phone },
    { $set: { updatedAt: new Date() } }
  );

  return doc;
}

async function setSession(phone, sessionData) {
  if (!mongoConnected) {
    // Fallback to in-memory if MongoDB is not connected
    sessions[phone] = { ...sessionData, updatedAt: Date.now() };
    return;
  }

  await db.collection('sessions').updateOne(
    { phone },
    { $set: { ...sessionData, phone, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function deleteSession(phone) {
  if (!mongoConnected) {
    delete sessions[phone];
    return;
  }

  await db.collection('sessions').deleteOne({ phone });
}

// Keep in-memory fallback for speed
const sessions = {};

// --- Helpers
function normalize(text) {
  return text.toLowerCase().trim();
}

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
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a strict financial message parser. \
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
            - No explanatations. \
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
            "
        },
        {
          role: "user",
          content: `Extrai uma transação financeira desta frase:\n"${text}"`
        }
      ]
    });

    const result = JSON.parse(response.choices[0].message.content);
    setCachedResponse(text, 'transaction', result);
    return result;
  } catch (error) {
    console.error('OpenAI API error in parseTransaction:', error.message);
    return { error: 'service_unavailable', message: 'Failed to parse transaction' };
  }
}

const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";

async function reply(to, body) {
  await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_NUMBER,
    to,
    body
  });
}

// --- Routes
app.post("/webhook", async (req, res) => {
  // Webhook Signature Verification (Sprint 9 - Security)
  // Generate request ID for tracking logs
  const reqId = Math.random().toString(36).substring(2, 8);
  req.reqId = reqId;
  // Signature verification logged below - no raw body logging (privacy)

  const twilioSignature = req.headers['x-twilio-signature'];
  if (twilioSignature && process.env.TWILIO_AUTH_TOKEN) {
    // Support Railway/reverse proxy forwarded headers
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const url = `${protocol}://${host}/webhook`;

    // Use Twilio's official validateRequest function
    const isValid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      twilioSignature,
      url,
      req.body  // Parsed body object
    );

    if (!isValid) {
      console.error(`[WEBHOOK:${reqId}] Invalid webhook signature from:`, req.ip);
      console.error(`[WEBHOOK:${reqId}] Expected:`, twilioSignature);
      console.error(`[WEBHOOK:${reqId}] URL:`, url);
      return res.status(401).send('Invalid signature');
    }

    console.log(`[WEBHOOK:${reqId}] Signature verified successfully`);
  }

  const from = req.body.From;
  const rawText = req.body.Body || "";
  // Input sanitization
  const text = normalize(sanitizeInput(rawText));
  const messageSid = req.body.MessageSid;

  // Log message_sent event
  await logEvent('message_sent', from, { message_length: rawText.length, message_type: 'unknown' });

  // Check if this is a new user
  const userIsNew = await isNewUser(from);
  if (userIsNew) {
    await logEvent('first_use', from, { source: 'whatsapp' });
    await setOnboardingState(from, 'awaiting_consent');
    await sendWelcomeMessage(from);
    return res.sendStatus(204);
  }

  // Check onboarding state
  const onboardingState = await getOnboardingState(from);
  if (onboardingState === 'awaiting_consent') {
    if (text === 'sim') {
      await logEvent('consent_given', from, {});
      await setOnboardingState(from, 'completed');
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

  // Rate limiting (Sprint 9)
  const rateLimit = checkRateLimit(from);
  if (!rateLimit.allowed) {
    await reply(from, `Limite diário de mensagens atingido. Tente novamente amanhã.`);
    return res.sendStatus(204);
  }

  // Retry protection
  if (!messageSid) {
    return res.sendStatus(204);
  }

  if (processedMessages.has(messageSid)) {
    return res.sendStatus(204);
  }

  processedMessages.add(messageSid);

  if (processedMessages.size > MAX_PROCESSED_MESSAGES) {
    const iterator = processedMessages.values();
    const first = iterator.next().value;
    processedMessages.delete(first);
  }

  // Load session from MongoDB
  let session = sessions[from];
  if (!session) {
    const mongoSession = await getSession(from);
    session = mongoSession || { state: "IDLE" };
    sessions[from] = session;
  }

  // Save session to MongoDB immediately after load
  await setSession(from, session);

  // Command: hoje
  if (text === "hoje") {
    await logEvent('command_used', from, { command: 'hoje' });

    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const docs = await transactions.find({
      user_phone: from,
      date: { $gte: start }
    }).toArray();

    let total = 0;

    for (const t of docs) {
      const amount = Number(t.amount);

      if (!Number.isFinite(amount)) continue;

      if (t.type === "income") {
        total += amount;
      } else if (t.type === "expense") {
        total -= amount;
      }
    }

    await reply(from, `Total de hoje: ${total} Kz`);
    return res.sendStatus(204);
  }

  // Command: /quemedeve - Who owes user
  if (text === "/quemedeve") {
    await logEvent('command_used', from, { command: 'quemedeve' });
    const docs = await debts.find({
      user_phone: from,
      type: "recebido",
      settled: { $ne: true }
    }).toArray();

    if (docs.length === 0) {
      await reply(from, "Ninguém te deve dinheiro.");
      return res.sendStatus(204);
    }

    let message = "Quem te deve dinheiro:\n";
    for (const d of docs) {
      message += `- ${d.debtor}: ${d.amount} Kz\n`;
    }
    await reply(from, message);
    return res.sendStatus(204);
  }

  // Command: /quemdevo - Who user owes
  if (text === "/quemdevo") {
    await logEvent('command_used', from, { command: 'quemdevo' });
    const docs = await debts.find({
      user_phone: from,
      type: "devido",
      settled: { $ne: true }
    }).toArray();

    if (docs.length === 0) {
      await reply(from, "Tu não deves dinheiro a ninguém.");
      return res.sendStatus(204);
    }

    let message = "Tu deves dinheiro a:\n";
    for (const d of docs) {
      message += `- ${d.creditor}: ${d.amount} Kz\n`;
    }
    await reply(from, message);
    return res.sendStatus(204);
  }

  // Command: /kilapi - All debts
  if (text === "/kilapi") {
    await logEvent('command_used', from, { command: 'kilapi' });
    const docs = await debts.find({
      user_phone: from,
      settled: { $ne: true }
    }).toArray();

    if (docs.length === 0) {
      await reply(from, "Não tens dívidas ativas.");
      return res.sendStatus(204);
    }

    let message = "Dívidas ativas:\n";
    for (const d of docs) {
      if (d.type === "recebido") {
        message += `- ${d.debtor} te deve: ${d.amount} Kz\n`;
      } else {
        message += `- Tu deves a ${d.creditor}: ${d.amount} Kz\n`;
      }
    }
    await reply(from, message);
    return res.sendStatus(204);
  }

  // Command: /pago - Mark debt as paid
  const pagoMatch = text.match(/^\/pago\s+(.+)/i);
  if (pagoMatch) {
    await logEvent('command_used', from, { command: 'pago' });
    const name = pagoMatch[1].trim();
    // Escape special regex characters to prevent ReDoS attacks
    const sanitizedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const doc = await debts.findOne({
      user_phone: from,
      settled: { $ne: true },
      $or: [
        { creditor: { $regex: new RegExp(sanitizedName, "i") } },
        { debtor: { $regex: new RegExp(sanitizedName, "i") } }
      ]
    });

    if (!doc) {
      await reply(from, "Não encontrei esta dívida. Use /dividas para ver as dívidas ativas.");
      return res.sendStatus(204);
    }

    await debts.updateOne(
      { _id: doc._id },
      { $set: { settled: true, settled_date: new Date() } }
    );

    if (doc.type === "recebido") {
      await reply(from, `Dívida de ${doc.debtor} (que te deve ${doc.amount} Kz) marcada como paga.`);
    } else {
      await reply(from, `Dívida a ${doc.creditor} (que tu deves ${doc.amount} Kz) marcada como paga.`);
    }
    return res.sendStatus(204);
  }

  // Command: /stats - Admin only statistics
  if (text === "/stats" && isAdmin(from)) {
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
• "vendi 1000 de pão"
• "comprei 500 kz de saldo"
• "João me deve 2000"
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

Política completa: https://riclex.github.io/contador/docs/PRIVACY.html`;
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

Termos completos: https://riclex.github.io/contador/docs/TERMS.html`;
    await reply(from, termosMessage);
    return res.sendStatus(204);
  }

  // Command: meusdados - Show user data (Lei 22/11 right to access)
  if (text === "meusdados" || text === "/meusdados") {
    await logEvent('command_used', from, { command: 'meusdados' });

    // Get all user data
    const userTransactions = await transactions.find({ user_phone: from }).toArray();
    const userDebts = await debts.find({ user_phone: from }).toArray();
    const userEvents = await events.find({ user_hash: from }).toArray();

    const totalIncome = userTransactions.filter(t => t.type === "income").reduce((sum, t) => sum + t.amount, 0);
    const totalExpenses = userTransactions.filter(t => t.type === "expense").reduce((sum, t) => sum + t.amount, 0);
    const activeDebts = userDebts.filter(d => !d.settled).length;

    const message = `📄 TEUS DADOS

👤 Usuário: ${from}

📊 RESUMO:
• Transações: ${userTransactions.length}
• Receitas: ${totalIncome.toFixed(2)} Kz
• Despesas: ${totalExpenses.toFixed(2)} Kz
• Saldo: ${(totalIncome - totalExpenses).toFixed(2)} Kz
• Dívidas ativas: ${activeDebts}

🔒 EVENTOS (auditoria):
• Total: ${userEvents.length}

Para apagar todos os teus dados: /apagar`;
    await reply(from, message);
    return res.sendStatus(204);
  }

  // Command: apagar - Delete all user data (Lei 22/11 right to be forgotten)
  if (text === "apagar" || text === "/apagar") {
    await logEvent('command_used', from, { command: 'apagar' });

    // Check if user has data to delete
    const userTransactions = await transactions.countDocuments({ user_phone: from });
    const userDebts = await debts.countDocuments({ user_phone: from });
    const userEvents = await events.countDocuments({ user_hash: from });

    if (userTransactions === 0 && userDebts === 0 && userEvents === 0) {
      await reply(from, "Não tens dados armazenados para apagar.");
      return res.sendStatus(204);
    }

    // Ask for confirmation
    sessions[from] = { state: "AWAITING_APAGAR_CONFIRM" };
    await setSession(from, sessions[from]);

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

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const docs = await transactions.find({
      user_phone: from,
      date: { $gte: sevenDaysAgo }
    }).toArray();

    if (docs.length === 0) {
      await reply(from, "Sem transações nos últimos 7 dias.");
      return res.sendStatus(204);
    }

    let income = 0;
    let expenses = 0;
    const dailyBreakdown = {};

    for (const doc of docs) {
      if (doc.type === "income") {
        income += doc.amount;
      } else {
        expenses += doc.amount;
      }

      // Group by day
      const day = new Date(doc.date).toLocaleDateString('pt-AO', { weekday: 'short', day: 'numeric' });
      if (!dailyBreakdown[day]) dailyBreakdown[day] = { income: 0, expenses: 0 };
      if (doc.type === "income") dailyBreakdown[day].income += doc.amount;
      else dailyBreakdown[day].expenses += doc.amount;
    }

    const balance = income - expenses;
    const days = Object.keys(dailyBreakdown);

    let message = `📊 Resumo (Últimos 7 dias)

💰 Entradas: ${income.toFixed(2)} Kz
💸 Saídas: ${expenses.toFixed(2)} Kz
📈 Saldo: ${balance.toFixed(2)} Kz

--- Por dia:`;

    for (const day of days) {
      const d = dailyBreakdown[day];
      const dayBalance = d.income - d.expenses;
      const signal = dayBalance >= 0 ? '+' : '';
      message += `\n${day}: ${signal}${dayBalance.toFixed(2)} Kz`;
    }

    await reply(from, message);
    return res.sendStatus(204);
  }

  // Command: mes - Monthly summary
  if (text === "mes" || text === "/mes") {
    await logEvent('command_used', from, { command: 'mes' });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const docs = await transactions.find({
      user_phone: from,
      date: { $gte: startOfMonth }
    }).toArray();

    if (docs.length === 0) {
      await reply(from, "Sem transações neste mês.");
      return res.sendStatus(204);
    }

    let income = 0;
    let expenses = 0;
    const categories = {};

    for (const doc of docs) {
      if (doc.type === "income") {
        income += doc.amount;
      } else {
        expenses += doc.amount;
      }

      // Extract category from description (first word after preposition)
      const descLower = doc.description.toLowerCase();
      let category = "Outros";
      for (const prep of ['de ', 'do ', 'da ', 'dos ', 'das ', 'em ']) {
        const idx = descLower.indexOf(prep);
        if (idx !== -1) {
          const start = idx + prep.length;
          const end = descLower.indexOf(' ', start);
          category = end !== -1 ? descLower.substring(start, end) : descLower.substring(start);
          // Capitalize first letter
          category = category.charAt(0).toUpperCase() + category.slice(1);
          break;
        }
      }

      if (!categories[category]) categories[category] = { income: 0, expenses: 0 };
      if (doc.type === "income") categories[category].income += doc.amount;
      else categories[category].expenses += doc.amount;
    }

    const balance = income - expenses;
    const monthName = now.toLocaleDateString('pt-AO', { month: 'long', year: 'numeric' });

    let message = `📊 ${monthName.charAt(0).toUpperCase() + monthName.slice(1)}

💰 Entradas: ${income.toFixed(2)} Kz
💸 Saídas: ${expenses.toFixed(2)} Kz
📈 Saldo: ${balance.toFixed(2)} Kz

--- Por categoria:`;

    for (const cat of Object.keys(categories).sort()) {
      const c = categories[cat];
      const catBalance = c.income - c.expenses;
      const signal = catBalance >= 0 ? '+' : '';
      message += `\n${cat}: ${signal}${catBalance.toFixed(2)} Kz`;
    }

    await reply(from, message);
    return res.sendStatus(204);
  }

  // Awaiting confirmation (regular transaction)
  if (session.state === "AWAITING_CONFIRMATION") {
    if (text === "sim") {
      try {
        await transactions.insertOne({
          message_sid: messageSid,
          user_phone: from,
          type: session.pending.type,
          amount: Number(session.pending.amount),
          description: session.pending.description,
          date: new Date()
        });
        await logEvent('transaction_confirmed', from, {
          amount: session.pending.amount,
          type: session.pending.type,
          description: session.pending.description
        });
      } catch (e) {
        if (e.code !== 11000) throw e;
      }
      await reply(from, "Registado.");
    } else {
      await reply(from, "Cancelado.");
    }
    sessions[from] = { state: "IDLE" };
    await setSession(from, sessions[from]);
    return res.sendStatus(204);
  }

  // Awaiting debt confirmation
  if (session.state === "AWAITING_DEBT_CONFIRMATION") {
    if (text === "sim") {
      try {
        await debts.insertOne({
          message_sid: messageSid,
          user_phone: from,
          type: session.pendingDebt.type,
          creditor: session.pendingDebt.creditor,
          debtor: session.pendingDebt.debtor,
          amount: session.pendingDebt.amount,
          description: session.pendingDebt.description,
          date: new Date(),
          settled: false,
          settled_date: null
        });
        await logEvent('debt_created', from, {
          amount: session.pendingDebt.amount,
          type: session.pendingDebt.type,
          debtor: session.pendingDebt.debtor,
          creditor: session.pendingDebt.creditor
        });
        await reply(from, "Dívida registada.");
      } catch (e) {
        if (e.code !== 11000) throw e;
        await reply(from, "Dívida registada.");
      }
    } else {
      await reply(from, "Cancelado.");
    }
    sessions[from] = { state: "IDLE" };
    await setSession(from, sessions[from]);
    return res.sendStatus(204);
  }

  // Handle Awaiting Debtor Name state (for regex parses where name was 'user')
  if (session.state === "AWAITING_DEBTOR_NAME") {
    const pendingDebt = session.pendingDebt;

    if (text === "nao" || text === "não") {
      await reply(from, "Cancelado.");
      sessions[from] = { state: "IDLE" };
      await setSession(from, sessions[from]);
      return res.sendStatus(204);
    }

    // Update the name based on debt type
    if (pendingDebt.type === "recebido" && pendingDebt.debtor === "user") {
      pendingDebt.debtor = text.trim();
    } else if (pendingDebt.type === "devido" && pendingDebt.creditor === "user") {
      pendingDebt.creditor = text.trim();
    }

    try {
      await debts.insertOne({
        message_sid: messageSid,
        user_phone: from,
        type: pendingDebt.type,
        creditor: pendingDebt.creditor,
        debtor: pendingDebt.debtor,
        amount: pendingDebt.amount,
        description: pendingDebt.description,
        date: new Date(),
        settled: false,
        settled_date: null
      });
      await logEvent('debt_created', from, {
        amount: pendingDebt.amount,
        type: pendingDebt.type,
        debtor: pendingDebt.debtor,
        creditor: pendingDebt.creditor
      });
      await reply(from, "Dívida registada.");
    } catch (e) {
      if (e.code !== 11000) throw e;
      await reply(from, "Dívida registada.");
    }
    sessions[from] = { state: "IDLE" };
    await setSession(from, sessions[from]);
    return res.sendStatus(204);
  }

  // Awaiting apagar confirmation (right to be forgotten)
  if (session.state === "AWAITING_APAGAR_CONFIRM") {
    if (text === "sim" || text === "yes") {
      // Delete all user data
      const deleteTrans = await transactions.deleteMany({ user_phone: from });
      const deleteDebts = await debts.deleteMany({ user_phone: from });
      const deleteEvents = await events.deleteMany({ user_hash: from });
      const deleteSession = await db.collection('sessions').deleteOne({ user_phone: from });
      const deleteOnboarding = await db.collection('onboarding').deleteOne({ user_phone: from });

      await logEvent('data_deleted', from, {
        transactions_deleted: deleteTrans.deletedCount,
        debts_deleted: deleteDebts.deletedCount,
        events_deleted: deleteEvents.deletedCount
      });

      await reply(from, "✅ Todos os teus dados foram apagados permanentemente.");
    } else {
      await reply(from, "Operação cancelada. Os teus dados permanecem armazenados.");
    }
    sessions[from] = { state: "IDLE" };
    await setSession(from, sessions[from]);
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
      typeof parsedDebt.creditor === "string" &&
      typeof parsedDebt.debtor === "string"
    ) {
      // Check if we need user input to fill in a name
      if (parsedDebt.creditor === "user" || parsedDebt.debtor === "user") {
        sessions[from] = {
          state: "AWAITING_DEBTOR_NAME",
          pendingDebt: {
            type: parsedDebt.type,
            creditor: parsedDebt.creditor,
            debtor: parsedDebt.debtor,
            amount: parsedDebt.amount,
            description: parsedDebt.description
          }
        };
        await setSession(from, sessions[from]);
        if (parsedDebt.type === "recebido") {
          await reply(from, "Quem te deve? Escreve o nome.");
        } else {
          await reply(from, "Tu deves a quem? Escreve o nome.");
        }
        return res.sendStatus(204);
      }

      // Full info available, ask for confirmation
      sessions[from] = {
        state: "AWAITING_DEBT_CONFIRMATION",
        pendingDebt: {
          type: parsedDebt.type,
          creditor: parsedDebt.creditor,
          debtor: parsedDebt.debtor,
          amount: parsedDebt.amount,
          description: parsedDebt.description
        }
      };
      await setSession(from, sessions[from]);

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

    sessions[from] = {
      state: "AWAITING_CONFIRMATION",
      pending: parsed
    };
    await setSession(from, sessions[from]);

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

});

app.get("/health", (_, res) => res.send("ok"));

app.listen(process.env.PORT || 3000);

// --- Graceful shutdown
let serverClosing = false;

async function gracefulShutdown() {
  if (serverClosing) return;
  serverClosing = true;
  console.log('Shutting down gracefully...');

  try {
    // Close MongoDB connection
    await mongo.close();
    console.log('MongoDB connection closed');
  } catch (err) {
    console.error('Error closing MongoDB:', err.message);
  }

  process.exit(0);
}

// --- Export functions for testing
export { parseTransactionRegex, parseDebtRegex };

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);