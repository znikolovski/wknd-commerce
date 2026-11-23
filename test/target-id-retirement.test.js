const { createMemoryStore } = require('../lib/store');
const { createBindingStore } = require('../lib/target-binding-store');
const { createIdRetirementService, PARTNER } = require('../lib/target-id-retirement');
const { sha256 } = require('../lib/promotion-schema');
const { shopperKey } = require('../lib/recovery-policy');

const SUB = 'auth0|synthetic-retirement';
const KEY = shopperKey('https://example.auth0.com/', SUB);
const ECID = '1'.repeat(38);
const T0 = Date.UTC(2026, 10, 23);
const jsonResponse = (body) => ({ ok: true, json: async () => body });

async function harness({ over = {}, deps = {}, fetchImpl = jest.fn(async () => jsonResponse({})) } = {}) {
  const db = createMemoryStore();
  const store = createBindingStore(db);
  await store.put(KEY, {
    state: 'retiring', shopperKey: KEY, subject: sha256(SUB),
    orgId: PARTNER.orgId, dpid: '1547309', ecid: ECID, ecidSource: 'server-issued',
    consentGrantId: 'old-grant', regionHints: { anonymousMint: 6, lastBound: 9 },
    retirement: { state: 'pending', reason: 'consent-withdrawn' }, ...over,
  }, { ifMatch: null });
  const clock = { t: T0 };
  const consent = { lookup: jest.fn(async () => ({ state: 'withdrawn' })) };
  const service = createIdRetirementService({
    enabled: true, orgId: PARTNER.orgId, dpid: '1547309', environment: 'stage',
    namespace: 'example-stage', consent, store, fetchImpl, now: () => clock.t, ...deps,
  });
  const run = (step) => service.run({ shopperKey: KEY, sub: SUB, step });
  return { store, consent, fetchImpl, service, clock, run };
}

test('submission and regional code-171 observation remain separate, pending and identifier-free', async () => {
  const fetchImpl = jest.fn()
    .mockResolvedValueOnce(jsonResponse({ uuid: 'never-expose' }))
    .mockResolvedValueOnce(jsonResponse({ errors: [{ code: 171 }], dcs_region: 9 }));
  const h = await harness({ fetchImpl });
  expect(await h.run('observe')).toMatchObject({ reason: 'submission-required' });
  expect(fetchImpl).not.toHaveBeenCalled();
  const submitted = await h.run('submit');
  expect(submitted).toMatchObject({ submission: 'submitted', observation: 'not-observed', coverage: 'incomplete' });
  const observed = await h.run('observe');
  expect(observed).toMatchObject({
    observation: 'opt-out-observed', regionalObservation: true, status: 'pending',
    coverage: 'incomplete', historicalDeletion: false, unsegmentationVerified: false,
    evidence: false, financialAuthorization: false,
  });
  const record = (await h.store.get(KEY)).record;
  expect(record).toMatchObject({
    state: 'retiring', ecid: ECID, regionHints: { anonymousMint: 6, lastBound: 9 },
    retirement: {
      state: 'pending',
      submission: { state: 'submitted', scope: PARTNER },
      observation: { state: 'opt-out-observed', region: 9, code: 171 },
    },
  });
  await h.run('submit');
  await h.run('observe');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const urls = fetchImpl.mock.calls.map(([url]) => new URL(url));
  expect(urls.map((url) => url.hostname)).toEqual([PARTNER.host, PARTNER.host]);
  expect(urls.map((url) => url.pathname)).toEqual(['/demoptout.jpg', '/event']);
  expect([...urls[0].searchParams.keys()]).toEqual(['d_mid', 'd_orgid']);
  expect([...urls[1].searchParams.keys()]).toEqual(['d_mid', 'd_orgid', 'd_rtbd']);
  fetchImpl.mock.calls.forEach(([, opts]) => {
    expect(opts).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
    expect(opts.headers).toBeUndefined();
  });
  [SUB, KEY, ECID, 'never-expose'].forEach((id) => expect(JSON.stringify(observed)).not.toContain(id));
});

test.each([
  ['browser source', { ecidSource: 'browser-relayed' }, 'unverified-record'],
  ['wrong org', { orgId: '0'.repeat(24) + '@AdobeOrg' }, 'foreign-record'],
  ['wrong owner', { subject: sha256('another-subject') }, 'foreign-record'],
])('%s is refused without changing the retained ID', async (_, over, reason) => {
  const h = await harness({ over });
  const before = await h.store.get(KEY);
  expect(await h.run('submit')).toMatchObject({ reason });
  expect(await h.store.get(KEY)).toEqual(before);
  expect(h.fetchImpl).not.toHaveBeenCalled();
});

test('a usable binding with still-granted consent is not retired', async () => {
  const h = await harness({ over: { state: 'bound' }, deps: { consent: { lookup: async () => ({ state: 'granted', grantId: 'old-grant' }) } } });
  const before = await h.store.get(KEY);
  expect(await h.run('submit')).toMatchObject({ reason: 'not-retiring' });
  expect(await h.store.get(KEY)).toEqual(before);
  expect(h.fetchImpl).not.toHaveBeenCalled();
});

