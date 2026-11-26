const { jwtVerify } = require('jose');
const { createAeroBundle, COMPONENTS, MANAGEMENT_CLASS } = require('../lib/aero-bundle');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { loadCatalog, resetCatalogCache, priceFor } = require('../lib/catalog');
const { migrateLegacyPromotions, loadPromotionRuntime } = require('../lib/promotions');
const { createCart, addItem, saveCart, computeTotals } = require('../lib/cart');
const { evaluatePromotions } = require('../lib/promotion-evaluation');
const { runGraphQL } = require('../lib/graphql-server');
const CATALOG = require('../data/catalog.json');

const NOW = Date.parse('2026-11-25T00:00:00.000Z');
const DAY = 86400000;
const BOOKING = 'BK_0123456789abcdef';
const CUSTOMER = { sub: 'auth0|flight-shopper', email: 'shopper@example.com' };
const PARAMS = {
  AERO_BUNDLE_ENABLED: 'true', AUTH0_ISSUER: 'https://example.auth0.com/',
  AUTH0_AUDIENCE: 'https://wknd-aero-api.jaggah.workers.dev',
  WKND_BOOKING_ASSERTION_SECRET: 'test-only-booking-assertion-secret-0123456789',
};
const FIELDS = 'status reason booking_id promotion_id bundle_id percent_off expires_at components{sku quantity name}';
const QUERY = `query($id:String!){wkndAeroBundleOffer(booking_id:$id){${FIELDS}}}`;
const CLAIM = `mutation($id:String!){claimWkndAeroBundleOffer(booking_id:$id){${FIELDS}}}`;
let store;
let cat;
let booking;
let fetchMock;
let service;

const runtime = (cart) => loadPromotionRuntime(store, { params: PARAMS, customer: CUSTOMER, cart, catalog: cat });
const execute = (query, variables = { id: BOOKING }, auth = true) => runGraphQL({
  query, variables, headers: auth ? { authorization: 'Bearer test-shop-token' } : {},
}, { store, params: PARAMS, verify: async () => ({ ...CUSTOMER }) });

async function kitCart(quantity = 1) {
  const cart = await createCart(store, { customerSub: CUSTOMER.sub });
  COMPONENTS.forEach((c) => addItem(cat, cart, { sku: c.sku, quantity }));
  return saveCart(store, {
    ...cart, email: CUSTOMER.email, shippingAddress: { country_code: 'AU' }, billingAddress: { country_code: 'AU' },
    shippingMethod: { carrier_code: 'wknd', method_code: 'standard' }, paymentMethod: 'wknd_demo_pay',
  });
}

beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
  await migrateLegacyPromotions(store);
  cat = await loadCatalog(store, { fresh: true });
  booking = { id: BOOKING, status: 'confirmed', demo: true, createdAt: new Date(NOW - DAY).toISOString() };
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => ({
    ok: true, status: 200, json: async () => ({ ...booking }),
  }));
  service = createAeroBundle({ store, params: PARAMS });
});

afterEach(() => jest.restoreAllMocks());

test('query is read-only and signs only the verified customer for isolated Commerce delegation', async () => {
  const result = await execute(QUERY);
  expect(result.body.errors).toBeUndefined();
  expect(result.body.data.wkndAeroBundleOffer).toMatchObject({
    status: 'ELIGIBLE', percent_off: 50, expires_at: new Date(NOW + 6 * DAY).toISOString(),
    components: COMPONENTS,
  });
  const [url, options] = fetchMock.mock.calls[0];
  expect(url.href).toBe(`https://wknd-aero-api.jaggah.workers.dev/api/bookings/${BOOKING}`);
  expect(options.headers['X-WKND-Delegation']).toBe('commerce');
  const { payload } = await jwtVerify(options.headers.Authorization.slice(7), new TextEncoder().encode(PARAMS.WKND_BOOKING_ASSERTION_SECRET), {
    algorithms: ['HS256'], issuer: 'urn:wknd-commerce:storefront',
    audience: PARAMS.AUTH0_AUDIENCE, currentDate: new Date(NOW),
  });
  expect(payload).toMatchObject({ sub: CUSTOMER.sub, identity_issuer: PARAMS.AUTH0_ISSUER, scope: 'bookings:read' });
  expect(payload.exp - payload.iat).toBe(60);
  expect(await store.collection('aero_bundle_entitlements').countDocuments({})).toBe(0);
  expect(await store.collection('carts').countDocuments({})).toBe(0);
});

