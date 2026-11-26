/**
 * Compare-and-set adapter for the Target ECID binding store (lib/target-id-binding.js contract), built
 * on the repo store surface (insertOne duplicate-key / updateOne matchedCount / deleteOne deletedCount,
 * the same primitives lib/cart.js relies on). INERT: the collection is touched only from
 * actions/target-diagnostic after every live gate is approved, or by withdrawal of an existing grant.
 * No unconditional setup: nothing creates the collection eagerly.
 *
 * Document: { _id: bindingKey, etag, record }. Legacy binding keys are shopper keys;
 * approved alias bindings use a fixed shopper/alias-scoped key in this same collection.
 * `record.shopperKey` and `record.subject` retain withdrawal-scan ownership.
 * `etag` is a random UUID per write, so an etag is never
 * reused for a key even after removal (a restarting counter would let a stale holder's write match).
 * `record.subject` = sha256(sub) lets withdrawal paths retain generation-scoped retirement work.
 */
const crypto = require('node:crypto');
const { isDuplicateKeyError, isNotFound } = require('./store');

// Old bundled withdrawal helpers retain the literal v1 name and cannot erase this generation.
const BINDING_COLLECTION = 'target_id_bindings_v2';

function createBindingStore(store, { collection = BINDING_COLLECTION, randomUUID = crypto.randomUUID } = {}) {
  const coll = () => store.collection(collection);
  return {
    async get(key) {
      const doc = await coll().findOne({ _id: key });
      if (!doc) return null;
      if (typeof doc.etag !== 'string' || !doc.record || typeof doc.record !== 'object') {
        throw new Error('Malformed binding document');
      }
      return { etag: doc.etag, record: doc.record };
    },
    async put(key, record, { ifMatch } = {}) {
      const etag = randomUUID();
      if (ifMatch === null) {
        try {
          await coll().insertOne({ _id: key, etag, record });
          return etag;
        } catch (e) {
          if (isDuplicateKeyError(e)) return null;
          throw e;
        }
      }
      if (typeof ifMatch !== 'string' || !ifMatch) throw new Error('put requires ifMatch (etag or null)');
      const res = await coll().updateOne({ _id: key, etag: ifMatch }, { $set: { etag, record } });
      return (res?.matchedCount ?? 0) === 1 ? etag : null;
    },
    async remove(key, { ifMatch } = {}) {
      const filter = ifMatch === undefined ? { _id: key } : { _id: key, etag: ifMatch };
      try {
        const res = await coll().deleteOne(filter);
        return (res?.deletedCount ?? 0) === 1;
      } catch (e) {
        if (isNotFound(e)) return false;
        throw e;
      }
    },
  };
}

const ECID = /^\d{38}$/;

function retirementRecord(record, reason) {
  const ecid = [record.ecid, record.priorEcid].find((id) => typeof id === 'string' && ECID.test(id));
  const { blob: _blob, ...retained } = record;
  if (!ecid && record.state === 'issuing' && record.phase === 'minting'
    && record.priorEcid === null && record.ecid === undefined) return null;
  return {
    ...retained,
    state: 'retiring',
    ...(ecid ? { ecid } : {}),
    retirement: { state: 'pending', reason },
  };
}

/**
 * Keep known IDs as non-authorizing retirement work. Removing an anonymous mint claim is safe:
 * its holder cannot persist an ECID or transmit a declared ID after losing its CAS ownership.
 * This is local containment, not an upstream opt-out or deletion acknowledgment.
 */
async function retireOrRemoveBinding(bindingStore, key, current, { reason = 'consent-withdrawn' } = {}) {
  if (!current) return true;
  const { record, etag } = current;
  if (record.state === 'retiring') return true;
  const retired = retirementRecord(record, reason);
  if (!retired) return bindingStore.remove(key, { ifMatch: etag });
  return Boolean(await bindingStore.put(key, retired, { ifMatch: etag }));
}

/** Retires known subject IDs; removes only anonymous claims, limited to the withdrawn generation. */
async function removeBindingsForSubject(store, subject, { collection = BINDING_COLLECTION, grantId } = {}) {
  try {
    const coll = store.collection(collection);
    const scope = {
      'record.subject': subject,
      ...(grantId === undefined ? {} : { 'record.consentGrantId': grantId }),
      'record.state': { $ne: 'retiring' },
    };
    let changed = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // The repo store strips _id from reads. Match the opaque etag plus subject/generation instead;
      // a concurrent refresh is retried, and a newer consent generation is never touched.
      // eslint-disable-next-line no-await-in-loop
      const docs = await coll.find(scope);
      if (!docs.length) return changed;
      for (const doc of docs) {
        const filter = { ...scope, etag: doc.etag };
        const retired = retirementRecord(doc.record, 'consent-withdrawn');
        // eslint-disable-next-line no-await-in-loop
        const res = retired
          ? await coll.updateOne(filter, { $set: { etag: crypto.randomUUID(), record: retired } })
          : await coll.deleteOne(filter);
        changed += retired ? res?.matchedCount ?? 0 : res?.deletedCount ?? 0;
      }
    }
    if ((await coll.find(scope)).length) throw new Error('Binding retirement conflict');
    return changed;
  } catch (e) {
    if (isNotFound(e)) return 0;
    throw e;
  }
}

module.exports = {
  BINDING_COLLECTION, createBindingStore, removeBindingsForSubject, retireOrRemoveBinding,
};
