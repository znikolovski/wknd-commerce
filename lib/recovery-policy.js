/**
 * Protected cart-recovery offer policy (wknd.promotions/v1 §2 "Protected recovery rules", §8).
 *
 * The server binds a protected promotion to an immutable private policy version and stable
 * campaign identity. Generic management may change only name/enabled. Eligibility is the
 * backend operational cohort (signed-in owner of a non-empty active cart, inactive 24h..7d, no
 * purchase since) — not verified AAM membership. One redemption per verified shopper per stable
 * campaign is enforced with a unique-key reservation across carts and both order paths.
 */
const { sha256, canonicalJson, DEFINITION_KEYS } = require('./promotion-schema');
const { isDuplicateKeyError } = require('./store');

const HOUR = 3600 * 1000;
const POLICY_V1 = Object.freeze({
  policyVersion: 1,
  basisPoints: 1000,
  capMinor: 2500,
  minInactivityMs: 24 * HOUR,
  maxInactivityMs: 7 * 24 * HOUR,
  requiresAudienceMembership: false,
});

const DEFAULT_CAMPAIGN = Object.freeze({
  campaignId: 'wknd-cart-recovery-2026',
  code: 'RECOVER10',
  name: 'Welcome back — 10% off your gear (max $25)',
});

const approvedDefinition = (code) => ({
  mode: 'coupon',
  code,
  discount: { kind: 'percentage', basisPoints: POLICY_V1.basisPoints },
  maxDiscountMinor: POLICY_V1.capMinor,
  minimumMerchandiseMinor: null,
  target: { kind: 'all' },
  startsAt: null,
  endsAt: null,
  audienceRestriction: null,
});

const promotionIdFor = (campaignId) => `prm_${sha256(`recovery:${campaignId}`).slice(0, 32)}`;
const shopperKey = (issuer, sub) => sha256(canonicalJson(['auth0', issuer, sub]));
const redemptionKey = (shopper, campaignId) => sha256(canonicalJson(['recovery-redemption', shopper, campaignId]));

/**
 * Verified redemption-storage capability. Must only be set after the unique-key/conditional
 * update behaviour has been proven against the real Database Storage instance.
 */
function readiness(params = {}) {
  const storage = params.RECOVERY_REDEMPTION_VERIFIED === 'true' || params.RECOVERY_REDEMPTION_VERIFIED === true;
  return { ready: storage, storage, audience: false };
}

/** Fields an existing protected definition must keep (all except name/enabled). */
const PROTECTED_KEYS = DEFINITION_KEYS.filter((k) => k !== 'name' && k !== 'enabled');

function integrityOk(policy, doc) {
  if (!policy || policy.promotionId !== doc.id || policy.policyVersion !== POLICY_V1.policyVersion) return false;
  const approved = policy.approved;
  return PROTECTED_KEYS.every((k) => canonicalJson(k === 'audienceRestriction' ? null : doc[k]) === canonicalJson(approved[k]));
}

/**
 * Presence/equality check against the approved policy for a raw full-update definition.
 * Comparison uses normalized values supplied by the caller where valid.
 * @returns {Array} field errors with reason PROTECTED
 */
function protectedViolations(policy, rawDefinition, normalized) {
  const fields = [];
  PROTECTED_KEYS.forEach((k) => {
    const path = `/promotion/${k}`;
    if (!rawDefinition || rawDefinition[k] === undefined) {
      fields.push({ path, code: 'PROTECTED', message: 'Field is managed by the recovery policy.' });
      return;
    }
    if (canonicalJson(normalized[k]) !== canonicalJson(policy.approved[k])) {
      fields.push({ path, code: 'PROTECTED', message: 'Field is managed by the recovery policy.' });
    }
  });
  return fields;
}

async function loadPolicies(store, ids) {
  if (!ids.length) return new Map();
  const list = await store.collection('recovery_policies').find({ promotionId: { $in: ids } });
  return new Map(list.map((p) => [p.promotionId, p]));
}

const activityOf = (cart) => Date.parse(cart.activityAt || cart.updatedAt || cart.createdAt);

/**
 * Operational recovery cohort check (no writes).
 * @returns {Promise<{eligible:boolean, reason?:string, episodeStart?:number, expiresAt?:number}>}
 */
