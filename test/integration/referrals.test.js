import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, clearCollections } from '../helpers/setup.js';
import { createTestContext } from '../helpers/context-factory.js';
import { handleIndicar, handleReferidos } from '../../lib/handlers/commands.js';
import { handleAwaitingReferralName, handleAwaitingReferralPhone, handleAwaitingConfirmation, handleAwaitingApagarConfirm } from '../../lib/handlers/session.js';
import { SessionState, hashPhone } from '../../lib/security.js';
import { createReferral, activateReferral, maybeEarnReferral, REFERRAL_STATUS } from '../../lib/referrals.js';

const REFERRER_PHONE = 'whatsapp:+244912345678';
const REFERRER_HASH = hashPhone(REFERRER_PHONE);
const REFERRED_PHONE = 'whatsapp:+244987654321';
const REFERRED_HASH = hashPhone(REFERRED_PHONE);

let db, referrals, transactions, debts, events, rateLimits;

describe('Referral Integration Tests', () => {
  beforeEach(async () => {
    const setup = await startMongo();
    db = setup.db;
    referrals = db.collection('referrals');
    transactions = db.collection('transactions');
    debts = db.collection('debts');
    events = db.collection('events');
    rateLimits = db.collection('rate_limits');
  });

  afterEach(async () => {
    await clearCollections();
    await stopMongo();
  });

  it('/indicar with name + phone creates a pending referral', async () => {
    const { ctx, messages, events: logged } = createTestContext({ referrals, transactions, debts, events, rateLimits, db });
    ctx.text = '/indicar Maria 244987654321';

    await handleIndicar(ctx);

    const doc = await referrals.findOne({ referred_hash: REFERRED_HASH });
    assert.ok(doc, 'referral record created');
    assert.equal(doc.status, REFERRAL_STATUS.PENDING);
    assert.equal(doc.referrer_hash, REFERRER_HASH);
    assert.equal(doc.name, 'Maria');
    assert.ok(messages.some(m => m.body.includes('Obrigado')));
    assert.ok(logged.some(e => e.eventName === 'referral_created'));
    // The referred person's name is PII — it must not leak into the audit event.
    const created = logged.find(e => e.eventName === 'referral_created');
    assert.equal(created.metadata.name, undefined, 'name must not be logged');
  });

  it('/indicar with no args starts the two-step flow (prompts for name)', async () => {
    const { ctx, messages } = createTestContext({ referrals, transactions, debts, events, rateLimits, db });
    ctx.text = '/indicar';

    await handleIndicar(ctx);

    assert.equal(ctx.sessions.get(ctx.sessionKey).state, SessionState.AWAITING_REFERRAL_NAME);
    assert.ok(messages.some(m => m.body.includes('nome')));
  });

  it('two-step flow: name then phone creates a pending referral', async () => {
    const { ctx, messages } = createTestContext({ referrals, transactions, debts, events, rateLimits, db });

    // Step 1: name
    ctx.text = 'Maria';
    ctx.session = { state: SessionState.AWAITING_REFERRAL_NAME };
    ctx.sessions.set(ctx.sessionKey, ctx.session);
    await handleAwaitingReferralName(ctx);
    assert.equal(ctx.sessions.get(ctx.sessionKey).state, SessionState.AWAITING_REFERRAL_PHONE);

    // Step 2: phone
    ctx.session = ctx.sessions.get(ctx.sessionKey);
    ctx.text = '244987654321';
    await handleAwaitingReferralPhone(ctx);

    const doc = await referrals.findOne({ referred_hash: REFERRED_HASH });
    assert.ok(doc, 'referral record created');
    assert.equal(doc.status, REFERRAL_STATUS.PENDING);
    assert.equal(doc.name, 'Maria');
    assert.equal(ctx.sessions.get(ctx.sessionKey).state, SessionState.IDLE);
    assert.ok(messages.some(m => m.body.includes('Obrigado')));
  });

  it('rejects self-referral', async () => {
    const { ctx, messages } = createTestContext({ referrals, transactions, debts, events, rateLimits, db });
    ctx.text = `/indicar Eu ${REFERRER_PHONE.replace('whatsapp:+', '')}`;

    await handleIndicar(ctx);

    const count = await referrals.countDocuments({});
    assert.equal(count, 0, 'no referral stored');
    assert.ok(messages.some(m => m.body.includes('ti mesmo')));
  });

  it('rejects duplicate referral of the same phone', async () => {
    await createReferral(referrals, { referrerHash: REFERRER_HASH, referredPhone: REFERRED_PHONE, name: 'Maria' });

    const { ctx, messages } = createTestContext({ referrals, transactions, debts, events, rateLimits, db });
    ctx.text = '/indicar Maria 244987654321';
    await handleIndicar(ctx);

    const count = await referrals.countDocuments({});
    assert.equal(count, 1, 'only one referral for the same phone');
    assert.ok(messages.some(m => m.body.includes('já foi indicada')));
  });

  it('rejects phone without Angola country code', async () => {
    const { ctx } = createTestContext({ referrals, transactions, debts, events, rateLimits, db });
    ctx.text = '/indicar Maria 987654321';

    await handleIndicar(ctx);

    const count = await referrals.countDocuments({});
    assert.equal(count, 0, 'no referral stored for invalid phone');
    assert.equal(ctx.sessions.get(ctx.sessionKey).state, SessionState.AWAITING_REFERRAL_PHONE, 'prompts for a valid phone');
  });

  it('/indicar with only an invalid phone prompts for the name (not a dead-end)', async () => {
    const { ctx, messages } = createTestContext({ referrals, transactions, debts, events, rateLimits, db });
    ctx.text = '/indicar 987654321'; // invalid phone, no name

    await handleIndicar(ctx);

    // Must start from the name step, not carry an empty name into the phone step
    // (which would later surface as a confusing "Erro interno").
    assert.equal(ctx.sessions.get(ctx.sessionKey).state, SessionState.AWAITING_REFERRAL_NAME);
    assert.ok(messages.some(m => m.body.includes('nome')));
  });

  it('activateReferral flips pending → activated on first_use', async () => {
    await createReferral(referrals, { referrerHash: REFERRER_HASH, referredPhone: REFERRED_PHONE, name: 'Maria' });

    const flipped = await activateReferral(referrals, REFERRED_HASH);

    assert.equal(flipped, true);
    const doc = await referrals.findOne({ referred_hash: REFERRED_HASH });
    assert.equal(doc.status, REFERRAL_STATUS.ACTIVATED);
    assert.ok(doc.activated_at);
  });

  it('maybeEarnReferral flips activated → earned at the transaction threshold', async () => {
    await createReferral(referrals, { referrerHash: REFERRER_HASH, referredPhone: REFERRED_PHONE, name: 'Maria' });
    await activateReferral(referrals, REFERRED_HASH);

    // Below threshold: no change
    const below = await maybeEarnReferral(referrals, REFERRED_HASH, 2);
    assert.equal(below, false);
    assert.equal((await referrals.findOne({ referred_hash: REFERRED_HASH })).status, REFERRAL_STATUS.ACTIVATED);

    // At threshold: earned
    const at = await maybeEarnReferral(referrals, REFERRED_HASH, 3);
    assert.equal(at, true);
    const doc = await referrals.findOne({ referred_hash: REFERRED_HASH });
    assert.equal(doc.status, REFERRAL_STATUS.EARNED);
    assert.ok(doc.earned_at);
  });

  it('confirming a transaction triggers maybeEarnReferral via the session handler', async () => {
    await createReferral(referrals, { referrerHash: REFERRER_HASH, referredPhone: REFERRED_PHONE, name: 'Maria' });
    await activateReferral(referrals, REFERRED_HASH);

    // Simulate the referred user confirming 3 transactions
    const { ctx } = createTestContext({ referrals, transactions, debts, events, rateLimits, db });
    ctx.userHash = REFERRED_HASH;
    for (let i = 0; i < 3; i++) {
      ctx.messageSid = `SM_ref_earn_${i}`; // unique SID per insert (unique message_sid index)
      ctx.session = { state: SessionState.AWAITING_CONFIRMATION, pending: { type: 'income', amount: 1000, description: 'pao' } };
      ctx.sessions.set(ctx.sessionKey, ctx.session);
      ctx.text = 'sim';
      await handleAwaitingConfirmation(ctx);
    }

    const doc = await referrals.findOne({ referred_hash: REFERRED_HASH });
    assert.equal(doc.status, REFERRAL_STATUS.EARNED, 'referral earned after 3 confirmed transactions');
  });

  it('referring an already-onboarded user still earns (PENDING → EARNED without consent)', async () => {
    // Existing-user dead-end: a referral created for someone who already completed
    // onboarding never re-enters the consent flow, so activateReferral never fires.
    // The fix lets maybeEarnReferral match PENDING directly, so the next confirmed
    // transaction (counted from all history) flips it to EARNED.
    await createReferral(referrals, { referrerHash: REFERRER_HASH, referredPhone: REFERRED_PHONE, name: 'Maria' });
    assert.equal((await referrals.findOne({ referred_hash: REFERRED_HASH })).status, REFERRAL_STATUS.PENDING);

    // Referred user (already onboarded) confirms a transaction; they have 2 prior
    // transactions in history, so this confirmation brings the count to 3.
    await transactions.insertMany([
      { user_hash: REFERRED_HASH, type: 'income', amount: 1000, description: 'a', date: new Date(), message_sid: 'SM_prior_1' },
      { user_hash: REFERRED_HASH, type: 'income', amount: 1000, description: 'b', date: new Date(), message_sid: 'SM_prior_2' }
    ]);

    const { ctx } = createTestContext({ referrals, transactions, debts, events, rateLimits, db });
    ctx.userHash = REFERRED_HASH;
    ctx.messageSid = 'SM_ref_existing_1';
    ctx.session = { state: SessionState.AWAITING_CONFIRMATION, pending: { type: 'income', amount: 1000, description: 'pao' } };
    ctx.sessions.set(ctx.sessionKey, ctx.session);
    ctx.text = 'sim';
    await handleAwaitingConfirmation(ctx);

    const doc = await referrals.findOne({ referred_hash: REFERRED_HASH });
    assert.equal(doc.status, REFERRAL_STATUS.EARNED, 'referral of an existing user earns without consent');
  });

  it('storing a referral never persists the referred phone in plaintext', async () => {
    await createReferral(referrals, { referrerHash: REFERRER_HASH, referredPhone: REFERRED_PHONE, name: 'Maria' });
    const doc = await referrals.findOne({ referred_hash: REFERRED_HASH });
    assert.equal(doc.referred_phone, undefined, 'raw referred_phone must not be stored');
    assert.ok(doc.referred_hash, 'referred_hash is stored for matching');
  });

  it('/apagar scrubs the referred person’s data but preserves the referrer’s record', async () => {
    await createReferral(referrals, { referrerHash: REFERRER_HASH, referredPhone: REFERRED_PHONE, name: 'Maria' });
    assert.equal(await referrals.countDocuments({ referred_hash: REFERRED_HASH }), 1);

    // transactionsSupported:false → sequential (non-transaction) branch, no mongoClient needed.
    const { ctx } = createTestContext({ referrals, transactions, debts, events, rateLimits, db, transactionsSupported: false });
    ctx.userHash = REFERRED_HASH;
    ctx.from = REFERRED_PHONE;
    ctx.session = { state: SessionState.AWAITING_APAGAR_CONFIRM };
    ctx.sessions.set(ctx.sessionKey, ctx.session);
    ctx.text = 'sim';
    await handleAwaitingApagarConfirm(ctx);

    // The referred person's identifying data is gone...
    assert.equal(await referrals.countDocuments({ referred_hash: REFERRED_HASH }), 0,
      'referred person’s real hash must be removed');
    // ...but the referrer's record (and credit state) survives, with the hash scrubbed.
    const doc = await referrals.findOne({ referrer_hash: REFERRER_HASH });
    assert.ok(doc, 'referrer’s record is preserved so their earned credit is not lost');
    assert.ok(doc.referred_hash.startsWith('deleted:'), 'referred hash is scrubbed to a sentinel');
    assert.notEqual(doc.referred_hash, REFERRED_HASH, 'original hash must not be retained in the sentinel');
    assert.equal(doc.name, null);
    assert.equal(doc.status, REFERRAL_STATUS.PENDING);
  });

  it('/referidos is admin-only', async () => {
    const { ctx, messages } = createTestContext({ referrals, transactions, debts, events, rateLimits, db });
    // Non-empty admin list that excludes the current user → "reservado" branch
    ctx.adminNumbers = ['whatsapp:+351999999999'];
    ctx.text = '/referidos';
    await handleReferidos(ctx);
    assert.ok(messages.some(m => m.body.includes('reservado para administradores')));
  });

  it('/referidos shows referral counts for admins', async () => {
    await createReferral(referrals, { referrerHash: REFERRER_HASH, referredPhone: REFERRED_PHONE, name: 'Maria' });

    const { ctx, messages } = createTestContext({ referrals, transactions, debts, events, rateLimits, db });
    ctx.adminNumbers = [REFERRER_PHONE];
    ctx.from = REFERRER_PHONE;
    ctx.text = '/referidos';
    await handleReferidos(ctx);

    const body = messages[messages.length - 1].body;
    assert.ok(body.includes('Pendentes: 1'));
    assert.ok(body.includes('Maria'));
  });
});
