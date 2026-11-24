const crypto = require('node:crypto');
const { createMemoryStore } = require('../lib/store');
const { createBindingStore } = require('../lib/target-binding-store');
const { shopperKey } = require('../lib/recovery-policy');
const { ORG_ID, DPID, createPersonAliasSource } = require('../lib/person-alias');
const { registerDestinationIdentity } = require('../lib/aam-identity');
const { INBOX, MAX_BYTES, hash, sourceConfig, createReceiver } = require('../lib/aam-outbound');
const {
  MEMBERSHIPS, IDENTITIES, PROJECTIONS, commerceMemberships, emailHash,
} = require('../lib/aam-membership');
const { runAudienceWorker } = require('../lib/aam-worker');
const { createBrevoListClient } = require('../lib/brevo-lists');

const NOW = Date.parse('2026-11-24T06:00:00Z');
const DATE = 'Tue Nov 24 06:00:00 UTC 2026';
const namespace = '28538-wkndcommerce';
const alias = 'wpa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const sub = 'auth0|unit-test-existing-customer';
const grant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const params = {
  AAM_RECEIVER_ENABLED: 'true', AAM_WORKER_ENABLED: 'true', AAM_CONFIG_VERIFIED: 'true',
  AAM_ENVIRONMENT: 'production', AAM_DESTINATION_ID: '423', AAM_CLIENT_ID: 'test-wknd',
  AAM_USER_DPID: DPID, AAM_SEGMENT_ALLOWLIST: '27507403,27507404', AAM_MEMBERSHIP_TTL_MS: '60000',
  AAM_SIGNATURE_ALGORITHM: 'sha256', AAM_SIGNATURE_HEADER: 'x-aam-signature',
  AAM_SIGNATURE_SECRET: 'offline-test-signing-key-not-a-deploy-secret',
  AAM_IDENTITY_FORMAT: 'person-alias', AAM_IDENTITY_MAPPING_VERIFIED: 'true', AAM_COMMERCE_READ_ENABLED: 'true',
  AAM_BREVO_SYNC_ENABLED: 'false', AAM_BREVO_LISTS_VERIFIED: 'true', AAM_BREVO_LISTS: '{"27507403":11,"27507404":12}',
  AUTH0_ISSUER: 'https://unit-test.auth0.invalid/',
  TARGET_PERSON_ALIAS_APPROVED: 'true', TARGET_ID_LINKAGE_ENABLED: 'true',
  TARGET_ID_BINDING_STORE_APPROVED: 'true', TARGET_ID_ORG_ID: ORG_ID, TARGET_ID_DPID: DPID,
};

function payload(segments = [{ Segment_ID: '27507403', Status: '1', DateTime: DATE }]) {
  return {
    ProcessTime: DATE, User_DPID: DPID, Client_ID: 'test-wknd', AAM_Destination_Id: '423', User_count: '1',
    Users: [{ AAM_UUID: '19393572368547369350319949416899715727', DataPartner_UUID: alias, Segments: segments }],
  };
}

function signed(body, extra = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return {
    ...params, __ow_method: 'post', __ow_body: bytes.toString('base64'),
    __ow_headers: {
      'content-type': 'application/json',
      'x-aam-signature': crypto.createHmac('sha256', params.AAM_SIGNATURE_SECRET).update(bytes).digest('base64'),
    },
    ...extra,
  };
}

function harness() {
  const store = createMemoryStore();
  const report = jest.fn();
  const getStore = jest.fn(async () => store);
  const receive = createReceiver({ getStore, report, now: () => NOW, namespace: () => namespace });
  const worker = (extra = {}, options = {}) => runAudienceWorker({
    store, params: { ...params, ...extra }, namespace, now: () => NOW, report, ...options,
  });
  return { store, report, getStore, receive, worker };
}

