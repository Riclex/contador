import logger from './logger.js';
import { hashPhone } from './security.js';

// --- Migration Guard
async function isMigrationDone(db, name) {
  const doc = await db.collection('_migrations').findOne({ _id: name });
  return doc !== null;
}

async function markMigrationDone(db, name) {
  await db.collection('_migrations').insertOne({ _id: name, timestamp: new Date() });
}

// --- Migration: Backfill user_hash from user_phone
async function backfillUserHash(db, collections) {
  if (await isMigrationDone(db, 'backfill_user_hash')) {
    logger.info('[MIGRATE] Skipping backfill_user_hash — already done');
    return;
  }

  for (const collection of collections) {
    let count = 0;
    const cursor = collection.find({ user_phone: { $exists: true }, user_hash: { $exists: false } }).batchSize(100);
    for await (const doc of cursor) {
      await collection.updateOne(
        { _id: doc._id },
        { $set: { user_hash: hashPhone(doc.user_phone) } }
      );
      count++;
    }
    if (count > 0) {
      logger.info(`[MIGRATE] Backfilled user_hash for ${count} ${collection.collectionName} records.`);
    }
    logger.info(`[MIGRATE] ${collection.collectionName} migration complete.`);
  }

  // Remove raw phone numbers after backfill
  for (const collection of collections) {
    const result = await collection.updateMany(
      { user_phone: { $exists: true }, user_hash: { $exists: true } },
      { $unset: { user_phone: "" } }
    );
    if (result.modifiedCount > 0) {
      logger.info(`[MIGRATE] Removed user_phone from ${result.modifiedCount} ${collection.collectionName} records.`);
    }
  }

  // Migrate onboarding phone numbers to broadcast_list
  let broadcastMigrated = 0;
  const onboardingWithPhone = db.collection('onboarding').find({ phone: { $exists: true } });
  for await (const doc of onboardingWithPhone) {
    if (doc.phone && doc.user_hash && (doc.state === 'COMPLETED' || doc.state === 'completed')) {
      await db.collection('broadcast_list').updateOne(
        { user_hash: doc.user_hash },
        { $set: { phone: doc.phone, updated_at: new Date() } },
        { upsert: true }
      );
      broadcastMigrated++;
    }
    await db.collection('onboarding').updateOne(
      { _id: doc._id },
      { $unset: { phone: "" } }
    );
  }
  if (broadcastMigrated > 0) {
    logger.info(`[MIGRATE] Migrated ${broadcastMigrated} phone numbers from onboarding to broadcast_list`);
  }

  await markMigrationDone(db, 'backfill_user_hash');
}

// --- Migration: Backfill creditor_lower/debtor_lower
async function backfillDebtNormalizedFields(db, debts) {
  let count = 0;
  const cursor = debts.find({
    $or: [
      { creditor_lower: { $exists: false } },
      { debtor_lower: { $exists: false } }
    ]
  }).batchSize(100);

  for await (const doc of cursor) {
    const update = {};
    if (doc.creditor && !doc.creditor_lower) update.creditor_lower = doc.creditor.toLowerCase();
    if (doc.debtor && !doc.debtor_lower) update.debtor_lower = doc.debtor.toLowerCase();
    if (Object.keys(update).length > 0) {
      await debts.updateOne({ _id: doc._id }, { $set: update });
      count++;
    }
  }
  if (count > 0) {
    logger.info(`[MIGRATE] Backfilled creditor_lower/debtor_lower for ${count} debt records.`);
  }
}

// --- Migration: Check for 16-char hashes
async function checkHashLengthMigration(db, collections) {
  if (await isMigrationDone(db, 'hash_16_to_32')) {
    logger.info('[MIGRATE] Skipping hash_16_to_32 — already done');
    return;
  }

  logger.info('[MIGRATE] Checking for 16-char user_hash values...');
  for (const collection of collections) {
    const field = collection.collectionName === 'sessions' ? 'phone_hash' : 'user_hash';
    const shortHashDocs = await collection.find({
      $expr: { $eq: [{ $strLenCP: `$${field}` }, 16] }
    }).limit(1).toArray();
    if (shortHashDocs.length > 0) {
      logger.warn(`[MIGRATE] Found 16-char ${field} values in ${collection.collectionName}.`);
    }
  }

  await markMigrationDone(db, 'hash_16_to_32');
  logger.info('[MIGRATE] hash_16_to_32 migration check complete');
}

// --- Run all migrations
export async function runMigrations(db, transactions, debts) {
  try {
    const migrateCollections = [transactions, debts, db.collection('onboarding'), db.collection('sessions')];
    await backfillUserHash(db, migrateCollections);
    await backfillDebtNormalizedFields(db, debts);
    await checkHashLengthMigration(db, migrateCollections);
  } catch (err) {
    logger.error(err, '[MIGRATE] Migration error (non-fatal)');
  }
}
