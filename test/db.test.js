import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, clearCollections } from './helpers/setup.js';
import { ensureIndex } from '../lib/db.js';

let db;

describe('ensureIndex', () => {
  beforeEach(async () => {
    const setup = await startMongo();
    db = setup.db;
  });

  afterEach(async () => {
    await clearCollections();
    await stopMongo();
  });

  it('creates a simple index', async () => {
    const collection = db.collection('test_index');
    await ensureIndex(collection, { name: 1 });

    const indexes = await collection.indexes();
    const keys = indexes.map(i => i.key);
    assert.ok(keys.some(k => k.name === 1), 'index on name should exist');
  });

  it('creates a compound index', async () => {
    const collection = db.collection('test_compound');
    await ensureIndex(collection, { user_hash: 1, date: -1 });

    const indexes = await collection.indexes();
    const keys = indexes.map(i => i.key);
    assert.ok(keys.some(k => k.user_hash === 1 && k.date === -1), 'compound index should exist');
  });

  it('creates a unique index', async () => {
    const collection = db.collection('test_unique');
    await ensureIndex(collection, { message_sid: 1 }, { unique: true });

    const indexes = await collection.indexes();
    const uniqueIndexes = indexes.filter(i => i.unique);
    assert.ok(uniqueIndexes.length > 0, 'unique index should exist');
    await collection.insertOne({ message_sid: 'sid-1' });
    await assert.rejects(
      () => collection.insertOne({ message_sid: 'sid-1' }),
      /duplicate key/,
      'duplicate inserts should be rejected'
    );
  });

  it('handles error code 86 gracefully (index already exists)', async () => {
    const collection = db.collection('test_86');
    // Create the index first
    await collection.createIndex({ name: 1 }, { unique: true });
    // ensureIndex should not throw when the index already exists
    await assert.doesNotReject(
      () => ensureIndex(collection, { name: 1 }, { unique: true }),
      'should not throw on duplicate index (code 86)'
    );
  });

  it('handles error code 67 gracefully (immutable option)', async () => {
    // Use a fake collection to simulate error code 67 (ImmutableOption)
    const fakeCollection = {
      collectionName: 'fake',
      createIndex: async () => { throw { code: 67, message: 'Immutable option', name: 'MongoServerError' }; }
    };
    await assert.doesNotReject(
      () => ensureIndex(fakeCollection, { updatedAt: 1 }, { expireAfterSeconds: 3600 }),
      'should not throw on immutable option (code 67)'
    );
  });

  it('re-throws unknown error codes', async () => {
    // Use a fake collection to simulate an unknown error that should be re-thrown
    const fakeCollection = {
      collectionName: 'fake',
      createIndex: async () => { throw new Error('Something went terribly wrong'); }
    };
    await assert.rejects(
      () => ensureIndex(fakeCollection, { x: 1 }),
      /Something went terribly wrong/,
      'should re-throw non-86/67 errors'
    );
  });
});
