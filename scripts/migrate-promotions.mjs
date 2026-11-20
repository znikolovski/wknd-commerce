#!/usr/bin/env node
/**
 * Explicit, idempotent promotion storage migration (wknd.promotions/v1).
 *
 *   node scripts/migrate-promotions.mjs --memory              # dry run against an in-memory store
 *   node scripts/migrate-promotions.mjs                       # migrate the workspace database
 *   node scripts/migrate-promotions.mjs --bootstrap-recovery  # also bind the protected recovery
 *                                                             # promotion (created DISABLED)
 *   node scripts/migrate-promotions.mjs --verify-storage      # prove unique _id + conditional
 *                                                             # update on a scratch collection
 *
 * Database credentials come from .env (OAuth server-to-server credential of the App Builder
 * workspace): PROMOTIONS_DB_CLIENT_ID, PROMOTIONS_DB_CLIENT_SECRET, PROMOTIONS_DB_ORG_ID,
 * optional PROMOTIONS_DB_SCOPES (comma separated) and DB_REGION.
 * Migration never overwrites operator edits or re-enables promotions; a foreign record using a
 * legacy code fails with MIGRATION_CONFLICT and storage stays uninitialized.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getStore, createMemoryStore, isDuplicateKeyError } = require(path.join(root, 'lib/store.js'));
const { migrateLegacyPromotions } = require(path.join(root, 'lib/promotions.js'));
const { bootstrapRecoveryPromotion } = require(path.join(root, 'lib/recovery-policy.js'));

const args = new Set(process.argv.slice(2));

function readEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

async function openStore() {
  if (args.has('--memory')) return createMemoryStore();
  const env = { ...readEnv(), ...process.env };
  const missing = ['PROMOTIONS_DB_CLIENT_ID', 'PROMOTIONS_DB_CLIENT_SECRET', 'PROMOTIONS_DB_ORG_ID'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')} (see script header).`);
  return getStore({
    clientId: env.PROMOTIONS_DB_CLIENT_ID,
    clientSecret: env.PROMOTIONS_DB_CLIENT_SECRET,
    orgId: env.PROMOTIONS_DB_ORG_ID,
    scopes: (env.PROMOTIONS_DB_SCOPES || '').split(',').map((s) => s.trim()).filter(Boolean),
    DB_REGION: env.DB_REGION,
  });
}

/** Proves the primitives the promotion service depends on; leaves only a marker record. */
async function verifyStorage(store) {
  const coll = store.collection('promotion_capability_checks');
  const id = `check-${crypto.randomUUID()}`;
  await coll.insertOne({ _id: id, key: id, slot: 1 });
  let duplicateRejected = false;
  try {
    await coll.insertOne({ _id: id, key: id, slot: 99 });
  } catch (e) {
    duplicateRejected = isDuplicateKeyError(e);
    if (!duplicateRejected) throw e;
  }
  const first = await coll.replaceOne({ key: id, slot: 1 }, { key: id, slot: 2 });
  const stale = await coll.replaceOne({ key: id, slot: 1 }, { key: id, slot: 3 });
  const final = await coll.findOne({ key: id });
  const result = {
    duplicateRejected,
    casFirstMatched: (first?.matchedCount ?? 0) === 1,
    casStaleRejected: (stale?.matchedCount ?? 0) === 0,
    finalSlot: final?.slot,
  };
  result.verified = result.duplicateRejected && result.casFirstMatched && result.casStaleRejected && result.finalSlot === 2;
  await coll.deleteOne({ key: id });
  return result;
}

const store = await openStore();
if (args.has('--verify-storage')) {
  const result = await verifyStorage(store);
  console.log('storage capability check:', result);
  if (!result.verified) process.exitCode = 1;
} else {
  console.log('legacy migration:', await migrateLegacyPromotions(store));
  if (args.has('--bootstrap-recovery')) console.log('recovery bootstrap:', await bootstrapRecoveryPromotion(store));
}
await store.close();
