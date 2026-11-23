/**
 * Offline fixtures for the trusted ECID binding provider. No network: fetch and store are injected.
 */
const {
  ID_SERVICE, MAX_ISSUED_BLOB_BYTES, idServiceUrl, parseIdServiceResponse, createIdServiceBindingProvider,
} = require('../lib/target-id-binding');
const { runTargetDiagnostic } = require('../lib/target-diagnostic');
const { shopperKey } = require('../lib/recovery-policy');

const ORG = '28260E2056581D3B7F000101@AdobeOrg';
const DPID = '1547309';
const ISSUER = 'https://example.auth0.com/';
const SUB = 'auth0|pilot-shopper';
const KEY = shopperKey(ISSUER, SUB);
const ECID_A = '1'.repeat(38);
const ECID_B = '2'.repeat(38);
const T0 = Date.UTC(2026, 10, 23, 0, 0, 0);

function memoryStore() {
  const data = new Map();
  return {
    data,
    get: jest.fn(async (k) => (data.has(k) ? { ...data.get(k) } : null)),
    put: jest.fn(async (k, record, { expectedRevision }) => {
      const cur = data.get(k);
      if ((cur?.revision ?? null) !== expectedRevision) return false;
      data.set(k, { ...record, revision: (cur?.revision ?? 0) + 1 });
      return true;
    }),
    remove: jest.fn(async (k) => { data.delete(k); }),
  };
}
const idResponse = (over = {}) => ({
  d_mid: ECID_A, dcs_region: '9', id_sync_ttl: '604800', d_blob: 'issued-blob', ...over,
});
const fetchJson = (body, status = 200) => jest.fn(async () => ({ ok: status === 200, status, json: async () => body }));
function provider(over = {}) {
  const store = over.store || memoryStore();
  const fetchImpl = over.fetchImpl || fetchJson(idResponse());
  let clock = over.clock ?? T0;
  const p = createIdServiceBindingProvider({
    orgId: ORG,
    dpid: DPID,
    consent: over.consent || { allowed: async () => true },
    store,
    fetchImpl,
    now: () => clock,
    ...over.deps,
  });
  return {
    p, store, fetchImpl, advance: (ms) => { clock += ms; },
  };
}

describe('ID Service request (documented direct integration)', () => {
  test('sends only org, version, optional stored ECID and the declared authenticated ID', () => {
    const url = new URL(idServiceUrl({ orgId: ORG, dpid: DPID, sub: SUB }));
    expect(`${url.origin}${url.pathname}`).toBe(ID_SERVICE);
    expect([...url.searchParams.keys()]).toEqual(['d_orgid', 'd_ver', 'd_cid']);
    expect(url.searchParams.get('d_ver')).toBe('2');
    expect(url.searchParams.get('d_cid')).toBe(`${DPID}\u0001${SUB}\u00011`);
    expect(url.search).toContain('d_cid=1547309%01auth0%7Cpilot-shopper%011');
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
    [`blob over ${MAX_ISSUED_BLOB_BYTES} bytes`, { d_blob: 'b'.repeat(MAX_ISSUED_BLOB_BYTES + 1) }],
  ])('a response with %s is rejected', (_, over) => {
    expect(parseIdServiceResponse(idResponse(over))).toBeNull();
  });

  test('id_sync_ttl is a resync interval; missing or absurd values mean "do not reuse"', () => {
    expect(parseIdServiceResponse(idResponse()).ttlS).toBe(604800);
    expect(parseIdServiceResponse(idResponse({ id_sync_ttl: undefined })).ttlS).toBe(0);
    expect(parseIdServiceResponse(idResponse({ id_sync_ttl: '999999999' })).ttlS).toBe(0);
  });
});

