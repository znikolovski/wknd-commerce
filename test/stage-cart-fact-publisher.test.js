const { createMemoryStore } = require('../lib/store');
const { createCart } = require('../lib/cart');
const { createBindingStore } = require('../lib/target-binding-store');
const { createServerCartFacts } = require('../lib/server-cart-facts');
const { createStageCartFactService, mapStageCartFacts } = require('../lib/stage-cart-fact-publisher');
const { shopperKey } = require('../lib/recovery-policy');
const { sha256 } = require('../lib/promotion-schema');
const { PARTNER } = require('../lib/target-id-retirement');
const { STAGE_NAMESPACE, stageFactsEnabled } = require('../lib/stage-planner-release');

const NOW = Date.parse('2026-11-23T08:00:00.000Z');
const SUB = 'auth0|synthetic-fact-shopper';
const ISSUER = 'https://example.auth0.com/';
const GRANT = '11111111-2222-4333-8444-555555555555';
const KEY = shopperKey(ISSUER, SUB);
let store;
let cart;
let fetchImpl;
let params;
let service;
let reports;
const acknowledged = () => ({ ok: true, headers: { get: () => null }, json: async () => ({ uuid: '2'.repeat(38), dcs_region: 9 }) });
const make = (options = {}) => createStageCartFactService({
  enabled: true, params, store, claims: { sub: SUB }, namespace: STAGE_NAMESPACE,
  fetchImpl, now: () => NOW, report: (receipt) => reports.push(receipt), ...options,
});

beforeEach(async () => {
  jest.useFakeTimers().setSystemTime(NOW - 3600000);
  store = createMemoryStore();
  cart = await createCart(store, { customerSub: SUB });
  await store.collection('carts').updateOne({ id: cart.id }, { $set: {
    items: [{ uid: 'one', sku: 'private-sku', quantity: 2 }],
  } });
  jest.setSystemTime(NOW);
  await store.collection('customers').insertOne({ sub: SUB, idLinkage: { state: 'granted', grantId: GRANT } });
  await createBindingStore(store).put(KEY, {
    state: 'bound', shopperKey: KEY, subject: sha256(SUB), consentGrantId: GRANT,
    ecid: '1'.repeat(38), ecidSource: 'server-issued', locationHint: 9, blob: 'offline-blob',
    orgId: PARTNER.orgId, dpid: '1547309', resyncAt: NOW + 60000,
  }, { ifMatch: null });
  params = {
    AUTH0_ISSUER: ISSUER, AUTH0_AUDIENCE: 'offline', TARGET_DIAG_ENABLED: 'true',
    TARGET_DIAG_ENVIRONMENT: 'stage', TARGET_DIAG_STAGE_NAMESPACE: STAGE_NAMESPACE,
    TARGET_DIAG_SHOPPER_KEYS: KEY, TARGET_ID_LINKAGE_ENABLED: 'true',
    TARGET_ID_LINKAGE_WORDING_VERSIONS: 'approved-v1', TARGET_ID_BINDING_STORE_APPROVED: 'true',
    TARGET_ID_SERVICE_ENABLED: 'true', TARGET_ID_ORG_ID: PARTNER.orgId, TARGET_ID_DPID: '1547309',
    TARGET_CLIENT_CODE: 'exampleclient', TARGET_PROPERTY_TOKEN: GRANT,
  };
  fetchImpl = jest.fn(async () => acknowledged());
  reports = [];
  service = make();
});
afterEach(() => jest.useRealTimers());

test('maps facts only, preserving tri-state and omitting absent optional values', async () => {
  await store.collection('orders').insertOne({ customerSub: SUB, createdAt: 'invalid', status: 'Processing (demo)' });
  const packet = await createServerCartFacts({ store, claims: { sub: SUB }, environment: 'stage', clock: () => NOW }).read(cart.id);
  const mapped = mapStageCartFacts(packet);
  expect(mapped.c_wknd_stage_purchase_since_last_activity).toBe('unknown');
  expect(mapped).not.toHaveProperty('c_wknd_stage_purchase_last_order_at');
  expect(mapped.c_wknd_stage_cart_total_quantity).toBe('2');
  expect(Object.keys(mapped).every((key) => key.startsWith('c_wknd_stage_'))).toBe(true);
  expect(JSON.stringify(mapped)).not.toMatch(/private-sku|auth0\||financial|qualified|member|planning|pageViews/);
});

