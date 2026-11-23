/**
 * ID-linkage consent: a separate, optional purpose that authorizes the configured Target diagnostic to link
 * the shopper's verified Auth0 `sub` to a server-issued ECID through the Audience Manager ID Service.
 * OFF by default (TARGET_ID_LINKAGE_ENABLED) and never inferred:
 * - Granted only by an explicit, authenticated, first-party request from the shopper (website or app).
 *   Delegated agents (the ChatGPT/LLM app), email purposes and system jobs never grant it.
 * - Granted only under a server-approved wording version (TARGET_ID_LINKAGE_WORDING_VERSIONS); no
 *   wording is approved by default, so no grant is possible until the operational owner approves it.
 * - Authoritative state lives on the customer document, with generation-conditional updates:
 *   `idLinkage: { state:'pending'|'granted'|'withdrawn', grantId, source, wordingVersion, updatedAt }`.
 *   `grantId` is a server-issued UUID, unique per grant, so it is the generation token: a withdrawal
 *   and later reconsent can never resurrect a binding issued under an older grant.
 * - Every applied change appends to `marketing_consent_events` (purpose 'idLinkage') as evidence.
 *   Pending grants authorize nothing; evidence must succeed before that same generation activates.
 * - Withdrawal (shopper or Brevo unsubscribe, which withdraws every purpose) is always allowed, never
 *   grants, and removes stored bindings for the subject.
 * Separate from lib/recovery-email.js CONSENT_PURPOSES: those are email purposes and are not bundled.
 */
const crypto = require('node:crypto');
const { sha256 } = require('./promotion-schema');
const { shopperKey: deriveShopperKey } = require('./recovery-policy');
const { removeBindingsForSubject } = require('./target-binding-store');

const PURPOSE = 'idLinkage';
const GRANT_SOURCES = Object.freeze(['account-settings', 'ios']);
const WITHDRAW_SOURCES = Object.freeze([...GRANT_SOURCES, 'brevo-unsubscribe']);
const WORDING_VERSION = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const GRANT_ID = /^[0-9a-f-]{36}$/;
// A reservation without evidence older than this is abandoned and may be superseded. It must outlive
// the evidence insert of a live request; bounded and not an SLA.
const PENDING_LEASE_MS = 60000;

class IdLinkageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Server configuration only (manifest inputs). */
function linkageConfig(params = {}) {
  const wordingVersions = String(params.TARGET_ID_LINKAGE_WORDING_VERSIONS || '').split(',')
    .map((v) => v.trim()).filter((v) => WORDING_VERSION.test(v));
  return { enabled: params.TARGET_ID_LINKAGE_ENABLED === 'true', wordingVersions };
}

async function appendEvent(store, {
  sub, optIn, source, wordingVersion, grantId, at, randomUUID,
}) {
  const id = randomUUID();
  await store.collection('marketing_consent_events').insertOne({
    _id: id,
    id,
    subject: sha256(sub),
    subjectKind: 'customer',
    purpose: PURPOSE,
    optIn,
    source,
    wordingVersion,
    grantId,
    at,
  });
}

/**
 * Withdraws a pending or granted generation for `sub` (state first: fail safe, then bindings).
 * Resolves `null` when there is nothing to withdraw, otherwise a thunk that records the evidence
 * (throws EVIDENCE_FAILED), so withdraw-all callers can finish every state change before reporting.
 */
async function withdrawState(store, sub, { source, clock, randomUUID }) {
  const at = new Date(clock()).toISOString();
  const customers = store.collection('customers');
  const active = { sub, 'idLinkage.state': { $in: ['pending', 'granted'] } };
  const customer = await customers.findOne(active);
  if (!customer) return null;
  const res = await customers.updateOne(
    { ...active, 'idLinkage.grantId': customer.idLinkage.grantId },
    {
      $set: {
        idLinkage: {
          state: 'withdrawn', grantId: null, source, wordingVersion: null, updatedAt: at,
        },
      },
    },
  );
  if ((res?.matchedCount ?? 0) !== 1) throw new IdLinkageError('CONFLICT', 'The setting changed; try again.');
  await removeBindingsForSubject(store, sha256(sub), { grantId: customer.idLinkage.grantId });
  return async () => {
    try {
      await appendEvent(store, {
        sub, optIn: false, source, wordingVersion: null, grantId: null, at, randomUUID,
      });
    } catch {
      throw new IdLinkageError('EVIDENCE_FAILED', 'The setting could not be saved.');
    }
  };
}

