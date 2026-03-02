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
  // Debug: log the exact data being signed (first 200 chars)
  console.log(`[DEBUG:${reqId}] Signing data (first 200 chars): ${urlAndParams.substring(0, 200)}...`);
  console.log(`[DEBUG:${reqId}] Param keys:`, sortedKeys.slice(0, 10));
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

  // Extract description - try multiple patterns
  let description = '';

  // Pattern: "para X" (for transfers: "transferi 200000 para Hugo")
  const paraMatch = normalized.match(/para\s+([\w\u00C0-\u00FF]+)/iu);
  if (paraMatch) {
    description = normalized.includes('minha conta') ? 'transferência para conta' : `transferência para ${paraMatch[1]}`;
  } else {
    // Pattern: "de/do/da X" (existing logic)
    const descMatch = normalized.match(/(?:de|do|da)\s+(.+?)(?:\b|$)/);
    description = descMatch ? descMatch[1].trim() : '';
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

  // Pattern 3: "Eu devo 1500 ao Maria" - User owes someone (name after 'ao' or 'a')
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

// Admin phone numbers for /stats command - loaded from env with fallback
const ADMIN_NUMBERS = process.env.ADMIN_NUMBERS
  ? process.env.ADMIN_NUMBERS.split(',').map(s => s.trim())
  : [
      "whatsapp:+244912756717",
      "whatsapp:+351936123127"
    ];

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

function getCacheStats() {
  const total = cacheHits + cacheMisses;
  const hitRate = total > 0 ? ((cacheHits / total) * 100).toFixed(1) : 0;
  return {
    size: responseCache.size,
    hits: cacheHits,
    misses: cacheMisses,
    hitRate: `${hitRate}%`
  };
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
  console.log(`[WEBHOOK:${reqId}] Received request, rawBody length:`, req.rawBody?.length);
  console.log(`[WEBHOOK:${reqId}] rawBody preview:`, req.rawBody?.substring(0, 300));
  console.log(`[WEBHOOK:${reqId}] parsed Body:`, req.body?.Body);

  const twilioSignature = req.headers['x-twilio-signature'];
  if (twilioSignature && process.env.TWILIO_AUTH_TOKEN) {
    // Support Railway/reverse proxy forwarded headers
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const port = req.headers['x-forwarded-port'];

    // Debug headers
    console.log('[DEBUG] Headers:', {
      'x-forwarded-proto': req.headers['x-forwarded-proto'],
      'x-forwarded-host': req.headers['x-forwarded-host'],
      'x-forwarded-port': req.headers['x-forwarded-port'],
      'host': req.get('host'),
      'protocol': req.protocol,
    });

    // Build host with port if present (Twilio might include it in the signature)
    const hostWithPort = port && port !== '80' && port !== '443' ? `${host}:${port}` : host;

    // Try multiple URL variations (Twilio might sign with different combinations)
    const urls = [
      `${protocol}://${host}/webhook`,
      `${protocol}://${host}/webhook/`,
      `${protocol}://${hostWithPort}/webhook`,
      `${protocol}://${hostWithPort}/webhook/`,
    ];

    let isValid = false;
    let computedSignatures = [];
    for (const url of urls) {
      const computed = computeWebhookSignature(url, req.rawBody, reqId);
      computedSignatures.push(`${url} => ${computed?.substring(0, 20)}...`);
      if (computed === twilioSignature) {
        isValid = true;
        console.log('✓ Signature valid for URL:', url);
        break;
      }
    }

    if (!isValid) {
      console.error(`[WEBHOOK:${reqId}] Invalid webhook signature from:`, req.ip);
      console.error(`[WEBHOOK:${reqId}] Expected:`, twilioSignature);
      console.error(`[WEBHOOK:${reqId}] Computed:`, computedSignatures.join(' | '));
      console.error(`[WEBHOOK:${reqId}] Raw body:`, req.rawBody);
      return res.status(401).send('Invalid signature');
    }
  }

  const from = req.body.From;
  const rawText = req.body.Body || "";
  // Input sanitization
  const text = normalize(sanitizeInput(rawText));
  const messageSid = req.body.MessageSid;

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

  // Command: /stats - Admin only cache statistics
  if (text === "/stats" && isAdmin(from)) {
    const stats = getCacheStats();
    await reply(from, `📊 Cache Stats:\n• Size: ${stats.size} entries\n• Hits: ${stats.hits}\n• Misses: ${stats.misses}\n• Hit rate: ${stats.hitRate}`);
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
      await reply(from, "Dívida registada.");
    } catch (e) {
      if (e.code !== 11000) throw e;
      await reply(from, "Dívida registada.");
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

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