test('only real bounded transport ACK plus same fresh binding/grant acknowledges handoff', async () => {
  expect(await service.handoff(cart.id)).toEqual({ status: 'acknowledged' });
  const [endpoint, options] = fetchImpl.mock.calls[0];
  expect(new URL(endpoint).hostname).toBe(PARTNER.host);
  expect(new URL(endpoint).searchParams.get('c_wknd_stage_purchase_since_last_activity')).toBe('not-recorded');
  expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', method: 'GET' });
  expect((await createBindingStore(store).get(KEY)).record.factHandoff.state).toBe('acknowledged');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('delegated shopper facts reuse the existing MID without any declared-ID link or mint', async () => {
  expect(await make({ claims: { sub: SUB, delegated: true } }).handoff(cart.id)).toEqual({ status: 'acknowledged' });
  const endpoint = new URL(fetchImpl.mock.calls[0][0]);
  expect(endpoint.searchParams.get('d_mid')).toBe('1'.repeat(38));
  expect(endpoint.searchParams.has('d_cid')).toBe(false);
  expect(endpoint.searchParams.has('d_cid_ic')).toBe(false);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test.each([
  ['OFF', { enabled: false }],
  ['Production', { namespace: '28538-wkndcommerce' }],
  ['caller namespace label', { namespace: 'another-stage' }],
])('%s does not read facts or call DCS', async (_, options) => {
  const disabled = make(options);
  const read = jest.spyOn(store, 'collection');
  expect(await disabled.handoff(cart.id)).toEqual({ status: 'disabled' });
  expect(read).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(stageFactsEnabled(STAGE_NAMESPACE)).toBe(false);
});

test('withdrawal during transport cannot ACK or grant/remint an identity', async () => {
  fetchImpl.mockImplementation(async () => {
    await store.collection('customers').updateOne({ sub: SUB }, { $set: { idLinkage: { state: 'withdrawn' } } });
    return acknowledged();
  });
  expect(await service.handoff(cart.id)).toMatchObject({ status: 'unavailable', reason: 'BINDING_CHANGED' });
  expect((await createBindingStore(store).get(KEY)).record.ecid).toBe('1'.repeat(38));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('cart changes during transport and DCS errors are honest failures without ACK', async () => {
  fetchImpl.mockImplementation(async () => {
    await store.collection('carts').updateOne({ id: cart.id }, { $set: { revision: 2 } });
    return acknowledged();
  });
  expect(await service.handoff(cart.id)).toMatchObject({ status: 'unavailable', reason: 'FACT_CHANGED' });
  fetchImpl.mockImplementation(async () => ({ ok: true, json: async () => ({ uuid: '2'.repeat(38), errors: [{ code: 171 }] }) }));
  expect(await service.handoff(cart.id)).toMatchObject({ status: 'unavailable', reason: 'DCS_NOT_ACKNOWLEDGED' });
  expect(reports.every((receipt) => !JSON.stringify(receipt).includes(SUB))).toBe(true);
});

test('binding CAS serializes concurrent sends; a second sender cannot overtake the first', async () => {
  let release;
  fetchImpl.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const first = service.handoff(cart.id);
  while (!release) await Promise.resolve();
  expect(await make().handoff(cart.id)).toMatchObject({ status: 'unavailable', reason: 'HANDOFF_BUSY' });
  release(acknowledged());
  expect(await first).toEqual({ status: 'acknowledged' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('durable merged source is locally terminal; only destination sends, no external end/global exclusion', async () => {
  const destination = await createCart(store, { customerSub: SUB });
  const sourceFacts = await createServerCartFacts({ store, claims: { sub: SUB }, environment: 'stage', clock: () => NOW }).read(cart.id);
  await store.collection('carts').updateOne({ id: cart.id }, { $set: { status: 'merged', mergedInto: destination.id } });
  await store.collection('carts').updateOne({ id: destination.id }, { $set: { mergedSources: [cart.id] } });
  expect((await service.afterMerge(cart.id, destination.id)).destination.status).toBe('acknowledged');
  expect((await createBindingStore(store).get(KEY)).record.factTerminalEpisodes).toContain(sourceFacts.episode.key);
  expect(await service.handoff(cart.id)).toMatchObject({ status: 'unavailable', reason: 'EPISODE_TERMINAL' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('c_wknd_stage_cart_state')).toBe('active');
});

test('recorded purchase refreshes other active carts even when the ordered-cart telemetry fails', async () => {
  const other = await createCart(store, { customerSub: SUB });
  await store.collection('orders').insertOne({
    customerSub: SUB, status: 'Processing (demo)', createdAt: new Date(NOW).toISOString(),
  });
  await store.collection('carts').updateOne({ id: cart.id }, { $set: { items: [{ quantity: 'invalid' }] } });
  const result = await service.afterOrder(cart.id);
  expect(result.status).toBe('unavailable');
  expect(result.receipts.some((receipt) => receipt.status === 'acknowledged')).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('c_wknd_stage_purchase_since_last_activity')).toBe('recorded');
  expect(await store.collection('carts').findOne({ id: other.id })).toBeTruthy();
});
