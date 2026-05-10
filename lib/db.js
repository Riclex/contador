import logger from './logger.js';

/**
 * Safely create a MongoDB index, ignoring "already exists" errors.
 * Code 86 = IndexKeySpecsConflict (index already exists with different spec)
 * Code 67 = ImmutableOption (index exists but TTL changed — common during development)
 */
export async function ensureIndex(collection, keys, options = {}) {
  try {
    await collection.createIndex(keys, options);
    logger.info(`[DB] Index created on ${collection.collectionName}: ${JSON.stringify(keys)}`);
  } catch (err) {
    if (err.code !== 86 && err.code !== 67) throw err;
    logger.debug(`[DB] Index already exists on ${collection.collectionName}: ${JSON.stringify(keys)}`);
  }
}
