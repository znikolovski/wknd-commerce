const crypto = require('node:crypto');
const { createBindingStore } = require('./target-binding-store');
const { createPersonAliasSource, DPID } = require('./person-alias');
const { INBOX, AamError, sourceConfig, hash } = require('./aam-outbound');
const { sha256 } = require('./promotion-schema');
const { hasConsent } = require('./recovery-email');

const MEMBERSHIPS = 'aam_memberships_v1';
const IDENTITIES = 'aam_destination_identities_v1';
const PROJECTIONS = 'aam_brevo_projections_v1';
const LOCKS = 'aam_worker_locks_v1';
const LEASE_MS = 5 * 60 * 1000;
const emailHash = (email) => sha256(email.trim().toLowerCase());

async function applyEvent(store, config, event) {
  const bindings = createBindingStore(store, { collection: MEMBERSHIPS });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    /* eslint-disable no-await-in-loop */
    const current = await bindings.get(event.key);
    const before = current?.record;
    if (before?.state === 'withdrawn') return;
    if (event.active && before && event.qualifiedAt <= before.qualifiedAt) return;
    const record = {
      key: event.key, scopeKey: config.scopeKey, identityKey: event.identityKey,
      segmentId: event.segmentId, state: event.active ? 'observed-active' : 'withdrawn',
      qualifiedAt: event.qualifiedAt,
      expiresAt: Math.min(event.qualifiedAt, event.processAt) + config.ttlMs,
    };
    if (await bindings.put(event.key, record, { ifMatch: current?.etag ?? null })) return;
    /* eslint-enable no-await-in-loop */
  }
  throw new AamError('MEMBERSHIP_CONFLICT', 503);
}

async function drainInbox(store, config, now, limit = 5) {
  const inbox = store.collection(INBOX);
  const pending = await inbox.find({
    scopeKey: config.scopeKey, state: { $ne: 'completed' }, complete: true,
  }, { sort: { receivedAt: 1 }, limit });
  for (const item of pending) {
    /* eslint-disable no-await-in-loop */
    for (const event of item.events) await applyEvent(store, config, event);
    const updated = await inbox.updateOne(
      { key: item.key, complete: true, state: { $ne: 'completed' } },
      { $set: { state: 'completed', completedAt: now } },
    );
    if (updated.matchedCount !== 1) throw new AamError('INBOX_CONFLICT', 503);
    /* eslint-enable no-await-in-loop */
  }
  return pending.length;
}

async function pendingInbox(store, config) {
  return Boolean(await store.collection(INBOX).findOne({
    scopeKey: config.scopeKey, state: { $ne: 'completed' },
  }));
}

async function verifiedIdentity(store, params, config, identityKey, now) {
  if (params.AAM_IDENTITY_MAPPING_VERIFIED !== 'true' || params.AAM_IDENTITY_FORMAT !== 'person-alias'
    || String(config.scope.dpid) !== DPID) return null;
  const mapping = (await createBindingStore(store, { collection: IDENTITIES }).get(identityKey))?.record;
  if (!mapping || mapping.source !== 'server-person-alias-v1' || mapping.auth0Issuer !== params.AUTH0_ISSUER
    || typeof mapping.customerSub !== 'string' || !mapping.customerSub
    || !/^wpa_[0-9a-f]{32}$/.test(mapping.personAlias || '')
    || identityKey !== hash(JSON.stringify([config.scopeKey, mapping.personAlias]))
    || !Number.isFinite(mapping.expiresAt) || mapping.expiresAt <= now
    || !Number.isFinite(mapping.verifiedAt) || mapping.verifiedAt > now) return null;
  const customer = await store.collection('customers').findOne({ sub: mapping.customerSub });
  if (!customer || customer.idLinkage?.state !== 'granted'
    || customer.idLinkage.grantId !== mapping.consentGeneration) return null;
  const source = createPersonAliasSource(store, {
    ...params, TARGET_DIAG_ENVIRONMENT: config.scope.environment, __OW_NAMESPACE: config.scope.namespace,
  }, { now: () => now });
  const result = await source.resolve({ sub: customer.sub, create: false });
  if (!result.binding || result.binding.personAlias !== mapping.personAlias
    || result.binding.consentGeneration !== mapping.consentGeneration) return null;
  return { mapping, customer };
}

