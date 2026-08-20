import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReferralPhone, extractPhoneFromText, isValidReferralName, REFERRAL_STATUS, MAX_PENDING_REFERRALS, REFERRAL_EARN_TRANSACTIONS } from '../lib/referrals.js';

describe('referrals helpers', () => {
  it('normalizes a valid Angola phone to whatsapp:+244...', () => {
    assert.equal(normalizeReferralPhone('244912345678'), 'whatsapp:+244912345678');
    assert.equal(normalizeReferralPhone('+244912345678'), 'whatsapp:+244912345678');
    assert.equal(normalizeReferralPhone('244 912 345 678'), 'whatsapp:+244912345678');
  });

  it('rejects phones without the Angola country code', () => {
    assert.equal(normalizeReferralPhone('912345678'), null);
    assert.equal(normalizeReferralPhone('+351912345678'), null);
  });

  it('rejects too-short and too-long digit strings even with the 244 prefix', () => {
    // 244 + 7 digits (10 total): too short to be a real Angolan mobile, but the old
    // 7-15-digit validator accepted it, creating an unactivatable referral that also
    // squat the unique referred_hash slot. Must be rejected.
    assert.equal(normalizeReferralPhone('2449123456'), null);
    // 244 + 10 digits (13 total): too long.
    assert.equal(normalizeReferralPhone('2449123456789'), null);
  });

  it('rejects non-phone input', () => {
    assert.equal(normalizeReferralPhone(''), null);
    assert.equal(normalizeReferralPhone('abc'), null);
    assert.equal(normalizeReferralPhone(null), null);
    assert.equal(normalizeReferralPhone(undefined), null);
  });

  it('extracts the first phone-like token from free text', () => {
    assert.equal(extractPhoneFromText('Maria 244912345678'), '244912345678');
    assert.equal(extractPhoneFromText('+244912345678'), '+244912345678');
    // Spaced digit groups are de-spaced so they reach normalizeReferralPhone.
    assert.equal(extractPhoneFromText('Maria 244 912 345 678'), '244912345678');
    assert.equal(extractPhoneFromText('sem numero'), null);
  });

  it('validates referral names (letters/accented/spaces only, ≤50, no reserved words)', () => {
    // A referred person's name is stored verbatim, so it must be a real name — not a
    // confirmation word ("sim"/"nao") that would be ambiguous in the flow, and not junk.
    assert.equal(isValidReferralName('Maria'), true);
    assert.equal(isValidReferralName('João Silva'), true);
    assert.equal(isValidReferralName('  Maria  '), true); // trimmed
    assert.equal(isValidReferralName(''), false);
    assert.equal(isValidReferralName('   '), false);
    assert.equal(isValidReferralName('Maria123'), false); // digits
    assert.equal(isValidReferralName('Maria!'), false); // punctuation
    assert.equal(isValidReferralName('sim'), false); // reserved confirmation word
    assert.equal(isValidReferralName('Sim'), false); // case-insensitive
    assert.equal(isValidReferralName('nao'), false);
    assert.equal(isValidReferralName('a'.repeat(51)), false); // >50 chars
    assert.equal(isValidReferralName('a'.repeat(50)), true); // exactly 50
    assert.equal(isValidReferralName(null), false);
  });

  it('exposes the expected constants', () => {
    assert.equal(REFERRAL_STATUS.PENDING, 'pending');
    assert.equal(REFERRAL_STATUS.ACTIVATED, 'activated');
    assert.equal(REFERRAL_STATUS.EARNED, 'earned');
    assert.equal(REFERRAL_STATUS.PAID, 'paid');
    assert.equal(MAX_PENDING_REFERRALS, 10);
    assert.equal(REFERRAL_EARN_TRANSACTIONS, 3);
  });
});
