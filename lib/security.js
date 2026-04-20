import crypto from 'crypto';

// --- Angola timezone helper (WAT = UTC+1, no DST) ---
const ANGOLA_OFFSET_MS = 60 * 60 * 1000; // UTC+1

function getAngolaMidnightUTC(date = new Date()) {
  // Compute the UTC timestamp that corresponds to midnight in Angola
  const angolaTime = new Date(date.getTime() + ANGOLA_OFFSET_MS);
  return new Date(Date.UTC(
    angolaTime.getUTCFullYear(), angolaTime.getUTCMonth(), angolaTime.getUTCDate(), 0, 0, 0
  ) - ANGOLA_OFFSET_MS);
}

// --- Input Sanitization ---
function sanitizeInput(text) {
  if (typeof text !== 'string') {
    return '';
  }
  // Remove all control characters (ASCII + Unicode) and zero-width/format characters
  return text.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g, '');
}

// --- Phone Number Validation (prevent NoSQL injection) ---
function isValidWhatsAppPhone(phone) {
  // Must match format: whatsapp:+[country code][number]
  return /^whatsapp:\+\d{7,15}$/.test(phone);
}

// --- Phone Number Hashing (for privacy-compliant event storage) ---
function hashPhone(phone) {
  // 32 hex chars = 128 bits. Birthday paradox collision at ~2^64 unique inputs.
  // Safe for any practical scale.
  return crypto.createHash('sha256').update(phone).digest('hex').substring(0, 32);
}

// --- Maximum transaction/debt amount (1 billion Kz) ---
const MAX_AMOUNT = 1_000_000_000;

// --- Confirmation Keyword Detection (Angolan Portuguese) ---
const AFFIRMATIVE_WORDS = new Set([
  'sim', 's', 'si', 'ya', 'ep', 'isso', 'claro', 'confirmo', 'yes', 'ok'
]);

const NEGATIVE_WORDS = new Set([
  'nao', 'não', 'n', 'na', 'nop', 'cancela', 'cancelar', 'no'
]);

function isAffirmative(text) {
  return AFFIRMATIVE_WORDS.has(text.toLowerCase().trim());
}

function isNegative(text) {
  return NEGATIVE_WORDS.has(text.toLowerCase().trim());
}

function isConfirmationWord(text) {
  return isAffirmative(text) || isNegative(text);
}

// --- Angolan Kwanza formatting (space thousands, comma decimal) ---
function formatKz(amount) {
  if (!Number.isFinite(amount)) return '0,00';
  const fixed = Math.abs(amount).toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const sign = amount < 0 ? '-' : '';
  return `${sign}${formatted},${decPart}`;
}