async function existingIdentity(store) {
  const config = sourceConfig(params, namespace);
  const identityKey = hash(JSON.stringify([config.scopeKey, alias]));
  const customer = {
    sub, email: 'existing@example.invalid', emailIdentityVerified: true, profileFetchedAt: NOW,
    idLinkage: { state: 'granted', grantId: grant },
    marketing: { audienceEmail: { optIn: true, wordingVersion: 'test-v1', updatedAt: DATE } },
  };
  await store.collection('customers').insertOne(customer);
  const scope = {
    environment: 'production', runtimeNamespace: namespace, orgId: ORG_ID, dpid: DPID,
    namespace: 'wkndCustomerId', issuer: `https://${namespace}.adobeioruntime.net/api/v1/web/commerce/target-diagnostic`,
  };
  const key = hash(JSON.stringify([scope, params.AUTH0_ISSUER, shopperKey(params.AUTH0_ISSUER, sub)]));
  await createBindingStore(store, { collection: 'person_aliases_v1' }).put(key, { ...scope, alias }, { ifMatch: null });
  await createBindingStore(store, { collection: IDENTITIES }).put(identityKey, {
    identityKey, scopeKey: config.scopeKey, source: 'server-person-alias-v1', customerSub: sub,
    personAlias: alias, auth0Issuer: params.AUTH0_ISSUER, consentGeneration: grant,
    verifiedAt: NOW, expiresAt: NOW + 86400000,
    verifiedEmailHash: emailHash(customer.email), emailVerificationSource: 'auth0-email-verified', brevoContactId: 7,
  }, { ifMatch: null });
  await store.collection('marketing_consent_events').insertOne({
    subject: hash(sub), subjectKind: 'customer', purpose: 'audience', optIn: true, at: DATE, wordingVersion: 'test-v1',
  });
  return customer;
}