test('anonymous claim is rejected before booking lookup or grant writes', async () => {
  const result = await execute(CLAIM, { id: BOOKING }, false);
  expect(result.body.errors[0].extensions.category).toBe('graphql-authorization');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await store.collection('aero_bundle_entitlements').countDocuments({})).toBe(0);
});

test('missing and foreign bookings have the same ineligible result', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 404 });
  await expect(service.offer(CUSTOMER, BOOKING, { claim: true })).resolves.toMatchObject({
    status: 'INELIGIBLE', reason: 'BOOKING_NOT_ELIGIBLE', components: [],
  });
  expect(await store.collection('aero_bundle_entitlements').countDocuments({})).toBe(0);
});

test.each([
  { status: 'pending' }, { demo: false }, { id: 'BK_fedcba9876543210' },
  { createdAt: 'invalid' }, { createdAt: new Date(NOW + 1).toISOString() },
  { createdAt: new Date(NOW - 7 * DAY).toISOString() },
])('unconfirmed, non-demo, mismatched and out-of-window bookings cannot grant (%j)', async (change) => {
  Object.assign(booking, change);
  expect((await service.offer(CUSTOMER, BOOKING, { claim: true })).status).toBe('INELIGIBLE');
  expect(await store.collection('aero_bundle_entitlements').countDocuments({})).toBe(0);
});

test('verification failures and missing configuration are explicit, not eligible or silently ineligible', async () => {
  fetchMock.mockRejectedValue(new Error('network'));
  await expect(service.offer(CUSTOMER, BOOKING, { claim: true })).rejects.toMatchObject({ code: 'AERO_BUNDLE_UNAVAILABLE' });
  await expect(createAeroBundle({ store, params: { ...PARAMS, WKND_BOOKING_ASSERTION_SECRET: '' } })
    .offer(CUSTOMER, BOOKING)).rejects.toMatchObject({ code: 'AERO_BUNDLE_UNAVAILABLE' });
  expect(await store.collection('aero_bundle_entitlements').countDocuments({})).toBe(0);
});

test('default-off policy cannot issue grants and a caller-supplied verification origin is ignored', async () => {
  const off = createAeroBundle({ store, params: { ...PARAMS, AERO_BUNDLE_ENABLED: '' } });
  expect((await off.offer(CUSTOMER, BOOKING, { claim: true })).reason).toBe('OFFER_DISABLED');
  expect(fetchMock).not.toHaveBeenCalled();
  await createAeroBundle({ store, params: { ...PARAMS, WKND_BOOKING_API_BASE: 'https://untrusted.example' } })
    .offer(CUSTOMER, BOOKING);
  expect(fetchMock.mock.calls[0][0].origin).toBe('https://wknd-aero-api.jaggah.workers.dev');
  expect(await store.collection('aero_bundle_entitlements').countDocuments({})).toBe(0);
});

test('concurrent claims are idempotent and do not edit the cart; later booking changes cannot renew a grant', async () => {
  const cart = await kitCart();
  const results = await Promise.all([service.offer(CUSTOMER, BOOKING, { claim: true }), service.offer(CUSTOMER, BOOKING, { claim: true })]);
  expect(results.map((r) => r.status)).toEqual(['CLAIMED', 'CLAIMED']);
  expect(await store.collection('aero_bundle_entitlements').countDocuments({})).toBe(1);
  expect(await store.collection('carts').findOne({ id: cart.id })).toEqual(cart);
  booking.createdAt = new Date(NOW).toISOString();
  await expect(service.offer(CUSTOMER, BOOKING, { claim: true })).rejects.toMatchObject({ code: 'AERO_BUNDLE_UNAVAILABLE' });
});

