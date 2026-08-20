import { SessionState, hashPhone } from '../../lib/security.js';

const TEST_PHONE = 'whatsapp:+244912345678';

export function createTestContext(overrides = {}) {
  const messages = [];
  const events = [];
  let sessionDirty = false;

  const ctx = {
    from: TEST_PHONE,
    text: '',
    userHash: hashPhone(TEST_PHONE),
    messageSid: 'SM_test_' + Math.random().toString(36).substring(2, 8),
    sessionKey: hashPhone(TEST_PHONE),
    session: { state: SessionState.IDLE },
    sessions: new Map(),
    db: overrides.db || null,
    transactions: overrides.transactions || null,
    debts: overrides.debts || null,
    events: overrides.events || null,
    rateLimits: overrides.rateLimits || null,
    referrals: overrides.referrals || null,
    mongoClient: overrides.mongoClient || null,
    mongoConnected: overrides.mongoConnected !== undefined ? overrides.mongoConnected : true,
    transactionsSupported: overrides.transactionsSupported !== undefined ? overrides.transactionsSupported : true,
    reply: (body) => { messages.push({ body }); },
    replyWithRetry: (body) => { messages.push({ body }); },
    logEvent: (eventName, metadata) => { events.push({ eventName, metadata }); },
    markSessionDirty: () => { sessionDirty = true; },
    saveSessionIfDirty: async () => {
      if (sessionDirty) {
        sessionDirty = false;
      }
    },
    parseTransaction: overrides.parseTransaction || (async () => ({ error: 'ambiguous' })),
    parseDebt: overrides.parseDebt || (async () => ({ error: 'ambiguous' })),
    adminNumbers: [],
    getRetentionData: overrides.getRetentionData || (async () => ({
      totalUsers: 0,
      cohorts: []
    })),
    _sessionDirty: false,
    _getSessionDirty: () => sessionDirty,
  };

  Object.defineProperty(ctx, '_sessionDirty', {
    get: () => sessionDirty
  });

  return { ctx, messages, events };
}