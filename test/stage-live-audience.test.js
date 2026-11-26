const { createMemoryStore } = require('../lib/store');
const { createBindingStore } = require('../lib/target-binding-store');
const { createStageLiveAudienceProvider } = require('../lib/stage-live-audience');
const { shopperKey } = require('../lib/recovery-policy');
const { sha256 } = require('../lib/promotion-schema');
const { MBOX, PRODUCTION_MBOX, REQUEST_SCHEMA } = require('../lib/target-diagnostic');
const { createPersonAliasSource } = require('../lib/person-alias');
const { removeBindingsForSubject } = require('../lib/target-binding-store');

const SUB = 'auth0|synthetic-stage-demo';
const ISSUER = 'https://example.auth0.com/';
const NS = '28538-wkndcommerce-stage';
const KEY = shopperKey(ISSUER, SUB);
const T0 = Date.UTC(2026, 10, 23);
const GRANT = '11111111-2222-4333-8444-555555555555';
const mapping = { 'climbing-planner': 'planner-registry-key', 'climbing-interest': 'interest-registry-key' };
const params = {
  STAGE_AAM_GENERAL_OFFERS_ENABLED: 'true', TARGET_DIAG_ENABLED: 'true',
  TARGET_DIAG_ENVIRONMENT: 'stage', TARGET_DIAG_STAGE_NAMESPACE: NS,
  TARGET_DIAG_PRODUCTION_NAMESPACE: 'example-production', AUTH0_ISSUER: ISSUER,
  AUTH0_AUDIENCE: 'example-audience', TARGET_DIAG_SHOPPER_KEYS: KEY,
  TARGET_ID_LINKAGE_ENABLED: 'true', TARGET_ID_LINKAGE_WORDING_VERSIONS: 'approved-v1',
  TARGET_ID_BINDING_STORE_APPROVED: 'true', TARGET_ID_SERVICE_ENABLED: 'true',
  TARGET_ID_ORG_ID: 'A'.repeat(24) + '@AdobeOrg', TARGET_ID_DPID: '1547309',
  TARGET_CLIENT_CODE: 'exampleclient', TARGET_PROPERTY_TOKEN: '11111111-2222-4333-8444-555555555555',
};
async function harness({
  marker = 'climbing-planner', change = {}, consent = 'granted', bound = true, response,
  namespace = NS, productionDemo = false,
} = {}) {
  const store = createMemoryStore();
  await store.collection('customers').insertOne({ sub: SUB, idLinkage: { state: consent, grantId: GRANT } });
  if (bound) await createBindingStore(store).put(KEY, {
    state: 'bound', shopperKey: KEY, subject: sha256(SUB), orgId: params.TARGET_ID_ORG_ID,
    dpid: params.TARGET_ID_DPID, ecid: '1'.repeat(38), ecidSource: 'server-issued',
    locationHint: 9, blob: 'offline-issued-blob', consentGrantId: GRANT, resyncAt: T0 + 60000,
  }, { ifMatch: null });
  const fetchImpl = jest.fn(async () => ({
    ok: true, json: async () => response || { execute: { mboxes: [{ name: MBOX, options: [{
      type: 'json', content: { schema: REQUEST_SCHEMA, environment: 'stage', marker, financialAuthorization: false },
    }] }] } },
  }));
  const provider = createStageLiveAudienceProvider({
    params: { ...params, ...change }, store, registryKeysByMarker: mapping, fetchImpl, now: () => T0, namespace,
    productionDemo,
  });
  return { store, fetchImpl, provider };
}

