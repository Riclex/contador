import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeDailyMetrics, getOrCreateSnapshot, getRecentSnapshots, formatDelta, getAngolaDateStr } from '../lib/metrics.js';
import { trackOpenAICall, getOpenAIStats } from '../lib/cache.js';

describe('formatDelta', () => {
  it('shows equals for no change', () => {
    assert.equal(formatDelta(5, 5), '(=)');
  });

  it('shows increase with percentage', () => {
    assert.equal(formatDelta(10, 5), '(+5 ↑100%)');
  });

  it('shows decrease with percentage', () => {
    assert.equal(formatDelta(3, 5), '(-2 ↓40%)');
  });

  it('handles zero previous with new users', () => {
    assert.equal(formatDelta(5, 0), '(+5 novo)');
  });

  it('handles both zero', () => {
    assert.equal(formatDelta(0, 0), '(=)');
  });

  it('handles zero current with non-zero previous', () => {
    assert.equal(formatDelta(0, 5), '(-5 ↓100%)');
  });
});

describe('getAngolaDateStr', () => {
  it('returns date string in YYYY-MM-DD format', () => {
    const result = getAngolaDateStr();
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('OpenAI Call Tracking', () => {
  it('tracks OpenAI calls', () => {
    const before = getOpenAIStats();
    trackOpenAICall(false);
    trackOpenAICall(false);
    const after = getOpenAIStats();
    assert.equal(after.calls, before.calls + 2);
  });

  it('tracks cache hits', () => {
    const before = getOpenAIStats();
    trackOpenAICall(true);
    trackOpenAICall(true);
    trackOpenAICall(true);
    const after = getOpenAIStats();
    assert.equal(after.cacheHits, before.cacheHits + 3);
  });

  it('tracks mixed calls and hits', () => {
    const before = getOpenAIStats();
    trackOpenAICall(false);
    trackOpenAICall(true);
    trackOpenAICall(false);
    const after = getOpenAIStats();
    assert.equal(after.calls, before.calls + 2);
    assert.equal(after.cacheHits, before.cacheHits + 1);
  });
});

// Helper to create MongoDB-like aggregate cursor mocks
function mockAggregate(result) {
  return { toArray: async () => result };
}

describe('computeDailyMetrics', () => {
  it('returns date in correct format', async () => {
    const events = {
      async countDocuments() { return 0; },
      aggregate() { return mockAggregate([]); },
      async distinct() { return []; }
    };
    const transactions = {
      aggregate() { return mockAggregate([]); }
    };
    const debts = {
      async countDocuments() { return 0; }
    };
    const today = new Date();
    const result = await computeDailyMetrics(events, transactions, debts, today);
    assert.match(result.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(result.newUsers, 0);
    assert.equal(result.activeUsers, 0);
    assert.equal(result.returningUsers, 0);
    assert.equal(result.totalMessages, 0);
  });

  it('counts new users from first_use events', async () => {
    const events = {
      async countDocuments(query) {
        if (query && query.event_name === 'first_use') return 2;
        return 0;
      },
      aggregate(pipeline) {
        if (pipeline.some(s => s.$count)) return mockAggregate([{ count: 5 }]);
        if (pipeline.some(s => s.$group && s.$group._id === '$metadata.command')) return mockAggregate([]);
        return mockAggregate([]);
      },
      async distinct() { return []; }
    };
    const transactions = {
      aggregate() { return mockAggregate([]); }
    };
    const debts = {
      async countDocuments() { return 0; }
    };
    const today = new Date();
    const result = await computeDailyMetrics(events, transactions, debts, today);
    assert.equal(result.newUsers, 2);
    assert.equal(result.activeUsers, 5);
  });
});

describe('getOrCreateSnapshot', () => {
  it('returns existing snapshot without recomputing', async () => {
    const existingSnapshot = {
      _id: '2026-04-20',
      date: '2026-04-20',
      newUsers: 5,
      activeUsers: 10,
      returningUsers: 2,
      totalMessages: 30,
      confirmedTransactions: 8,
      debtsCreated: 1,
      totalIncome: 15000,
      totalExpense: 8000,
      debtsSettled: 0,
      commandsUsed: { hoje: 5 },
      openaiCalls: 3,
      openaiCacheHits: 7,
      computedAt: new Date()
    };
    const dailyMetrics = {
      async findOne(query) { return query._id === '2026-04-20' ? existingSnapshot : null; },
      async replaceOne() {}
    };
    const events = {
      async countDocuments() { return 999; },
      aggregate() { return mockAggregate([]); },
      async distinct() { return []; }
    };
    const transactions = { aggregate() { return mockAggregate([]); } };
    const debts = { async countDocuments() { return 0; } };

    const date = new Date('2026-04-20');
    const result = await getOrCreateSnapshot(dailyMetrics, events, transactions, debts, date);
    assert.equal(result.newUsers, 5);
    assert.equal(result.activeUsers, 10);
  });
});

describe('Command - /metricas', () => {
  it('rejects non-admin users', async () => {
    const { handleMetricas } = await import('../lib/commands.js');
    let replied = '';
    const ctx = {
      adminNumbers: [],
      from: 'whatsapp:+244912345678',
      reply: async (msg) => { replied = msg; }
    };
    await handleMetricas(ctx);
    assert.equal(replied, 'Comando desativado.');
  });

  it('rejects unauthorized phone numbers', async () => {
    const { handleMetricas } = await import('../lib/commands.js');
    let replied = '';
    const ctx = {
      adminNumbers: ['whatsapp:+244999999999'],
      from: 'whatsapp:+244912345678',
      reply: async (msg) => { replied = msg; }
    };
    await handleMetricas(ctx);
    assert.equal(replied, 'Comando reservado para administradores.');
  });
});

describe('COMMANDS set includes /metricas', () => {
  it('has metricas in the COMMANDS set', async () => {
    const { COMMANDS } = await import('../lib/commands.js');
    assert.ok(COMMANDS.has('/metricas'));
  });
});