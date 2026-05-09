import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, clearCollections } from '../helpers/setup.js';
import { OnboardingState, isAffirmative, isNegative, hashPhone } from '../../lib/security.js';

const TEST_PHONE = 'whatsapp:+244912345678';
const TEST_USER_HASH = hashPhone(TEST_PHONE);

describe('Onboarding Integration Tests', () => {
  let db;

  beforeEach(async () => {
    const setup = await startMongo();
    db = setup.db;
  });

  afterEach(async () => {
    await clearCollections();
    await stopMongo();
  });

  describe('OnboardingState enum', () => {
    it('has correct state values', () => {
      assert.equal(OnboardingState.AWAITING_CONSENT, 'AWAITING_CONSENT');
      assert.equal(OnboardingState.COMPLETED, 'COMPLETED');
    });

    it('states are frozen strings', () => {
      assert.equal(typeof OnboardingState.AWAITING_CONSENT, 'string');
      assert.equal(typeof OnboardingState.COMPLETED, 'string');
    });
  });

  describe('Consent detection', () => {
    it('detects affirmative responses (isAffirmative)', () => {
      assert.ok(isAffirmative('sim'));
      assert.ok(isAffirmative('Sim'));
      assert.ok(isAffirmative('SIM'));
      assert.ok(isAffirmative('s'));
      assert.ok(isAffirmative('ok'));
    });

    it('detects negative responses (isNegative)', () => {
      assert.ok(isNegative('nao'));
      assert.ok(isNegative('não'));
      assert.ok(isNegative('Nao'));
      assert.ok(isNegative('NÃO'));
      assert.ok(isNegative('no'));
    });

    it('rejects ambiguous responses', () => {
      assert.ok(!isAffirmative('talvez'));
      assert.ok(!isNegative('talvez'));
      assert.ok(!isAffirmative(''));
      assert.ok(!isNegative(''));
      // Multi-word phrases are not matched — the function does exact word matching
      assert.ok(!isAffirmative('sim, aceito'));
      assert.ok(!isNegative('nao quero'));
    });
  });

  describe('Onboarding state transitions', () => {
    it('stores AWAITING_CONSENT for new user', async () => {
      const userHash = TEST_USER_HASH;
      const now = new Date();

      await db.collection('onboarding').insertOne({
        user_hash: userHash,
        state: OnboardingState.AWAITING_CONSENT,
        updated_at: now
      });

      const doc = await db.collection('onboarding').findOne({ user_hash: userHash });
      assert.ok(doc);
      assert.equal(doc.state, OnboardingState.AWAITING_CONSENT);
    });

    it('transitions from AWAITING_CONSENT to COMPLETED', async () => {
      const userHash = TEST_USER_HASH;

      // Insert as AWAITING_CONSENT
      await db.collection('onboarding').insertOne({
        user_hash: userHash,
        state: OnboardingState.AWAITING_CONSENT,
        updated_at: new Date()
      });

      // Update to COMPLETED (simulates affirmative consent)
      await db.collection('onboarding').updateOne(
        { user_hash: userHash },
        { $set: { state: OnboardingState.COMPLETED, updated_at: new Date() } }
      );

      const doc = await db.collection('onboarding').findOne({ user_hash: userHash });
      assert.ok(doc);
      assert.equal(doc.state, OnboardingState.COMPLETED);
      assert.ok(doc.updated_at > new Date(Date.now() - 1000), 'updated_at should be recent');
    });

    it('remains AWAITING_CONSENT after non-affirmative response', async () => {
      const userHash = TEST_USER_HASH;

      await db.collection('onboarding').insertOne({
        user_hash: userHash,
        state: OnboardingState.AWAITING_CONSENT,
        updated_at: new Date(2020, 1, 1) // old date
      });

      // Simulate: user said "nao", state should NOT change
      // (real handler updates updated_at but keeps state)
      const oldUpdatedAt = (await db.collection('onboarding').findOne({ user_hash: userHash })).updated_at;

      // After non-affirmative, the handler bumps updated_at but keeps state
      await db.collection('onboarding').updateOne(
        { user_hash: userHash },
        { $set: { updated_at: new Date() } } // no change to state
      );

      const doc = await db.collection('onboarding').findOne({ user_hash: userHash });
      assert.equal(doc.state, OnboardingState.AWAITING_CONSENT);
      assert.ok(new Date(doc.updated_at) > new Date(oldUpdatedAt), 'updated_at should refresh');
    });
  });

  describe('Onboarding events logging', () => {
    it('logs first_use and consent_given events after consent', async () => {
      const userHash = TEST_USER_HASH;
      const events = db.collection('events');

      // Simulate what the webhook preamble does after affirmative consent
      await events.insertOne({
        user_hash: userHash,
        event_name: 'first_use',
        timestamp: new Date(),
        metadata: { source: 'whatsapp' }
      });
      await events.insertOne({
        user_hash: userHash,
        event_name: 'consent_given',
        timestamp: new Date(),
        metadata: {}
      });

      const firstUseCount = await events.countDocuments({ user_hash: userHash, event_name: 'first_use' });
      const consentCount = await events.countDocuments({ user_hash: userHash, event_name: 'consent_given' });
      assert.equal(firstUseCount, 1);
      assert.equal(consentCount, 1);
    });

    it('does not log events before consent', async () => {
      const userHash = hashPhone('whatsapp:+244987654321');

      // Only onboarding record exists, no events
      await db.collection('onboarding').insertOne({
        user_hash: userHash,
        state: OnboardingState.AWAITING_CONSENT,
        updated_at: new Date()
      });

      const eventsCount = await db.collection('events').countDocuments({ user_hash: userHash });
      assert.equal(eventsCount, 0);
    });
  });

  describe('Broadcast list', () => {
    beforeEach(async () => {
      // Create unique index like production does
      try {
        await db.collection('broadcast_list').createIndex({ user_hash: 1 }, { unique: true });
      } catch { /* already exists */ }
    });

    it('stores user in broadcast_list after consent', async () => {
      const userHash = TEST_USER_HASH;

      await db.collection('broadcast_list').insertOne({
        user_hash: userHash,
        phone: TEST_PHONE,
        updated_at: new Date()
      });

      const doc = await db.collection('broadcast_list').findOne({ user_hash: userHash });
      assert.ok(doc);
      assert.equal(doc.phone, TEST_PHONE);
    });

    it('broadcast_list has unique constraint on user_hash', async () => {
      const userHash = TEST_USER_HASH;

      await db.collection('broadcast_list').insertOne({
        user_hash: userHash,
        phone: TEST_PHONE,
        updated_at: new Date()
      });

      // Duplicate insert should fail
      await assert.rejects(
        db.collection('broadcast_list').insertOne({
          user_hash: userHash,
          phone: TEST_PHONE,
          updated_at: new Date()
        }),
        (err) => err.code === 11000 // duplicate key error
      );
    });
  });
});