describe('Adobe signed POST intake', () => {
  test('format285 omits optional regions; durable ack never calls consumers, and duplicates are one inbox entry', async () => {
    const h = harness();
    const request = signed(payload());
    expect((await h.receive(request)).statusCode).toBe(200);
    expect((await h.receive(request)).statusCode).toBe(200);
    expect(await h.store.collection(INBOX).countDocuments()).toBe(1);
    expect(await h.store.collection(MEMBERSHIPS).countDocuments()).toBe(0);
    expect(await h.store.collection(INBOX).findOne({})).toMatchObject({ complete: true, state: 'queued' });
  });

  test('table spelling and integer fields work; contradictory documented spellings do not', async () => {
    const h = harness();
    const body = payload();
    delete body.AAM_Destination_Id;
    Object.assign(body, { AAM_Destination_ID: 423, User_DPID: 1547309, User_count: 1 });
    body.Users[0].AAM_Regions = [9, '6'];
    expect((await h.receive(signed(body))).statusCode).toBe(200);
    body.AAM_Destination_Id = '424';
    expect((await h.receive(signed(body))).body.code).toBe('DESTINATION_CONFLICT');
  });

  test.each([
    ['wrong signature', (r) => { r.__ow_headers['x-aam-signature'] = `${'a'.repeat(43)}=`; }, 401],
    ['modified whitespace after signing', (r) => { r.__ow_body = Buffer.from(`${Buffer.from(r.__ow_body, 'base64')}\n`).toString('base64'); }, 401],
    ['hex signature', (r) => { r.__ow_headers['x-aam-signature'] = 'a'.repeat(64); }, 401],
    ['reconstructed/plain body', (r) => { r.__ow_body = JSON.stringify(payload()); }, 400],
    ['query config overrides', (r) => { r.__ow_query = 'AAM_DESTINATION_ID=424'; }, 400],
    ['GET', (r) => { r.__ow_method = 'get'; }, 405],
    ['oversized body', (r) => { r.__ow_body = Buffer.alloc(MAX_BYTES + 1).toString('base64'); }, 413],
    ['unverified config', (r) => { r.AAM_CONFIG_VERIFIED = 'false'; }, 503],
    ['unsupported algorithm', (r) => { r.AAM_SIGNATURE_ALGORITHM = 'sha1'; }, 503],
    ['disabled', (r) => { r.AAM_RECEIVER_ENABLED = 'false'; }, 404],
    ['wrong environment', (r) => { r.AAM_ENVIRONMENT = 'stage'; }, 503],
  ])('%s rejects before storage', async (_, change, status) => {
    const h = harness();
    const request = signed(payload());
    change(request);
    expect((await h.receive(request)).statusCode).toBe(status);
    expect(h.getStore).not.toHaveBeenCalled();
  });

  test.each([
    ['wrong destination', (b) => { b.AAM_Destination_Id = '424'; }],
    ['wrong client', (b) => { b.Client_ID = 'another-client'; }],
    ['boolean integer', (b) => { b.User_DPID = true; }],
    ['array integer', (b) => { b.User_count = ['1']; }],
    ['unknown segment', (b) => { b.Users[0].Segments[0].Segment_ID = '999'; }],
    ['unknown status', (b) => { b.Users[0].Segments[0].Status = '2'; }],
    ['missing status', (b) => { delete b.Users[0].Segments[0].Status; }],
    ['invalid day', (b) => { b.ProcessTime = 'Tue Nov 31 06:00:00 UTC 2026'; }],
    ['duplicate segment', (b) => { b.Users[0].Segments.push(b.Users[0].Segments[0]); }],
    ['count mismatch', (b) => { b.User_count = '2'; }],
    ['future process', (b) => { b.ProcessTime = 'Tue Nov 24 06:01:00 UTC 2026'; }],
  ])('%s is not acknowledged', async (_, change) => {
    const h = harness();
    const body = payload();
    change(body);
    expect((await h.receive(signed(body))).statusCode).not.toBe(200);
    expect(h.getStore).not.toHaveBeenCalled();
  });

  test('uncertain persistence and an unfinished duplicate cannot falsely acknowledge', async () => {
    const h = harness();
    const inbox = h.store.collection(INBOX);
    const original = inbox.insertOne.bind(inbox);
    inbox.insertOne = async (doc) => { await original(doc); throw new Error('uncertain write'); };
    expect((await h.receive(signed(payload()))).statusCode).toBe(503);
    inbox.insertOne = original;
    await inbox.updateOne({}, { $set: { complete: false } });
    expect((await h.receive(signed(payload()))).statusCode).toBe(503);
    await inbox.updateOne({}, { $set: { complete: true } });
    expect((await h.receive(signed(payload()))).statusCode).toBe(200);
    expect(JSON.stringify(h.report.mock.calls)).not.toContain(alias);
  });

  test('persistence timeout is non200 within Adobe response window', async () => {
    const h = harness();
    h.store.collection(INBOX).insertOne = () => new Promise(() => {});
    const before = Date.now();
    expect((await h.receive(signed(payload()))).statusCode).toBe(503);
    expect(Date.now() - before).toBeLessThan(3000);
  });
});

