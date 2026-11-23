/**
 * Offline fixtures for the trusted ECID binding provider. No network, consent source or store:
 * fetch, consent and a compare-and-set memory store are injected.
 */
const crypto = require('node:crypto');
const {
  ID_SERVICE, MAX_ISSUED_BLOB_BYTES, DEFAULT_LEASE_MS, idServiceUrl, parseIdServiceResponse,
  createIdServiceBindingProvider,
} = require('../lib/target-id-binding');
const { runTargetDiagnostic } = require('../lib/target-diagnostic');
const { shopperKey } = require('../lib/recovery-policy');

const ORG = '28260E2056581D3B7F000101@AdobeOrg';
const DPID = '1547309';
const ISSUER = 'https://example.auth0.com/';
const SUB = 'auth0|pilot-shopper';
const KEY = shopperKey(ISSUER, SUB);
const OTHER_SUB = 'auth0|other';
const OTHER_KEY = shopperKey(ISSUER, OTHER_SUB);
const ECID_A = '1'.repeat(38);
const ECID_B = '2'.repeat(38);
const T0 = Date.UTC(2026, 10, 23, 0, 0, 0);
const TTL_MS = 604800000;
const GRANTED = { state: 'granted', grantId: 'consent-evt-1' };

/** Reference CAS store: opaque etags never reused for a key, even after removal. */
function memoryStore() {
  const data = new Map();
  const store = {
    data,
    record: (k) => data.get(k)?.record,
    get: jest.fn(async (k) => (data.has(k) ? structuredClone(data.get(k)) : null)),
    put: jest.fn(async (k, record, { ifMatch }) => {
      if ((data.get(k)?.etag ?? null) !== ifMatch) return null;
      const etag = crypto.randomUUID();
      data.set(k, { etag, record: structuredClone(record) });
      return etag;
    }),
    remove: jest.fn(async (k, { ifMatch } = {}) => {
      if (!data.has(k) || (ifMatch !== undefined && data.get(k).etag !== ifMatch)) return false;
      return data.delete(k);
    }),
  };
  return store;
}
function consentSource(initial = GRANTED) {
  const c = { answer: initial };
  c.lookup = jest.fn(async () => (typeof c.answer === 'function' ? c.answer() : c.answer));
  return c;
}
const idResponse = (over = {}) => ({
  d_mid: ECID_A, dcs_region: '9', id_sync_ttl: '604800', d_blob: 'issued-blob', ...over,
});
const fetchJson = (body, status = 200) => jest.fn(async () => ({ ok: status === 200, status, json: async () => body }));
const dMid = (fetchImpl, i = 0) => new URL(fetchImpl.mock.calls[i][0]).searchParams.get('d_mid');
function provider(over = {}) {
  const store = over.store || memoryStore();
  const consent = over.consent || consentSource();
  const fetchImpl = over.fetchImpl || fetchJson(idResponse());
  const clock = { t: over.clock ?? T0 };
  const p = createIdServiceBindingProvider({
    orgId: ORG, dpid: DPID, consent, store, fetchImpl, now: () => clock.t, ...over.deps,
  });
  return {
    p, store, consent, fetchImpl, clock, advance: (ms) => { clock.t += ms; },
  };
}
const resolveA = (p) => p.resolve({ shopperKey: KEY, sub: SUB });
const un = (reason) => ({ source: 'unavailable', reason });
const SUBJECT = crypto.createHash('sha256').update(SUB, 'utf8').digest('hex');