test('only claimed owned booking grants authorize exactly one complete kit, using fresh prices and no stacking', async () => {
  const cart = await kitCart(2);
  expect((await runtime(cart)).definitions.some((p) => p.managementClass === MANAGEMENT_CLASS)).toBe(false);
  await service.offer(CUSTOMER, BOOKING, { claim: true });
  const changedSku = COMPONENTS[0].sku;
  await store.collection('prices').updateOne({ sku: changedSku }, { $set: { regular: 40, special: null } });
  const rt = await runtime(cart);
  const totals = computeTotals(rt.catalogSnapshot, cart, rt);
  const expectedMinor = COMPONENTS.reduce((n, c) => n + Math.round(priceFor(rt.catalogSnapshot, c.sku).final * 100), 0);
  expect(totals.promotion.selected.managementClass).toBe(MANAGEMENT_CLASS);
  expect(totals.discountTotal).toBe(Math.round(expectedMinor / 2) / 100);
  const partial = { ...cart, items: cart.items.slice(1) };
  expect(computeTotals(rt.catalogSnapshot, partial, rt).promotion.selected?.managementClass).not.toBe(MANAGEMENT_CLASS);
  expect((await runtime({ ...cart, customerSub: 'auth0|another' })).definitions.some((p) => p.managementClass === MANAGEMENT_CLASS)).toBe(false);
  const stronger = {
    ...rt.definitions.find((p) => p.managementClass === MANAGEMENT_CLASS),
    id: 'standard-stronger-coupon', managementClass: 'standard', mode: 'coupon', code: 'BETTER90',
    discount: { kind: 'percentage', basisPoints: 9000 },
  };
  const result = evaluatePromotions({
    promotions: [...rt.definitions, stronger], lines: totals.lines.map((l) => ({
      id: l.item.uid, sku: l.item.sku, quantity: l.item.quantity, unitPriceMinor: Math.round(l.final * 100),
      grossMinor: Math.round(l.rowIncl * 100), currency: 'AUD', availableQuantity: 100, sellable: true,
    })),
    explicitCode: 'BETTER90', selection: rt.selection, trust: rt.trust, nowMs: NOW,
  });
  expect(result.selected.id).toBe(stronger.id);
});

test('booking revocation, spent grants and insufficient current kit stock remove eligibility', async () => {
  const cart = await kitCart();
  await service.offer(CUSTOMER, BOOKING, { claim: true });
  booking.status = 'cancelled';
  expect((await runtime(cart)).definitions.some((p) => p.managementClass === MANAGEMENT_CLASS)).toBe(false);
  booking.status = 'confirmed';
  await store.collection('inventory').updateOne({ sku: COMPONENTS[0].sku }, { $set: { qty: 0 } });
  const rt = await runtime(cart);
  expect(computeTotals(rt.catalogSnapshot, cart, rt).promotion.selected?.managementClass).not.toBe(MANAGEMENT_CLASS);
});

test.each([false, true])('claimed kit completes with one cart CAS, including an empty cart: %s', async (empty) => {
  await service.offer(CUSTOMER, BOOKING, { claim: true });
  let cart = await createCart(store, { customerSub: CUSTOMER.sub });
  if (!empty) addItem(cat, cart, { sku: COMPONENTS[0].sku, quantity: 1 });
  cart = await saveCart(store, cart);
  const offers = await execute('query($id:String!){wkndBundleOffers(cart_id:$id){promotion_id bundle_id cart_version}}', { id: cart.id });
  expect(offers.body.errors).toBeUndefined();
  const promotionId = (await service.offer(CUSTOMER, BOOKING)).promotion_id;
  const offer = offers.body.data.wkndBundleOffers.find((o) => o.promotion_id === promotionId);
  expect(offer).toBeDefined();
  const complete = `mutation($id:String!,$promotion:String!,$bundle:String!,$version:String!){
    completeWkndBundle(cart_id:$id,promotion_id:$promotion,bundle_id:$bundle,expected_cart_version:$version){
      cart{total_quantity wknd_cart_version} user_errors{code}
    }
  }`;
  const variables = { id: cart.id, promotion: offer.promotion_id, bundle: offer.bundle_id, version: 'v0' };
  const stale = await execute(complete, variables);
  expect(stale.body.errors).toBeDefined();
  expect(await store.collection('carts').findOne({ id: cart.id })).toEqual(cart);
  const completed = await execute(complete, { ...variables, version: offer.cart_version });
  expect(completed.body.errors).toBeUndefined();
  expect(completed.body.data.completeWkndBundle).toEqual({
    cart: { total_quantity: 3, wknd_cart_version: `v${cart.revision + 1}` }, user_errors: [],
  });
  const saved = await store.collection('carts').findOne({ id: cart.id });
  expect(saved.items.map(({ sku, quantity }) => ({ sku, quantity })).sort((a, b) => a.sku.localeCompare(b.sku)))
    .toEqual(COMPONENTS.map(({ sku, quantity }) => ({ sku, quantity })).sort((a, b) => a.sku.localeCompare(b.sku)));
  const rt = await runtime(saved);
  const totals = computeTotals(rt.catalogSnapshot, saved, rt);
  const kitMinor = COMPONENTS.reduce((sum, component) => sum + Math.round(priceFor(rt.catalogSnapshot, component.sku).final * 100), 0);
  expect(totals.discountTotal).toBe(Math.round(kitMinor / 2) / 100);
  expect(totals.promotion.selected.managementClass).toBe(MANAGEMENT_CLASS);
  const repeated = await execute(complete, { ...variables, version: `v${saved.revision}` });
  expect(repeated.body.errors).toBeDefined();
  expect(await store.collection('carts').findOne({ id: cart.id })).toEqual(saved);
  expect(await store.collection('aero_bundle_redemptions').countDocuments({})).toBe(0);
});

