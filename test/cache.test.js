import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCacheKey,
  getCachedResponse,
  setCachedResponse,
  getCacheStats,
  resetCache
} from '../lib/cache.js';

describe('Response Cache', () => {
  beforeEach(() => {
    resetCache();
  });

  it('miss returns null', () => {
    assert.equal(getCachedResponse('nonexistent', 'transaction'), null);
  });

  it('set then get returns cached data', () => {
    setCachedResponse('vendi 1000', 'transaction', { type: 'income', amount: 1000 });
    const result = getCachedResponse('vendi 1000', 'transaction');
    assert.deepEqual(result, { type: 'income', amount: 1000 });
  });

  it('keys are case-insensitive', () => {
    setCachedResponse('Vendi 1000', 'transaction', { type: 'income', amount: 1000 });
    const result = getCachedResponse('vendi 1000', 'transaction');
    assert.deepEqual(result, { type: 'income', amount: 1000 });
  });

  it('transaction and debt caches are separate', () => {
    setCachedResponse('vendi 1000', 'transaction', { type: 'income', amount: 1000 });
    setCachedResponse('vendi 1000', 'debt', { type: 'recebido', amount: 1000 });
    const txResult = getCachedResponse('vendi 1000', 'transaction');
    const debtResult = getCachedResponse('vendi 1000', 'debt');
    assert.equal(txResult.type, 'income');
    assert.equal(debtResult.type, 'recebido');
  });

  it('hit rate is computed correctly (2 hits + 1 miss)', () => {
    setCachedResponse('msg1', 'transaction', { type: 'income' });
    setCachedResponse('msg2', 'transaction', { type: 'expense' });

    // 2 hits
    getCachedResponse('msg1', 'transaction');
    getCachedResponse('msg2', 'transaction');

    // 1 miss
    getCachedResponse('msg3', 'transaction');

    const stats = getCacheStats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
    // hitRate = (2 / 3) * 100 = 66.7%
    assert.equal(stats.hitRate, '66.7%');
  });

  it('getCacheKey normalizes text (lowercase + trim)', () => {
    const key1 = getCacheKey('  Vendi 1000  ', 'transaction');
    const key2 = getCacheKey('vendi 1000', 'transaction');
    assert.equal(key1, key2);
  });
});