describe('ID Service request (documented direct integration)', () => {
  test('sends only org, version, optional stored ECID and the declared authenticated ID', () => {
    const url = new URL(idServiceUrl({
      orgId: ORG, dpid: DPID, sub: SUB, ecid: ECID_A,
    }));
    expect(`${url.origin}${url.pathname}`).toBe(ID_SERVICE);
    expect([...url.searchParams.keys()]).toEqual(['d_orgid', 'd_ver', 'd_mid', 'd_cid']);
    expect(url.searchParams.get('d_ver')).toBe('2');
    expect(url.searchParams.get('d_cid')).toBe(`${DPID}\u0001${SUB}\u00011`);
    expect(url.search).toContain('d_cid=1547309%01auth0%7Cpilot-shopper%011');
    const anonymous = new URL(idServiceUrl({ orgId: ORG }));
    expect([...anonymous.searchParams.keys()]).toEqual(['d_orgid', 'd_ver']);
    expect(() => idServiceUrl({ orgId: ORG, dpid: DPID, sub: SUB })).toThrow('known ECID');
    const resync = new URL(idServiceUrl({
      orgId: ORG, dpid: DPID, sub: SUB, ecid: ECID_A,
    }));
    expect([...resync.searchParams.keys()]).toEqual(['d_orgid', 'd_ver', 'd_mid', 'd_cid']);
  });

  test.each([
    ['malformed ECID', { d_mid: '123' }],
    ['region below 1', { dcs_region: '0' }],
    ['non-numeric region', { dcs_region: 'x' }],
    ['empty blob', { d_blob: '' }],
    [`blob over ${MAX_ISSUED_BLOB_BYTES} bytes (ID Service limit; Target allows 1024)`, { d_blob: 'b'.repeat(MAX_ISSUED_BLOB_BYTES + 1) }],
  ])('a response with %s is rejected', (_, over) => {
    expect(parseIdServiceResponse(idResponse(over))).toBeNull();
  });

  test.each([
    ['a numeric d_mid (precision loss)', { d_mid: 1e37 }],
    ['a boolean region', { dcs_region: true }],
    ['an array region', { dcs_region: [9] }],
    ['a fractional region', { dcs_region: 9.5 }],
    ['a signed region string', { dcs_region: '+9' }],
    ['an exponent region string', { dcs_region: '9e0' }],
    ['an array body', null],
  ])('documented wire types only: %s is rejected', (_, over) => {
    expect(parseIdServiceResponse(over ? idResponse(over) : [idResponse()])).toBeNull();
  });

  test('integer and decimal-string region/TTL are both accepted; coercible TTL junk means no reuse', () => {
    expect(parseIdServiceResponse(idResponse({ dcs_region: 9, id_sync_ttl: 604800 }))).toMatchObject({ locationHint: 9, ttlS: 604800 });
    expect(parseIdServiceResponse(idResponse({ id_sync_ttl: true })).ttlS).toBe(0);
    expect(parseIdServiceResponse(idResponse({ id_sync_ttl: [604800] })).ttlS).toBe(0);
    expect(parseIdServiceResponse(idResponse({ id_sync_ttl: '6.048e5' })).ttlS).toBe(0);
  });

  test('id_sync_ttl is a resync interval; missing or absurd values mean "do not reuse"', () => {
    expect(parseIdServiceResponse(idResponse()).ttlS).toBe(604800);
    expect(parseIdServiceResponse(idResponse({ id_sync_ttl: undefined })).ttlS).toBe(0);
    expect(parseIdServiceResponse(idResponse({ id_sync_ttl: '999999999' })).ttlS).toBe(0);
  });
});