async function qualifyingEpisode(store, { customer, cart, nowMs }) {
  if (!customer?.sub) return { eligible: false, reason: 'SIGN_IN_REQUIRED' };
  if (!cart || cart.status !== 'active' || cart.customerSub !== customer.sub) return { eligible: false, reason: 'CART_NOT_ELIGIBLE' };
  if (!cart.items?.length) return { eligible: false, reason: 'CART_EMPTY' };
  const start = activityOf(cart);
  if (!Number.isFinite(start)) return { eligible: false, reason: 'CART_NOT_ELIGIBLE' };
  const idle = nowMs - start;
  if (idle < POLICY_V1.minInactivityMs || idle > POLICY_V1.maxInactivityMs) return { eligible: false, reason: 'NOT_IN_RECOVERY_WINDOW' };
  const purchases = await store.collection('orders').countDocuments({
    customerSub: customer.sub, createdAt: { $gte: new Date(start).toISOString() },
  });
  if (purchases) return { eligible: false, reason: 'PURCHASED_SINCE' };
  return { eligible: true, episodeStart: start, expiresAt: start + POLICY_V1.maxInactivityMs };
}

function createRecovery({ store, params = {}, clock = Date.now }) {
  const issuer = params.AUTH0_ISSUER || '';
  const entitlements = () => store.collection('recovery_entitlements');
  const redemptions = () => store.collection('recovery_redemptions');

  async function protectedPromotion() {
    const policies = await store.collection('recovery_policies').find({}, { limit: 10 });
    for (let i = 0; i < policies.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const doc = await store.collection('promotions').findOne({ id: policies[i].promotionId, fenced: { $ne: true } });
      if (doc && doc.managementClass === 'protected-recovery') return { doc, policy: policies[i] };
    }
    return null;
  }

  const bindingFor = (customer) => (customer?.sub && issuer ? shopperKey(issuer, customer.sub) : null);

  return {
    readiness: () => readiness(params),

    /**
     * Read-only status for the shopper's cart.
     */
    async offerStatus({ customer, cart }) {
      const nowMs = clock();
      if (!customer?.sub) return { status: 'SIGN_IN_REQUIRED' };
      const found = await protectedPromotion();
      if (!found || !found.doc.enabled || !integrityOk(found.policy, found.doc) || !readiness(params).ready || !issuer) {
        return { status: 'UNAVAILABLE' };
      }
      const shopper = bindingFor(customer);
      const redeemed = await redemptions().findOne({ key: redemptionKey(shopper, found.policy.campaignId) });
      if (redeemed) return { status: 'REDEEMED', promotion: found.doc };
      const ent = await entitlements().findOne({
        shopper, campaignId: found.policy.campaignId, cartId: cart?.id, expiresAtMs: { $gt: nowMs },
      });
      if (ent) return { status: 'CLAIMED', promotion: found.doc, expiresAt: new Date(ent.expiresAtMs).toISOString() };
      const ep = await qualifyingEpisode(store, { customer, cart, nowMs });
      if (!ep.eligible) return { status: 'INELIGIBLE', reason: ep.reason };
      return { status: 'ELIGIBLE', promotion: found.doc, expiresAt: new Date(ep.expiresAt).toISOString() };
    },

    /** Idempotently issues the customer/campaign/episode-bound entitlement. */
    async claim({ customer, cart }) {
      const status = await this.offerStatus({ customer, cart });
      if (status.status !== 'ELIGIBLE') return status;
      const found = await protectedPromotion();
      const nowMs = clock();
      const ep = await qualifyingEpisode(store, { customer, cart, nowMs });
      if (!ep.eligible) return { status: 'INELIGIBLE', reason: ep.reason };
      const shopper = bindingFor(customer);
      const key = sha256(canonicalJson(['recovery-entitlement', shopper, found.policy.campaignId, cart.id, ep.episodeStart]));
      try {
        await entitlements().insertOne({
          _id: key,
          key,
          shopper,
          campaignId: found.policy.campaignId,
          promotionId: found.doc.id,
          cartId: cart.id,
          episodeStart: new Date(ep.episodeStart).toISOString(),
          issuedAt: new Date(nowMs).toISOString(),
          expiresAtMs: ep.expiresAt,
        });
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
      }
      return { status: 'CLAIMED', promotion: found.doc, expiresAt: new Date(ep.expiresAt).toISOString() };
    },

    /**
     * Preloads the server-side trust decision for protected promotions on one cart.
     * @returns {Promise<Function>} (promotion) => { ok, capMinor? } | { ok:false, code }
     */
    async trustFor({ customer, cart, promotions }) {
      const protectedDocs = promotions.filter((p) => p.managementClass === 'protected-recovery');
      if (!protectedDocs.length) return () => ({ ok: true });
      const nowMs = clock();
      const policies = await loadPolicies(store, protectedDocs.map((p) => p.id));
      const shopper = bindingFor(customer);
      const decisions = new Map();
      await Promise.all(protectedDocs.map(async (p) => {
        const policy = policies.get(p.id);
        if (!policy || !integrityOk(policy, p) || !readiness(params).ready) {
          decisions.set(p.id, { ok: false, code: 'COUPON_ELIGIBILITY_UNAVAILABLE' });
          return;
        }
        if (policy.requiresAudienceMembership) {
          decisions.set(p.id, { ok: false, code: 'COUPON_ELIGIBILITY_UNAVAILABLE' });
          return;
        }
        if (!shopper || !cart || cart.customerSub !== customer.sub) {
          decisions.set(p.id, { ok: false, code: 'COUPON_SHOPPER_INELIGIBLE' });
          return;
        }
        const [redeemed, ent] = await Promise.all([
          redemptions().findOne({ key: redemptionKey(shopper, policy.campaignId) }),
          entitlements().findOne({
            shopper, campaignId: policy.campaignId, cartId: cart.id, expiresAtMs: { $gt: nowMs },
          }),
        ]);
        if (redeemed) decisions.set(p.id, { ok: false, code: 'RECOVERY_ALREADY_REDEEMED' });
        else if (!ent) decisions.set(p.id, { ok: false, code: 'COUPON_SHOPPER_INELIGIBLE' });
        else decisions.set(p.id, { ok: true, capMinor: POLICY_V1.capMinor, campaignId: policy.campaignId });
      }));
      return (p) => (p.managementClass === 'protected-recovery'
        ? decisions.get(p.id) || { ok: false, code: 'COUPON_ELIGIBILITY_UNAVAILABLE' }
        : { ok: true });
    },

    /**
     * Reserves the single campaign redemption before stock reservation. Throws
     * RECOVERY_ALREADY_REDEEMED when another cart/path holds or used it.
     */
    async reserveRedemption({ customer, promotion, cartId }) {
      const policy = (await loadPolicies(store, [promotion.id])).get(promotion.id);
      if (!policy || !readiness(params).ready) {
        const err = new Error('Coupon eligibility cannot currently be verified.');
        err.code = 'COUPON_ELIGIBILITY_UNAVAILABLE';
        throw err;
      }
      const key = redemptionKey(bindingFor(customer), policy.campaignId);
      try {
        await redemptions().insertOne({
          _id: key, key, state: 'reserved', cartId, campaignId: policy.campaignId, promotionId: promotion.id, reservedAt: new Date(clock()).toISOString(),
        });
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
        const err = new Error('This offer has already been used.');
        err.code = 'RECOVERY_ALREADY_REDEEMED';
        throw err;
      }
      return {
        key,
        /** Only call when no order was durably created (proven no-commit). */
        release: () => redemptions().deleteOne({ key, cartId, state: 'reserved' }),
        confirm: (orderNumber) => redemptions().updateOne({ key, cartId }, { $set: { state: 'redeemed', orderNumber, redeemedAt: new Date(clock()).toISOString() } }),
      };
    },
  };
}

