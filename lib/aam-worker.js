const { createBindingStore } = require('./target-binding-store');
const { AamError, integer, sourceConfig } = require('./aam-outbound');
const {
  MEMBERSHIPS, IDENTITIES, PROJECTIONS, LEASE_MS, emailHash, drainInbox, pendingInbox,
  verifiedIdentity, marketingAllowed, acquireWorker, releaseWorker,
} = require('./aam-membership');
const { createBrevoListClient } = require('./brevo-lists');

function listConfig(params, config) {
  let lists;
  try {
    lists = JSON.parse(params.AAM_BREVO_LISTS);
  } catch {
    throw new AamError('BREVO_LIST_CONFIG_INVALID', 503);
  }
  if (!lists || typeof lists !== 'object' || Array.isArray(lists)
    || Object.keys(lists).some((id) => !config.segments.includes(id))
    || Object.keys(lists).length !== config.segments.length) throw new AamError('BREVO_LIST_CONFIG_INVALID', 503);
  const values = Object.values(lists).map(integer);
  if (values.some((id) => !id) || new Set(values).size !== values.length) {
    throw new AamError('BREVO_LIST_CONFIG_INVALID', 503);
  }
  return Object.fromEntries(Object.entries(lists).map(([segment, id]) => [segment, integer(id)]));
}

async function desiredIdentity(store, params, config, row, now) {
  if (!config.segments.includes(row.segmentId) || row.state !== 'observed-active'
    || Math.min(row.expiresAt, row.qualifiedAt + config.ttlMs) <= now
    || await pendingInbox(store, config)) return null;
  const identity = await verifiedIdentity(store, params, config, row.identityKey, now);
  return identity && await marketingAllowed(store, identity, now) ? identity : null;
}

async function prepareContact(store, identity, client) {
  const verifiedEmailHash = emailHash(identity.customer.email);
  if (identity.mapping.verifiedEmailHash === verifiedEmailHash
    && Number.isSafeInteger(identity.mapping.brevoContactId) && identity.mapping.brevoContactId > 0) return identity;
  const contact = await client.contactByEmail(identity.customer.email);
  if (emailHash(contact.email) !== verifiedEmailHash) throw new AamError('BREVO_IDENTITY_CHANGED', 503);
  const identities = createBindingStore(store, { collection: IDENTITIES });
  const current = await identities.get(identity.mapping.identityKey);
  if (!current || current.record.customerSub !== identity.customer.sub
    || current.record.consentGeneration !== identity.mapping.consentGeneration) throw new AamError('IDENTITY_CHANGED', 503);
  const mapping = {
    ...current.record, verifiedEmailHash, emailVerificationSource: 'auth0-email-verified', brevoContactId: contact.id,
  };
  if (!await identities.put(identity.mapping.identityKey, mapping, { ifMatch: current.etag })) {
    throw new AamError('IDENTITY_CHANGED', 503);
  }
  return { ...identity, mapping };
}

