const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { resetCatalogCache } = require('../lib/catalog');
const { createCart, assertCartVersion } = require('../lib/cart');
const { createBindingStore } = require('../lib/target-binding-store');
const { shopperKey } = require('../lib/recovery-policy');
const { runGraphQL } = require('../lib/graphql-server');
const { MBOX, REQUEST_SCHEMA } = require('../lib/target-diagnostic');
const CATALOG = require('../data/catalog.json');

const SUB = 'auth0|synthetic-planner-cart';
const ISSUER = 'https://example.auth0.com/';
const NS = '28538-wkndcommerce-stage';
const GRANT = '11111111-2222-4333-8444-555555555555';
const FIELDS = 'kind status coupon_code percent_off max_discount { value currency } saving { value currency } current_saving { value currency } expires_at message';
const QUERY = `query($id:String!) {
  cart(cart_id:$id) { wknd_cart_version wknd_planner_offer { ${FIELDS} } prices { grand_total { value } discounts { amount { value } label coupon { code } } } }
  wkndPlannerOffer(cart_id:$id) { ${FIELDS} }
}`;
let store;
let cart;
let params;
let marker;
let fetchImpl;
async function read(change = {}) {
  return runGraphQL({ query: QUERY, variables: { id: cart.id }, headers: { authorization: 'Bearer offline' } }, {
    store, params: { ...params, ...change }, namespace: NS, audienceFetchImpl: fetchImpl, verify: async () => ({ sub: SUB }),
  }).then(r => r.body);
}

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
  await store.collection('customers').insertOne({
    _id: SUB, id: SUB, sub: SUB, email: 'synthetic@example.com',
    idLinkage: { state: 'granted', grantId: GRANT },
  });
  const key = shopperKey(ISSUER, SUB);
  await createBindingStore(store).put(key, {
    state: 'bound', shopperKey: key, orgId: 'A'.repeat(24) + '@AdobeOrg', dpid: '1547309',
    ecid: '1'.repeat(38), locationHint: 9, blob: 'offline-blob', ecidSource: 'server-issued',
    consentGrantId: GRANT, resyncAt: Date.now() + 60000,
  }, { ifMatch: null });
  cart = await createCart(store, { customerSub: SUB });
  await store.collection('carts').updateOne({ id: cart.id }, { $set: {
    items: [{ uid: 'line-1', sku: 'WKND-LGT-001', parentSku: 'WKND-LGT-001', quantity: 10 }],
  } });
  params = {
    AUTH0_ISSUER: ISSUER, AUTH0_AUDIENCE: 'offline',
    STAGE_AAM_GENERAL_OFFERS_ENABLED: 'true', TARGET_DIAG_ENABLED: 'true',
    TARGET_DIAG_ENVIRONMENT: 'stage', TARGET_DIAG_STAGE_NAMESPACE: NS,
    TARGET_DIAG_PRODUCTION_NAMESPACE: 'example-production', TARGET_DIAG_SHOPPER_KEYS: key,
    TARGET_CLIENT_CODE: 'exampleclient', TARGET_PROPERTY_TOKEN: GRANT,
    TARGET_ID_LINKAGE_ENABLED: 'true', TARGET_ID_LINKAGE_WORDING_VERSIONS: 'approved-v1',
    TARGET_ID_BINDING_STORE_APPROVED: 'true', TARGET_ID_SERVICE_ENABLED: 'true',
    TARGET_ID_ORG_ID: 'A'.repeat(24) + '@AdobeOrg', TARGET_ID_DPID: '1547309',
  };
  marker = 'climbing-planner';
  fetchImpl = jest.fn(async () => ({
    ok: true, json: async () => ({ execute: { mboxes: [{ name: MBOX, options: [{
      type: 'json', content: { schema: REQUEST_SCHEMA, environment: 'stage', marker, financialAuthorization: false },
    }] }] } }),
  }));
});