describe('shared membership and Commerce', () => {
  test('authenticated first-party alias receipt registers its own mapping without arbitrary ID lookup or grant creation', async () => {
    const h = harness();
    await existingIdentity(h.store);
    await h.store.collection(IDENTITIES).deleteMany({});
    const config = { ...params, __OW_NAMESPACE: namespace, TARGET_DIAG_ENVIRONMENT: 'production',
      AAM_IDENTITY_REGISTRATION_ENABLED: 'true' };
    const person = createPersonAliasSource(h.store, config, { now: () => NOW });
    const { binding } = await person.resolve({ sub, create: false });
    const request = { store: h.store, params: config, person, sub, binding, delegated: true, now: () => NOW };
    await registerDestinationIdentity(request);
    expect(await h.store.collection(IDENTITIES).countDocuments()).toBe(0);
    await registerDestinationIdentity({ ...request, delegated: false });
    expect((await h.store.collection(IDENTITIES).findOne({})).record).toMatchObject({
      customerSub: sub, personAlias: alias, consentGeneration: grant,
    });
    await expect(registerDestinationIdentity({ ...request, delegated: false, sub: 'another-subject' })).rejects.toMatchObject({
      code: 'IDENTITY_REGISTRATION_REJECTED',
    });
    expect((await h.store.collection('customers').findOne({ sub })).idLinkage.grantId).toBe(grant);
  });

  test('unknown identity and pending completion fail closed; verified scope binds the current shopper', async () => {
    const h = harness();
    await h.receive(signed(payload()));
    const read = (customer, at = NOW) => commerceMemberships({
      store: h.store, params, namespace, customer, now: at,
    });
    const customer = await existingIdentity(h.store);
    expect((await read(customer)).every((r) => r.status === 'UNKNOWN')).toBe(true);
    await h.worker();
    expect((await read(customer))[0]).toMatchObject({ status: 'MEMBER', financial_authorization: false });
    expect((await read({ sub: 'someone-else' }))[0].status).toBe('UNKNOWN');
    expect((await read(customer, NOW + 60000))[0].status).toBe('UNKNOWN');
    await h.store.collection('customers').updateOne({ sub }, { $set: { 'idLinkage.grantId': 'changed' } });
    expect((await read(customer))[0].status).toBe('UNKNOWN');
  });

  test('same verification time/replayed batches never refresh freshness; absence never removes', async () => {
    const h = harness();
    await h.receive(signed(payload()));
    await h.worker();
    const before = await h.store.collection(MEMBERSHIPS).findOne({});
    const batch = payload([]);
    batch.ProcessTime = 'Tue Nov 24 06:00:00 UTC 2026';
    await h.receive(signed(batch));
    await h.worker();
    expect((await h.store.collection(MEMBERSHIPS).findOne({})).record).toEqual(before.record);
    await h.receive(signed(payload()));
    await h.worker();
    expect((await h.store.collection(MEMBERSHIPS).findOne({})).etag).toBe(before.etag);
  });

  test('late removal wins; equal and later positive verification cannot resurrect a tombstone', async () => {
    const h = harness();
    await h.receive(signed(payload()));
    await h.worker();
    await h.receive(signed(payload([{ Segment_ID: '27507403', Status: '0', DateTime: 'Tue Nov 24 05:59:00 UTC 2026' }])));
    await h.worker();
    await h.receive(signed(payload()));
    await h.worker();
    expect((await h.store.collection(MEMBERSHIPS).findOne({})).record.state).toBe('withdrawn');
  });

  test('historical signed withdrawals persist even after membership TTL; stale positives remain unknown', async () => {
    const h = harness();
    const old = payload();
    old.ProcessTime = 'Tue Nov 24 05:00:00 UTC 2026';
    old.Users[0].Segments[0].DateTime = old.ProcessTime;
    await h.receive(signed(old));
    await h.worker();
    const customer = await existingIdentity(h.store);
    const read = () => commerceMemberships({ store: h.store, params, namespace, customer, now: NOW });
    expect((await read())[0].status).toBe('UNKNOWN');
    old.Users[0].Segments[0].Status = '0';
    await h.receive(signed(old));
    await h.worker();
    expect((await read())[0].status).toBe('WITHDRAWN');
  });
});

