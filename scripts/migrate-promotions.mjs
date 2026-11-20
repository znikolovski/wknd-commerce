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
 * Uses the same App Builder Database Storage as the deployed actions, authenticated with the
 * workspace's OAuth server-to-server credential from .env (IMS_OAUTH_S2S_CLIENT_ID/_SECRET/
 * _ORG_ID/_SCOPES, written by `aio app use`; PROMOTIONS_DB_* override them) and DB_REGION
 * (default amer). `--env=<path>` reads another checkout's .env (e.g. a worktree without one).
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

const args = new Set(process.argv.slice(2).filter((a) => !a.startsWith('--env=')));

const envArg = process.argv.slice(2).find((a) => a.startsWith('--env='));

function readEnv() {
  const file = envArg ? path.resolve(envArg.slice(6)) : path.join(root, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

function parseScopes(raw = '') {
  const text = String(raw).trim();
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split(',').map((x) => x.trim()).filter(Boolean);
}

async function openStore() {
  if (args.has('--memory')) return createMemoryStore();
  const env = { ...readEnv(), ...process.env };
  const pick = (name) => env[`PROMOTIONS_DB_${name}`] || env[`IMS_OAUTH_S2S_${name}`];
  const missing = ['CLIENT_ID', 'CLIENT_SECRET', 'ORG_ID'].filter((k) => !pick(k));
  if (missing.length) throw new Error(`Missing IMS_OAUTH_S2S_${missing.join(', IMS_OAUTH_S2S_')} in .env (run \`aio app use\`).`);
  // The database is scoped to the workspace's Runtime namespace (set in actions by I/O Runtime).
  process.env.__OW_NAMESPACE ||= env.AIO_runtime_namespace || env.AIO_RUNTIME_NAMESPACE;
  if (!process.env.__OW_NAMESPACE) throw new Error('Missing AIO_runtime_namespace in .env (run `aio app use`).');
  return getStore({
    clientId: pick('CLIENT_ID'),
    clientSecret: pick('CLIENT_SECRET'),
    orgId: pick('ORG_ID'),
    scopes: parseScopes(pick('SCOPES')),
    DB_REGION: env.DB_REGION || 'amer',
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
  // Concurrency: N racing inserts of one _id and N racing CAS writes from the same slot.
  const raceId = `race-${crypto.randomUUID()}`;
  const inserts = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => coll.insertOne({ _id: raceId, key: raceId, slot: 1, writer: i })));
  result.raceInsertWinners = inserts.filter((r) => r.status === 'fulfilled').length;
  result.raceInsertDuplicates = inserts.filter((r) => r.status === 'rejected' && isDuplicateKeyError(r.reason)).length;
  const cas = await Promise.all(Array.from({ length: 10 }, (_, i) => coll.replaceOne({ key: raceId, slot: 1 }, { key: raceId, slot: 2, writer: i })));
  result.raceCasWinners = cas.filter((r) => (r?.matchedCount ?? 0) === 1).length;
  result.verified = result.duplicateRejected && result.casFirstMatched && result.casStaleRejected && result.finalSlot === 2
    && result.raceInsertWinners === 1 && result.raceInsertDuplicates === 9 && result.raceCasWinners === 1;
  await coll.deleteOne({ key: id });
  await coll.deleteOne({ key: raceId });
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