// --- Sanitize user input before embedding in OpenAI prompt (prevent injection, limit length) ---
const MAX_OPENAI_INPUT_LENGTH = 500;
function sanitizeForPrompt(text) {
  let sanitized = text.length > MAX_OPENAI_INPUT_LENGTH ? text.substring(0, MAX_OPENAI_INPUT_LENGTH) : text;
  sanitized = sanitized.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
  // Strip common prompt injection patterns (case-insensitive, defense-in-depth)
  sanitized = sanitized.replace(/ignore\s+(?:previous|all|above|prior|earlier)\s*(?:instructions?|prompts?|rules?|commands?)/gi, '[filtered]');
  sanitized = sanitized.replace(/forget\s+(?:everything|all|previous|prior|above)/gi, '[filtered]');
  sanitized = sanitized.replace(/disregard\s+(?:the\s+)?(?:above|previous|prior|earlier|all)/gi, '[filtered]');
  sanitized = sanitized.replace(/new\s+instructions?\s*:/gi, '[filtered]');
  sanitized = sanitized.replace(/(?:system|assistant|user)\s*:\s*/gi, '[filtered]');
  sanitized = sanitized.replace(/(?:act\s+as|pretend\s+(?:to\s+be|you're))\s+(?:a|an|the)\s+(?:admin|system|root|developer|sudo)/gi, '[filtered]');
  return sanitized;
}

// --- OpenAI Response Validation (prevent hallucinated/extra fields from reaching MongoDB) ---
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_NAME_LENGTH = 50;

function validateTransactionResponse(result) {
  if (!result || typeof result !== 'object') return { error: 'ambiguous' };
  if (result.error) return result; // pass through error responses
  // Must have type (income/expense) and amount (positive finite number)
  if (result.type !== 'income' && result.type !== 'expense') return { error: 'ambiguous' };
  if (typeof result.amount !== 'number' || !Number.isFinite(result.amount) || result.amount <= 0 || result.amount > MAX_AMOUNT) return { error: 'ambiguous' };
  // Description must be a string, capped length
  if (result.description !== undefined && result.description !== null) {
    if (typeof result.description !== 'string') return { error: 'ambiguous' };
    result.description = result.description.substring(0, MAX_DESCRIPTION_LENGTH).trim();
  }
  // Remove any extra fields not expected in a transaction
  return { type: result.type, amount: result.amount, description: result.description || '' };
}

function validateDebtResponse(result) {
  if (!result || typeof result !== 'object') return { error: 'ambiguous' };
  if (result.error) return result;
  if (result.type !== 'recebido' && result.type !== 'devido') return { error: 'ambiguous' };
  if (typeof result.amount !== 'number' || !Number.isFinite(result.amount) || result.amount <= 0 || result.amount > MAX_AMOUNT) return { error: 'ambiguous' };
  // Creditor and debtor must be non-empty strings, capped length
  if (typeof result.creditor !== 'string' || result.creditor.trim().length === 0) return { error: 'ambiguous' };
  if (typeof result.debtor !== 'string' || result.debtor.trim().length === 0) return { error: 'ambiguous' };
  result.creditor = result.creditor.substring(0, MAX_NAME_LENGTH).trim();
  result.debtor = result.debtor.substring(0, MAX_NAME_LENGTH).trim();
  // Description must be a string, capped length
  if (result.description !== undefined && result.description !== null) {
    if (typeof result.description !== 'string') return { error: 'ambiguous' };
    result.description = result.description.substring(0, MAX_DESCRIPTION_LENGTH).trim();
  }
  // Remove any extra fields not expected in a debt
  return { type: result.type, creditor: result.creditor, debtor: result.debtor, amount: result.amount, description: result.description || '' };
}

// --- Session and Onboarding State Enums (prevent typos creating dead-end states) ---
const SessionState = Object.freeze({
  IDLE: 'IDLE',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  AWAITING_DEBT_CONFIRMATION: 'AWAITING_DEBT_CONFIRMATION',
  AWAITING_DEBTOR_NAME: 'AWAITING_DEBTOR_NAME',
  AWAITING_PAGO_CONFIRM: 'AWAITING_PAGO_CONFIRM',
  AWAITING_APAGAR_CONFIRM: 'AWAITING_APAGAR_CONFIRM',
  AWAITING_DESFAZER_CONFIRM: 'AWAITING_DESFAZER_CONFIRM',
});

const OnboardingState = Object.freeze({
  AWAITING_CONSENT: 'awaiting_consent',
  COMPLETED: 'completed',
});

// --- Debt Name Validation (applied consistently to OpenAI, regex, and user-provided names) ---
const RESERVED_DEBT_NAMES = new Set([
  'sim', 's', 'si', 'ya', 'ep', 'isso', 'claro', 'confirmo',
  'nao', 'não', 'n', 'na', 'nop', 'cancela', 'cancelar', 'ok'
]);

function isValidDebtName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 30) return false;
  if (!/^[a-zA-Z\u00C0-\u00FF\s]+$/.test(trimmed)) return false;
  if (RESERVED_DEBT_NAMES.has(trimmed.toLowerCase())) return false;
  return true;
}

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
  isValidDebtName,
  validateTransactionResponse,
  validateDebtResponse,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH
};