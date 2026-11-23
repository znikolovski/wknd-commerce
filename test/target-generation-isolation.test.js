const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createMemoryStore } = require('../lib/store');
const { createBindingStore, removeBindingsForSubject } = require('../lib/target-binding-store');
const { createIdServiceBindingProvider } = require('../lib/target-id-binding');
const { createIdRetirementService, PARTNER } = require('../lib/target-id-retirement');
const { setIdLinkageConsent, linkageConfig, createIdLinkageConsentSource } = require('../lib/id-linkage-consent');
const { shopperKey } = require('../lib/recovery-policy');
const { sha256 } = require('../lib/promotion-schema');

const ISSUER = 'https://example.auth0.com/';
const SUB = 'auth0|generation-isolation';
const EMAIL = 'generation@example.com';
const KEY = shopperKey(ISSUER, SUB);
const ECID = '1'.repeat(38);
const DPID = '1547309';
const CONFIG = linkageConfig({ TARGET_ID_LINKAGE_ENABLED: 'true', TARGET_ID_LINKAGE_WORDING_VERSIONS: 'test-v1' });

// Run the actual consent handler against the pre-retention deleteMany and v12 cleanup contracts.
function legacyProfile(version) {
  const file = require.resolve('../lib/id-linkage-consent');
  const load = createRequire(file);
  const module = { exports: {} };
  const remove = version === 11
    ? async (store, subject, { grantId } = {}) => {
      const result = await store.collection('target_id_bindings').deleteMany({
        'record.subject': subject, ...(grantId === undefined ? {} : { 'record.consentGrantId': grantId }),
      });
      return result.deletedCount;
    }
    : (store, subject, options) => removeBindingsForSubject(store, subject, { ...options, collection: 'target_id_bindings' });
  const wrapper = vm.runInThisContext(`(function(require, module, exports) { ${fs.readFileSync(file, 'utf8')}\n})`);
  wrapper((name) => (name === './target-binding-store' ? { removeBindingsForSubject: remove } : load(name)), module, module.exports);
  return module.exports;
}

async function fixture() {
  const db = createMemoryStore();
  await db.collection('customers').insertOne({ _id: SUB, sub: SUB, email: EMAIL });
  const grant = () => setIdLinkageConsent(db, { sub: SUB }, true, { config: CONFIG, wordingVersion: 'test-v1' });
  await grant();
  const consent = createIdLinkageConsentSource(db, { issuer: ISSUER });
  const bindings = createBindingStore(db);
  const mint = jest.fn(async () => ({
    ok: true, json: async () => ({ d_mid: ECID, dcs_region: 9, d_blob: 'private-blob', id_sync_ttl: 604800 }),
  }));
  const provider = createIdServiceBindingProvider({ orgId: PARTNER.orgId, dpid: DPID, consent, store: bindings, fetchImpl: mint });
  const binding = await provider.resolve({ shopperKey: KEY, sub: SUB });
  const remote = jest.fn(async () => ({ ok: true, status: 200 }));
  const service = (source = consent) => createIdRetirementService({
    enabled: true, orgId: PARTNER.orgId, dpid: DPID, environment: 'stage', namespace: 'mock-stage',
    consent: source, store: bindings, fetchImpl: remote,
  });
  const run = (source) => service(source).run({ shopperKey: KEY, sub: SUB, step: 'submit' });
  return { db, consent, bindings, provider, binding, mint, remote, grant, run };
}

test.each([11, 12])('actual legacy v%s email withdrawal cannot erase new bindings and reconciles without another grant', async (version) => {
  const h = await fixture();
  const before = await h.bindings.get(KEY);
  const old = h.db.collection('target_id_bindings');
  await old.insertOne({ _id: 'old-key', etag: 'old-etag', record: before.record });
  expect(await legacyProfile(version).withdrawIdLinkageForEmail(h.db, EMAIL)).toBe(1);
  expect(await h.bindings.get(KEY)).toEqual(before);
  const expectedRetained = [
    expect.objectContaining({ record: expect.objectContaining({ state: 'retiring', ecid: ECID }) }),
  ];
  expect(await old.find({})).toEqual(version === 11 ? [] : expectedRetained);
  expect(await h.provider.confirm({ shopperKey: KEY, sub: SUB, binding: h.binding })).toBe(false);
  expect(await h.run()).toMatchObject({ reason: 'reconciled-pending', status: 'pending', historicalDeletion: false });
  const retired = (await h.bindings.get(KEY)).record;
  expect(retired).toMatchObject({
    state: 'retiring', ecid: ECID, ecidSource: 'server-issued', consentGrantId: before.record.consentGrantId,
    regionHints: before.record.regionHints, retirement: { state: 'pending', reason: 'legacy-consent-withdrawn' },
  });
  expect(retired.blob).toBeUndefined();
  expect(h.remote).not.toHaveBeenCalled();
  expect((await h.db.collection('customers').findOne({ sub: SUB })).idLinkage.state).toBe('withdrawn');
  await h.grant();
  expect((await h.provider.resolve({ shopperKey: KEY, sub: SUB })).reason).toBe('retirement-pending');
  expect(h.mint).toHaveBeenCalledTimes(2);
});