test('redemption has one winner across carts and releases only a proven stock-failure reservation', async () => {
  await service.offer(CUSTOMER, BOOKING, { claim: true });
  const cart = await kitCart();
  const promotion = (await runtime(cart)).definitions.find((p) => p.managementClass === MANAGEMENT_CLASS);
  const results = await Promise.allSettled(['cart-a', 'cart-b'].map((cartId) => service.reserveRedemption({ customer: CUSTOMER, promotion, cartId })));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect((await service.offer(CUSTOMER, BOOKING)).status).toBe('REDEEMED');
  await results.find((r) => r.status === 'fulfilled').value.release();
  expect((await service.offer(CUSTOMER, BOOKING)).status).toBe('CLAIMED');
});

test('a stock race after financial validation releases the grant and creates no order', async () => {
  await service.offer(CUSTOMER, BOOKING, { claim: true });
  const cart = await kitCart();
  const inventory = store.collection('inventory');
  const update = inventory.updateOne.bind(inventory);
  jest.spyOn(inventory, 'updateOne').mockImplementation((filter, values, options) => (
    values.$inc?.qty < 0 ? Promise.resolve({ matchedCount: 0 }) : update(filter, values, options)
  ));
  const result = await execute('mutation($id:String!){placeOrder(input:{cart_id:$id}){errors{code} orderV2{number}}}', { id: cart.id });
  expect(result.body.data.placeOrder.errors.length).toBeGreaterThan(0);
  expect(await store.collection('orders').countDocuments({})).toBe(0);
  expect(await store.collection('aero_bundle_redemptions').countDocuments({})).toBe(0);
  expect((await store.collection('carts').findOne({ id: cart.id })).status).toBe('active');
});

test('unknown order insertion outcome conservatively retains the redemption reservation', async () => {
  await service.offer(CUSTOMER, BOOKING, { claim: true });
  const cart = await kitCart();
  const orders = store.collection('orders');
  const insert = orders.insertOne.bind(orders);
  jest.spyOn(orders, 'insertOne').mockImplementation(async (order) => {
    await insert(order);
    throw new Error('insertion outcome unknown');
  });
  const result = await execute('mutation($id:String!){placeOrder(input:{cart_id:$id}){orderV2{number}}}', { id: cart.id });
  expect(result.body.errors).toBeDefined();
  expect(await store.collection('orders').countDocuments({})).toBe(1);
  expect(await store.collection('aero_bundle_redemptions').findOne({})).toMatchObject({ state: 'reserved', cartId: cart.id });
  expect((await service.offer(CUSTOMER, BOOKING)).status).toBe('REDEEMED');
});

test.each([
  'mutation($id:String!){placeOrder(input:{cart_id:$id}){orderV2{number}}}',
  'mutation($id:String!){setPaymentMethodAndPlaceOrder(input:{cart_id:$id,payment_method:{code:"wknd_demo_pay"}}){order{order_number}}}',
])('both order roots enforce and durably consume the booking grant (%#)', async (query) => {
  await service.offer(CUSTOMER, BOOKING, { claim: true });
  const cart = await kitCart();
  const result = await execute(query, { id: cart.id });
  expect(result.body.errors).toBeUndefined();
  const orders = await store.collection('orders').find({});
  expect(orders).toHaveLength(1);
  expect(orders[0].promotion.managementClass).toBe(MANAGEMENT_CLASS);
  expect(await store.collection('aero_bundle_redemptions').findOne({})).toMatchObject({
    cartId: cart.id, state: 'redeemed', orderNumber: orders[0].number,
  });
  expect((await service.offer(CUSTOMER, BOOKING)).status).toBe('REDEEMED');
  const other = await kitCart();
  expect((await runtime(other)).definitions.some((p) => p.managementClass === MANAGEMENT_CLASS)).toBe(false);
});
