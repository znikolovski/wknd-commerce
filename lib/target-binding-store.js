/**
 * Compare-and-set adapter for the Target ECID binding store (lib/target-id-binding.js contract), built
 * on the repo store surface (insertOne duplicate-key / updateOne matchedCount / deleteOne deletedCount,
 * the same primitives lib/cart.js relies on). INERT: the collection is touched only from
 * actions/target-diagnostic after every live gate is approved, or by withdrawal of an existing grant.
 * No unconditional setup: nothing creates the collection eagerly.
 *
 * Document: { _id: shopperKey, etag, record }. `etag` is a random UUID per write, so an etag is never
 * reused for a key even after removal (a restarting counter would let a stale holder's write match).
 * `record.subject` = sha256(sub) lets withdrawal paths that know only the customer remove bindings.
 */
const crypto = require('node:crypto');
const { isDuplicateKeyError, isNotFound } = require('./store');

const BINDING_COLLECTION = 'target_id_bindings';

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

/** Removes subject bindings, optionally limited to a withdrawn generation. A missing collection is 0. */
async function removeBindingsForSubject(store, subject, { collection = BINDING_COLLECTION, grantId } = {}) {
  try {
    const res = await store.collection(collection).deleteMany({
      'record.subject': subject,
      ...(grantId === undefined ? {} : { 'record.consentGrantId': grantId }),
    });
    return res?.deletedCount ?? 0;
  } catch (e) {
    if (isNotFound(e)) return 0;
    throw e;
  }
}

module.exports = { BINDING_COLLECTION, createBindingStore, removeBindingsForSubject };