test('OFF defaults and absent purpose are read-only before binding access', async () => {
  const h = await harness({ deps: { enabled: false } });
  const get = jest.spyOn(h.store, 'get');
  const put = jest.spyOn(h.store, 'put');
  expect(await h.run('submit')).toMatchObject({ reason: 'disabled' });
  expect(h.consent.lookup).not.toHaveBeenCalled();
  const absent = await harness({ deps: { consent: { lookup: async () => ({ state: 'absent' }) } } });
  const absentGet = jest.spyOn(absent.store, 'get');
  const absentPut = jest.spyOn(absent.store, 'put');
  expect(await absent.run('submit')).toMatchObject({ reason: 'consent-absent' });
  expect(get).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(absentGet).not.toHaveBeenCalled();
  expect(absentPut).not.toHaveBeenCalled();
  expect(absent.fetchImpl).not.toHaveBeenCalled();
});

test.each([
  ['no opt-out error', jsonResponse({ uuid: 'private-uuid', dcs_region: 9 }), 'unobserved', false],
  ['conflicting errors', jsonResponse({ errors: [{ code: 171 }, { code: 1 }], dcs_region: 9 }), 'unknown', false],
  ['string error code', jsonResponse({ errors: [{ code: '171' }] }), 'unknown', false],
  ['header without region', { ok: true, headers: { get: () => '171' }, json: async () => { throw new Error('pixel'); } }, 'opt-out-observed', false],
])('%s never claims full coverage or unsegmentation', async (_, response, state, regionalObservation) => {
  const fetchImpl = jest.fn().mockResolvedValueOnce(jsonResponse({})).mockResolvedValueOnce(response);
  const h = await harness({ fetchImpl });
  await h.run('submit');
  expect(await h.run('observe')).toMatchObject({
    observation: state, regionalObservation, coverage: 'incomplete', unsegmentationVerified: false,
  });
  expect((await h.store.get(KEY)).record).toMatchObject({ state: 'retiring', ecid: ECID });
});

test('a lost submission response remains unknown; observation can proceed without automatic resubmission', async () => {
  const fetchImpl = jest.fn().mockRejectedValueOnce(new Error('simulated response loss'))
    .mockResolvedValueOnce(jsonResponse({ errors: [{ code: 171 }], dcs_region: 6 }));
  const h = await harness({ fetchImpl });
  expect(await h.run('submit')).toMatchObject({ submission: 'unknown' });
  expect(await h.run('submit')).toMatchObject({ submission: 'unknown', reason: 'outcome-unknown' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(await h.run('observe')).toMatchObject({ submission: 'unknown', observation: 'opt-out-observed', coverage: 'incomplete' });
  expect((await h.store.get(KEY)).record.ecid).toBe(ECID);
});

test('crash after HTTP acceptance retains a durable sending claim, then unknown outcome, never auto-resubmits', async () => {
  const h = await harness();
  const put = h.store.put.bind(h.store);
  jest.spyOn(h.store, 'put').mockImplementationOnce(put).mockRejectedValueOnce(new Error('write failed'));
  expect(await h.run('submit')).toMatchObject({ reason: 'store-or-consent-unavailable' });
  expect((await h.store.get(KEY)).record).toMatchObject({ ecid: ECID, retirement: { submission: { state: 'sending' } } });
  expect(await h.run('submit')).toMatchObject({ reason: 'in-progress' });
  h.clock.t += 10001;
  expect(await h.run('observe')).toMatchObject({ submission: 'unknown', reason: 'outcome-unknown' });
  expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  expect((await h.store.get(KEY)).record).toMatchObject({ state: 'retiring', ecid: ECID });
});

test('a final CAS race cannot claim durable submission or discard the winning retained ID', async () => {
  let h;
  const fetchImpl = jest.fn(async () => {
    const current = await h.store.get(KEY);
    await h.store.put(KEY, {
      ...current.record, retirement: { ...current.record.retirement, submission: { ...current.record.retirement.submission, state: 'unknown' } },
    }, { ifMatch: current.etag });
    return jsonResponse({});
  });
  h = await harness({ fetchImpl });
  expect(await h.run('submit')).toMatchObject({ reason: 'cas-conflict', submission: 'sending' });
  expect((await h.store.get(KEY)).record).toMatchObject({ ecid: ECID, retirement: { state: 'pending', submission: { state: 'unknown' } } });
});

test('a copied Stage submission is not observed in a different namespace', async () => {
  const h = await harness();
  await h.run('submit');
  const other = createIdRetirementService({
    enabled: true, orgId: PARTNER.orgId, dpid: '1547309', environment: 'production', namespace: 'example-production',
    consent: h.consent, store: h.store, fetchImpl: h.fetchImpl, now: () => T0,
  });
  expect(await other.run({ shopperKey: KEY, sub: SUB, step: 'observe' })).toMatchObject({ reason: 'unscoped-attempt', observation: 'unknown', regionalObservation: false });
  expect(h.fetchImpl).toHaveBeenCalledTimes(1);
});

test('an unscoped stored code-171 observation is not presented as scoped or regional evidence', async () => {
  const h = await harness({ over: {
    retirement: { state: 'pending', observation: { state: 'opt-out-observed', code: 171, region: 9, ecid: ECID, scope: {} } },
  } });
  const before = await h.store.get(KEY);
  expect(await h.run('submit')).toMatchObject({ reason: 'unscoped-attempt', observation: 'unknown', regionalObservation: false });
  expect(await h.store.get(KEY)).toEqual(before);
  expect(h.fetchImpl).not.toHaveBeenCalled();
});