/**
 * Internal bootstrap (never exposed through MCP): binds a protected recovery promotion to the
 * immutable policy and stable campaign. Created disabled. Idempotent; never overwrites edits.
 */
async function bootstrapRecoveryPromotion(store, { campaign = DEFAULT_CAMPAIGN, clock = Date.now } = {}) {
  const id = promotionIdFor(campaign.campaignId);
  const at = new Date(clock()).toISOString();
  const approved = approvedDefinition(campaign.code);
  const existingCode = await store.collection('promotion_codes').findOne({ code: campaign.code });
  if (existingCode && existingCode.promotionId !== id) {
    const err = new Error('Recovery coupon code is already reserved.');
    err.code = 'MIGRATION_CONFLICT';
    throw err;
  }
  if (!existingCode) {
    await store.collection('promotion_codes').insertOne({
      _id: campaign.code, code: campaign.code, promotionId: id, reservedBy: 'recovery-bootstrap', protected: true,
    }).catch((e) => { if (!isDuplicateKeyError(e)) throw e; });
  }
  const policy = {
    _id: id, promotionId: id, policyVersion: POLICY_V1.policyVersion, campaignId: campaign.campaignId, approved, requiresAudienceMembership: false, createdAt: at,
  };
  await store.collection('recovery_policies').insertOne(policy).catch((e) => { if (!isDuplicateKeyError(e)) throw e; });
  const doc = {
    _id: id,
    id,
    slot: 1,
    revision: 1,
    managementClass: 'protected-recovery',
    name: campaign.name,
    enabled: false,
    ...approved,
    createdAt: at,
    updatedAt: at,
    recentSlots: [{ slot: 1, ref: 'recovery-bootstrap' }],
    private: {},
  };
  let created = true;
  await store.collection('promotions').insertOne(doc).catch((e) => {
    if (!isDuplicateKeyError(e)) throw e;
    created = false;
  });
  return { id, created };
}

module.exports = {
  POLICY_V1,
  DEFAULT_CAMPAIGN,
  PROTECTED_KEYS,
  approvedDefinition,
  promotionIdFor,
  shopperKey,
  redemptionKey,
  readiness,
  integrityOk,
  protectedViolations,
  qualifyingEpisode,
  createRecovery,
  bootstrapRecoveryPromotion,
};