/**
 * A grant found pending (another request in flight, or one interrupted after reserving). Evidence
 * already recorded for that generation under still-approved wording: activate exactly it (the retry
 * completes the interrupted grant). No evidence and the reservation lease has lapsed: supersede
 * exactly it. Otherwise it may still be in flight: CONFLICT. Never touches a newer generation.
 * @returns {Promise<'activated'|'superseded'>}
 */
async function recoverPending(store, sub, pending, { config, clock }) {
  const customers = store.collection('customers');
  const same = { sub, 'idLinkage.state': 'pending', 'idLinkage.grantId': pending.grantId };
  const evidence = typeof pending.grantId === 'string' && await store.collection('marketing_consent_events').findOne({
    subject: sha256(sub), purpose: PURPOSE, optIn: true, grantId: pending.grantId,
  });
  if (evidence && config.wordingVersions.includes(pending.wordingVersion)) {
    const res = await customers.updateOne(same, { $set: { 'idLinkage.state': 'granted' } });
    if ((res?.matchedCount ?? 0) !== 1) throw new IdLinkageError('CONFLICT', 'The setting changed; try again.');
    return 'activated';
  }
  const since = Date.parse(pending.updatedAt);
  if (Number.isFinite(since) && clock() < since + PENDING_LEASE_MS) {
    throw new IdLinkageError('CONFLICT', 'The setting changed; try again.');
  }
  return 'superseded';
}

/**
 * Explicit shopper change. `customer` must come from verified Auth0 claims (never a delegated agent).
 * @returns {Promise<{ state: 'granted'|'withdrawn', changed: boolean }>}
 */
async function setIdLinkageConsent(store, customer, optIn, {
  source = 'account-settings', wordingVersion = null, config = linkageConfig(),
  clock = Date.now, randomUUID = crypto.randomUUID,
} = {}) {
  if (typeof customer?.sub !== 'string' || !customer.sub.trim()) {
    throw new IdLinkageError('SIGN_IN_REQUIRED', 'Sign in to manage this setting.');
  }
  if (customer.delegated) {
    throw new IdLinkageError('DIRECT_SIGN_IN_REQUIRED', 'Change this setting in your WKND account.');
  }
  if (typeof optIn !== 'boolean') throw new IdLinkageError('INVALID', 'Choose whether to allow ID linkage.');
  if (!optIn) {
    if (!WITHDRAW_SOURCES.includes(source)) throw new IdLinkageError('INVALID', 'Unknown consent source.');
    const recordEvidence = await withdrawState(store, customer.sub, { source, clock, randomUUID });
    if (recordEvidence) await recordEvidence();
    return { state: 'withdrawn', changed: Boolean(recordEvidence) };
  }
  if (!config.enabled) throw new IdLinkageError('DISABLED', 'ID linkage is not available.');
  if (!GRANT_SOURCES.includes(source)) throw new IdLinkageError('INVALID', 'Unknown consent source.');
  if (typeof wordingVersion !== 'string' || !config.wordingVersions.includes(wordingVersion)) {
    throw new IdLinkageError('WORDING_NOT_APPROVED', 'This consent wording is not approved.');
  }
  const customers = store.collection('customers');
  const grantId = randomUUID();
  const at = new Date(clock()).toISOString();
  const reserve = (filter) => customers.updateOne(filter, {
    $set: {
      idLinkage: {
        state: 'pending', grantId, source, wordingVersion, updatedAt: at,
      },
    },
  });
  const res = await reserve({ sub: customer.sub, 'idLinkage.state': { $nin: ['pending', 'granted'] } });
  if ((res?.matchedCount ?? 0) !== 1) {
    const existing = await customers.findOne({ sub: customer.sub });
    if (!existing) throw new IdLinkageError('NO_CUSTOMER', 'Sign in on the WKND website first.');
    const il = existing.idLinkage;
    if (il?.state === 'granted') return { state: 'granted', changed: false };
    if (il?.state !== 'pending') throw new IdLinkageError('CONFLICT', 'The setting changed; try again.');
    if (await recoverPending(store, customer.sub, il, { config, clock }) === 'activated') {
      return { state: 'granted', changed: true };
    }
    const replaced = await reserve({ sub: customer.sub, 'idLinkage.state': 'pending', 'idLinkage.grantId': il.grantId });
    if ((replaced?.matchedCount ?? 0) !== 1) throw new IdLinkageError('CONFLICT', 'The setting changed; try again.');
  }
  const thisGrant = { sub: customer.sub, 'idLinkage.state': 'pending', 'idLinkage.grantId': grantId };
  try {
    await appendEvent(store, {
      sub: customer.sub, optIn: true, source, wordingVersion, grantId, at, randomUUID,
    });
  } catch {
    // No evidence, no grant: revert exactly this generation. If the revert itself fails the pending
    // reservation still authorizes nothing and is superseded once its lease lapses.
    await customers.updateOne(thisGrant, {
      $set: {
        idLinkage: {
          state: 'withdrawn', grantId: null, source: 'evidence-failure', wordingVersion: null, updatedAt: at,
        },
      },
    }).catch(() => {});
    throw new IdLinkageError('EVIDENCE_FAILED', 'The setting could not be saved.');
  }
  let activated;
  try {
    activated = await customers.updateOne(thisGrant, { $set: { 'idLinkage.state': 'granted' } });
  } catch {
    // Evidence exists, so a retry activates this same generation (recoverPending); never success here.
    throw new IdLinkageError('ACTIVATION_PENDING', 'The setting is still being saved; try again.');
  }
  if ((activated?.matchedCount ?? 0) !== 1) {
    const now = (await customers.findOne({ sub: customer.sub }))?.idLinkage;
    if (now?.state === 'granted' && now.grantId === grantId) return { state: 'granted', changed: true };
    throw new IdLinkageError('CONFLICT', 'The setting changed; try again.');
  }
  return { state: 'granted', changed: true };
}