test('explicit Production demo uses its own namespace/mbox/environment and rejects Stage offers', async () => {
  const options = {
    namespace: '28538-wkndcommerce', productionDemo: true,
    change: { TARGET_DIAG_ENVIRONMENT: 'production', TARGET_DIAG_PRODUCTION_NAMESPACE: '28538-wkndcommerce', TARGET_DIAG_TARGET_CONFIG_APPROVED: 'true' },
    response: { execute: { mboxes: [{ name: PRODUCTION_MBOX, options: [{
      type: 'json', content: { schema: REQUEST_SCHEMA, environment: 'production', marker: 'climbing-planner', financialAuthorization: false },
    }] }] } },
  };
  const h = await harness(options);
  expect(await h.provider.resolve({ customer: { sub: SUB }, registryKey: mapping['climbing-planner'] }))
    .toMatchObject({ status: 'member', evidence: false, financialAuthorization: false });
  const disabled = await harness({ ...options, productionDemo: false });
  expect(disabled.provider.configured).toBe(false);
  const wrong = await harness({ ...options, response: {
    execute: { mboxes: [{ name: PRODUCTION_MBOX, options: [{
      type: 'json', content: { schema: REQUEST_SCHEMA, environment: 'stage', marker: 'climbing-planner', financialAuthorization: false },
    }] }] },
  } });
  expect(await wrong.provider.resolve({ customer: { sub: SUB }, registryKey: mapping['climbing-planner'] }))
    .toMatchObject({ status: 'unknown' });
});

test('Production planner and delegated cart reads share the confirmed alias while preserving the legacy MID', async () => {
  const config = {
    ...params, TARGET_DIAG_ENVIRONMENT: 'production',
    TARGET_DIAG_PRODUCTION_NAMESPACE: '28538-wkndcommerce', __OW_NAMESPACE: '28538-wkndcommerce',
    TARGET_DIAG_TARGET_CONFIG_APPROVED: 'true', TARGET_PERSON_ALIAS_APPROVED: 'true',
    TARGET_ID_ORG_ID: '28260E2056581D3B7F000101@AdobeOrg',
  };
  const store = createMemoryStore();
  await store.collection('customers').insertOne({ sub: SUB, idLinkage: { state: 'granted', grantId: GRANT } });
  const aliases = createPersonAliasSource(store, config, { now: () => T0 });
  const { binding: alias } = await aliases.resolve({ sub: SUB });
  const bindings = createBindingStore(store);
  await bindings.put(KEY, {
    state: 'retiring', shopperKey: KEY, subject: sha256(SUB), orgId: config.TARGET_ID_ORG_ID,
    dpid: config.TARGET_ID_DPID, ecid: '1'.repeat(38), ecidSource: 'server-issued',
    consentGrantId: GRANT, retirement: { state: 'pending', reason: 'identity-mapping-changed' },
  }, { ifMatch: null });
  const retained = await bindings.get(KEY);
  const fetchImpl = jest.fn(async (url) => ({
    ok: true,
    json: async () => (new URL(url).hostname === 'dpm.demdex.net'
      ? { d_mid: '2'.repeat(38), dcs_region: 9, id_sync_ttl: 604800, d_blob: 'new-alias-blob' }
      : { execute: { mboxes: [{ name: PRODUCTION_MBOX, options: [{
        type: 'json', content: { schema: REQUEST_SCHEMA, environment: 'production', marker: 'climbing-planner', financialAuthorization: false },
      }] }] } }),
  }));
  const providerFor = () => createStageLiveAudienceProvider({
    params: config, store, fetchImpl, registryKeysByMarker: mapping,
    now: () => T0, namespace: config.__OW_NAMESPACE, productionDemo: true,
  });
  const request = { customer: { sub: SUB }, registryKey: mapping['climbing-planner'] };
  expect(await providerFor().resolve(request)).toMatchObject({ status: 'member' });
  expect(await bindings.get(KEY)).toEqual(retained);
  const targetCalls = fetchImpl.mock.calls.filter(([url]) => new URL(url).hostname.endsWith('.tt.omtrdc.net'));
  expect(JSON.parse(targetCalls[0][1].body).id.customerIds[0].id).toBe(alias.personAlias);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(await providerFor().resolve({ ...request, customer: { sub: SUB, delegated: true } }))
    .toMatchObject({ status: 'member' });
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect((await store.collection('customers').findOne({ sub: SUB })).idLinkage.grantId).toBe(GRANT);
  await store.collection('customers').updateOne({ sub: SUB }, { $set: { 'idLinkage.state': 'withdrawn' } });
  await removeBindingsForSubject(store, sha256(SUB), { grantId: GRANT });
  expect((await store.collection('target_id_bindings_v2').find({ 'record.subject': sha256(SUB) }))
    .every(({ record }) => record.state === 'retiring')).toBe(true);
  expect(await providerFor().resolve(request)).toMatchObject({ status: 'unknown' });
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});

