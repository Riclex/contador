import crypto from 'crypto';
import { hashPhone, isValidWhatsAppPhone, RESERVED_DEBT_NAMES } from './security.js';

// --- Referral status lifecycle ---
// pending   → user referred someone, not yet active
// activated → the referred person gave consent (first_use)
// earned    → the referred person logged >= REFERRAL_EARN_TRANSACTIONS transactions
// paid      → the outreach person delivered the data/airtime credit
export const REFERRAL_STATUS = Object.freeze({
  PENDING: 'pending',
  ACTIVATED: 'activated',
  EARNED: 'earned',
  PAID: 'paid',
});

// Anti-abuse: a referrer may have at most this many open (pending/activated) referrals.
export const MAX_PENDING_REFERRALS = 10;
// A referral only earns credit after the referred person logs this many transactions.
export const REFERRAL_EARN_TRANSACTIONS = 3;

// Normalize a user-typed phone to the canonical whatsapp:+244... form, or null if invalid.
// Requires the full Angola mobile format (244 + 9 digits = 12 total) so the stored hash
// matches a real webhook `from`. Rejecting shorter digit strings stops junk like
// "2449123456" from squatting the unique referred_hash slot with an unactivatable hash.
export function normalizeReferralPhone(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (!/^244\d{9}$/.test(digits)) return null;
  const phone = `whatsapp:+${digits}`;
  return isValidWhatsAppPhone(phone) ? phone : null;
}

// Extract the first phone-like token from free text (e.g. "Maria +244912345678").
// Allows spaces/dashes between digit groups (e.g. "244 912 345 678") so spaced
// numbers reach normalizeReferralPhone, which strips non-digits. The match is then
// de-spaced so the caller gets clean digits.
export function extractPhoneFromText(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\+?\d(?:[\s-]*\d){6,14}/);
  return m ? m[0].replace(/[\s-]/g, '') : null;
}

// Validate a referred person's name: letters/accented chars/spaces only, ≤50 chars,
// and not a reserved confirmation word (so "sim"/"nao" can't be stored as a name).
export function isValidReferralName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 50) return false;
  if (!/^[a-zA-ZÀ-ÿ\s]+$/.test(trimmed)) return false;
  if (RESERVED_DEBT_NAMES.has(trimmed.toLowerCase())) return false;
  return true;
}

// Create a referral record. Returns { ok: true, referredHash } or { ok: false, reason }.
// NOTE: only the referred person's HASH is stored — never the raw phone. The raw phone is
// used solely to compute the hash and is then discarded, per PRIVACY.md pseudonymization.
export async function createReferral(referrals, { referrerHash, referredPhone, name }) {
  const referredHash = hashPhone(referredPhone);
  if (referredHash === referrerHash) {
    return { ok: false, reason: 'self' };
  }
  // Anti-abuse cap. The count-then-insert is not atomic, but the webhook's per-user
  // `processingUsers` lock serializes concurrent requests from the same referrer, so
  // this cannot race in production (single-process deployment). The unique referred_hash
  // index independently blocks duplicate referrals of the same phone.
  const openCount = await referrals.countDocuments({
    referrer_hash: referrerHash,
    status: { $in: [REFERRAL_STATUS.PENDING, REFERRAL_STATUS.ACTIVATED] }
  });
  if (openCount >= MAX_PENDING_REFERRALS) {
    return { ok: false, reason: 'limit' };
  }
  try {
    await referrals.insertOne({
      referrer_hash: referrerHash,
      referred_hash: referredHash,
      name: String(name || '').substring(0, 50),
      status: REFERRAL_STATUS.PENDING,
      created_at: new Date(),
      activated_at: null,
      earned_at: null,
      paid_at: null
    });
    return { ok: true, referredHash };
  } catch (err) {
    if (err.code === 11000) return { ok: false, reason: 'duplicate' };
    throw err;
  }
}

// Mark a referral activated when the referred person first gives consent.
// Returns true if a pending referral was flipped.
export async function activateReferral(referrals, referredHash) {
  const res = await referrals.updateOne(
    { referred_hash: referredHash, status: REFERRAL_STATUS.PENDING },
    { $set: { status: REFERRAL_STATUS.ACTIVATED, activated_at: new Date() } }
  );
  return res.modifiedCount > 0;
}

// Mark a referral earned once the referred person reaches the transaction threshold.
// Matches both PENDING and ACTIVATED so that referring an already-onboarded user
// (who never re-enters the consent flow) can still earn once they transact.
// Returns true if a referral was flipped to earned.
export async function maybeEarnReferral(referrals, referredHash, transactionCount) {
  if (transactionCount < REFERRAL_EARN_TRANSACTIONS) return false;
  const res = await referrals.updateOne(
    { referred_hash: referredHash, status: { $in: [REFERRAL_STATUS.PENDING, REFERRAL_STATUS.ACTIVATED] } },
    { $set: { status: REFERRAL_STATUS.EARNED, earned_at: new Date() } }
  );
  return res.modifiedCount > 0;
}

// Scrub a referred person's identifying data from their referral record while preserving
// the referrer's credit state (status/earned_at/paid_at). Used by /apagar so the referred
// person's own deletion doesn't erase the referrer's earned credit. The referred_hash is
// rewritten to a random sentinel (not nulled, and not derived from the original hash) so
// the identifying data is fully removed and a re-referral + re-delete can't collide on the
// unique index. updateOne is sufficient: the unique referred_hash index guarantees at most
// one match.
export async function scrubReferredPerson(referrals, referredHash, options = {}) {
  const res = await referrals.updateOne(
    { referred_hash: referredHash },
    { $set: { referred_hash: `deleted:${crypto.randomUUID()}`, name: null } },
    options
  );
  return res.modifiedCount;
}

// Global counts + recent referrals (for the admin /referidos view).
export async function getAllReferralStats(referrals) {
  const [pending, activated, earned, paid, recent] = await Promise.all([
    referrals.countDocuments({ status: REFERRAL_STATUS.PENDING }),
    referrals.countDocuments({ status: REFERRAL_STATUS.ACTIVATED }),
    referrals.countDocuments({ status: REFERRAL_STATUS.EARNED }),
    referrals.countDocuments({ status: REFERRAL_STATUS.PAID }),
    referrals.find({}).sort({ created_at: -1 }).limit(10).toArray()
  ]);
  return { pending, activated, earned, paid, recent };
}

// Shared success reply for /indicar — kept here so the one-shot and two-step flows stay
// in sync and no placeholder link ever ships to a user.
export function referralSuccessMessage(name) {
  return `Obrigado! Quando ${name} começar a usar, ganhas saldo de dados. 📲\n\nPartilha o número do Contador com ${name} para começar.`;
}