async function syncProjection({ store, params, config, row, listId, client, now }) {
  const projections = createBindingStore(store, { collection: PROJECTIONS });
  let current = await projections.get(row.key);
  let desired = await desiredIdentity(store, params, config, row, now());
  if (current?.record.state === 'unknown' || current?.record.state === 'pending'
    || current?.record.blocked) desired = null;
  if (desired) desired = await prepareContact(store, desired, client);
  const previous = current?.record;
  const sameContact = desired && previous?.contactId === desired.mapping.brevoContactId
    && previous?.emailHash === desired.mapping.verifiedEmailHash && previous?.listId === listId;
  if (previous && !sameContact && previous.state !== 'absent' && previous.state !== 'blocked') desired = null;
  if (!desired && (!previous || ['absent', 'blocked'].includes(previous.state))) return 'unchanged';
  const contactId = desired ? desired.mapping.brevoContactId : previous.contactId;
  const targetList = desired ? listId : previous.listId;
  const contact = await client.contact(contactId);
  const expectedEmailHash = desired ? desired.mapping.verifiedEmailHash : previous.emailHash;
  if (emailHash(contact.email) !== expectedEmailHash) throw new AamError('BREVO_IDENTITY_CHANGED', 503);
  if (desired && contact.emailBlacklisted) desired = null;
  if (!desired && !previous) return 'suppressed';
  const add = Boolean(desired);
  const blocked = previous?.blocked === true || ['pending', 'unknown'].includes(previous?.state);
  if (contact.listIds.includes(targetList) === add) {
    const record = {
      scopeKey: config.scopeKey, key: row.key, contactId, listId: targetList,
      emailHash: expectedEmailHash, state: add ? 'present' : blocked ? 'blocked' : 'absent', blocked,
    };
    if (!await projections.put(row.key, record, { ifMatch: current?.etag ?? null })) {
      throw new AamError('PROJECTION_CONFLICT', 503);
    }
    return 'reconciled';
  }
  if (add) {
    desired = await desiredIdentity(store, params, config, row, now());
    if (!desired || desired.mapping.brevoContactId !== contactId
      || desired.mapping.verifiedEmailHash !== expectedEmailHash) return 'deferred';
  }
  const pending = {
    scopeKey: config.scopeKey, key: row.key, contactId, listId: targetList,
    emailHash: expectedEmailHash, state: 'pending', blocked, operation: add ? 'add' : 'remove',
  };
  const etag = await projections.put(row.key, pending, { ifMatch: current?.etag ?? null });
  if (!etag) throw new AamError('PROJECTION_CONFLICT', 503);
  try {
    await client.change(targetList, contactId, add);
    const confirmed = await client.contact(contactId);
    if (emailHash(confirmed.email) !== expectedEmailHash || confirmed.listIds.includes(targetList) !== add) {
      throw new AamError('BREVO_CHANGE_UNCONFIRMED', 503);
    }
    if (add && (!await desiredIdentity(store, params, config, row, now()) || confirmed.emailBlacklisted)) {
      // A withdrawal/expiry that raced the add must remove the projection, never authorize a send.
      await client.change(targetList, contactId, false);
      const removed = await client.contact(contactId);
      if (removed.listIds.includes(targetList)) throw new AamError('BREVO_REMOVAL_UNCONFIRMED', 503);
      pending.state = 'absent';
    } else pending.state = add ? 'present' : blocked ? 'blocked' : 'absent';
    if (!await projections.put(row.key, pending, { ifMatch: etag })) throw new AamError('PROJECTION_CONFLICT', 503);
    return add && pending.state === 'present' ? 'added' : 'removed';
  } catch (error) {
    const saved = await projections.put(row.key, { ...pending, state: 'unknown', blocked: true }, { ifMatch: etag });
    if (!saved) throw new AamError('PROJECTION_CONFLICT', 503);
    throw error;
  }
}

async function runAudienceWorker({
  store, params, namespace, now = Date.now, createClient = createBrevoListClient, report = () => {},
}) {
  if (params.AAM_WORKER_ENABLED !== 'true') return { status: 'disabled' };
  if (params.AAM_CONFIG_VERIFIED !== 'true') throw new AamError('CONFIG_NOT_VERIFIED', 503);
  const config = sourceConfig(params, namespace);
  const lists = params.AAM_BREVO_SYNC_ENABLED === 'true' ? listConfig(params, config) : null;
  if (lists && params.AAM_BREVO_LISTS_VERIFIED !== 'true') throw new AamError('BREVO_LISTS_NOT_VERIFIED', 503);
  const startedAt = now();
  const lease = await acquireWorker(store, config, startedAt);
  if (!lease) return { status: 'busy' };
  const counts = { received: 0, scanned: 0, added: 0, removed: 0, deferred: 0 };
  try {
    counts.received = await drainInbox(store, config, now(), 1);
    if (!lists) return { status: 'processed', ...counts };
    const client = createClient({ apiKey: params.BREVO_API_KEY });
    const cursorStore = store.collection('aam_worker_cursors_v1');
    const cursor = await cursorStore.findOne({ key: config.scopeKey });
    const rows = await store.collection(MEMBERSHIPS).find({
      'record.scopeKey': config.scopeKey, 'record.key': { $gt: cursor?.after || '' },
    }, { sort: { 'record.key': 1 }, limit: 50 });
    for (const item of rows) {
      /* eslint-disable no-await-in-loop */
      if (now() >= startedAt + LEASE_MS - 30000) throw new AamError('WORKER_LEASE_EXPIRED', 503);
      try {
        const outcome = await syncProjection({
          store, params, config, row: item.record, listId: lists[item.record.segmentId], client, now,
        });
        if (outcome === 'added') counts.added += 1;
        if (outcome === 'removed') counts.removed += 1;
      } catch (error) {
        counts.deferred += 1;
        report({ code: error instanceof AamError ? error.code : 'BREVO_SYNC_FAILED' });
      }
      counts.scanned += 1;
      await cursorStore.updateOne({ key: config.scopeKey }, { $set: { after: item.record.key } }, { upsert: true });
      /* eslint-enable no-await-in-loop */
    }
    if (rows.length < 50) await cursorStore.updateOne({ key: config.scopeKey }, { $set: { after: '' } }, { upsert: true });
    return { status: counts.deferred ? 'partial' : 'processed', ...counts };
  } finally {
    await releaseWorker(store, config, lease);
  }
}

module.exports = { runAudienceWorker };
