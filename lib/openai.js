import OpenAI from "openai";
import logger from './logger.js';
import { isOpenAICapReached, trackOpenAICall } from './cache.js';
import { getCachedResponse, setCachedResponse } from './cache.js';
import { sanitizeForPrompt, validateDebtResponse, validateTransactionResponse } from './security.js';
import { parseDebtRegex, parseTransactionRegex } from './parsers.js';

// --- OpenAI health tracking
let openaiHealthy = true;
let openaiConsecutiveFailures = 0;
const OPENAI_FAILURE_THRESHOLD = 3;

function isOpenaiHealthy() { return openaiHealthy; }

// --- Lazy OpenAI client initialization
let _openai = null;
function getClient() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const OPENAI_TIMEOUT_MS = 15000; // 15 second timeout

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
  // Test mode: return mock responses without calling OpenAI API
  if (process.env.NODE_ENV === 'test' && process.env.OPENAI_MOCK_RESPONSE === 'true') {
    const { MOCK_RESPONSES } = await import('../test/mocks/openai-mock.js');
    const normalizedInput = userPrompt.toLowerCase().trim();
    let mockResponse = MOCK_RESPONSES.get(normalizedInput);
    if (!mockResponse) {
      // Substring match — the prompt wraps user input (e.g., 'Extrai uma transacao...:\n"passei 3000"')
      for (const [key, value] of MOCK_RESPONSES) {
        if (normalizedInput.includes(key)) {
          mockResponse = value;
          break;
        }
      }
    }
    if (mockResponse) {
      logger.info('[OPENAI-MOCK] Returning mock response for test input');
      return JSON.parse(mockResponse);
    }
    // No mock match: simulate ambiguous to avoid real API calls
    return { error: 'ambiguous' };
  }

  // Safety valve: check daily OpenAI cost cap
  if (isOpenAICapReached()) {
    logger.warn('[OPENAI] Daily cost cap reached. Falling back to regex-only.');
    return { error: 'ambiguous' };
  }
  let timeoutId;
  const openaiPromise = getClient().chat.completions.create({
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
    openaiConsecutiveFailures = 0;
    openaiHealthy = true;
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    clearTimeout(timeoutId);
    openaiPromise.catch(() => {}); // Neutralize losing promise rejection
    openaiConsecutiveFailures++;
    if (openaiConsecutiveFailures >= OPENAI_FAILURE_THRESHOLD) {
      openaiHealthy = false;
    }
    logger.error(error, 'OpenAI API error');
    if (error.message === 'OpenAI timeout') return { error: 'service_unavailable' };
    if (error instanceof SyntaxError) return { error: 'ambiguous' };
    return { error: 'service_unavailable' };
  }
}

async function parseDebtOpenAI(text) {
  const result = await callOpenAI(
    DEBT_SYSTEM_PROMPT,
    `Extrai uma dívida desta frase:\n"${sanitizeForPrompt(text)}"`,
    { temperature: 0 }
  );
  if (result.error) return result;
  const validated = validateDebtResponse(result);
  if (validated.error) {
    logger.error({ response: result }, '[OpenAI] Malformed debt response');
    return validated;
  }
  return validated;
}

async function parseDebt(text) {
  // Check cache first
  const cached = getCachedResponse(text, 'debt');
  if (cached) {
    logger.info('Cache hit for debt');
    return { ...cached, source: 'cache' };
  }

  // Try regex first (fast, free)
  const regexResult = parseDebtRegex(text);
  if (regexResult.error !== 'ambiguous') {
    setCachedResponse(text, 'debt', regexResult);
    return { ...regexResult, source: 'regex' };
  }

  // Fallback to OpenAI for ambiguous cases
  logger.info('Cache miss - calling OpenAI for debt');
  trackOpenAICall(false);
  const result = await parseDebtOpenAI(text);
  if (!result.error) {
    setCachedResponse(text, 'debt', result);
  }
  return { ...result, source: 'openai' };
}

async function parseTransaction(text) {
  // Check cache first
  const cached = getCachedResponse(text, 'transaction');
  if (cached) {
    logger.info('Cache hit for transaction');
    return { ...cached, source: 'cache' };
  }

  // Try regex first (fast, free)
  const regexResult = parseTransactionRegex(text);
  if (regexResult.error !== 'ambiguous') {
    setCachedResponse(text, 'transaction', regexResult);
    return { ...regexResult, source: 'regex' };
  }

  // Fallback to OpenAI for ambiguous cases
  logger.info('Cache miss - calling OpenAI for transaction');
  trackOpenAICall(false);
  const result = await callOpenAI(
    TRANSACTION_SYSTEM_PROMPT,
    `Extrai uma transação financeira desta frase:\n"${sanitizeForPrompt(text)}"`,
    { temperature: 0 }
  );
  if (result.error) return { ...result, source: 'openai' };
  const validated = validateTransactionResponse(result);
  if (validated.error) {
    logger.error({ response: result }, '[OpenAI] Malformed transaction response');
    return { ...validated, source: 'openai' };
  }
  setCachedResponse(text, 'transaction', validated);
  return { ...validated, source: 'openai' };
}

// --- Proactive OpenAI health check
function startOpenaiHealthCheck() {
  const OPENAI_HEALTH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const OPENAI_HEALTH_TIMEOUT_MS = 5000; // 5 second timeout
  const timer = setInterval(async () => {
    try {
      await Promise.race([
        getClient().models.list().next(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), OPENAI_HEALTH_TIMEOUT_MS))
      ]);
      openaiHealthy = true;
    } catch (err) {
      openaiHealthy = false;
      logger.warn(err, '[OPENAI-HEALTH] Check failed');
    }
  }, OPENAI_HEALTH_INTERVAL_MS);
  timer.unref(); // Don't prevent process exit
  return timer;
}

export {
  parseDebt,
  parseTransaction,
  isOpenaiHealthy,
  startOpenaiHealthCheck
};