describe('binding lifecycle (fixtures only)', () => {
  test('unconfigured provider (no consent source or store) issues nothing', async () => {
    const fetchImpl = fetchJson(idResponse());
    for (const deps of [{ consent: undefined }, { store: undefined }, { orgId: 'nope' }, { dpid: 'x' }]) {
      const p = createIdServiceBindingProvider({
        orgId: ORG, dpid: DPID, consent: { allowed: async () => true }, store: memoryStore(), fetchImpl, ...deps,
      });
      expect(p.configured).toBe(false);
      // eslint-disable-next-line no-await-in-loop
      expect(await p.resolve({ shopperKey: KEY, sub: SUB })).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('first issuance stores the binding with a resync time, never a membership expiry', async () => {
    const { p, store, fetchImpl } = provider();
    expect(await p.resolve({ shopperKey: KEY, sub: SUB })).toEqual({
      source: 'server-issued', ecid: ECID_A, locationHint: 9, blob: 'issued-blob',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(new URL(url).searchParams.has('d_mid')).toBe(false);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' });
    expect(store.data.get(KEY)).toMatchObject({ ecid: ECID_A, issuedAt: T0, resyncAt: T0 + 604800000 });
    expect(Object.keys(store.data.get(KEY))).not.toEqual(expect.arrayContaining(['expiresAt', 'qualified', 'segments']));
  });

  test('before resync the stored binding is reused with no ID Service call', async () => {
    const { p, fetchImpl, advance } = provider();
    await p.resolve({ shopperKey: KEY, sub: SUB });
    advance(604800000 - 1);
    expect((await p.resolve({ shopperKey: KEY, sub: SUB })).ecid).toBe(ECID_A);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('resync sends the stored ECID and refuses a different returned ECID', async () => {
    const store = memoryStore();
    const first = provider({ store });
    await first.p.resolve({ shopperKey: KEY, sub: SUB });
    const later = provider({ store, clock: T0 + 604800000, fetchImpl: fetchJson(idResponse({ d_mid: ECID_B })) });
    expect(await later.p.resolve({ shopperKey: KEY, sub: SUB })).toBeNull();
    expect(new URL(later.fetchImpl.mock.calls[0][0]).searchParams.get('d_mid')).toBe(ECID_A);
    expect(store.data.get(KEY).ecid).toBe(ECID_A);
    const ok = provider({ store, clock: T0 + 604800000, fetchImpl: fetchJson(idResponse({ d_blob: 'fresh' })) });
    expect((await ok.p.resolve({ shopperKey: KEY, sub: SUB })).blob).toBe('fresh');
  });

  test('a missing TTL is never reused', async () => {
    const { p, fetchImpl } = provider({ fetchImpl: fetchJson(idResponse({ id_sync_ttl: undefined })) });
    await p.resolve({ shopperKey: KEY, sub: SUB });
    await p.resolve({ shopperKey: KEY, sub: SUB });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('a lost conditional write (concurrent issuance) returns unavailable', async () => {
    const store = memoryStore();
    store.put.mockResolvedValueOnce(false);
    const { p } = provider({ store });
    expect(await p.resolve({ shopperKey: KEY, sub: SUB })).toBeNull();
  });

  test.each([
    ['consent false', async () => false],
    ['consent non-boolean truthy', async () => 'yes'],
    ['consent lookup failure', async () => { throw new Error('down'); }],
  ])('%s invalidates the stored binding and issues nothing', async (_, allowed) => {
    const store = memoryStore();
    await provider({ store }).p.resolve({ shopperKey: KEY, sub: SUB });
    const fetchImpl = fetchJson(idResponse());
    const { p } = provider({ store, fetchImpl, consent: { allowed } });
    expect(await p.resolve({ shopperKey: KEY, sub: SUB })).toBeNull();
    expect(store.data.has(KEY)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('after withdrawal, consent again re-issues rather than reinstating the old binding', async () => {
    const store = memoryStore();
    await provider({ store }).p.resolve({ shopperKey: KEY, sub: SUB });
    await provider({ store, consent: { allowed: async () => false } }).p.resolve({ shopperKey: KEY, sub: SUB });
    const again = provider({ store, fetchImpl: fetchJson(idResponse({ d_mid: ECID_B })) });
    expect((await again.p.resolve({ shopperKey: KEY, sub: SUB })).ecid).toBe(ECID_B);
    expect(new URL(again.fetchImpl.mock.calls[0][0]).searchParams.has('d_mid')).toBe(false);
  });

  test('account switch: another shopper never reads this binding', async () => {
    const store = memoryStore();
    await provider({ store }).p.resolve({ shopperKey: KEY, sub: SUB });
    const otherKey = shopperKey(ISSUER, 'auth0|other');
    const other = provider({ store, fetchImpl: fetchJson(idResponse({ d_mid: ECID_B })) });
    expect((await other.p.resolve({ shopperKey: otherKey, sub: 'auth0|other' })).ecid).toBe(ECID_B);
    expect(store.data.get(KEY).ecid).toBe(ECID_A);
  });

  test.each([
    ['HTTP error', fetchJson({}, 503)],
    ['network failure', jest.fn(async () => { throw new Error('offline'); })],
    ['invalid body', fetchJson({ d_mid: 'x' })],
  ])('ID Service %s is unavailable and stores nothing', async (_, fetchImpl) => {
    const { p, store } = provider({ fetchImpl });
    expect(await p.resolve({ shopperKey: KEY, sub: SUB })).toBeNull();
    expect(store.put).not.toHaveBeenCalled();
  });

  test('an unverified or missing sub never reaches the ID Service', async () => {
    const { p, fetchImpl } = provider();
    expect(await p.resolve({ shopperKey: KEY, sub: '' })).toBeNull();
    expect(await p.resolve({ shopperKey: '', sub: SUB })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

test('the issued binding is accepted by the diagnostic adapter (still inert by default)', async () => {
  const { p } = provider();
  const target = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      execute: {
        mboxes: [{
          name: 'wknd-aam-stage-eligibility-v1',
          options: [{
            type: 'json',
            content: {
              schema: 'wknd.target-aam-diagnostic/v1', environment: 'stage', marker: 'control', financialAuthorization: false,
            },
          }],
        }],
      },
    }),
  }));
  const r = await runTargetDiagnostic({
    claims: { sub: SUB },
    params: {
      TARGET_DIAG_ENABLED: 'true',
      TARGET_DIAG_ENVIRONMENT: 'stage',
      __OW_NAMESPACE: '00000-example-stage',
      TARGET_CLIENT_CODE: 'exampleclient',
      TARGET_PROPERTY_TOKEN: '11111111-2222-4333-8444-555555555555',
      TARGET_DIAG_SHOPPER_KEYS: KEY,
      AUTH0_ISSUER: ISSUER,
    },
    bindingProvider: p,
    fetchImpl: target,
  });
  expect(r).toMatchObject({ status: 'decided', marker: 'control', evidence: false });
  const sent = JSON.parse(target.mock.calls[0][1].body);
  expect(sent.id.marketingCloudVisitorId).toBe(ECID_A);
  expect(sent.experienceCloud.audienceManager).toEqual({ locationHint: 9, blob: 'issued-blob' });
});