describe('Brevo existing-contact list projection', () => {
  async function ready() {
    const h = harness();
    await existingIdentity(h.store);
    await h.receive(signed(payload()));
    const contact = { id: 7, email: 'existing@example.invalid', emailBlacklisted: false, listIds: [] };
    const client = {
      contact: jest.fn(async () => ({ ...contact, listIds: [...contact.listIds] })),
      change: jest.fn(async (list, id, add) => {
        contact.listIds = add ? [...new Set([...contact.listIds, list])] : contact.listIds.filter((l) => l !== list);
      }),
    };
    const work = (extra = {}, options = {}) => h.worker(
      { AAM_BREVO_SYNC_ENABLED: 'true', ...extra }, { createClient: () => client, ...options },
    );
    return { ...h, client, contact, work };
  }

  test('adds only verified existing contact; TTL expiry removes through the same store', async () => {
    const h = await ready();
    expect((await h.work()).added).toBe(1);
    expect(h.client.change).toHaveBeenCalledWith(11, 7, true);
    expect((await h.work({}, { now: () => NOW + 60000 })).removed).toBe(1);
    expect(h.client.change).toHaveBeenLastCalledWith(11, 7, false);
  });

  test.each(['mapping', 'emailProof', 'linkage', 'audience', 'suppression', 'blacklist'])('%s blocks adds', async (gate) => {
    const h = await ready();
    if (gate === 'mapping') await h.store.collection(IDENTITIES).deleteMany({});
    if (gate === 'emailProof') await h.store.collection('customers').updateOne({ sub }, { $set: { emailIdentityVerified: false } });
    if (gate === 'linkage') await h.store.collection('customers').updateOne({ sub }, { $set: { 'idLinkage.state': 'withdrawn' } });
    if (gate === 'audience') await h.store.collection('customers').updateOne({ sub }, { $set: { 'marketing.audienceEmail.optIn': false } });
    if (gate === 'suppression') await h.store.collection('email_suppressions').insertOne({ key: emailHash(h.contact.email) });
    if (gate === 'blacklist') h.contact.emailBlacklisted = true;
    await h.work();
    expect(h.client.change).not.toHaveBeenCalled();
  });

  test('withdrawn consent removes an owned projection even when mapping is no longer usable', async () => {
    const h = await ready();
    await h.work();
    await h.store.collection('customers').updateOne({ sub }, { $set: { 'idLinkage.state': 'withdrawn' } });
    expect((await h.work()).removed).toBe(1);
    expect(h.client.change).toHaveBeenLastCalledWith(11, 7, false);
  });

  test('verified Auth0 email locates only an existing contact and stores the confirmed ID without creating contacts', async () => {
    const h = await ready();
    await h.store.collection(IDENTITIES).updateOne({}, { $unset: {
      'record.brevoContactId': '', 'record.verifiedEmailHash': '',
    } });
    h.client.contactByEmail = jest.fn(async () => ({ ...h.contact }));
    expect((await h.work()).added).toBe(1);
    expect(h.client.contactByEmail).toHaveBeenCalledWith('existing@example.invalid');
    expect((await h.store.collection(IDENTITIES).findOne({})).record.brevoContactId).toBe(7);
  });

  test('ambiguous add is never blindly retried; partial outcome is blocked and safely removed', async () => {
    const h = await ready();
    h.client.change.mockImplementationOnce(async (list) => {
      h.contact.listIds.push(list);
      throw new Error('provider accepted but connection lost');
    });
    expect((await h.work()).status).toBe('partial');
    expect((await h.store.collection(PROJECTIONS).findOne({})).record.state).toBe('unknown');
    await h.work();
    expect(h.client.change.mock.calls).toEqual([[11, 7, true], [11, 7, false]]);
    await h.work();
    expect(h.client.change.mock.calls).toHaveLength(2);
  });

  test('fresh receipt during a provider call suppresses and compensates an add', async () => {
    const h = await ready();
    h.client.change.mockImplementationOnce(async (list) => {
      h.contact.listIds.push(list);
      await h.receive(signed(payload([{ Segment_ID: '27507403', Status: '0', DateTime: DATE }])));
    });
    await h.work();
    expect(h.client.change.mock.calls).toEqual([[11, 7, true], [11, 7, false]]);
  });

  test.each([
    { contacts: { success: [7], failure: [8] } },
    { contacts: { success: [] } },
    {},
  ])('HTTP201 partial/missing confirmation is not success', async (body) => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 201, json: async () => body }));
    const client = createBrevoListClient({ apiKey: 'offline', fetchImpl });
    await expect(client.change(11, 7, true)).rejects.toMatchObject({ ambiguous: true });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ ids: [7] });
  });
});