test('canonical planner auto-selects normalized capped v1 Money/CLAIMED without abandonment or claim', async () => {
  const body = await read();
  expect(body.errors).toBeUndefined();
  const offer = body.data.wkndPlannerOffer;
  expect(offer).toMatchObject({
    kind: 'climbing_planner', status: 'CLAIMED', coupon_code: null, percent_off: 10,
    max_discount: { value: 25, currency: 'AUD' }, saving: { value: 25, currency: 'AUD' },
    expires_at: null,
  });
  expect(body.data.cart.wknd_planner_offer).toEqual(offer);
  expect(body.data.cart.prices.discounts[0]).toMatchObject({ label: 'Climbing planner gear benefit', coupon: null });
  expect(JSON.stringify(offer)).not.toMatch(/evidence|financialAuthorization|27507404|11256852|pdr_|offer_applied/);
  expect(await store.collection('recovery_entitlements').countDocuments({})).toBe(0);
});

test.each([
  ['control', {}, 'control'],
  ['OFF default', { STAGE_AAM_GENERAL_OFFERS_ENABLED: '' }, 'climbing-planner'],
  ['Production', { TARGET_DIAG_ENVIRONMENT: 'production', TARGET_DIAG_TARGET_CONFIG_APPROVED: 'true' }, 'climbing-planner'],
])('%s leaves the cart undiscounted, UNAVAILABLE with a message, and no gratuitous version write', async (_, change, selected) => {
  marker = selected;
  const body = await read(change);
  expect(body.errors).toBeUndefined();
  expect(body.data.wkndPlannerOffer).toMatchObject({ status: 'UNAVAILABLE', saving: null });
  expect(body.data.wkndPlannerOffer.message).toBeTruthy();
  expect(body.data.cart.prices.discounts).toEqual([]);
  expect(body.data.cart.wknd_cart_version).toBe('v0');
  expect(fetchImpl).toHaveBeenCalledTimes(selected === 'control' ? 1 : 0);
});

test('best-saving preserves a better coupon and reports the planner as ELIGIBLE, not applied', async () => {
  await store.collection('carts').updateOne({ id: cart.id }, { $set: { coupons: ['WKND10'] } });
  const body = await read();
  expect(body.errors).toBeUndefined();
  expect(body.data.wkndPlannerOffer.status).toBe('ELIGIBLE');
  expect(body.data.wkndPlannerOffer.current_saving.value).toBeGreaterThan(body.data.wkndPlannerOffer.saving.value);
  expect(body.data.cart.prices.discounts[0].coupon.code).toBe('WKND10');
});

test('selection change advances the reviewed cart version; stable reads and concurrent field reads do not', async () => {
  const initial = await read();
  const version = initial.data.cart.wknd_cart_version;
  expect(version).not.toBe('v0');
  expect((await read()).data.cart.wknd_cart_version).toBe(version);
  marker = 'control';
  const lost = await read();
  expect(lost.data.cart.wknd_cart_version).not.toBe(version);
  expect(lost.data.cart.prices.discounts).toEqual([]);
  const actual = await store.collection('carts').findOne({ id: cart.id });
  expect(() => assertCartVersion(actual, version)).toThrow(expect.objectContaining({ code: 'CART_CHANGED' }));
  expect((await read()).data.cart.wknd_cart_version).toBe(lost.data.cart.wknd_cart_version);
});

test('ordinary OFF code rollback reconciles pricing/version even with absent Target settings', async () => {
  const initial = await read();
  const version = initial.data.cart.wknd_cart_version;
  const off = { STAGE_AAM_GENERAL_OFFERS_ENABLED: '', TARGET_DIAG_ENVIRONMENT: '', TARGET_DIAG_STAGE_NAMESPACE: '' };
  const rolledBack = await read(off);
  expect(rolledBack.data.cart.prices.discounts).toEqual([]);
  expect(rolledBack.data.cart.wknd_cart_version).not.toBe(version);
  expect((await read(off)).data.cart.wknd_cart_version).toBe(rolledBack.data.cart.wknd_cart_version);
});