test('a known-MID linking claim abandoned by legacy withdrawal is retained as pending retirement', async () => {
  const h = await fixture();
  const before = await h.bindings.get(KEY);
  const { ecid, ...record } = before.record;
  await h.bindings.put(KEY, { ...record, state: 'issuing', phase: 'linking', priorEcid: ecid }, { ifMatch: before.etag });
  await legacyProfile(11).withdrawIdLinkageForEmail(h.db, EMAIL);
  expect(await h.run()).toMatchObject({ reason: 'reconciled-pending' });
  expect((await h.bindings.get(KEY)).record).toMatchObject({ state: 'retiring', ecid, priorEcid: ecid });
  expect(h.remote).not.toHaveBeenCalled();
});

test.each(['before-confirmation', 'before-cas'])('reconsent %s cannot retire a newer valid binding', async (point) => {
  const h = await fixture();
  await legacyProfile(11).withdrawIdLinkageForEmail(h.db, EMAIL);
  const put = h.bindings.put.bind(h.bindings);
  let newer;
  const replace = async () => {
    await h.grant();
    const purpose = await h.consent.lookup({ shopperKey: KEY, sub: SUB });
    const current = await h.bindings.get(KEY);
    await put(KEY, { ...current.record, ecid: '2'.repeat(38), consentGrantId: purpose.grantId }, { ifMatch: current.etag });
    newer = await h.bindings.get(KEY);
  };
  const source = { lookup: jest.fn(h.consent.lookup) };
  if (point === 'before-confirmation') {
    source.lookup.mockImplementationOnce(h.consent.lookup).mockImplementationOnce(async (args) => {
      await replace();
      return h.consent.lookup(args);
    });
  } else {
    jest.spyOn(h.bindings, 'put').mockImplementationOnce(async (...args) => {
      await replace();
      return put(...args);
    });
  }
  expect(await h.run(source)).toMatchObject({ reason: point === 'before-cas' ? 'cas-conflict' : 'consent-changed' });
  expect(await h.bindings.get(KEY)).toEqual(newer);
  expect(await h.provider.confirm({
    shopperKey: KEY, sub: SUB,
    binding: { ecid: newer.record.ecid, consentGrantId: newer.record.consentGrantId },
  })).toBe(true);
  expect(h.remote).not.toHaveBeenCalled();
});

test.each(['unknown', 'absent'])('%s consent never reads or reconciles the binding collection', async (state) => {
  const h = await fixture();
  const get = jest.spyOn(h.bindings, 'get');
  const put = jest.spyOn(h.bindings, 'put');
  expect(await h.run({ lookup: async () => ({ state }) })).toMatchObject({ reason: `consent-${state}` });
  expect(get).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(h.remote).not.toHaveBeenCalled();
});

test.each(['unknown', 'absent'])('consent becoming %s after lookup cannot mutate the known generation', async (state) => {
  const h = await fixture();
  await legacyProfile(11).withdrawIdLinkageForEmail(h.db, EMAIL);
  const before = await h.bindings.get(KEY);
  const source = { lookup: jest.fn().mockResolvedValueOnce({ state: 'withdrawn' }).mockResolvedValueOnce({ state }) };
  expect(await h.run(source)).toMatchObject({ reason: 'consent-changed' });
  expect(await h.bindings.get(KEY)).toEqual(before);
  expect(h.remote).not.toHaveBeenCalled();
});

test('withdrawn consent cannot reconcile a foreign owner or an unrecognized stored state', async () => {
  const h = await fixture();
  await legacyProfile(11).withdrawIdLinkageForEmail(h.db, EMAIL);
  let before = await h.bindings.get(KEY);
  await h.bindings.put(KEY, { ...before.record, subject: sha256('another') }, { ifMatch: before.etag });
  before = await h.bindings.get(KEY);
  expect(await h.run()).toMatchObject({ reason: 'foreign-record' });
  expect(await h.bindings.get(KEY)).toEqual(before);
  await h.bindings.put(KEY, { ...before.record, subject: sha256(SUB), state: 'unknown-state' }, { ifMatch: before.etag });
  before = await h.bindings.get(KEY);
  expect(await h.run()).toMatchObject({ reason: 'not-retiring' });
  expect(await h.bindings.get(KEY)).toEqual(before);
  expect(h.remote).not.toHaveBeenCalled();
});
