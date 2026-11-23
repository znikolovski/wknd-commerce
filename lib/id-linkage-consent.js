/**
 * ID-linkage consent: a separate, optional purpose that authorizes the Stage Target diagnostic to link
 * the shopper's verified Auth0 `sub` to a server-issued ECID through the Audience Manager ID Service.
 * OFF by default (TARGET_ID_LINKAGE_ENABLED) and never inferred:
 * - Granted only by an explicit, authenticated, first-party request from the shopper (website or app).
 *   Delegated agents (the ChatGPT/LLM app), email purposes and system jobs never grant it.
 * - Granted only under a server-approved wording version (TARGET_ID_LINKAGE_WORDING_VERSIONS); no
 *   wording is approved by default, so no grant is possible until legal sign-off.
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

/** Withdraws a pending or granted generation for `sub`; otherwise a no-op (false). */
async function withdraw(store, sub, { source, clock, randomUUID }) {
  const at = new Date(clock()).toISOString();
  const customers = store.collection('customers');
  const active = { sub, 'idLinkage.state': { $in: ['pending', 'granted'] } };
  const customer = await customers.findOne(active);
  if (!customer) return false;
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
  // State first (fail safe), then bindings, then evidence.
  await removeBindingsForSubject(store, sha256(sub), { grantId: customer.idLinkage.grantId });
  try {
    await appendEvent(store, {
      sub, optIn: false, source, wordingVersion: null, grantId: null, at, randomUUID,
    });
  } catch {
    throw new IdLinkageError('EVIDENCE_FAILED', 'The setting could not be saved.');
  }
  return true;
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
    const changed = await withdraw(store, customer.sub, { source, clock, randomUUID });
    return { state: 'withdrawn', changed };
  }
  if (!config.enabled) throw new IdLinkageError('DISABLED', 'ID linkage is not available.');
  if (!GRANT_SOURCES.includes(source)) throw new IdLinkageError('INVALID', 'Unknown consent source.');
  if (typeof wordingVersion !== 'string' || !config.wordingVersions.includes(wordingVersion)) {
    throw new IdLinkageError('WORDING_NOT_APPROVED', 'This consent wording is not approved.');
  }
  const customers = store.collection('customers');
  const grantId = randomUUID();
  const at = new Date(clock()).toISOString();
  const res = await customers.updateOne(
    { sub: customer.sub, 'idLinkage.state': { $nin: ['pending', 'granted'] } },
    {
      $set: {
        idLinkage: {
          state: 'pending', grantId, source, wordingVersion, updatedAt: at,
        },
      },
    },
  );
  if ((res?.matchedCount ?? 0) !== 1) {
    const existing = await customers.findOne({ sub: customer.sub });
    if (!existing) throw new IdLinkageError('NO_CUSTOMER', 'Sign in on the WKND website first.');
    if (existing.idLinkage?.state === 'granted') return { state: 'granted', changed: false };
    throw new IdLinkageError('CONFLICT', 'The setting changed; try again.');
  }
  try {
    await appendEvent(store, {
      sub: customer.sub, optIn: true, source, wordingVersion, grantId, at, randomUUID,
    });
  } catch (e) {
    // No evidence, no grant: revert exactly this grant (a newer change is left alone).
    await customers.updateOne(
      { sub: customer.sub, 'idLinkage.state': 'pending', 'idLinkage.grantId': grantId },
      {
        $set: {
          idLinkage: {
            state: 'withdrawn', grantId: null, source: 'evidence-failure', wordingVersion: null, updatedAt: at,
          },
        },
      },
    );
    throw new IdLinkageError('EVIDENCE_FAILED', 'The setting could not be saved.');
  }
  const activated = await customers.updateOne(
    { sub: customer.sub, 'idLinkage.state': 'pending', 'idLinkage.grantId': grantId },
    { $set: { 'idLinkage.state': 'granted' } },
  );
  if ((activated?.matchedCount ?? 0) !== 1) {
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
  let withdrawn = 0;
  for (let i = 0; i < granted.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await withdraw(store, granted[i].sub, { source: 'brevo-unsubscribe', clock, randomUUID })) withdrawn += 1;
  }
  return withdrawn;
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
  GRANT_SOURCES,
  IdLinkageError,
  linkageConfig,
  setIdLinkageConsent,
  withdrawIdLinkageForEmail,
  createIdLinkageConsentSource,
};
