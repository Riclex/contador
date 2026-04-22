import { getAngolaMidnightUTC, ANGOLA_OFFSET_MS } from './security.js';

// --- Daily Metrics Computation ---
// Computes all metrics for a given Angola-date by running parallel MongoDB aggregations.

function getAngolaDateStr(date = new Date()) {
  const angolaTime = new Date(date.getTime() + ANGOLA_OFFSET_MS);
  return `${angolaTime.getUTCFullYear()}-${String(angolaTime.getUTCMonth() + 1).padStart(2, '0')}-${String(angolaTime.getUTCDate()).padStart(2, '0')}`;
}

async function computeDailyMetrics(events, transactions, debts, date = new Date()) {
  const today = getAngolaMidnightUTC(date);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const timeRange = { $gte: today, $lt: tomorrow };

  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sixDaysAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    newUsers,
    activeUsersAgg,
    totalMessages,
    confirmedTransactions,
    debtsCreated,
    financialAgg,
    debtSettledAgg,
    commandAgg,
    openaiCallsAgg,
    returningUsers
  ] = await Promise.all([
    // 1. New users (first_use events today)
    events.countDocuments({ event_name: 'first_use', timestamp: timeRange }),

    // 2. Active users (distinct user_hashes with any event today)
    events.aggregate([
      { $match: { timestamp: timeRange } },
      { $group: { _id: '$user_hash' } },
      { $count: 'count' }
    ]).toArray(),

    // 3. Total messages today
    events.countDocuments({ event_name: 'message_sent', timestamp: timeRange }),

    // 4. Confirmed transactions today
    events.countDocuments({ event_name: 'transaction_confirmed', timestamp: timeRange }),

    // 5. Debts created today
    events.countDocuments({ event_name: 'debt_created', timestamp: timeRange }),

    // 6. Financial totals (income/expense) from transactions collection
    transactions.aggregate([
      { $match: { date: timeRange } },
      { $group: {
        _id: null,
        totalIncome: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
        totalExpense: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } }
      }}
    ]).toArray(),

    // 7. Debts settled today (pago)
    debts.countDocuments({ settled_date: timeRange }),

    // 8. Per-command breakdown
    events.aggregate([
      { $match: { event_name: 'command_used', timestamp: timeRange } },
      { $group: { _id: '$metadata.command', count: { $sum: 1 } } }
    ]).toArray(),

    // 9. OpenAI calls and cache hits
    events.aggregate([
      { $match: { event_name: { $in: ['openai_call', 'openai_cache_hit'] }, timestamp: timeRange } },
      { $group: { _id: '$event_name', count: { $sum: 1 } } }
    ]).toArray(),

    // 10. Returning users: active today, had activity 7-30 days ago, NOT active 1-6 days ago
    computeReturningUsers(events, today, sevenDaysAgo, sixDaysAgo, thirtyDaysAgo)
  ]);

  const activeUsers = activeUsersAgg[0]?.count || 0;
  const financial = financialAgg[0] || { totalIncome: 0, totalExpense: 0 };

  // Build commandsUsed object from aggregation
  const commandsUsed = {};
  for (const cmd of commandAgg) {
    if (cmd._id) commandsUsed[cmd._id] = cmd.count;
  }

  // Build OpenAI stats from aggregation
  const openaiStats = { calls: 0, cacheHits: 0 };
  for (const item of openaiCallsAgg) {
    if (item._id === 'openai_call') openaiStats.calls = item.count;
    if (item._id === 'openai_cache_hit') openaiStats.cacheHits = item.count;
  }

  return {
    date: getAngolaDateStr(date),
    newUsers,
    activeUsers,
    returningUsers,
    totalMessages,
    confirmedTransactions,
    debtsCreated,
    totalIncome: financial.totalIncome,
    totalExpense: financial.totalExpense,
    debtsSettled: debtSettledAgg,
    commandsUsed,
    openaiCalls: openaiStats.calls,
    openaiCacheHits: openaiStats.cacheHits,
    computedAt: new Date()
  };
}

async function computeReturningUsers(events, today, sevenDaysAgo, sixDaysAgo, thirtyDaysAgo) {
  // Get distinct users active today
  const todayUsers = await events.distinct('user_hash', { timestamp: { $gte: today } });

  if (todayUsers.length === 0) return 0;

  // Users who were active 7-30 days ago AND are active today
  const returningCandidates = await events.distinct('user_hash', {
    user_hash: { $in: todayUsers },
    timestamp: { $gte: thirtyDaysAgo, $lt: sevenDaysAgo }
  });

  if (returningCandidates.length === 0) return 0;

  // Exclude users who were also active in the last 6 days (they're not "returning")
  const recentUsers = await events.distinct('user_hash', {
    user_hash: { $in: returningCandidates },
    timestamp: { $gte: sixDaysAgo, $lt: today }
  });

  const recentSet = new Set(recentUsers);
  return returningCandidates.filter(h => !recentSet.has(h)).length;
}

async function getOrCreateSnapshot(dailyMetrics, events, transactions, debts, date) {
  const dateStr = getAngolaDateStr(date);
  const todayStr = getAngolaDateStr();

  // Today is always computed live
  if (dateStr === todayStr) {
    return computeDailyMetrics(events, transactions, debts, date);
  }

  // Past days: check for stored snapshot
  const existing = await dailyMetrics.findOne({ _id: dateStr });
  if (existing) return existing;

  // Compute and store
  const metrics = await computeDailyMetrics(events, transactions, debts, date);
  try {
    await dailyMetrics.replaceOne(
      { _id: dateStr },
      { ...metrics, _id: dateStr },
      { upsert: true }
    );
  } catch (err) {
    // Ignore duplicate key errors (race condition: another request computed it first)
    if (err.code !== 11000) throw err;
  }
  return metrics;
}

async function getRecentSnapshots(dailyMetrics, events, transactions, debts, days = 7) {
  const today = getAngolaMidnightUTC();
  const snapshots = [];

  for (let i = 1; i < days; i++) { // Start from yesterday (i=1), today is computed live
    const date = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const snapshot = await getOrCreateSnapshot(dailyMetrics, events, transactions, debts, date);
    snapshots.push(snapshot);
  }

  // Today is computed live
  const todayMetrics = await computeDailyMetrics(events, transactions, debts, new Date());
  snapshots.push(todayMetrics);

  // Sort chronologically (oldest first)
  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  return snapshots;
}

function formatDelta(current, previous) {
  if (previous === 0) {
    return current > 0 ? `(+${current} novo)` : '(=)';
  }
  const diff = current - previous;
  if (diff === 0) return '(=)';
  const pct = Math.round(Math.abs(diff / previous) * 100);
  const arrow = diff > 0 ? '↑' : '↓';
  return `(${diff > 0 ? '+' : ''}${diff} ${arrow}${pct}%)`;
}

export {
  computeDailyMetrics,
  getOrCreateSnapshot,
  getRecentSnapshots,
  formatDelta,
  getAngolaDateStr
};