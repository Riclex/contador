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
  // Strip common prompt injection phrases (case-insensitive)
  sanitized = sanitized.replace(/ignore\s+previous\s+(instructions?|prompts?|rules?)/gi, '[filtered]');
  sanitized = sanitized.replace(/forget\s+(everything|all|previous)/gi, '[filtered]');
  sanitized = sanitized.replace(/new\s+instructions?\s*:/gi, '[filtered]');
  sanitized = sanitized.replace(/(?:system|assistant)\s*:\s*/gi, '[filtered]');
  return sanitized;
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
  formatKz
};