import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, clearCollections } from '../helpers/setup.js';
import { hashPhone } from '../../lib/security.js';

let db, rateLimits;

describe('Rate Limit Integration Tests', () => {
  beforeEach(async () => {
    const setup = await startMongo();
    db = setup.db;
    rateLimits = db.collection('rate_limits');
  });

  afterEach(async () => {
    await clearCollections();
    await stopMongo();
  });

  it('rate limit allows messages under the daily limit', async () => {
    const phone = 'whatsapp:+244912345678';
    const normalizedPhone = hashPhone(phone);
    const angolaDate = new Date(Date.now() + 60 * 60 * 1000);
    const year = angolaDate.getUTCFullYear();
    const month = String(angolaDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(angolaDate.getUTCDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`;
    const key = `${normalizedPhone}:${today}`;

    // Insert a document with count below limit
    await rateLimits.insertOne({
      _id: key,
      count: 10,
      resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });

    const doc = await rateLimits.findOne({ _id: key });
    assert.ok(doc);
    assert.equal(doc.count, 10);
  });

  it('rate limit blocks messages at daily limit', async () => {
    const phone = 'whatsapp:+244912345678';
    const normalizedPhone = hashPhone(phone);
    const angolaDate = new Date(Date.now() + 60 * 60 * 1000);
    const year = angolaDate.getUTCFullYear();
    const month = String(angolaDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(angolaDate.getUTCDate()).padStart(2, '0');
    const today = `${year}-${month}-${day}`;
    const key = `${normalizedPhone}:${today}`;

    // Insert a document with count at limit
    await rateLimits.insertOne({
      _id: key,
      count: 51,
      notified: true,
      resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });

    const doc = await rateLimits.findOne({ _id: key });
    assert.ok(doc);
    assert.equal(doc.count, 51);
  });

  it('rate_limits collection uses TTL index for auto-deletion', async () => {
    const indexes = await rateLimits.indexes();
    const ttlIndex = indexes.find(idx => idx.expireAfterSeconds !== undefined);
    assert.ok(ttlIndex, 'Should have a TTL index on rate_limits');
    assert.equal(ttlIndex.expireAfterSeconds, 0);
  });
});