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
    sessions: {},
    db: overrides.db || null,
    transactions: overrides.transactions || null,
    debts: overrides.debts || null,
    events: overrides.events || null,
    rateLimits: overrides.rateLimits || null,
    mongoClient: overrides.mongoClient || null,
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
    getEnhancedStats: overrides.getEnhancedStats || (async () => ({
      today: { newUsers: 0, activeUsers: 0, totalMessages: 0, confirmedTransactions: 0, debtsCreated: 0 },
      cache: { size: 0, hits: 0, misses: 0, hitRate: '0%' },
      system: { uptime: '0d 0h 0m', mongodb: '✅' }
    })),
    _sessionDirty: false,
    _getSessionDirty: () => sessionDirty,
  };

  Object.defineProperty(ctx, '_sessionDirty', {
    get: () => sessionDirty
  });

  return { ctx, messages, events };
}