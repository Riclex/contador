import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let mongod;
let client;
let db;

export async function startMongo() {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = mongod.getUri();
  client = new MongoClient(uri);
  await client.connect();
  db = client.db('contador_test');

  // Create the same collections and indexes as production
  await db.collection('transactions').createIndex({ user_hash: 1, date: -1 });
  await db.collection('transactions').createIndex({ message_sid: 1 }, { unique: true });
  await db.collection('debts').createIndex({ user_hash: 1, settled: 1 });
  await db.collection('debts').createIndex({ user_hash: 1, creditor: 1, debtor: 1 });
  await db.collection('debts').createIndex({ message_sid: 1 }, { unique: true });
  await db.collection('events').createIndex({ event_name: 1, timestamp: -1 });
  await db.collection('events').createIndex({ user_hash: 1, timestamp: -1 });
  await db.collection('sessions').createIndex({ phone_hash: 1 }, { unique: true });
  await db.collection('rate_limits').createIndex({ resetAt: 1 }, { expireAfterSeconds: 0 });

  return { client, db, uri };
}

export async function stopMongo() {
  if (client) await client.close();
  if (mongod) await mongod.stop();
}

export async function clearCollections() {
  const collections = ['transactions', 'debts', 'events', 'sessions', 'onboarding', 'rate_limits'];
  await Promise.all(collections.map(c => db.collection(c).deleteMany({})));
}

export function getDb() { return db; }
export function getClient() { return client; }