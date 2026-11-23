/**
 * Disposable CAS acceptance probe using precisely the binding adapter's store primitives.
 * No store is opened by default. Execution requires an injected operator-owned store and an exact
 * platform namespace match. No customer identifiers, unconditional deletion, or collection setup.
 */
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createBindingStore } = require('./target-binding-store');
const { environmentGate } = require('./target-environment');

async function cleanupProbe(binding, key) {
  try {
    const current = await binding.get(key);
    if (current) assert.equal(await binding.remove(key, { ifMatch: current.etag }), true, 'Conditional cleanup failed');
  } catch (error) {
    error.probeKey = key;
    throw error;
  }
}

async function verifyTargetBindingCas({
  environment, namespace, stageNamespace, productionNamespace, prefix, platformNamespace,
  execute = false, getStore, randomUUID = crypto.randomUUID,
} = {}) {
  const config = {
    TARGET_DIAG_ENVIRONMENT: environment,
    TARGET_DIAG_STAGE_NAMESPACE: stageNamespace,
    TARGET_DIAG_PRODUCTION_NAMESPACE: productionNamespace,
  };
  const error = environmentGate(config, namespace);
  if (error) throw new Error(error);
  if (typeof prefix !== 'string' || !/^cas-probe-[a-z0-9-]{1,40}:$/.test(prefix)) {
    throw new Error('A disposable cas-probe-<name>: key prefix is required');
  }
  if (!execute) return { status: 'dry-run', environment, checks: 'insert/update/delete/ABA/concurrent-writers', writes: false };
  if (platformNamespace !== namespace || typeof getStore !== 'function') {
    throw new Error('Execution requires platform namespace verification and an injected store');
  }
  const key = `${prefix}${environment}:${namespace}:${randomUUID()}`;
  const store = await getStore();
  const binding = createBindingStore(store);
  const record = (step) => ({ probe: true, step });
  let owned = false;
  try {
    assert.equal(await binding.get(key), null, 'Disposable key must not already exist');
    const first = await binding.put(key, record('first'), { ifMatch: null });
    assert.ok(first, 'Insert must yield an etag');
    owned = true;
    assert.equal(await binding.put(key, record('duplicate'), { ifMatch: null }), null, 'Duplicate _id must fail');
    assert.equal((await binding.get(key)).etag, first, 'Duplicate must preserve original');
    const writers = await Promise.all([
      binding.put(key, record('writer-a'), { ifMatch: first }),
      binding.put(key, record('writer-b'), { ifMatch: first }),
    ]);
    assert.equal(writers.filter(Boolean).length, 1, 'Exactly one conditional writer must win');
    const winner = writers.find(Boolean);
    assert.notEqual(winner, first, 'ETag must rotate');
    assert.equal(await binding.remove(key, { ifMatch: first }), false, 'Stale delete must fail');
    assert.equal(await binding.put(key, record('stale'), { ifMatch: first }), null, 'Stale update must fail');
    assert.equal((await binding.get(key)).etag, winner, 'Stale writes must preserve winner');
    assert.equal(await binding.remove(key, { ifMatch: winner }), true, 'Current delete must succeed');
    assert.equal(await binding.get(key), null, 'Deleted record must be absent');
    const recreated = await binding.put(key, record('recreated'), { ifMatch: null });
    assert.ok(recreated, 'Reinsert must succeed');
    assert.notEqual(recreated, first, 'Reinsert must not reuse an old etag (ABA)');
    assert.notEqual(recreated, winner, 'Reinsert must rotate etag');
    assert.equal(await binding.put(key, record('aba'), { ifMatch: winner }), null, 'Pre-delete update must fail');
    assert.equal(await binding.remove(key, { ifMatch: winner }), false, 'Pre-delete remove must fail');
    assert.equal(await binding.remove(key, { ifMatch: recreated }), true, 'Probe cleanup must succeed');
    assert.equal(await binding.remove(key, { ifMatch: recreated }), false, 'Repeated deletion must report false');
    assert.equal(await binding.get(key), null, 'Probe must leave no record');
    owned = false;
    return { status: 'passed', environment, checks: 'insert/update/delete/ABA/concurrent-writers', writes: true };
  } catch (error) {
    error.probeKey = key;
    throw error;
  } finally {
    try {
      if (owned) await cleanupProbe(binding, key);
    } finally {
      await store.close?.();
    }
  }
}

module.exports = { verifyTargetBindingCas };