describe('configuration: no default consent source or store', () => {
  test.each([
    ['no consent source', { consent: undefined }],
    ['legacy boolean consent.allowed()', { consent: { allowed: async () => true } }],
    ['no store', { store: undefined }],
    ['store without CAS remove', { store: { get: async () => null, put: async () => 'e' } }],
    ['bad org', { orgId: 'nope' }],
    ['bad DPID', { dpid: 'x' }],
    ['lease shorter than two ID Service timeouts', { leaseMs: 3000, timeoutMs: 2000 }],
    ['timeout out of bounds', { timeoutMs: 60000, leaseMs: 60000 }],
    ['lease out of bounds', { leaseMs: 600000 }],
  ])('%s: unconfigured and issues nothing', async (_, deps) => {
    const fetchImpl = fetchJson(idResponse());
    const p = createIdServiceBindingProvider({
      orgId: ORG, dpid: DPID, consent: consentSource(), store: memoryStore(), fetchImpl, ...deps,
    });
    expect(p.configured).toBe(false);
    expect(await resolveA(p)).toEqual(un('unconfigured'));
    expect(await p.invalidate(KEY)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('issuance, reuse and resync', () => {
  test('cold start persists an anonymously acquired MID before transmitting a declared ID', async () => {
    const { p, store, fetchImpl } = provider();
    expect(await resolveA(p)).toEqual({
      source: 'server-issued', ecid: ECID_A, locationHint: 9, blob: 'issued-blob', consentGrantId: 'consent-evt-1',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(dMid(fetchImpl)).toBeNull();
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.has('d_cid')).toBe(false);
    expect(dMid(fetchImpl, 1)).toBe(ECID_A);
    expect(store.put.mock.calls[1][1]).toMatchObject({ state: 'issuing', priorEcid: ECID_A });
    const init = fetchImpl.mock.calls[0][1];
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
    expect(init.headers).toBeUndefined();
    expect(store.record(KEY)).toEqual({
      state: 'bound',
      shopperKey: KEY,
      subject: SUBJECT,
      orgId: ORG,
      dpid: DPID,
      consentGrantId: 'consent-evt-1',
      ecid: ECID_A,
      locationHint: 9,
      blob: 'issued-blob',
      issuedAt: T0,
      resyncAt: T0 + TTL_MS,
    });
  });

  test('before resync the binding is reused with no ID Service call, but consent is read every time', async () => {
    const { p, fetchImpl, consent, advance } = provider();
    await resolveA(p);
    const lookups = consent.lookup.mock.calls.length;
    advance(TTL_MS - 1);
    expect((await resolveA(p)).ecid).toBe(ECID_A);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(consent.lookup.mock.calls.length).toBe(lookups + 1);
  });

  test('a resync with an unexpected ECID retains retirement work and never retries linking', async () => {
    const store = memoryStore();
    await resolveA(provider({ store }).p);
    const bad = provider({ store, clock: T0 + TTL_MS, fetchImpl: fetchJson(idResponse({ d_mid: ECID_B })) });
    expect(await resolveA(bad.p)).toEqual(un('id-service-invalid'));
    expect(dMid(bad.fetchImpl)).toBe(ECID_A);
    expect(store.record(KEY)).toMatchObject({ state: 'retiring', ecid: ECID_A, retirement: { state: 'pending' } });
    const ok = provider({
      store, clock: T0 + TTL_MS + DEFAULT_LEASE_MS, fetchImpl: fetchJson(idResponse({ d_blob: 'fresh' })),
    });
    expect(await resolveA(ok.p)).toEqual(un('retirement-pending'));
    expect(ok.fetchImpl).not.toHaveBeenCalled();
  });

  test('a missing TTL is never reused', async () => {
    const { p, fetchImpl } = provider({ fetchImpl: fetchJson(idResponse({ id_sync_ttl: undefined })) });
    await resolveA(p);
    await resolveA(p);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(dMid(fetchImpl, 1)).toBe(ECID_A);
  });

  test.each([
    ['HTTP error', fetchJson({}, 503), 'id-service-error'],
    ['network failure', jest.fn(async () => { throw new Error('offline'); }), 'id-service-unreachable'],
    ['invalid body', fetchJson({ d_mid: 'x' }), 'id-service-invalid'],
    ['unparseable body', jest.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('x'); } })), 'id-service-invalid'],
  ])('ID Service %s: categorized unavailable, nothing bound (lease lapses)', async (_, fetchImpl, reason) => {
    const { p, store } = provider({ fetchImpl });
    expect(await resolveA(p)).toEqual(un(reason));
    expect(store.record(KEY)).toMatchObject({ state: 'issuing', priorEcid: null });
  });
});

describe('consent lifecycle (authoritative lookup; missing / fail / withdrawal / reconsent)', () => {
  async function bound() {
    const store = memoryStore();
    await resolveA(provider({ store }).p);
    return store;
  }

  test.each([
    ['withdrawn', { state: 'withdrawn' }],
    ['missing (absent record)', { state: 'absent' }],
  ])('consent %s retires the known binding and calls nothing', async (_, answer) => {
    const store = await bound();
    const { p, fetchImpl } = provider({ store, consent: consentSource(answer) });
    expect(await resolveA(p)).toEqual(un(answer.state === 'withdrawn' ? 'consent-withdrawn' : 'consent-absent'));
    expect(store.record(KEY)).toMatchObject({ state: 'retiring', ecid: ECID_A, retirement: { state: 'pending' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('missing consent with no record writes nothing', async () => {
    const { p, store } = provider({ consent: consentSource({ state: 'absent' }) });
    expect(await resolveA(p)).toEqual(un('consent-absent'));
    expect(store.put).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  test.each([
    ['lookup throws', () => { throw new Error('down'); }],
    ['granted without grantId', { state: 'granted' }],
    ['malformed grantId', { state: 'granted', grantId: 'x'.repeat(129) }],
    ['bare boolean true', true],
    ['unknown state', { state: 'pending' }],
  ])('consent failure (%s) denies but changes nothing', async (_, answer) => {
    const store = await bound();
    const before = structuredClone(store.data.get(KEY));
    const { p, fetchImpl } = provider({ store, consent: consentSource(answer) });
    store.put.mockClear();
    store.remove.mockClear();
    expect(await resolveA(p)).toEqual(un('consent-unknown'));
    expect(store.data.get(KEY)).toEqual(before);
    expect(store.put).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('reconsent preserves the old MID pending retirement even if no resolve saw withdrawal', async () => {
    const store = await bound();
    const again = provider({
      store,
      consent: consentSource({ state: 'granted', grantId: 'consent-evt-2' }),
      fetchImpl: fetchJson(idResponse({ d_mid: ECID_B })),
    });
    expect(await resolveA(again.p)).toEqual(un('retirement-pending'));
    expect(again.fetchImpl).not.toHaveBeenCalled();
    expect(store.record(KEY)).toMatchObject({ state: 'retiring', ecid: ECID_A, consentGrantId: GRANTED.grantId });
  });

  test('withdrawal during declared-ID transmission retains the MID and cannot resurrect a binding', async () => {
    const store = memoryStore();
    const consent = consentSource();
    let p;
    const fetchImpl = jest.fn(async () => {
      if (fetchImpl.mock.calls.length === 2) {
        consent.answer = { state: 'withdrawn' };
        await p.invalidate(KEY);
      }
      return { ok: true, json: async () => idResponse() };
    });
    ({ p } = provider({ store, consent, fetchImpl }));
    expect(await resolveA(p)).toEqual(un('cas-conflict'));
    expect(store.record(KEY)).toMatchObject({ state: 'retiring', ecid: ECID_A, retirement: { state: 'pending' } });
  });

  test('withdrawal between the first check and the claim is caught by the post-claim check', async () => {
    const answers = [GRANTED, { state: 'withdrawn' }];
    const { p, store, fetchImpl } = provider({ consent: consentSource(() => answers.shift()) });
    expect(await resolveA(p)).toEqual(un('consent-changed'));
    expect(store.data.has(KEY)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('invalidate() retains known IDs pending retirement and is idempotent', async () => {
    const store = await bound();
    const { p } = provider({ store });
    expect(await p.invalidate(KEY)).toBe(true);
    expect(await p.invalidate(KEY)).toBe(true);
    expect(store.record(KEY)).toMatchObject({ state: 'retiring', ecid: ECID_A });
  });
});

describe('durable issuance and retirement boundaries', () => {
  test('retirement while beforeLink consent lookup is paused prevents any late CID transmission', async () => {
    const store = memoryStore();
    const consent = consentSource();
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const paused = new Promise((resolve) => { release = resolve; });
    consent.lookup.mockImplementation(async () => {
      if (consent.lookup.mock.calls.length === 3) {
        entered();
        await paused;
      }
      return GRANTED;
    });
    const first = provider({ store, consent });
    const pending = resolveA(first.p);
    await started;
    first.advance(DEFAULT_LEASE_MS + 1);
    const second = provider({ store, consent, clock: T0 + DEFAULT_LEASE_MS + 1 });
    expect(await resolveA(second.p)).toEqual(un('retirement-pending'));
    release();
    expect(await pending).toEqual(un('retirement-pending'));
    expect(first.fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.has('d_cid'))).toEqual([false]);
    expect(second.fetchImpl).not.toHaveBeenCalled();
    expect(store.record(KEY)).toMatchObject({ state: 'retiring', ecid: ECID_A });
  });

  test.each([DEFAULT_LEASE_MS + 1, DEFAULT_LEASE_MS - 1000])(
    'a known-MID lease with elapsed time %s cannot send beyond its remaining timeout budget',
    async (elapsed) => {
      const consent = consentSource();
      let entered;
      let release;
      const started = new Promise((resolve) => { entered = resolve; });
      const paused = new Promise((resolve) => { release = resolve; });
      consent.lookup.mockImplementation(async () => {
        if (consent.lookup.mock.calls.length === 3) {
          entered();
          await paused;
        }
        return GRANTED;
      });
      const first = provider({ consent });
      const pending = resolveA(first.p);
      await started;
      first.advance(elapsed);
      release();
      expect(await pending).toEqual(un('lease-insufficient'));
      expect(first.fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.has('d_cid'))).toEqual([false]);
      expect(first.store.record(KEY)).toMatchObject({ state: 'retiring', ecid: ECID_A });
    },
  );

  test('a replaced CAS claim cannot transmit a CID even if its consent and lease remain valid', async () => {
    const consent = consentSource();
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const paused = new Promise((resolve) => { release = resolve; });
    consent.lookup.mockImplementation(async () => {
      if (consent.lookup.mock.calls.length === 3) {
        entered();
        await paused;
      }
      return GRANTED;
    });
    const first = provider({ consent });
    const pending = resolveA(first.p);
    await started;
    const current = await first.store.get(KEY);
    await first.store.put(KEY, current.record, { ifMatch: current.etag });
    release();
    expect(await pending).toEqual(un('cas-conflict'));
    expect(first.fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.has('d_cid'))).toEqual([false]);
    expect(first.store.record(KEY)).toMatchObject({ state: 'issuing', priorEcid: ECID_A });
  });

  test.each(['ecid', 'priorEcid'])('an unknown stored state with %s fails explicitly without changing its known ID', async (field) => {
    const store = memoryStore();
    await store.put(KEY, {
      state: 'unexpected-state', shopperKey: KEY, subject: SUBJECT,
      consentGrantId: GRANTED.grantId, [field]: ECID_A,
    }, { ifMatch: null });
    const before = structuredClone(store.data.get(KEY));
    store.put.mockClear();
    const { p, consent, fetchImpl } = provider({ store });
    expect(await resolveA(p)).toEqual(un('invalid-record-state'));
    expect(store.data.get(KEY)).toEqual(before);
    expect(store.put).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(consent.lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a legacy ambiguous issuing record is quarantined, never mistaken for anonymous acquisition', async () => {
    const store = memoryStore();
    await store.put(KEY, {
      state: 'issuing', shopperKey: KEY, subject: SUBJECT, consentGrantId: GRANTED.grantId,
      priorEcid: null, leaseUntil: T0 - 1,
    }, { ifMatch: null });
    const { p, fetchImpl } = provider({ store });
    expect(await resolveA(p)).toEqual(un('retirement-pending'));
    expect(store.record(KEY)).toMatchObject({ state: 'retiring', retirement: { state: 'pending', reason: 'identity-unknown' } });
    expect(fetchImpl).not.toHaveBeenCalled();
    await p.invalidate(KEY);
    expect(store.record(KEY).state).toBe('retiring');
  });

  test('a failed anonymous-MID persistence never transmits a declared ID', async () => {
    const store = memoryStore();
    const put = store.put.getMockImplementation();
    store.put.mockImplementation((key, record, opts) => (
      record.priorEcid ? Promise.reject(new Error('write unavailable')) : put(key, record, opts)
    ));
    const { p, fetchImpl } = provider({ store });
    expect(await resolveA(p)).toEqual(un('store-error'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.has('d_cid')).toBe(false);
    expect(store.record(KEY).priorEcid).toBeNull();
  });

  test('withdrawal during anonymous minting cannot transmit a declared ID', async () => {
    const store = memoryStore();
    const consent = consentSource();
    let p;
    const fetchImpl = jest.fn(async () => {
      consent.answer = { state: 'withdrawn' };
      await p.invalidate(KEY);
      return { ok: true, json: async () => idResponse() };
    });
    ({ p } = provider({ store, consent, fetchImpl }));
    expect(await resolveA(p)).toEqual(un('cas-conflict'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.has('d_cid')).toBe(false);
    expect(store.record(KEY)).toBeUndefined();
  });

  test.each(['lost-response', 'invalid-response'])('%s after linking retains pending work across reconsent', async (failure) => {
    const store = memoryStore();
    const consent = consentSource();
    let beforeTransmission;
    const fetchImpl = jest.fn(async (request) => {
      const url = new URL(request);
      if (url.searchParams.has('d_cid')) {
        beforeTransmission = structuredClone(store.record(KEY));
        if (failure === 'lost-response') throw new Error('response lost after simulated acceptance');
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => idResponse() };
    });
    const { p, advance } = provider({ store, consent, fetchImpl });
    expect(await resolveA(p)).toEqual(un(failure === 'lost-response' ? 'id-service-unreachable' : 'id-service-invalid'));
    expect(beforeTransmission).toMatchObject({ state: 'issuing', priorEcid: ECID_A, orgId: ORG });
    expect(dMid(fetchImpl, 1)).toBe(ECID_A);
    expect(store.record(KEY)).toMatchObject({ state: 'retiring', ecid: ECID_A, consentGrantId: GRANTED.grantId, retirement: { state: 'pending' } });
    advance(DEFAULT_LEASE_MS + 1);
    consent.answer = { state: 'granted', grantId: 'new-grant' };
    expect(await resolveA(p)).toEqual(un('retirement-pending'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('a crashed linking holder retains its MID; lease expiry cannot mint another or overwrite retirement', async () => {
    const store = memoryStore();
    let release;
    const slow = jest.fn(async (request) => {
      if (new URL(request).searchParams.has('d_cid')) return new Promise((resolve) => { release = resolve; });
      return { ok: true, json: async () => idResponse() };
    });
    const first = provider({ store, fetchImpl: slow });
    const pending = resolveA(first.p);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(store.record(KEY)).toMatchObject({ state: 'issuing', priorEcid: ECID_A });
    const retry = provider({ store, clock: T0 + DEFAULT_LEASE_MS });
    expect(await resolveA(retry.p)).toEqual(un('retirement-pending'));
    expect(retry.fetchImpl).not.toHaveBeenCalled();
    release({ ok: true, json: async () => idResponse() });
    expect(await pending).toEqual(un('cas-conflict'));
    expect(store.record(KEY)).toMatchObject({ state: 'retiring', ecid: ECID_A });
  });
});

describe('confirm(): authoritative re-check for the issued grant', () => {
  test('pending retirement invalidates a previously issued binding even while consent remains granted', async () => {
    const { p, store } = provider();
    const binding = await resolveA(p);
    expect(await p.confirm({ shopperKey: KEY, sub: SUB, binding })).toBe(true);
    await p.invalidate(KEY);
    expect(await p.confirm({ shopperKey: KEY, sub: SUB, binding })).toBe(false);
    expect(store.record(KEY)).toMatchObject({ state: 'retiring', ecid: ECID_A });
    store.get.mockRejectedValueOnce(new Error('read unavailable'));
    expect(await p.confirm({ shopperKey: KEY, sub: SUB, binding })).toBe(false);
  });

  test('true only while the same grant is current', async () => {
    const consent = consentSource();
    const { p } = provider({ consent });
    const binding = await resolveA(p);
    expect(await p.confirm({ shopperKey: KEY, sub: SUB, binding })).toBe(true);
    consent.answer = { state: 'granted', grantId: 'consent-evt-2' };
    expect(await p.confirm({ shopperKey: KEY, sub: SUB, binding })).toBe(false);
    consent.answer = { state: 'withdrawn' };
    expect(await p.confirm({ shopperKey: KEY, sub: SUB, binding })).toBe(false);
    consent.answer = () => { throw new Error('down'); };
    expect(await p.confirm({ shopperKey: KEY, sub: SUB, binding })).toBe(false);
    consent.answer = GRANTED;
    expect(await p.confirm({ shopperKey: KEY, sub: SUB, binding: { ...binding, consentGrantId: undefined } })).toBe(false);
    expect(await p.confirm({ shopperKey: KEY, sub: '', binding })).toBe(false);
  });
});

describe('concurrency and storage CAS', () => {
  test('concurrent cold-start resolves mint at most one ECID', async () => {
    const { p, store, fetchImpl } = provider();
    const results = await Promise.all([resolveA(p), resolveA(p)]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(results.filter((r) => r.source === 'server-issued')).toHaveLength(1);
    expect(results.filter((r) => r.source === 'unavailable').map((r) => r.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/^(cas-conflict|issuing-in-progress)$/)]));
    expect(store.record(KEY).ecid).toBe(ECID_A);
  });

  test('concurrent refresh at resync makes one ID Service call, keeping the ECID', async () => {
    const store = memoryStore();
    await resolveA(provider({ store }).p);
    const later = provider({ store, clock: T0 + TTL_MS });
    const results = await Promise.all([resolveA(later.p), resolveA(later.p)]);
    expect(later.fetchImpl).toHaveBeenCalledTimes(1);
    expect(dMid(later.fetchImpl)).toBe(ECID_A);
    expect(results.filter((r) => r.source === 'server-issued')).toHaveLength(1);
    expect(results.filter((r) => r.source === 'unavailable').map((r) => r.reason)).toEqual(expect.arrayContaining([expect.stringMatching(/^(cas-conflict|issuing-in-progress)$/)]));
  });

  test('an anonymous mint lease is not pre-empted; a lapsed one can mint without declared IDs', async () => {
    const store = memoryStore();
    await resolveA(provider({ store, clock: T0 + TTL_MS, fetchImpl: fetchJson({}, 503) }).p);
    const during = provider({ store, clock: T0 + TTL_MS + DEFAULT_LEASE_MS - 1 });
    expect(await resolveA(during.p)).toEqual(un('issuing-in-progress'));
    expect(during.fetchImpl).not.toHaveBeenCalled();
    const after = provider({ store, clock: T0 + TTL_MS + DEFAULT_LEASE_MS });
    expect((await resolveA(after.p)).ecid).toBe(ECID_A);
    expect(dMid(after.fetchImpl)).toBeNull();
    expect(new URL(after.fetchImpl.mock.calls[0][0]).searchParams.has('d_cid')).toBe(false);
  });

  test('a holder whose lease was taken over cannot overwrite the newer binding', async () => {
    const store = memoryStore();
    let release;
    const slow = jest.fn(() => new Promise((r) => { release = r; }));
    const stale = provider({ store, fetchImpl: slow });
    const pending = resolveA(stale.p);
    await new Promise((r) => { setImmediate(r); });
    const fresh = provider({ store, clock: T0 + DEFAULT_LEASE_MS, fetchImpl: fetchJson(idResponse({ d_mid: ECID_B })) });
    expect((await resolveA(fresh.p)).ecid).toBe(ECID_B);
    release({ ok: true, json: async () => idResponse() });
    expect(await pending).toEqual(un('cas-conflict'));
    expect(store.record(KEY).ecid).toBe(ECID_B);
  });

  test.each([
    ['read', 'get'], ['claim', 'put'],
  ])('store %s failure is unavailable with no ID Service call', async (_, method) => {
    const store = memoryStore();
    store[method].mockRejectedValueOnce(new Error('db down'));
    const { p, fetchImpl } = provider({ store });
    expect(await resolveA(p)).toEqual(un('store-error'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('account isolation, logout and caller input', () => {
  test('account switch: another shopper never reuses or sends this shopper\'s ECID', async () => {
    const store = memoryStore();
    await resolveA(provider({ store }).p);
    const other = provider({ store, fetchImpl: fetchJson(idResponse({ d_mid: ECID_B })) });
    expect((await other.p.resolve({ shopperKey: OTHER_KEY, sub: OTHER_SUB })).ecid).toBe(ECID_B);
    expect(dMid(other.fetchImpl)).toBeNull();
    expect(store.record(KEY).ecid).toBe(ECID_A);
  });

  test('a record stored under the wrong key is never reused, sent or overwritten', async () => {
    const store = memoryStore();
    await resolveA(provider({ store }).p);
    store.data.set(OTHER_KEY, structuredClone(store.data.get(KEY)));
    const before = structuredClone(store.data.get(OTHER_KEY));
    const other = provider({ store });
    expect(await other.p.resolve({ shopperKey: OTHER_KEY, sub: OTHER_SUB })).toEqual(un('foreign-record'));
    expect(other.fetchImpl).not.toHaveBeenCalled();
    expect(other.consent.lookup).not.toHaveBeenCalled();
    expect(store.data.get(OTHER_KEY)).toEqual(before);
  });

  test('an unverified or missing sub never reaches consent, the store or the ID Service', async () => {
    const { p, fetchImpl, store, consent } = provider();
    expect(await p.resolve({ shopperKey: KEY, sub: '' })).toEqual(un('invalid-input'));
    expect(await p.resolve({ shopperKey: '', sub: SUB })).toEqual(un('invalid-input'));
    expect(await p.resolve()).toEqual(un('invalid-input'));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(consent.lookup).not.toHaveBeenCalled();
  });
});

describe('diagnostic hand-off (adapter still inert by default)', () => {
  const offer = (marker) => ({
    schema: 'wknd.target-aam-diagnostic/v1', environment: 'stage', marker, financialAuthorization: false,
  });
  const targetFetch = () => jest.fn(async () => ({
    ok: true,
    json: async () => ({
      execute: { mboxes: [{ name: 'wknd-aam-stage-eligibility-v1', options: [{ type: 'json', content: offer('control') }] }] },
    }),
  }));
  const params = {
    TARGET_DIAG_ENABLED: 'true',
    TARGET_DIAG_ENVIRONMENT: 'stage',
    TARGET_DIAG_STAGE_NAMESPACE: '00000-example-stage',
    __OW_NAMESPACE: '00000-example-stage',
    TARGET_CLIENT_CODE: 'exampleclient',
    TARGET_PROPERTY_TOKEN: '11111111-2222-4333-8444-555555555555',
    TARGET_DIAG_SHOPPER_KEYS: `${KEY},${OTHER_KEY}`,
    AUTH0_ISSUER: ISSUER,
  };
  const run = (claims, bindingProvider, fetchImpl = targetFetch()) => runTargetDiagnostic({
    claims, params, bindingProvider, fetchImpl,
  });

  test('the issued binding reaches Target, but the result returned to the caller carries no identifiers', async () => {
    const { p } = provider();
    const target = targetFetch();
    const r = await run({ sub: SUB }, p, target);
    expect(r).toMatchObject({ status: 'decided', marker: 'control', evidence: false });
    const sent = JSON.parse(target.mock.calls[0][1].body);
    expect(sent.id.marketingCloudVisitorId).toBe(ECID_A);
    expect(sent.experienceCloud.audienceManager).toEqual({ locationHint: 9, blob: 'issued-blob' });
    const out = JSON.stringify(r);
    for (const secret of [ECID_A, 'issued-blob', SUB, KEY]) expect(out).not.toContain(secret);
  });

  test('logout: without verified claims nothing reads, issues or invalidates the binding', async () => {
    const { p, store, fetchImpl } = provider();
    await run({ sub: SUB }, p);
    const before = structuredClone(store.data.get(KEY));
    const spy = jest.spyOn(p, 'resolve');
    for (const claims of [undefined, {}, { sub: '' }]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await run(claims, p)).toMatchObject({ status: 'unavailable', reason: 'unauthenticated' });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(store.data.get(KEY)).toEqual(before);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('same-device account switch after logout uses only the new shopper\'s own binding; re-login reuses without churn', async () => {
    const store = memoryStore();
    const ids = [idResponse(), idResponse(), idResponse({ d_mid: ECID_B }), idResponse({ d_mid: ECID_B })];
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ids.shift() }));
    const { p } = provider({ store, fetchImpl });
    const target = targetFetch();
    await run({ sub: SUB }, p, target);
    await run({ sub: OTHER_SUB }, p, target);
    await run({ sub: SUB }, p, target);
    const sentEcids = target.mock.calls.map(([, init]) => JSON.parse(init.body).id.marketingCloudVisitorId);
    expect(sentEcids).toEqual([ECID_A, ECID_B, ECID_A]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(dMid(fetchImpl, 2)).toBeNull();
  });
});