test.each(['climbing-planner', 'climbing-interest'])('maps only canonical %s to its server-owned registry key', async (marker) => {
  const h = await harness({ marker });
  const answer = await h.provider.resolve({ customer: { sub: SUB }, registryKey: mapping[marker] });
  expect(answer).toEqual({ source: 'target-aam-decision', status: 'member', registryKey: mapping[marker], marker, evidence: false, financialAuthorization: false });
  expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  expect(h.fetchImpl.mock.calls[0][0]).toContain('.tt.omtrdc.net/rest/v1/delivery');
  expect(JSON.stringify(answer)).not.toContain(SUB);
});

test.each([
  ['control', { marker: 'control' }, 'control'],
  ['missing decision', { response: { execute: { mboxes: [] } } }, 'no-decision'],
  ['other audience', { marker: 'climbing-interest' }, 'no-qualified-marker'],
])('%s is unknown, never complete negative or financial evidence', async (_, options, reason) => {
  const h = await harness(options);
  expect(await h.provider.resolve({ customer: { sub: SUB }, registryKey: mapping['climbing-planner'] }))
    .toMatchObject({ status: 'unknown', registryKey: null, reason, evidence: false, financialAuthorization: false });
});

test.each([
  ['default OFF', { STAGE_AAM_GENERAL_OFFERS_ENABLED: '' }],
  ['Production', { TARGET_DIAG_ENVIRONMENT: 'production', TARGET_DIAG_TARGET_CONFIG_APPROVED: 'true' }],
  ['unapproved binding', { TARGET_ID_BINDING_STORE_APPROVED: 'false' }],
  ['namespace mismatch', { TARGET_DIAG_STAGE_NAMESPACE: 'another-stage' }],
])('%s cannot read bindings or call Adobe', async (_, change) => {
  const h = await harness({ change });
  const read = jest.spyOn(h.store, 'collection');
  expect(await h.provider.resolve({ customer: { sub: SUB }, registryKey: mapping['climbing-planner'] })).toMatchObject({ status: 'unknown' });
  expect(h.fetchImpl).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

test('verified delegated read reuses a binding but cannot mint, relink or grant', async () => {
  const existing = await harness();
  const read = await existing.provider.resolve({ customer: { sub: SUB, delegated: true }, registryKey: mapping['climbing-planner'] });
  expect(read.status).toBe('member');
  expect(existing.fetchImpl).toHaveBeenCalledTimes(1);
  const missing = await harness({ bound: false });
  expect(await missing.provider.resolve({ customer: { sub: SUB, delegated: true }, registryKey: mapping['climbing-planner'] })).toMatchObject({ status: 'unknown' });
  expect(missing.fetchImpl).not.toHaveBeenCalled();
  expect(await createBindingStore(missing.store).get(KEY)).toBeNull();
  expect((await missing.store.collection('customers').findOne({ sub: SUB })).idLinkage.grantId).toBe(GRANT);
});

test('withdrawn consent refuses a decision and one request shares only its own Target lookup', async () => {
  const revoked = await harness({ consent: 'withdrawn' });
  expect(await revoked.provider.resolve({ customer: { sub: SUB, delegated: true }, registryKey: mapping['climbing-planner'] })).toMatchObject({ status: 'unknown' });
  expect(revoked.fetchImpl).not.toHaveBeenCalled();
  const h = await harness();
  await h.provider.resolve({ customer: { sub: SUB }, registryKey: mapping['climbing-planner'] });
  await h.provider.resolve({ customer: { sub: SUB }, registryKey: mapping['climbing-interest'] });
  expect(h.fetchImpl).toHaveBeenCalledTimes(1);
});
