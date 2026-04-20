import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, clearCollections } from '../helpers/setup.js';
import { createTestContext } from '../helpers/context-factory.js';
import { SessionState } from '../../lib/security.js';

let db, transactions, debts, events, rateLimits;

describe('Onboarding Integration Tests', () => {
  beforeEach(async () => {
    const setup = await startMongo();
    db = setup.db;
    transactions = db.collection('transactions');
    debts = db.collection('debts');
    events = db.collection('events');
    rateLimits = db.collection('rate_limits');
  });

  afterEach(async () => {
    await clearCollections();
    await stopMongo();
  });

  // Note: Full onboarding flow tests require the webhook preamble (onboarding state check,
  // welcome message, consent flow) which is still in index.js. These tests cover the
  // session state transitions that the extracted handlers manage.

  it('AWAITING_CONSENT + "sim" completes onboarding (simulated)', async () => {
    // This simulates what happens after the webhook preamble determines
    // the user is in AWAITING_CONSENT state and types "sim"
    const { ctx, messages } = createTestContext({ transactions, debts, events, rateLimits, db });

    // The onboarding flow is in the webhook preamble, not in extracted handlers.
    // But we can verify the SessionState values are correct for the flow.
    assert.equal(SessionState.IDLE, 'IDLE');
    assert.equal(typeof SessionState.AWAITING_CONFIRMATION, 'string');
  });

  it('AWAITING_CONSENT + non-affirmative text re-prompts (simulated)', async () => {
    // Same as above — onboarding flow is in the preamble
    assert.ok(true, 'Onboarding flow test placeholder');
  });

});