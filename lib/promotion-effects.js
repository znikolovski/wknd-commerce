/**
 * Canonical promotion side effects. A committed promotion mutation records one durable effect
 * intent (global promotion invalidation) before it is executed. The storefront evaluates
 * definitions per request from authoritative storage, so invalidation bumps the promotion
 * version used by any cache; it never touches product sale prices or public PDP prerenders.
 */
const { newEffectId, WARNINGS } = require('./promotion-schema');
const { isDuplicateKeyError } = require('./store');

const PROMOTION_VERSION_KEY = 'promotions-version';

async function getPromotionVersion(store) {
  const doc = await store.collection('counters').findOne({ key: PROMOTION_VERSION_KEY });
  return doc?.value || 0;
}

async function bumpPromotionVersion(store) {
  await store.collection('counters').updateOne({ key: PROMOTION_VERSION_KEY }, { $inc: { value: 1 } }, { upsert: true });
}

function effectsView(effect) {
  if (!effect || effect.status === 'complete') return { status: 'complete', warnings: [], retryReference: null };
  if (effect.status === 'failed') {
    return {
      status: 'failed',
      warnings: [{ code: 'PROMOTION_CACHE_INVALIDATION_FAILED', message: WARNINGS.PROMOTION_CACHE_INVALIDATION_FAILED }],
      retryReference: effect.effectId,
    };
  }
  return {
    status: 'pending',
    warnings: [{ code: 'PROMOTION_EFFECTS_PENDING', message: WARNINGS.PROMOTION_EFFECTS_PENDING }],
    retryReference: effect.effectId,
  };
}

/** Upper bound used by output-size preflight. */
const MAX_EFFECTS_VIEW = {
  status: 'pending',
  warnings: Object.entries(WARNINGS).map(([code, message]) => ({ code, message })).sort((a, b) => (a.code < b.code ? -1 : 1)),
  retryReference: 'eff_ffffffffffffffffffffffffffffffff',
};

function createEffects({ store, clock }) {
  const effects = () => store.collection('promotion_effects');
  return {
    /** Idempotent: one intent per mutation, keyed by the effect id reserved at request claim. */
    async record({
      promotionId, revision, affected, effectId = newEffectId(),
    }) {
      const doc = {
        _id: effectId,
        effectId,
        kind: 'promotion-invalidation',
        promotionId,
        revision,
        scope: affected.scope,
        status: 'pending',
        attempts: 0,
        createdAt: new Date(clock()).toISOString(),
      };
      try {
        await effects().insertOne(doc);
        return doc;
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
        return effects().findOne({ effectId });
      }
    },
    async execute(effect) {
      try {
        await bumpPromotionVersion(store);
        await effects().updateOne({ effectId: effect.effectId }, { $set: { status: 'complete', settledAt: new Date(clock()).toISOString() }, $inc: { attempts: 1 } });
        return { ...effect, status: 'complete' };
      } catch (e) {
        await effects().updateOne({ effectId: effect.effectId }, { $set: { status: 'failed' }, $inc: { attempts: 1 } }).catch(() => {});
        return { ...effect, status: 'failed' };
      }
    },
    async get(id) {
      return id ? effects().findOne({ effectId: id }) : null;
    },
    async retryUnsettled({ limit = 50 } = {}) {
      const list = await effects().find({ status: { $in: ['pending', 'failed'] } }, { limit });
      const results = [];
      for (let i = 0; i < list.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await this.execute(list[i]));
      }
      return results;
    },
  };
}

module.exports = {
  createEffects, effectsView, MAX_EFFECTS_VIEW, getPromotionVersion, bumpPromotionVersion, PROMOTION_VERSION_KEY,
};