/**
 * Brevo unsubscribe withdraws every marketing purpose; it withdraws ID linkage conservatively and can
 * never grant it. Reads only pending/granted customers; with neither, nothing is written.
 */
async function withdrawIdLinkageForEmail(store, email, { clock = Date.now, randomUUID = crypto.randomUUID } = {}) {
  const variants = [...new Set([String(email).trim(), String(email).trim().toLowerCase()])];
  const granted = await store.collection('customers').find({ email: { $in: variants }, 'idLinkage.state': { $in: ['pending', 'granted'] } });
  // Every customer's state change is attempted before any failure is reported; evidence comes last.
  const stateErrors = [];
  const pendingEvidence = [];
  for (let i = 0; i < granted.length; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const recordEvidence = await withdrawState(store, granted[i].sub, { source: 'brevo-unsubscribe', clock, randomUUID });
      if (recordEvidence) pendingEvidence.push(recordEvidence);
    } catch (e) {
      stateErrors.push(e);
    }
  }
  const evidence = await Promise.allSettled(pendingEvidence.map((record) => record()));
  if (stateErrors.length) throw stateErrors[0];
  const failed = evidence.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  return pendingEvidence.length;
}

/**
 * Authoritative consent source for the binding provider. Throws on store failure (the provider then
 * treats consent as unknown: deny, no mutation).
 */
function createIdLinkageConsentSource(store, { issuer }) {
  return {
    async lookup({ shopperKey, sub }) {
      if (!issuer || typeof sub !== 'string' || shopperKey !== deriveShopperKey(issuer, sub)) {
        return { state: 'unknown' };
      }
      const customer = await store.collection('customers').findOne({ sub });
      const il = customer?.idLinkage;
      if (!il) return { state: 'absent' };
      if (il.state === 'granted') {
        return typeof il.grantId === 'string' && GRANT_ID.test(il.grantId)
          ? { state: 'granted', grantId: il.grantId } : { state: 'unknown' };
      }
      if (il.state === 'withdrawn') return { state: 'withdrawn' };
      return { state: 'unknown' };
    },
  };
}

module.exports = {
  PURPOSE,
  PENDING_LEASE_MS,
  GRANT_SOURCES,
  IdLinkageError,
  linkageConfig,
  setIdLinkageConsent,
  withdrawIdLinkageForEmail,
  createIdLinkageConsentSource,
};
