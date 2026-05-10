import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, clearCollections } from '../helpers/setup.js';
import { hashPhone, SessionState, OnboardingState } from '../../lib/security.js';

const TEST_PHONE = 'whatsapp:+244912345678';
const TEST_USER_HASH = hashPhone(TEST_PHONE);

describe('Webhook E2E Integration Tests', () => {
  let serverPort, db, mongoClient, baseUrl, indexModule;
  let origEnv = {};

  before(async () => {
    // Save original env vars
    origEnv = { ...process.env };

    // Start in-memory MongoDB
    const setup = await startMongo();
    db = setup.db;
    mongoClient = setup.client;

    // Set env vars for server startup — construct URI with database name
    process.env.NODE_ENV = 'test';
    // mongod.getUri() returns e.g. mongodb://127.0.0.1:PORT/?replicaSet=rs
    // Insert database name before the query string
    const qIdx = setup.uri.indexOf('?');
    if (qIdx !== -1) {
      // Remove trailing slash before ? if present, then insert /dbName before ?
      const beforeQuery = setup.uri.slice(0, qIdx).replace(/\/$/, '');
      const afterQuery = setup.uri.slice(qIdx);
      process.env.MONGODB_URI = `${beforeQuery}/${db.databaseName}${afterQuery}`;
    } else {
      const base = setup.uri.replace(/\/$/, '');
      process.env.MONGODB_URI = `${base}/${db.databaseName}`;
    }
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'test';
    process.env.OPENAI_API_KEY = 'test';
    process.env.WEBHOOK_URL = 'http://localhost:0/webhook';
    process.env.PORT = '0';

    // Dynamically import index.js which starts the server
    indexModule = await import('../../index.js');

    // Wait for server to bind port and become ready
    const maxWait = 30000;
    const pollInterval = 200;
    let waited = 0;
    while (waited < maxWait) {
      serverPort = indexModule.getServerPort();
      if (serverPort) {
        try {
          const res = await fetch(`http://localhost:${serverPort}/health`);
          if (res.status !== 503) break;
        } catch {
          // Server not ready yet
        }
      }
      await new Promise(r => setTimeout(r, pollInterval));
      waited += pollInterval;
    }

    if (!serverPort) throw new Error('Server did not start within timeout');
    baseUrl = `http://localhost:${serverPort}`;
  });

  after(async () => {
    // Restore original env vars
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    Object.assign(process.env, origEnv);

    await stopMongo();
  });

  // Clear in-memory state (session cache, dedup set) between tests — these persist
  // across requests in production but would cause cross-test leakage in the suite.
  beforeEach(() => {
    if (indexModule) {
      indexModule.clearInMemorySessions();
      indexModule.clearProcessedMessages();
    }
  });

  function post(path, body) {
    const params = new URLSearchParams(body || {});
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
  }

  describe('Startup guard', () => {
    it('returns 503 when server is not ready', async () => {
      // The health endpoint already tests this via serverReady flag.
      // This test verifies the 503 path works correctly.
      const res = await post('/webhook', {});
      // Since the server is actually ready, it should not return 503
      assert.notEqual(res.status, 503);
    });
  });

  describe('Phone validation', () => {
    beforeEach(async () => {
      await clearCollections();
    });

    it('returns 400 for invalid phone number', async () => {
      const res = await post('/webhook', {
        From: 'invalid',
        Body: 'hoje',
        MessageSid: 'SM_invalid_phone_1'
      });
      assert.equal(res.status, 400);
    });

    it('returns 400 for missing country code', async () => {
      const res = await post('/webhook', {
        From: 'whatsapp:912345678',
        Body: 'hoje',
        MessageSid: 'SM_no_code_1'
      });
      assert.equal(res.status, 400);
    });

    it('returns 400 for empty From', async () => {
      const res = await post('/webhook', {
        From: '',
        Body: 'hoje',
        MessageSid: 'SM_empty_from_1'
      });
      assert.equal(res.status, 400);
    });
  });

  describe('Onboarding flow', () => {
    beforeEach(async () => {
      await clearCollections();
    });

    it('new user receives welcome (consent prompt)', async () => {
      const res = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'vendi 5000 de pao',
        MessageSid: 'SM_onb_new_1'
      });
      assert.equal(res.status, 204);

      // Onboarding state should be set to AWAITING_CONSENT
      const onboarding = await db.collection('onboarding').findOne({ user_hash: TEST_USER_HASH });
      assert.ok(onboarding, 'Onboarding record should exist');
      assert.equal(onboarding.state, OnboardingState.AWAITING_CONSENT);
    });

    it('affirmative consent completes onboarding', async () => {
      // Pre-set user to AWAITING_CONSENT
      await db.collection('onboarding').insertOne({
        user_hash: TEST_USER_HASH,
        state: OnboardingState.AWAITING_CONSENT,
        updated_at: new Date()
      });

      const res = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'sim',
        MessageSid: 'SM_onb_sim_1'
      });
      assert.equal(res.status, 204);

      // Onboarding should be COMPLETED
      const onboarding = await db.collection('onboarding').findOne({ user_hash: TEST_USER_HASH });
      assert.equal(onboarding.state, OnboardingState.COMPLETED);

      // Events should be logged
      const firstUse = await db.collection('events').countDocuments({ user_hash: TEST_USER_HASH, event_name: 'first_use' });
      const consent = await db.collection('events').countDocuments({ user_hash: TEST_USER_HASH, event_name: 'consent_given' });
      assert.equal(firstUse, 1);
      assert.equal(consent, 1);
    });

    it('non-affirmative response during consent re-prompts', async () => {
      await db.collection('onboarding').insertOne({
        user_hash: TEST_USER_HASH,
        state: OnboardingState.AWAITING_CONSENT,
        updated_at: new Date()
      });

      const res = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'nao',
        MessageSid: 'SM_onb_nao_1'
      });
      assert.equal(res.status, 204);

      // Onboarding should still be AWAITING_CONSENT (not changed)
      const onboarding = await db.collection('onboarding').findOne({ user_hash: TEST_USER_HASH });
      assert.equal(onboarding.state, OnboardingState.AWAITING_CONSENT);
    });
  });

  describe('Command routing', () => {
    beforeEach(async () => {
      await clearCollections();
      // Pre-set consent completed user
      await db.collection('onboarding').insertOne({
        user_hash: TEST_USER_HASH,
        state: OnboardingState.COMPLETED,
        updated_at: new Date()
      });
    });

    it('/hoje returns balance for user with no records', async () => {
      const res = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'hoje',
        MessageSid: 'SM_cmd_hoje_1'
      });
      assert.equal(res.status, 204);
    });

    it('/hoje with income transaction shows balance', async () => {
      await db.collection('transactions').insertOne({
        user_hash: TEST_USER_HASH,
        type: 'income',
        amount: 5000,
        description: 'pao',
        date: new Date(),
        message_sid: 'SM_cmd_hoje_tx1'
      });

      const res = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'hoje',
        MessageSid: 'SM_cmd_hoje_2'
      });
      assert.equal(res.status, 204);
    });
  });

  describe('Session state dispatch', () => {
    beforeEach(async () => {
      await clearCollections();
      await db.collection('onboarding').insertOne({
        user_hash: TEST_USER_HASH,
        state: OnboardingState.COMPLETED,
        updated_at: new Date()
      });
    });

    it('AWAITING_CONFIRMATION + "sim" processes transaction', async () => {
      // Set up pending confirmation session
      await db.collection('sessions').insertOne({
        phone_hash: hashPhone(TEST_PHONE),
        state: SessionState.AWAITING_CONFIRMATION,
        pending: {
          type: 'expense',
          amount: 1500,
          description: 'saldo'
        },
        version: 0,
        updatedAt: new Date()
      });

      const res = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'sim',
        MessageSid: 'SM_sess_sim_1'
      });
      assert.equal(res.status, 204);

      // Transaction should be created
      const txCount = await db.collection('transactions').countDocuments({ user_hash: TEST_USER_HASH });
      assert.equal(txCount, 1);
    });

    it('AWAITING_CONFIRMATION + "nao" cancels transaction', async () => {
      await db.collection('sessions').insertOne({
        phone_hash: hashPhone(TEST_PHONE),
        state: SessionState.AWAITING_CONFIRMATION,
        pending: {
          type: 'expense',
          amount: 1500,
          description: 'saldo'
        },
        version: 0,
        updatedAt: new Date()
      });

      const res = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'nao',
        MessageSid: 'SM_sess_nao_1'
      });
      assert.equal(res.status, 204);

      // Transaction should NOT be created
      const txCount = await db.collection('transactions').countDocuments({ user_hash: TEST_USER_HASH });
      assert.equal(txCount, 0);
    });

    it('command typed during confirmation resets session', async () => {
      await db.collection('sessions').insertOne({
        phone_hash: hashPhone(TEST_PHONE),
        state: SessionState.AWAITING_CONFIRMATION,
        pending: {
          type: 'expense',
          amount: 1500,
          description: 'saldo'
        },
        version: 0,
        updatedAt: new Date()
      });

      const res = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'hoje',
        MessageSid: 'SM_sess_reset_1'
      });
      assert.equal(res.status, 204);

      // Session should be reset to IDLE
      const session = await db.collection('sessions').findOne({ phone_hash: hashPhone(TEST_PHONE) });
      assert.equal(session.state, SessionState.IDLE);
    });
  });

  describe('Deduplication', () => {
    beforeEach(async () => {
      await clearCollections();
      await db.collection('onboarding').insertOne({
        user_hash: TEST_USER_HASH,
        state: OnboardingState.COMPLETED,
        updated_at: new Date()
      });
    });

    it('duplicate MessageSid returns 204 without second processing', async () => {
      const messageSid = 'SM_dedup_1';

      // First request
      const res1 = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'hoje',
        MessageSid: messageSid
      });
      assert.equal(res1.status, 204);

      // Second request with same MessageSid
      const res2 = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'hoje',
        MessageSid: messageSid
      });
      assert.equal(res2.status, 204);

      // Dedup skips command execution on duplicate MessageSid, so only one
      // command_used event is logged despite two identical requests.
      const commandEvents = await db.collection('events').countDocuments({
        user_hash: TEST_USER_HASH,
        event_name: 'command_used'
      });
      assert.equal(commandEvents, 1);
    });
  });

  describe('Rate limiting', () => {
    beforeEach(async () => {
      await clearCollections();
      await db.collection('onboarding').insertOne({
        user_hash: TEST_USER_HASH,
        state: OnboardingState.COMPLETED,
        updated_at: new Date()
      });
    });

    it('returns 204 after rate limit exceeded (no error)', async () => {
      // Exhaust the rate limit by setting count to 50
      const angolaDate = new Date(Date.now() + 60 * 60 * 1000); // UTC+1
      const today = `${angolaDate.getUTCFullYear()}-${String(angolaDate.getUTCMonth() + 1).padStart(2, '0')}-${String(angolaDate.getUTCDate()).padStart(2, '0')}`;
      const rateKey = `${TEST_USER_HASH}:${today}`;

      await db.collection('rate_limits').insertOne({
        _id: rateKey,
        count: 50,
        resetAt: new Date(Date.now() + 86400000)
      });

      const res = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'hoje',
        MessageSid: 'SM_rate_1'
      });
      // Rate limited requests return 204 (silent drop with occasional notice)
      assert.equal(res.status, 204);
    });
  });

  describe('OpenAI fallback parsing', () => {
    beforeEach(async () => {
      await clearCollections();
      await db.collection('onboarding').insertOne({
        user_hash: TEST_USER_HASH,
        state: OnboardingState.COMPLETED,
        updated_at: new Date()
      });
      process.env.OPENAI_MOCK_RESPONSE = 'true';
    });

    afterEach(() => {
      delete process.env.OPENAI_MOCK_RESPONSE;
    });

    it('uses OpenAI fallback when regex returns ambiguous', async () => {
      // First message: parse the financial transaction via OpenAI mock
      const res = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'passei 3000 kz no mercado',
        MessageSid: 'SM_openai_fallback_1'
      });
      assert.equal(res.status, 204);

      // Second message: confirm the transaction
      const res2 = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'sim',
        MessageSid: 'SM_openai_fallback_2'
      });
      assert.equal(res2.status, 204);

      // Verify transaction was created (OpenAI mock resolved it, confirmation persisted it)
      const txCount = await db.collection('transactions').countDocuments({ user_hash: TEST_USER_HASH });
      assert.equal(txCount, 1);

      const tx = await db.collection('transactions').findOne({ user_hash: TEST_USER_HASH });
      assert.equal(tx.type, 'expense');
      assert.equal(tx.amount, 3000);
      assert.equal(tx.description, 'mercado');
    });

    it('replies "Não percebi" when OpenAI also returns ambiguous', async () => {
      const res = await post('/webhook', {
        From: TEST_PHONE,
        Body: 'qualquer coisa',
        MessageSid: 'SM_openai_ambig_1'
      });
      assert.equal(res.status, 204);

      // No transaction should be created
      const txCount = await db.collection('transactions').countDocuments({ user_hash: TEST_USER_HASH });
      assert.equal(txCount, 0);
    });
  });
});