async function marketingAllowed(store, identity, now) {
  const { customer } = identity;
  if (!hasConsent(customer, 'audience') || !customer.marketing.audienceEmail.wordingVersion
    || typeof customer.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)
    || customer.email.endsWith('@users.wknd.example')
    || customer.emailIdentityVerified !== true || !Number.isFinite(customer.profileFetchedAt)
    || customer.profileFetchedAt > now || customer.profileFetchedAt + 86400000 <= now) return false;
  const consent = customer.marketing.audienceEmail;
  if (!(await store.collection('marketing_consent_events').findOne({
    subject: sha256(customer.sub), subjectKind: 'customer', purpose: 'audience',
    optIn: true, at: consent.updatedAt, wordingVersion: consent.wordingVersion,
  }))) return false;
  return !(await store.collection('email_suppressions').findOne({ key: emailHash(customer.email) }));
}

async function commerceMemberships({ store, params, namespace, customer, now = Date.now() }) {
  if (params.AAM_COMMERCE_READ_ENABLED !== 'true' || params.AAM_CONFIG_VERIFIED !== 'true') return [];
  const config = sourceConfig(params, namespace);
  const unknown = () => config.segments.map((segmentId) => ({
    segment_id: segmentId, status: 'UNKNOWN', expires_at: null, financial_authorization: false,
  }));
  if (!customer?.sub || await pendingInbox(store, config)) return unknown();
  const mappings = await store.collection(IDENTITIES).find({
    'record.scopeKey': config.scopeKey, 'record.customerSub': customer.sub,
  }, { limit: 2 });
  if (mappings.length !== 1) return unknown();
  const identityKey = mappings[0].record.identityKey;
  const identity = await verifiedIdentity(store, params, config, identityKey, now);
  if (!identity) return unknown();
  const rows = await store.collection(MEMBERSHIPS).find({
    'record.scopeKey': config.scopeKey, 'record.identityKey': identityKey,
  });
  const confirmed = await verifiedIdentity(store, params, config, identityKey, now);
  if (!confirmed || confirmed.mapping.consentGeneration !== identity.mapping.consentGeneration
    || await pendingInbox(store, config)) return unknown();
  return config.segments.map((segmentId) => {
    const row = rows.find((item) => item.record.segmentId === segmentId)?.record;
    const status = row?.state === 'withdrawn' ? 'WITHDRAWN'
      : row?.state === 'observed-active' && Math.min(row.expiresAt, row.qualifiedAt + config.ttlMs) > now
        ? 'MEMBER' : 'UNKNOWN';
    return {
      segment_id: segmentId, status,
      expires_at: status === 'MEMBER' ? new Date(Math.min(row.expiresAt, row.qualifiedAt + config.ttlMs)).toISOString() : null,
      financial_authorization: false,
    };
  });
}

async function acquireWorker(store, config, now) {
  const locks = createBindingStore(store, { collection: LOCKS });
  const current = await locks.get(config.scopeKey);
  if (current?.record.until > now) return null;
  const token = crypto.randomUUID();
  const etag = await locks.put(config.scopeKey, { token, until: now + LEASE_MS }, { ifMatch: current?.etag ?? null });
  return etag ? { etag, token } : null;
}

async function releaseWorker(store, config, lease) {
  await createBindingStore(store, { collection: LOCKS }).remove(config.scopeKey, { ifMatch: lease.etag });
}

module.exports = {
  MEMBERSHIPS, IDENTITIES, PROJECTIONS, LEASE_MS, emailHash,
  drainInbox, pendingInbox, verifiedIdentity, marketingAllowed, commerceMemberships,
  acquireWorker, releaseWorker,
};
