/**
 * Shared promotion engine in the storefront cart and both order paths, plus the protected
 * cart-recovery offer (single redemption per verified shopper per campaign).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SignJWT } = require('jose');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { runGraphQL } = require('../lib/graphql-server');
const { resetCatalogCache, loadCatalog } = require('../lib/catalog');
const { placeOrder } = require('../lib/orders');
const { saveCart } = require('../lib/cart');
const {
  migrateLegacyPromotions, createPromotionService, loadPromotionRuntime, LEGACY_SEEDS,
} = require('../lib/promotions');
const { bootstrapRecoveryPromotion, promotionIdFor, DEFAULT_CAMPAIGN } = require('../lib/recovery-policy');
const { bundleOpportunities } = require('../lib/bundles');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
const AUTH0_ISSUER = 'https://example.auth0.com/';
const SUB = 'auth0|recovery-shopper';
const TOKEN = 'web-token';
const READY = { AUTH0_ISSUER, AUTH0_AUDIENCE: 'test', RECOVERY_REDEMPTION_VERIFIED: 'true' };
const NOT_READY = { AUTH0_ISSUER, AUTH0_AUDIENCE: 'test' };
const verify = async (token) => {
  if (token !== TOKEN) throw new Error('bad token');
  return { sub: SUB, email: 'shopper@example.com', given_name: 'Sam' };
};
const HOUR = 3600 * 1000;
const RID = promotionIdFor(DEFAULT_CAMPAIGN.campaignId);

const priceOf = (sku) => CATALOG.prices.find((p) => p.sku === sku);
const inStock = (sku) => (CATALOG.inventory.find((i) => i.sku === sku)?.qty || 0) > 5;
const simples = CATALOG.products.filter((p) => p.type === 'simple' && inStock(p.sku) && priceOf(p.sku)?.special == null);
const cheap = simples.find((p) => priceOf(p.sku).regular < 100);
const pricey = simples.find((p) => priceOf(p.sku).regular >= 300) || simples.find((p) => priceOf(p.sku).regular >= 150);

let store;
let params;
async function gql(query, variables = {}, { auth = true, factService, namespace } = {}) {
  const headers = auth ? { authorization: `Bearer ${TOKEN}` } : {};
  const { body } = await runGraphQL({ query, variables, headers }, { store, params, verify, factService, namespace });
  return body;
}

const CART_FIELDS = 'id applied_coupons { code } prices { grand_total { value } discounts { amount { value } label coupon { code } } applied_taxes { amount { value } } subtotal_including_tax { value } }';
const ADD = `mutation Add($id: String!, $sku: String!, $qty: Float!) { addProductsToCart(cartId: $id, cartItems: [{ sku: $sku, quantity: $qty }]) { cart { ${CART_FIELDS} } user_errors { code message } } }`;
const APPLY = `mutation Apply($id: String!, $code: String!) { applyCouponToCart(input: { cart_id: $id, coupon_code: $code }) { cart { ${CART_FIELDS} } } }`;
const OFFER = 'query Offer($id: String!) { wkndRecoveryOffer(cart_id: $id) { status reason coupon_code percent_off max_discount { value } expires_at } }';
const CLAIM = 'mutation Claim($id: String!) { claimWkndRecoveryOffer(cart_id: $id) { status reason coupon_code percent_off max_discount { value } expires_at } }';
const PLACE = 'mutation Place($id: String!) { placeOrder(input: { cart_id: $id }) { errors { code message } orderV2 { number total { discounts { amount { value } } grand_total { value } } } } }';

describe('facts-only post-persistence hooks', () => {
  test('cart handoff sees committed state; unavailable telemetry does not undo the mutation', async () => {
    const id = await customerCartId();
    const handoff = jest.fn(async (cartId) => {
      expect((await store.collection('carts').findOne({ id: cartId })).items[0].quantity).toBe(2);
      return { status: 'unavailable' };
    });
    const body = await gql(ADD, { id, sku: cheap.sku, qty: 2 }, { factService: { handoff } });
    expect(body.errors).toBeUndefined();
    expect(handoff).toHaveBeenCalledWith(id);
    expect((await store.collection('carts').findOne({ id })).items[0].quantity).toBe(2);
  });

  test.each([
    PLACE,
    'mutation($id:String!){setPaymentMethodAndPlaceOrder(input:{cart_id:$id,payment_method:{code:"wknd_demo_pay"}}){order{order_number}}}',
  ])('both order paths anchor facts to durable insert, even if subsequent cart bookkeeping fails (%#)', async (query) => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: cheap.sku, qty: 1 });
    await readyForCheckout(id);
    const afterOrder = jest.fn(async (cartId) => {
      expect(await store.collection('orders').countDocuments({ customerSub: SUB })).toBe(1);
      expect((await store.collection('carts').findOne({ id: cartId })).status).toBe('ordering');
      return { status: 'unavailable' };
    });
    const carts = store.collection('carts');
    const replace = carts.replaceOne.bind(carts);
    jest.spyOn(carts, 'replaceOne').mockImplementation((filter, next) => {
      if (next.status === 'ordered') throw new Error('mock bookkeeping failure');
      return replace(filter, next);
    });
    const body = await gql(query, { id }, { factService: { handoff: async () => ({ status: 'disabled' }), afterOrder } });
    expect(body.errors).toBeTruthy();
    expect(afterOrder).toHaveBeenCalledWith(id);
    expect(await store.collection('orders').countDocuments({ customerSub: SUB })).toBe(1);
  });
});

async function customerCartId() {
  return (await gql('query { customerCart { id } }')).data.customerCart.id;
}

async function readyForCheckout(id) {
  const address = {
    firstname: 'Sam', lastname: 'Shopper', street: ['1 Trail St'], city: 'Sydney', postcode: '2000', telephone: '0400000000', country_code: 'AU', region: 'NSW',
  };
  const steps = [
    await gql('mutation($id: String!) { setGuestEmailOnCart(input: { cart_id: $id, email: "shopper@example.com" }) { cart { id } } }', { id }),
    await gql('mutation($id: String!, $a: CartAddressInput!) { setShippingAddressesOnCart(input: { cart_id: $id, shipping_addresses: [{ address: $a }] }) { cart { id } } }', { id, a: address }),
    await gql('mutation($id: String!) { setBillingAddressOnCart(input: { cart_id: $id, billing_address: { same_as_shipping: true } }) { cart { id } } }', { id }),
    await gql('mutation($id: String!) { setPaymentMethodOnCart(input: { cart_id: $id, payment_method: { code: "wknd_demo_pay" } }) { cart { id } } }', { id }),
  ];
  steps.forEach((s) => expect(s.errors).toBeUndefined());
}

async function age(cartId, hours) {
  await store.collection('carts').updateOne({ id: cartId }, { $set: { activityAt: new Date(Date.now() - hours * HOUR).toISOString() } });
}

async function enableRecovery() {
  const svc = createPromotionService({ store, loadCatalog: () => loadCatalog(store), params: READY });
  const current = (await store.collection('promotions').findOne({ id: RID }));
  const r = await svc.updatePromotion({ actor: { kind: 'ims-operator', subject: 'op', orgId: 'ORG@AdobeOrg' }, correlationId: crypto.randomUUID() }, {
    id: RID,
    expectedRevision: current.revision,
    idempotencyKey: crypto.randomUUID(),
    promotion: {
      name: current.name,
      enabled: true,
      mode: 'coupon',
      code: 'RECOVER10',
      discount: { kind: 'percentage', basisPoints: 1000 },
      maxDiscountMinor: 2500,
      minimumMerchandiseMinor: null,
      target: { kind: 'all' },
      startsAt: null,
      endsAt: null,
      audienceRestriction: null,
    },
  });
  expect(r.ok).toBe(true);
}

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  params = READY;
  await importCatalog(store, CATALOG, { replace: true });
});

describe('cart read and add/remove definition overlap', () => {
  const operations = {
    cart: `query($id:String!){cart(cart_id:$id){${CART_FIELDS}}}`,
    customerCart: `query{customerCart{${CART_FIELDS}}}`,
    add: ADD,
    remove: `mutation($id:String!,$uid:ID!){removeItemFromCart(input:{cart_id:$id,cart_item_uid:$uid}){cart{${CART_FIELDS}}}}`,
  };

  test.each(Object.keys(operations))('%s starts global definitions while the owned cart read is pending', async (operation) => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: cheap.sku, qty: 1 });
    await migrateLegacyPromotions(store);
    const carts = store.collection('carts');
    const uid = (await carts.findOne({ id })).items[0].uid;
    let releaseCart;
    const definitionsStarted = new Promise((resolve) => { releaseCart = resolve; });
    const method = operation === 'customerCart' ? 'find' : 'findOne';
    const read = carts[method].bind(carts);
    jest.spyOn(carts, method).mockImplementationOnce(async (...args) => {
      await definitionsStarted;
      return read(...args);
    });
    const meta = store.collection('promotion_meta');
    const migration = meta.findOne.bind(meta);
    const migrationRead = jest.spyOn(meta, 'findOne').mockImplementation(async (...args) => {
      releaseCart();
      return migration(...args);
    });
    const result = await gql(operations[operation], { id, uid, sku: cheap.sku, qty: 1 });
    expect(result.errors).toBeUndefined();
    expect(migrationRead).toHaveBeenCalledTimes(1);
    const saved = await carts.findOne({ id });
    expect(saved.items.reduce((sum, item) => sum + item.quantity, 0)).toBe(operation === 'add' ? 2 : operation === 'remove' ? 0 : 1);
  });

  test.each(['missing', 'another-owner'])('a %s cart error takes priority over an earlier definition failure', async (kind) => {
    const id = await customerCartId();
    if (kind === 'missing') await store.collection('carts').deleteMany({ id });
    else await store.collection('carts').updateOne({ id }, { $set: { customerSub: 'another-owner' } });
    const carts = store.collection('carts');
    const read = carts.findOne.bind(carts);
    jest.spyOn(carts, 'findOne').mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => setImmediate(resolve));
      return read(...args);
    });
    jest.spyOn(store.collection('promotion_meta'), 'findOne').mockRejectedValue(new Error('definitions unavailable'));
    const result = await gql(operations.cart, { id });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].extensions.code).toBe(kind === 'missing' ? 'CART_NOT_FOUND' : 'UNAUTHORIZED');
  });

  test('customer authorization fails before any global definition read', async () => {
    const migration = jest.spyOn(store.collection('promotion_meta'), 'findOne');
    const result = await gql(operations.customerCart, {}, { auth: false });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].extensions.category).toBe('graphql-authorization');
    expect(migration).not.toHaveBeenCalled();
  });

  test('an independent definition failure surfaces without committing an add', async () => {
    const id = await customerCartId();
    const carts = store.collection('carts');
    const before = await carts.findOne({ id });
    jest.spyOn(store.collection('promotion_meta'), 'findOne').mockRejectedValue(new Error('definitions unavailable'));
    const result = await gql(ADD, { id, sku: cheap.sku, qty: 1 });
    expect(result.errors[0].message).toBe('definitions unavailable');
    expect(await carts.findOne({ id })).toEqual(before);
  });

  test.each(['add', 'remove'])('%s refreshes global definitions after a CAS conflict and on the next request', async (operation) => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: cheap.sku, qty: 1 });
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    await migrateLegacyPromotions(store);
    const svc = createPromotionService({ store, loadCatalog: () => loadCatalog(store) });
    const created = await svc.createPromotion({
      actor: { kind: 'ims-operator', subject: 'op', orgId: 'ORG@AdobeOrg' }, correlationId: crypto.randomUUID(),
    }, {
      idempotencyKey: crypto.randomUUID(),
      promotion: {
        name: 'Fresh five off', enabled: true, mode: 'automatic',
        discount: { kind: 'fixed', amountMinor: 500, currency: 'AUD' }, target: { kind: 'all' },
      },
    });
    expect(created.ok).toBe(true);
    const carts = store.collection('carts');
    const uid = (await carts.findOne({ id })).items[0].uid;
    const replace = carts.replaceOne.bind(carts);
    const migration = jest.spyOn(store.collection('promotion_meta'), 'findOne');
    jest.spyOn(carts, 'replaceOne').mockImplementationOnce(async (filter, next) => {
      await carts.updateOne({ id }, { $inc: { revision: 1 } });
      await store.collection('promotions').updateOne({ id: created.promotion.id }, { $set: { enabled: false } });
      return replace(filter, next);
    });
    const changed = await gql(operations[operation], { id, uid, sku: cheap.sku, qty: 1 });
    expect(changed.errors).toBeUndefined();
    const result = operation === 'add' ? changed.data.addProductsToCart : changed.data.removeItemFromCart;
    expect(result.cart.prices.discounts).toEqual([]);
    expect(migration).toHaveBeenCalledTimes(2);
    await store.collection('promotions').updateOne({ id: created.promotion.id }, { $set: { enabled: true } });
    const next = await gql(operations.cart, { id });
    expect(next.errors).toBeUndefined();
    expect(next.data.cart.prices.discounts).toEqual([{ amount: { value: 5 }, label: 'Fresh five off', coupon: null }]);
    expect(migration).toHaveBeenCalledTimes(3);
  });
});

test('quantity CAS retry discards scoped stock reads and revalidates the latest inventory', async () => {
  const id = await customerCartId();
  await gql(ADD, { id, sku: cheap.sku, qty: 1 });
  const cart = await store.collection('carts').findOne({ id });
  const carts = store.collection('carts');
  const replace = carts.replaceOne.bind(carts);
  const migrationRead = jest.spyOn(store.collection('promotion_meta'), 'findOne');
  jest.spyOn(carts, 'replaceOne').mockImplementationOnce(async (filter, next) => {
    await store.collection('inventory').updateOne({ sku: cheap.sku }, { $set: { qty: 2 } });
    await carts.updateOne({ id }, { $inc: { revision: 1 } });
    return replace(filter, next);
  });
  const result = await gql(`mutation($id:String!,$uid:ID!){
    updateCartItems(input:{cart_id:$id,cart_items:[{cart_item_uid:$uid,quantity:3}]}){
      cart{total_quantity} errors{code}
    }}`, { id, uid: cart.items[0].uid });
  expect(result.errors).toBeUndefined();
  expect(result.data.updateCartItems).toMatchObject({
    cart: { total_quantity: 2 }, errors: [{ code: 'INSUFFICIENT_STOCK' }],
  });
  expect(migrationRead).toHaveBeenCalledTimes(2);
});

test('quantity zero can still remove a now-disabled product without using stale financial facts', async () => {
  const id = await customerCartId();
  await gql(ADD, { id, sku: cheap.sku, qty: 1 });
  const cart = await store.collection('carts').findOne({ id });
  await store.collection('products').updateOne({ sku: cheap.sku }, { $set: { status: 'disabled' } });
  const result = await gql(`mutation($id:String!,$uid:ID!){
    updateCartItems(input:{cart_id:$id,cart_items:[{cart_item_uid:$uid,quantity:0}]}){
      cart{total_quantity} errors{code}
    }}`, { id, uid: cart.items[0].uid });
  expect(result.errors).toBeUndefined();
  expect(result.data.updateCartItems).toMatchObject({ cart: { total_quantity: 0 }, errors: [] });
});

describe('ordered cart mutation and estimate outcomes', () => {
  const batch = `mutation($id:String!,$uid:ID!,$estimateId:String!){
    updateCartItems(input:{cart_id:$id,cart_items:[{cart_item_uid:$uid,quantity:2}]}){
      cart{total_quantity} errors{code}
    }
    shipping:estimateShippingMethods(input:{cart_id:$estimateId,address:{country_code:AU}}){method_code}
    estimated:estimateTotals(input:{cart_id:$estimateId,address:{country_code:AU}}){cart{total_quantity}}
  }`;

  test.each(['missing', 'another-owner'])('post-write %s estimate errors preserve the committed update outcome', async (kind) => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: cheap.sku, qty: 1 });
    const cart = await store.collection('carts').findOne({ id });
    const estimateId = 'invalid-estimate-cart';
    if (kind === 'another-owner') {
      await store.collection('carts').insertOne({ ...cart, id: estimateId, customerSub: 'auth0|other-shopper' });
    }
    const result = await gql(batch, { id, uid: cart.items[0].uid, estimateId });
    expect(result.data.updateCartItems).toMatchObject({ cart: { total_quantity: 2 }, errors: [] });
    expect(result.data.shipping).toBeNull();
    expect(result.data.estimated.cart).toBeNull();
    expect(result.errors.find((error) => error.path.join('.') === 'estimated.cart')).toMatchObject({
      path: ['estimated', 'cart'],
      extensions: { category: kind === 'missing' ? 'graphql-no-such-entity' : 'graphql-authorization' },
    });
    expect(result.errors.find((error) => error.path.join('.') === 'shipping')).toMatchObject({
      extensions: { category: kind === 'missing' ? 'graphql-no-such-entity' : 'graphql-authorization' },
    });
    expect((await store.collection('carts').findOne({ id })).items[0].quantity).toBe(2);
  });

  test('empty cart and partial update errors remain visible alongside destination estimates', async () => {
    const id = await customerCartId();
    const empty = await gql(`mutation($id:String!){
      updateCartItems(input:{cart_id:$id,cart_items:[{cart_item_uid:"missing",quantity:2}]}){cart{total_quantity} errors{code}}
      shipping:estimateShippingMethods(input:{cart_id:$id,address:{country_code:AU}}){method_code}
      estimated:estimateTotals(input:{cart_id:$id,address:{country_code:AU}}){cart{total_quantity}}
    }`, { id });
    expect(empty.errors).toBeUndefined();
    expect(empty.data.updateCartItems).toMatchObject({
      cart: { total_quantity: 0 }, errors: [{ code: 'COULD_NOT_FIND_CART_ITEM' }],
    });
    expect(empty.data.estimated.cart.total_quantity).toBe(0);
    await gql(ADD, { id, sku: cheap.sku, qty: 1 });
    const cart = await store.collection('carts').findOne({ id });
    const partial = await gql(`mutation($id:String!,$uid:ID!){
      updateCartItems(input:{cart_id:$id,cart_items:[
        {cart_item_uid:$uid,quantity:2},{cart_item_uid:"missing",quantity:1}
      ]}){cart{total_quantity} errors{code}}
      estimated:estimateTotals(input:{cart_id:$id,address:{country_code:AU}}){cart{total_quantity}}
    }`, { id, uid: cart.items[0].uid });
    expect(partial.errors).toBeUndefined();
    expect(partial.data.updateCartItems).toMatchObject({
      cart: { total_quantity: 2 }, errors: [{ code: 'COULD_NOT_FIND_CART_ITEM' }],
    });
    expect(partial.data.estimated.cart.total_quantity).toBe(2);
  });

  test('partial add user_errors preserve the actual mutation outcome alongside the estimate', async () => {
    const id = await customerCartId();
    const result = await gql(`mutation($id:String!,$sku:String!){
      addProductsToCart(cartId:$id,cartItems:[{sku:$sku,quantity:1},{sku:"NOT-A-PRODUCT",quantity:1}]){
        cart{total_quantity} user_errors{code}
      }
      estimated:estimateTotals(input:{cart_id:$id,address:{country_code:AU}}){cart{total_quantity}}
    }`, { id, sku: cheap.sku });
    expect(result.errors).toBeUndefined();
    expect(result.data.addProductsToCart).toMatchObject({
      cart: { total_quantity: 1 }, user_errors: [{ code: 'PRODUCT_NOT_FOUND' }],
    });
    expect(result.data.estimated.cart.total_quantity).toBe(1);
  });
});

test.each(['placeOrder', 'setPaymentMethodAndPlaceOrder'])('bundle attribution persists through %s using fresh exact-variant prices', async (operation) => {
  await migrateLegacyPromotions(store);
  const cat = await loadCatalog(store);
  const [opportunity] = (await bundleOpportunities(store, {}, { catalog: async () => cat })).opportunities;
  const actor = { actor: { kind: 'ims-operator', subject: 'op', orgId: 'ORG@AdobeOrg' }, correlationId: crypto.randomUUID() };
  const service = createPromotionService({ store, loadCatalog: () => loadCatalog(store, { fresh: true }) });
  const promotion = {
    name: 'Fixture kit', enabled: false, mode: 'automatic', code: null,
    discount: { kind: 'percentage', basisPoints: 1000 }, maxDiscountMinor: null, minimumMerchandiseMinor: null,
    target: {
      kind: 'bundle', bundleId: opportunity.bundleId, experimentId: 'fixture-kit',
      currency: 'AUD', quoteExpiresAt: opportunity.quoteExpiresAt, safetyBuffer: opportunity.safetyBuffer,
      components: opportunity.components.map(({ sku, quantity, unitPriceMinor }) => ({ sku, quantity, unitPriceMinor })),
    },
    startsAt: null, endsAt: null, audienceRestriction: null,
  };
  const created = await service.createPromotion(actor, { idempotencyKey: crypto.randomUUID(), promotion });
  expect(created.ok).toBe(true);
  expect(await service.updatePromotion(actor, {
    id: created.promotion.id, expectedRevision: 1, idempotencyKey: crypto.randomUUID(), promotion: { ...promotion, enabled: true },
  })).toMatchObject({ ok: true });
  const id = await customerCartId();
  for (const c of opportunity.components) {
    // eslint-disable-next-line no-await-in-loop
    expect((await gql(ADD, { id, sku: c.sku, qty: c.quantity })).errors).toBeUndefined();
  }
  await readyForCheckout(id);
  const metadata = 'wknd_bundle_id wknd_experiment_id';
  const preview = await gql(`query($id:String!){cart(cart_id:$id){prices{discounts{${metadata}}}}}`, { id });
  expect(preview.data.cart.prices.discounts).toEqual([{
    wknd_bundle_id: opportunity.bundleId, wknd_experiment_id: 'fixture-kit',
  }]);
  const input = operation === 'placeOrder' ? 'cart_id:$id' : 'cart_id:$id,payment_method:{code:"wknd_demo_pay"}';
  const result = await gql(`mutation($id:String!){${operation}(input:{${input}}){errors{code} orderV2{number total{discounts{${metadata}}}}}}`, { id });
  expect(result.errors).toBeUndefined();
  expect(result.data[operation].errors).toEqual([]);
  expect(result.data[operation].orderV2.total.discounts).toEqual(preview.data.cart.prices.discounts);
  expect((await store.collection('orders').findOne({ cartId: id })).promotion).toMatchObject({
    bundleId: opportunity.bundleId, experimentId: 'fixture-kit', componentSkus: opportunity.components.map((c) => c.sku),
  });
});

describe('generic coupons through the shared engine', () => {
  test('pre-migration carts use the same legacy definitions', async () => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: cheap.sku, qty: 1 });
    const r = await gql(APPLY, { id, code: 'wknd10' });
    expect(r.data.applyCouponToCart.cart.prices.discounts[0]).toMatchObject({ coupon: { code: 'WKND10' } });
  });

  describe('after explicit migration', () => {
    beforeEach(async () => {
      await migrateLegacyPromotions(store);
    });

    test('invalid code is rejected and not stored', async () => {
      const id = await customerCartId();
      await gql(ADD, { id, sku: cheap.sku, qty: 1 });
      const r = await gql(APPLY, { id, code: 'BOGUS' });
      expect(r.errors[0].message).toBe('Coupon code is not valid.');
      const cart = await gql(`query($id: String!) { cart(cart_id: $id) { ${CART_FIELDS} } }`, { id });
      expect(cart.data.cart.applied_coupons).toEqual([]);
    });

    test('TRAILREADY below AUD 200: accepted with zero saving, no checkout block', async () => {
      const id = await customerCartId();
      await gql(ADD, { id, sku: cheap.sku, qty: 1 });
      const r = await gql(APPLY, { id, code: 'TRAILREADY' });
      expect(r.errors).toBeUndefined();
      expect(r.data.applyCouponToCart.cart.applied_coupons).toEqual([{ code: 'TRAILREADY' }]);
      expect(r.data.applyCouponToCart.cart.prices.discounts).toEqual([]);
      await readyForCheckout(id);
      const placed = await gql(PLACE, { id });
      expect(placed.data.placeOrder.errors).toEqual([]);
    });

    test('a stored coupon that became invalid blocks checkout explicitly', async () => {
      const id = await customerCartId();
      await gql(ADD, { id, sku: cheap.sku, qty: 1 });
      await gql(APPLY, { id, code: 'WKND10' });
      const svc = createPromotionService({ store, loadCatalog: () => loadCatalog(store) });
      const off = await svc.disablePromotion({ actor: { kind: 'ims-operator', subject: 'op', orgId: 'ORG@AdobeOrg' }, correlationId: crypto.randomUUID() }, {
        id: LEGACY_SEEDS[0].id, expectedRevision: 1, idempotencyKey: crypto.randomUUID(),
      });
      expect(off.ok).toBe(true);
      await readyForCheckout(id);
      const placed = await gql(PLACE, { id });
      expect(placed.data.placeOrder.orderV2).toBeNull();
      expect(placed.data.placeOrder.errors[0]).toMatchObject({ code: 'UNABLE_TO_PLACE_ORDER', message: 'Coupon is disabled.' });
    });

    test('automatic promotions apply without a code; explicit coupons win', async () => {
      const svc = createPromotionService({ store, loadCatalog: () => loadCatalog(store) });
      const created = await svc.createPromotion({ actor: { kind: 'ims-operator', subject: 'op', orgId: 'ORG@AdobeOrg' }, correlationId: crypto.randomUUID() }, {
        idempotencyKey: crypto.randomUUID(),
        promotion: {
          name: 'Five off', enabled: true, mode: 'automatic', discount: { kind: 'fixed', amountMinor: 500, currency: 'AUD' }, target: { kind: 'all' },
        },
      });
      expect(created.ok).toBe(true);
      const id = await customerCartId();
      const added = await gql(ADD, { id, sku: cheap.sku, qty: 1 });
      expect(added.data.addProductsToCart.cart.prices.discounts).toEqual([{ amount: { value: 5 }, label: 'Five off', coupon: null }]);
      const applied = await gql(APPLY, { id, code: 'WKND10' });
      expect(applied.data.applyCouponToCart.cart.prices.discounts[0].coupon).toEqual({ code: 'WKND10' });
    });
  });
});

describe('wknd.promotions/v2 best-saving gate through cart and order', () => {
  const actor = { kind: 'ims-operator', subject: 'op', orgId: 'ORG@AdobeOrg' };
  async function createAutomatic(basisPoints) {
    const svc = createPromotionService({ store, loadCatalog: () => loadCatalog(store), params });
    const r = await svc.createPromotion({ actor, correlationId: crypto.randomUUID() }, {
      idempotencyKey: crypto.randomUUID(),
      promotion: {
        name: `Auto ${basisPoints}`,
        enabled: true,
        mode: 'automatic',
        code: null,
        discount: { kind: 'percentage', basisPoints },
        maxDiscountMinor: null,
        minimumMerchandiseMinor: null,
        target: { kind: 'all' },
        startsAt: null,
        endsAt: null,
        audienceRestriction: null,
      },
    });
    expect(r.ok).toBe(true);
  }

  beforeEach(async () => {
    await migrateLegacyPromotions(store);
    await createAutomatic(1500);
  });

  test('v1 default: the explicit WKND10 coupon wins even though the automatic saves more', async () => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    const cart = (await gql(APPLY, { id, code: 'WKND10' })).data.applyCouponToCart.cart;
    expect(cart.prices.discounts[0].coupon).toEqual({ code: 'WKND10' });
  });

  test('best-saving: the larger automatic applies, the coupon stays stored, and the order uses it', async () => {
    params = { ...READY, PROMOTION_SELECTION: 'best-saving' };
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    const cart = (await gql(APPLY, { id, code: 'WKND10' })).data.applyCouponToCart.cart;
    const subtotalMinor = Math.round(cart.prices.subtotal_including_tax.value * 100);
    expect(cart.applied_coupons).toEqual([{ code: 'WKND10' }]);
    expect(cart.prices.discounts).toHaveLength(1);
    expect(cart.prices.discounts[0]).toMatchObject({ coupon: null, amount: { value: Math.round(subtotalMinor * 0.15) / 100 } });
    await readyForCheckout(id);
    const placed = await gql(PLACE, { id });
    expect(placed.data.placeOrder.errors).toEqual([]);
    const order = await store.collection('orders').findOne({ number: placed.data.placeOrder.orderV2.number });
    expect(order.promotion).toMatchObject({ code: null });
  });
});

describe('protected cart recovery', () => {
  beforeEach(async () => {
    await migrateLegacyPromotions(store);
    await bootstrapRecoveryPromotion(store);
    await enableRecovery();
  });

  test('guests cannot see or claim offers', async () => {
    const r = await gql(OFFER, { id: 'anything' }, { auth: false });
    expect(r.errors[0].extensions.category).toMatch(/graphql-auth/);
  });

  test('legacy inactivity survives a customerCart planner metadata write, while quantity edits reset it', async () => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    const previousActivity = new Date(Date.now() - HOUR).toISOString();
    await store.collection('carts').updateOne({ id }, {
      $unset: { activityAt: '' },
      $set: { updatedAt: previousActivity, stagePlannerPricing: 'old-planner-fingerprint' },
    });
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer.status).toBe('ELIGIBLE');
    const initial = await gql('query{customerCart{id wknd_cart_version}}', {}, { namespace: '28538-wkndcommerce-stage' });
    expect(initial.errors).toBeUndefined();
    const metadataWritten = await store.collection('carts').findOne({ id });
    expect(metadataWritten.updatedAt).not.toBe(previousActivity);
    expect(metadataWritten.stagePlannerPricing).not.toBe('old-planner-fingerprint');
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer.status).toBe('ELIGIBLE');
    expect(metadataWritten.activityAt).toBe(previousActivity);
    expect(await store.collection('recovery_entitlements').countDocuments({})).toBe(0);
    expect(await store.collection('recovery_redemptions').countDocuments({})).toBe(0);
    const edited = await gql(`mutation($id:String!,$uid:ID!){
      updateCartItems(input:{cart_id:$id,cart_items:[{cart_item_uid:$uid,quantity:2}]}){errors{code}}
    }`, { id, uid: metadataWritten.items[0].uid });
    expect(edited.errors).toBeUndefined();
    expect(edited.data.updateCartItems.errors).toEqual([]);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer).toMatchObject({
      status: 'INELIGIBLE', reason: 'NOT_IN_RECOVERY_WINDOW',
    });
  });

  test('offer and claim qualify at 55 minutes and survive ordinary cart reads, not beyond 7 days', async () => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    await age(id, (55 * 60 - 1) / 3600);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer).toMatchObject({ status: 'INELIGIBLE', reason: 'NOT_IN_RECOVERY_WINDOW' });
    await age(id, 55 / 60);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer).toMatchObject({ status: 'ELIGIBLE', percent_off: 10, max_discount: { value: 25 } });
    expect((await gql(CLAIM, { id })).data.claimWkndRecoveryOffer.status).toBe('CLAIMED');
    expect((await gql(APPLY, { id, code: 'RECOVER10' })).errors).toBeUndefined();
    expect(await customerCartId()).toBe(id);
    expect((await gql(`query($id:String!){cart(cart_id:$id){${CART_FIELDS}}}`, { id })).errors).toBeUndefined();
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer.status).toBe('CLAIMED');
    await age(id, 24 * 8);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer).toMatchObject({ status: 'INELIGIBLE', reason: 'NOT_IN_RECOVERY_WINDOW' });
  });

  test('a claimed offer is invalidated by meaningful cart activity and a later owner purchase', async () => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    await age(id, 55 / 60);
    expect((await gql(CLAIM, { id })).data.claimWkndRecoveryOffer.status).toBe('CLAIMED');
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer).toMatchObject({ status: 'INELIGIBLE', reason: 'NOT_IN_RECOVERY_WINDOW' });
    await age(id, 55 / 60);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer.status).toBe('ELIGIBLE');
    expect((await gql(CLAIM, { id })).data.claimWkndRecoveryOffer.status).toBe('CLAIMED');
    await store.collection('orders').insertOne({ customerSub: SUB, createdAt: new Date().toISOString() });
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer).toMatchObject({ status: 'INELIGIBLE', reason: 'PURCHASED_SINCE' });
  });

  test('unverified redemption storage keeps the offer unavailable', async () => {
    params = NOT_READY;
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    await age(id, 30);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer.status).toBe('UNAVAILABLE');
    const r = await gql(APPLY, { id, code: 'RECOVER10' });
    expect(r.errors[0].message).toBe('Coupon eligibility cannot currently be verified.');
  });

  test('coupon without a claimed entitlement is rejected (no trusted segment claim)', async () => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    const r = await gql(APPLY, { id, code: 'RECOVER10' });
    expect(r.errors[0].message).toBe('Coupon is not available for this shopper.');
  });

  test('offer reports engine-computed saving vs the current promotion (display only)', async () => {
    const COMPARE = 'query Offer($id: String!) { wkndRecoveryOffer(cart_id: $id) { status saving { value } current_saving { value } } }';
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 3 });
    await age(id, 30);
    const fresh = (await gql(COMPARE, { id })).data.wkndRecoveryOffer;
    const subtotalMinor = Math.round(priceOf(pricey.sku).regular * 100) * 3;
    expect(fresh).toEqual({
      status: 'ELIGIBLE', saving: { value: Math.min(Math.round(subtotalMinor * 0.1), 2500) / 100 }, current_saving: { value: 0 },
    });

    const withCode = (await gql(APPLY, { id, code: 'WKND10' })).data.applyCouponToCart.cart;
    await age(id, 30);
    const compared = (await gql(COMPARE, { id })).data.wkndRecoveryOffer;
    expect(compared.current_saving.value).toBe(withCode.prices.discounts[0].amount.value);
    expect(compared.saving.value).toBe(fresh.saving.value);
    expect(compared.current_saving.value).toBeGreaterThan(compared.saving.value);
    expect((await gql(CLAIM, { id })).data.claimWkndRecoveryOffer.status).toBe('CLAIMED');
    const claimed = (await gql(COMPARE, { id })).data.wkndRecoveryOffer;
    expect(claimed).toMatchObject({ status: 'CLAIMED', saving: fresh.saving, current_saving: compared.current_saving });
    // Estimating never applies the offer.
    expect((await gql(`query($id: String!) { cart(cart_id: $id) { ${CART_FIELDS} } }`, { id })).data.cart.applied_coupons).toEqual([{ code: 'WKND10' }]);
  });

  test('eligible display reuses only its validated candidate and performs each recovery guard once', async () => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    await age(id, 1);
    const policies = jest.spyOn(store.collection('recovery_policies'), 'find');
    const redeemed = jest.spyOn(store.collection('recovery_redemptions'), 'findOne');
    const purchases = jest.spyOn(store.collection('orders'), 'countDocuments');
    const entitlements = jest.spyOn(store.collection('recovery_entitlements'), 'findOne');
    const promotions = jest.spyOn(store.collection('promotions'), 'find');
    const result = await gql(`query($id:String!){
      wkndRecoveryOffer(cart_id:$id){status saving{value} current_saving{value}}
    }`, { id });
    expect(result.errors).toBeUndefined();
    expect(result.data.wkndRecoveryOffer).toMatchObject({
      status: 'ELIGIBLE', saving: { value: 25 }, current_saving: { value: 0 },
    });
    [policies, redeemed, purchases, entitlements].forEach((read) => expect(read).toHaveBeenCalledTimes(1));
    expect(promotions.mock.calls.some(([filter]) => filter.code?.$in?.includes('RECOVER10'))).toBe(false);
    expect(await store.collection('recovery_entitlements').countDocuments({})).toBe(0);
    expect(await store.collection('recovery_redemptions').countDocuments({})).toBe(0);
    const applied = await gql(APPLY, { id, code: 'RECOVER10' });
    expect(applied.errors[0].message).toBe('Coupon is not available for this shopper.');
  });

  test('display refreshes cart financial facts and current-coupon validity without caching a candidate between requests', async () => {
    const catalog = await loadCatalog(store);
    const [kit] = (await bundleOpportunities(store, {}, { catalog: async () => catalog })).opportunities;
    const service = createPromotionService({ store, loadCatalog: () => loadCatalog(store) });
    const actor = { actor: { kind: 'ims-operator', subject: 'op', orgId: 'ORG@AdobeOrg' }, correlationId: crypto.randomUUID() };
    const promotion = {
      name: 'Fresh display kit', enabled: false, mode: 'automatic', code: null,
      discount: { kind: 'percentage', basisPoints: 1000 }, maxDiscountMinor: null, minimumMerchandiseMinor: null,
      target: {
        kind: 'bundle', bundleId: kit.bundleId, experimentId: null, currency: 'AUD',
        quoteExpiresAt: kit.quoteExpiresAt, safetyBuffer: kit.safetyBuffer,
        components: kit.components.map(({ sku, quantity, unitPriceMinor }) => ({ sku, quantity, unitPriceMinor })),
      },
      startsAt: null, endsAt: null, audienceRestriction: null,
    };
    const created = await service.createPromotion(actor, { idempotencyKey: crypto.randomUUID(), promotion });
    expect(created.ok).toBe(true);
    expect(await service.updatePromotion(actor, {
      id: created.promotion.id, expectedRevision: 1, idempotencyKey: crypto.randomUUID(),
      promotion: { ...promotion, enabled: true },
    })).toMatchObject({ ok: true });
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    await gql(APPLY, { id, code: 'WKND10' });
    await age(id, 1);
    const query = `query($id:String!){wkndRecoveryOffer(cart_id:$id){status saving{value} current_saving{value}}}`;
    const first = await gql(query, { id });
    expect(first.errors).toBeUndefined();
    expect(first.data.wkndRecoveryOffer.saving.value).toBe(25);
    await store.collection('prices').updateOne({ sku: pricey.sku }, { $set: { regular: 50, special: null } });
    const repriced = await gql(query, { id });
    expect(repriced.errors).toBeUndefined();
    expect(repriced.data.wkndRecoveryOffer).toMatchObject({
      status: 'ELIGIBLE', saving: { value: 5 }, current_saving: { value: 5 },
    });
    expect(await service.disablePromotion(actor, {
      id: LEGACY_SEEDS[0].id, expectedRevision: 1, idempotencyKey: crypto.randomUUID(),
    })).toMatchObject({ ok: true });
    const currentDisabled = await gql(query, { id });
    expect(currentDisabled.errors).toBeUndefined();
    expect(currentDisabled.data.wkndRecoveryOffer).toMatchObject({
      status: 'ELIGIBLE', saving: { value: 5 }, current_saving: { value: 0 },
    });
    expect(await store.collection('recovery_entitlements').countDocuments({})).toBe(0);
    const current = await store.collection('promotions').findOne({ id: RID });
    expect(await service.disablePromotion(actor, {
      id: RID, expectedRevision: current.revision, idempotencyKey: crypto.randomUUID(),
    })).toMatchObject({ ok: true });
    expect((await gql(query, { id })).data.wkndRecoveryOffer).toMatchObject({
      status: 'UNAVAILABLE', saving: null, current_saving: null,
    });
  });

  test('unavailable offers carry no saving figures', async () => {
    const COMPARE = 'query Offer($id: String!) { wkndRecoveryOffer(cart_id: $id) { status saving { value } current_saving { value } } }';
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    expect((await gql(COMPARE, { id })).data.wkndRecoveryOffer).toEqual({ status: 'INELIGIBLE', saving: null, current_saving: null });
  });

  test('claim → apply → order; then the campaign is redeemed for that shopper', async () => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 2 });
    await age(id, 30);
    const offer = (await gql(OFFER, { id })).data.wkndRecoveryOffer;
    expect(offer).toMatchObject({
      status: 'ELIGIBLE', coupon_code: 'RECOVER10', percent_off: 10, max_discount: { value: 25 },
    });
    expect((await gql(CLAIM, { id })).data.claimWkndRecoveryOffer.status).toBe('CLAIMED');
    expect((await gql(CLAIM, { id })).data.claimWkndRecoveryOffer.status).toBe('CLAIMED');
    const applied = (await gql(APPLY, { id, code: 'recover10' })).data.applyCouponToCart.cart;
    const subtotal = applied.prices.subtotal_including_tax.value;
    const expected = Math.min(Math.round(subtotal * 100 * 0.1), 2500) / 100;
    expect(applied.prices.discounts[0].amount.value).toBe(expected);
    const currentOffer = await gql(`query($id:String!){
      wkndRecoveryOffer(cart_id:$id){status saving{value} current_saving{value}}
    }`, { id });
    expect(currentOffer.errors).toBeUndefined();
    expect(currentOffer.data.wkndRecoveryOffer).toMatchObject({
      status: 'CLAIMED', saving: { value: expected }, current_saving: { value: expected },
    });
    await readyForCheckout(id);
    const placed = await gql(PLACE, { id });
    expect(placed.data.placeOrder.errors).toEqual([]);
    expect(placed.data.placeOrder.orderV2.total.discounts[0].amount.value).toBe(expected);
    const order = await store.collection('orders').findOne({ number: placed.data.placeOrder.orderV2.number });
    expect(order.promotion).toMatchObject({ id: RID, code: 'RECOVER10', managementClass: 'protected-recovery' });

    const next = await customerCartId();
    expect(next).not.toBe(id);
    await gql(ADD, { id: next, sku: pricey.sku, qty: 1 });
    await age(next, 30);
    expect((await gql(OFFER, { id: next })).data.wkndRecoveryOffer.status).toBe('REDEEMED');
    expect((await gql(APPLY, { id: next, code: 'RECOVER10' })).errors[0].message).toBe('This offer has already been used.');
  });

  test('two carts racing through checkout redeem at most once', async () => {
    const cat = await loadCatalog(store);
    const customer = { sub: SUB, email: 'shopper@example.com' };
    const carts = [];
    for (let i = 0; i < 2; i += 1) {
      const cart = {
        id: `race-${i}`,
        customerSub: SUB,
        email: 'shopper@example.com',
        items: [{
          uid: `u${i}`, sku: pricey.sku, parentSku: pricey.sku, quantity: 1,
        }],
        shippingAddress: {
          firstname: 'S', lastname: 'S', street: ['1'], city: 'Sydney', postcode: '2000', telephone: '1', country_code: 'AU', region_code: 'NSW', region_label: 'New South Wales', region_id: 1,
        },
        shippingMethod: { carrier_code: 'wknd', method_code: 'standard' },
        billingAddress: { country_code: 'AU' },
        paymentMethod: 'wknd_demo_pay',
        coupons: ['RECOVER10'],
        status: 'active',
        revision: 1,
        activityAt: new Date(Date.now() - 30 * HOUR).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // eslint-disable-next-line no-await-in-loop
      await store.collection('carts').insertOne(cart);
      carts.push(cart);
    }
    const { createRecovery } = require('../lib/recovery-policy'); // eslint-disable-line global-require
    const rec = createRecovery({ store, params: READY });
    await Promise.all(carts.map((cart) => rec.claim({ customer, cart })));
    const runtimes = await Promise.all(carts.map((cart) => loadPromotionRuntime(store, { params: READY, customer, cart })));
    const results = await Promise.allSettled(carts.map((cart, i) => placeOrder(store, cat, cart, customer, runtimes[i])));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({ code: 'UNABLE_TO_PLACE_ORDER', message: 'This offer has already been used.' });
    expect(await store.collection('orders').countDocuments({ customerSub: SUB })).toBe(1);
    const loser = carts[results.findIndex((r) => r.status === 'rejected')];
    expect((await store.collection('carts').findOne({ id: loser.id })).status).toBe('active');
    expect(await store.collection('recovery_redemptions').countDocuments({})).toBe(1);
  });

  test('a redemption reserved before a failed stock reservation is released', async () => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    await age(id, 30);
    await gql(CLAIM, { id });
    await gql(APPLY, { id, code: 'RECOVER10' });
    await readyForCheckout(id);
    await store.collection('inventory').updateOne({ sku: pricey.sku }, { $set: { qty: 0 } });
    resetCatalogCache();
    await store.collection('inventory').updateOne({ sku: pricey.sku }, { $set: { qty: 5 } });
    const inventory = store.collection('inventory');
    const original = inventory.updateOne.bind(inventory);
    inventory.updateOne = async (filter, update) => (filter.qty ? { matchedCount: 0 } : original(filter, update));
    const placed = await gql(PLACE, { id });
    inventory.updateOne = original;
    expect(placed.data.placeOrder.orderV2).toBeNull();
    expect(await store.collection('recovery_redemptions').countDocuments({})).toBe(0);
  });
});

describe('coupon writes are revision-guarded (protected-offer removal / no-downgrade races)', () => {
  const REMOVE = 'mutation Remove($id: String!, $code: String!) { removeCouponsFromCart(input: { cart_id: $id, coupon_codes: [$code] }) { cart { applied_coupons { code } } } }';

  beforeEach(async () => {
    await migrateLegacyPromotions(store);
    await bootstrapRecoveryPromotion(store);
    await enableRecovery();
  });

  async function protectedCart() {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 2 });
    await age(id, 30);
    expect((await gql(CLAIM, { id })).data.claimWkndRecoveryOffer.status).toBe('CLAIMED');
    expect((await gql(APPLY, { id, code: 'RECOVER10' })).data.applyCouponToCart.cart.applied_coupons).toEqual([{ code: 'RECOVER10' }]);
    return id;
  }

  test('a stale write is refused with CART_CHANGED and never erases a concurrent coupon', async () => {
    const id = await protectedCart();
    const stale = await store.collection('carts').findOne({ id });
    await gql(APPLY, { id, code: 'WKND10' });
    await expect(saveCart(store, { ...stale, coupons: [] }, { expectRevision: true }))
      .rejects.toMatchObject({ code: 'CART_CHANGED' });
    expect((await store.collection('carts').findOne({ id })).coupons).toEqual(['WKND10']);
  });

  test('removing the protected code after another channel replaced it leaves the ordinary coupon', async () => {
    const id = await protectedCart();
    await gql(APPLY, { id, code: 'WKND10' });
    const r = await gql(REMOVE, { id, code: 'RECOVER10' });
    expect(r.errors).toBeUndefined();
    expect(r.data.removeCouponsFromCart.cart.applied_coupons).toEqual([{ code: 'WKND10' }]);
  });

  /** Commits another channel's coupon between this mutation's read and its write. */
  function interleave(id, coupons) {
    const carts = store.collection('carts');
    const original = carts.replaceOne.bind(carts);
    carts.replaceOne = async (filter, doc, options) => {
      carts.replaceOne = original;
      const live = await carts.findOne({ id });
      await carts.updateOne({ id }, { $set: { coupons, revision: (live.revision || 0) + 1 } });
      return original(filter, doc, options);
    };
  }

  test('removal racing an ordinary coupon applied in between: refused, ordinary coupon kept', async () => {
    const id = await protectedCart();
    interleave(id, ['WKND10']);
    const r = await gql(REMOVE, { id, code: 'RECOVER10' });
    expect(r.errors[0].extensions.code).toBe('CART_CHANGED');
    expect((await store.collection('carts').findOne({ id })).coupons).toEqual(['WKND10']);
  });

  test('protected apply racing an ordinary coupon applied in between: refused, no silent replace', async () => {
    const id = await protectedCart();
    await gql(REMOVE, { id, code: 'RECOVER10' });
    interleave(id, ['TRAILREADY']);
    const r = await gql(APPLY, { id, code: 'RECOVER10' });
    expect(r.errors[0].extensions.code).toBe('CART_CHANGED');
    expect((await store.collection('carts').findOne({ id })).coupons).toEqual(['TRAILREADY']);
  });

  test('removing the protected coupon leaves the entitlement and redemption untouched', async () => {
    const id = await protectedCart();
    const before = await store.collection('recovery_entitlements').find({});
    const r = await gql(REMOVE, { id, code: 'RECOVER10' });
    expect(r.data.removeCouponsFromCart.cart.applied_coupons).toEqual([]);
    expect(await store.collection('recovery_entitlements').find({})).toEqual(before);
    expect(await store.collection('recovery_redemptions').countDocuments({})).toBe(0);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer.status).toBe('CLAIMED');
  });
});

describe('reviewed-version recovery offer apply/remove (no-downgrade, changed-cart guard)', () => {
  const MCP_ISSUER = 'https://example.adobeio-static.net/api/v1/web/llm-apps/mcp';
  const SECRET = 'test-only-mcp-delegation-secret-of-32-bytes+';
  const VERSION = 'query($id: String!) { cart(cart_id: $id) { wknd_cart_version applied_coupons { code } } }';
  const APPLY_OFFER = 'mutation($id: String!, $v: String!) { applyWkndRecoveryOffer(cart_id: $id, expected_cart_version: $v) { outcome cart { wknd_cart_version applied_coupons { code } prices { discounts { amount { value } } } } } }';
  const REMOVE_OFFER = 'mutation($id: String!, $v: String!) { removeWkndRecoveryOffer(cart_id: $id, expected_cart_version: $v) { outcome cart { wknd_cart_version applied_coupons { code } } } }';

  beforeEach(async () => {
    params = { ...READY, MCP_DELEGATION_ISSUER: MCP_ISSUER, MCP_DELEGATION_SECRET: SECRET };
    await migrateLegacyPromotions(store);
    await bootstrapRecoveryPromotion(store);
    await enableRecovery();
  });

  async function delegated(query, variables = {}) {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({
      sub: SUB, identity_issuer: AUTH0_ISSUER, scope: 'shop:cart', jti: crypto.randomUUID(),
    }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer(MCP_ISSUER)
      .setAudience('urn:wknd-commerce:storefront').setIssuedAt(now).setExpirationTime(now + 60)
      .sign(new TextEncoder().encode(SECRET));
    const headers = { authorization: ['Bearer', assertion].join(' '), 'x-wknd-delegation': 'mcp' };
    const { body } = await runGraphQL({ query, variables, headers }, { store, params, verify });
    return body;
  }

  /** Inactive (30h) signed-in cart, qty 2 of a pricey item; optional ordinary coupon. */
  async function idleCart(coupon) {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 2 });
    if (coupon) await gql(APPLY, { id, code: coupon });
    await age(id, 30);
    return id;
  }
  const version = async (id) => (await gql(VERSION, { id })).data.cart.wknd_cart_version;
  const coupons = async (id) => (await store.collection('carts').findOne({ id })).coupons;
  const entitlements = () => store.collection('recovery_entitlements').countDocuments({});

  function interleave(id, next) {
    const carts = store.collection('carts');
    const original = carts.replaceOne.bind(carts);
    carts.replaceOne = async (filter, doc, options) => {
      carts.replaceOne = original;
      const live = await carts.findOne({ id });
      await carts.updateOne({ id }, { $set: { coupons: next, revision: (live.revision || 0) + 1 } });
      return original(filter, doc, options);
    };
  }

  test('the cart exposes an opaque version that changes on every write', async () => {
    const id = await idleCart();
    const v1 = await version(id);
    await gql(APPLY, { id, code: 'TRAILREADY' });
    expect(await version(id)).not.toBe(v1);
  });

  test('replaces a smaller ordinary coupon (TRAILREADY) and claims the entitlement on the way', async () => {
    const id = await idleCart('TRAILREADY');
    const r = (await gql(APPLY_OFFER, { id, v: await version(id) })).data.applyWkndRecoveryOffer;
    expect(r.outcome).toBe('APPLIED');
    expect(r.cart.applied_coupons).toEqual([{ code: 'RECOVER10' }]);
    expect(r.cart.prices.discounts[0].amount.value).toBe(25);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer.status).toBe('CLAIMED');
    const again = (await gql(APPLY_OFFER, { id, v: r.cart.wknd_cart_version })).data.applyWkndRecoveryOffer;
    expect(again.outcome).toBe('ALREADY_APPLIED');
  });

  test('never downgrades: a better ordinary coupon (WKND10) is kept, nothing claimed', async () => {
    const id = await idleCart('WKND10');
    const r = await gql(APPLY_OFFER, { id, v: await version(id) });
    expect(r.errors[0].extensions.code).toBe('OFFER_NOT_BETTER');
    expect(await coupons(id)).toEqual(['WKND10']);
    expect(await entitlements()).toBe(0);
  });

  test('a better coupon applied after the final review is never replaced (stale version)', async () => {
    const id = await idleCart('TRAILREADY');
    const reviewed = await version(id);
    await gql(APPLY, { id, code: 'WKND10' });
    const r = await gql(APPLY_OFFER, { id, v: reviewed });
    expect(r.errors[0].extensions.code).toBe('CART_CHANGED');
    expect(await coupons(id)).toEqual(['WKND10']);
  });

  test('a better coupon committed between the server read and write is never replaced', async () => {
    const id = await idleCart('TRAILREADY');
    interleave(id, ['WKND10']);
    const r = await gql(APPLY_OFFER, { id, v: await version(id) });
    expect(r.errors[0].extensions.code).toBe('CART_CHANGED');
    expect(await coupons(id)).toEqual(['WKND10']);
  });

  test('missing or malformed expected version is refused without a write', async () => {
    const id = await idleCart('TRAILREADY');
    const r = await gql(APPLY_OFFER, { id, v: 'v999' });
    expect(r.errors[0].extensions.code).toBe('CART_CHANGED');
    expect(await coupons(id)).toEqual(['TRAILREADY']);
  });

  test('an unavailable offer is an explicit error, not a silent no-op', async () => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 2 });
    const r = await gql(APPLY_OFFER, { id, v: await version(id) });
    expect(r.errors[0].extensions.code).toBe('RECOVERY_OFFER_UNAVAILABLE');
  });

  test('remove: only the protected coupon, at the reviewed version; entitlement kept', async () => {
    const id = await idleCart('TRAILREADY');
    const applied = (await gql(APPLY_OFFER, { id, v: await version(id) })).data.applyWkndRecoveryOffer;
    const before = await store.collection('recovery_entitlements').find({});
    const r = (await gql(REMOVE_OFFER, { id, v: applied.cart.wknd_cart_version })).data.removeWkndRecoveryOffer;
    expect(r).toMatchObject({ outcome: 'REMOVED', cart: { applied_coupons: [] } });
    expect(await store.collection('recovery_entitlements').find({})).toEqual(before);
    expect(await store.collection('recovery_redemptions').countDocuments({})).toBe(0);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer.status).toBe('CLAIMED');
  });

  test('remove: an ordinary coupon is never removed (NOT_APPLIED, no write)', async () => {
    const id = await idleCart('WKND10');
    const v = await version(id);
    const r = (await gql(REMOVE_OFFER, { id, v })).data.removeWkndRecoveryOffer;
    expect(r.outcome).toBe('NOT_APPLIED');
    expect(r.cart.wknd_cart_version).toBe(v);
    expect(await coupons(id)).toEqual(['WKND10']);
  });

  test('remove: an ordinary coupon that replaced the offer after review is kept', async () => {
    const id = await idleCart('TRAILREADY');
    const reviewed = (await gql(APPLY_OFFER, { id, v: await version(id) })).data.applyWkndRecoveryOffer.cart.wknd_cart_version;
    await gql(APPLY, { id, code: 'WKND10' });
    expect((await gql(REMOVE_OFFER, { id, v: reviewed })).errors[0].extensions.code).toBe('CART_CHANGED');
    const live = await version(id);
    expect(await coupons(id)).toEqual(['WKND10']);
    const r = (await gql(REMOVE_OFFER, { id, v: live })).data.removeWkndRecoveryOffer;
    expect(r.outcome).toBe('NOT_APPLIED');
  });

  test('remove: a replacement committed between the server read and write is kept', async () => {
    const id = await idleCart('TRAILREADY');
    const v = (await gql(APPLY_OFFER, { id, v: await version(id) })).data.applyWkndRecoveryOffer.cart.wknd_cart_version;
    interleave(id, ['WKND10']);
    expect((await gql(REMOVE_OFFER, { id, v })).errors[0].extensions.code).toBe('CART_CHANGED');
    expect(await coupons(id)).toEqual(['WKND10']);
  });

  test('delegated agents: protected code only via the reviewed-version mutation; same customer and cart', async () => {
    const id = await idleCart('TRAILREADY');
    const generic = await delegated(APPLY, { id, code: 'recover10' });
    expect(generic.errors[0].extensions.code).toBe('REVIEWED_VERSION_REQUIRED');
    expect(await coupons(id)).toEqual(['TRAILREADY']);
    const r = (await delegated(APPLY_OFFER, { id, v: await version(id) })).data.applyWkndRecoveryOffer;
    expect(r.outcome).toBe('APPLIED');
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer.status).toBe('CLAIMED');
    expect((await delegated(APPLY, { id, code: 'WKND10' })).data.applyCouponToCart.cart.applied_coupons).toEqual([{ code: 'WKND10' }]);
  });

  test('guests cannot apply or remove the offer', async () => {
    const r = await gql(APPLY_OFFER, { id: 'x', v: 'v0' }, { auth: false });
    expect(r.errors[0].extensions.category).toMatch(/graphql-auth/);
  });

  test('reviewed version is invalidated by any cart change (item edit after review)', async () => {
    const id = await idleCart('TRAILREADY');
    const reviewed = await version(id);
    await gql(ADD, { id, sku: cheap.sku, qty: 1 });
    await age(id, 30);
    const r = await gql(APPLY_OFFER, { id, v: reviewed });
    expect(r.errors[0].extensions.code).toBe('CART_CHANGED');
    expect(await coupons(id)).toEqual(['TRAILREADY']);
  });

  const SHIP = 'mutation($id: String!) { setShippingAddressesOnCart(input: { cart_id: $id, shipping_addresses: [{ address: { firstname: "Sam", lastname: "S", street: ["1 Trail St"], city: "Sydney", postcode: "2000", telephone: "0400000000", country_code: "AU", region: "NSW" } }] }) { cart { wknd_cart_version applied_coupons { code } } } }';

  test.each([
    ['setShippingAddressesOnCart', (id) => gql(SHIP, { id })],
    ['addProductsToCart', (id) => gql(ADD, { id, sku: cheap.sku, qty: 1 })],
  ])('%s racing a guarded coupon write keeps that coupon and still applies its own change', async (_, write) => {
    const id = await idleCart('TRAILREADY');
    const before = await store.collection('carts').findOne({ id });
    interleave(id, ['RECOVER10']);
    const r = await write(id);
    expect(r.errors).toBeUndefined();
    const after = await store.collection('carts').findOne({ id });
    expect(after.coupons).toEqual(['RECOVER10']);
    expect(after.revision).toBeGreaterThanOrEqual((before.revision || 0) + 2);
    expect(JSON.stringify(after.shippingAddress || after.items.length)).not.toBe(JSON.stringify(before.shippingAddress || before.items.length));
  });

  test('stale item/address save after a guarded coupon CAS: coupon kept, versions strictly increase (no ABA)', async () => {
    const id = await idleCart('TRAILREADY');
    const seen = [await version(id)];
    const num = (v) => Number(v.slice(1));
    const applied = (await gql(APPLY_OFFER, { id, v: seen[0] })).data.applyWkndRecoveryOffer.cart.wknd_cart_version;
    seen.push(applied);
    interleave(id, ['RECOVER10']);
    const shipped = (await gql(SHIP, { id })).data.setShippingAddressesOnCart.cart;
    seen.push(shipped.wknd_cart_version);
    expect(shipped.applied_coupons).toEqual([{ code: 'RECOVER10' }]);
    const removed = (await gql(REMOVE_OFFER, { id, v: shipped.wknd_cart_version })).data.removeWkndRecoveryOffer;
    seen.push(removed.cart.wknd_cart_version);
    interleave(id, ['WKND10']);
    const added = (await gql(ADD, { id, sku: cheap.sku, qty: 1 })).data.addProductsToCart.cart;
    expect(added.applied_coupons).toEqual([{ code: 'WKND10' }]);
    seen.push(await version(id));
    seen.map(num).reduce((prev, n) => { expect(n).toBeGreaterThan(prev); return n; }, -1);
    expect(new Set(seen).size).toBe(seen.length);
    // an old reviewed version can never become valid again
    expect((await gql(APPLY_OFFER, { id, v: applied })).errors[0].extensions.code).toBe('CART_CHANGED');
  });

  test('normal checkout validation errors are unchanged by the retrying writers', async () => {
    const id = await idleCart();
    const r = await gql('mutation($id: String!) { setShippingMethodsOnCart(input: { cart_id: $id, shipping_methods: [{ carrier_code: "x", method_code: "y" }] }) { cart { id } } }', { id });
    expect(r.errors[0].message).toBe('The shipping address is missing. Set the address and try again.');
    const p = await gql('mutation($id: String!) { setPaymentMethodOnCart(input: { cart_id: $id, payment_method: { code: "nope" } }) { cart { id } } }', { id });
    expect(p.errors[0].message).toBe('The requested Payment Method is not available.');
  });

  test('a writer that keeps losing the race surfaces CART_CHANGED and writes nothing stale', async () => {
    const id = await idleCart('TRAILREADY');
    const carts = store.collection('carts');
    const original = carts.replaceOne.bind(carts);
    carts.replaceOne = async (filter, doc, options) => {
      const live = await carts.findOne({ id });
      await carts.updateOne({ id }, { $set: { coupons: ['WKND10'], revision: (live.revision || 0) + 1 } });
      return original(filter, doc, options);
    };
    const r = await gql(SHIP, { id });
    carts.replaceOne = original;
    expect(r.errors[0].extensions.code).toBe('CART_CHANGED');
    const after = await carts.findOne({ id });
    expect(after.coupons).toEqual(['WKND10']);
    expect(after.shippingAddress ?? null).toBeNull();
  });

  test('delegated agents: protected removal only via the reviewed-version mutation', async () => {
    const id = await idleCart('TRAILREADY');
    await gql(APPLY_OFFER, { id, v: await version(id) });
    const REMOVE_ONE = 'mutation($id: String!) { removeCouponFromCart(input: { cart_id: $id }) { cart { applied_coupons { code } } } }';
    const REMOVE_SOME = 'mutation($id: String!, $codes: [String!]!) { removeCouponsFromCart(input: { cart_id: $id, coupon_codes: $codes }) { cart { applied_coupons { code } } } }';
    expect((await delegated(REMOVE_ONE, { id })).errors[0].extensions.code).toBe('REVIEWED_VERSION_REQUIRED');
    expect((await delegated(REMOVE_SOME, { id, codes: ['RECOVER10'] })).errors[0].extensions.code).toBe('REVIEWED_VERSION_REQUIRED');
    expect(await coupons(id)).toEqual(['RECOVER10']);
    const r = (await delegated(REMOVE_OFFER, { id, v: await version(id) })).data.removeWkndRecoveryOffer;
    expect(r.outcome).toBe('REMOVED');
    await gql(APPLY, { id, code: 'WKND10' });
    expect((await delegated(REMOVE_SOME, { id, codes: ['WKND10'] })).data.removeCouponsFromCart.cart.applied_coupons).toEqual([]);
  });

  test('website ordinary coupon removal is unchanged (clear-all still works)', async () => {
    const id = await idleCart('TRAILREADY');
    await gql(APPLY_OFFER, { id, v: await version(id) });
    const r = await gql('mutation($id: String!) { removeCouponFromCart(input: { cart_id: $id }) { cart { applied_coupons { code } } } }', { id });
    expect(r.data.removeCouponFromCart.cart.applied_coupons).toEqual([]);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer.status).toBe('CLAIMED');
  });
});

describe('mergeCarts: claim → apply once → retire (exactly-once, explicit errors)', () => {
  const MERGE = 'mutation($s: String!, $d: String) { mergeCarts(source_cart_id: $s, destination_cart_id: $d) { id items { quantity product { sku } } } }';
  const extra = simples.find((p) => p.sku !== cheap.sku && p.sku !== pricey.sku);
  const carts = () => store.collection('carts');

  async function guestCart(items) {
    const id = (await gql('mutation { createGuestCart { cart { id } } }', {}, { auth: false })).data.createGuestCart.cart.id;
    for (const [sku, qty] of items) {
      // eslint-disable-next-line no-await-in-loop
      expect((await gql(ADD, { id, sku, qty }, { auth: false })).errors).toBeUndefined();
    }
    return id;
  }
  async function setup() {
    const dest = await customerCartId();
    await gql(ADD, { id: dest, sku: pricey.sku, qty: 1 });
    const src = await guestCart([[cheap.sku, 2]]);
    return { dest, src };
  }
  const qty = async (id, sku) => ((await carts().findOne({ id })).items.find((i) => i.sku === sku)?.quantity) || 0;
  const status = async (id) => (await carts().findOne({ id })).status;
  const merge = (src, dest) => gql(MERGE, { s: src, d: dest });

  /** Runs `fn` once, just before the first carts.updateOne matching `when`, then restores. */
  function beforeUpdate(when, fn) {
    const original = carts().updateOne.bind(carts());
    const coll = carts();
    coll.updateOne = async (filter, update, options) => {
      if (when(filter, update)) {
        coll.updateOne = original;
        await fn(original, filter, update);
      }
      return original(filter, update, options);
    };
    return () => { coll.updateOne = original; };
  }

  test('merges once; a repeated request adds nothing', async () => {
    const { dest, src } = await setup();
    expect((await merge(src, dest)).errors).toBeUndefined();
    expect(await qty(dest, cheap.sku)).toBe(2);
    expect(await status(src)).toBe('merged');
    expect((await merge(src, dest)).errors).toBeUndefined();
    expect(await qty(dest, cheap.sku)).toBe(2);
  });

  test('a source changed after it was read is re-read and claimed whole (nothing lost)', async () => {
    const { dest, src } = await setup();
    beforeUpdate((f, u) => f.id === src && f.status === 'active' && u.$set?.status === 'merging', async (original) => {
      const live = await carts().findOne({ id: src });
      await original({ id: src }, { $set: { items: [...live.items, { uid: 'x1', sku: extra.sku, parentSku: extra.sku, quantity: 1 }], revision: (live.revision || 0) + 1 } });
    });
    expect((await merge(src, dest)).errors).toBeUndefined();
    expect(await qty(dest, cheap.sku)).toBe(2);
    expect(await qty(dest, extra.sku)).toBe(1);
    expect(await status(src)).toBe('merged');
  });

  test('a claimed source cannot be edited (no change slips in after the snapshot)', async () => {
    const { dest, src } = await setup();
    let edit;
    beforeUpdate((f, u) => f.id === src && u.$set?.status === 'merged', async () => {
      edit = await gql(ADD, { id: src, sku: extra.sku, qty: 1 }, { auth: false });
    });
    expect((await merge(src, dest)).errors).toBeUndefined();
    expect(edit.errors[0].message).toMatch(/isn't active/);
    expect(await qty(dest, extra.sku)).toBe(0);
  });

  test('concurrent merges of the same source add its items exactly once', async () => {
    const { dest, src } = await setup();
    const results = await Promise.all([merge(src, dest), merge(src, dest), merge(src, dest)]);
    results.filter((r) => r.errors).forEach((r) => expect(r.errors[0].extensions.code).toBe('CART_CHANGED'));
    expect(results.some((r) => !r.errors)).toBe(true);
    expect(await qty(dest, cheap.sku)).toBe(2);
    expect(await status(src)).toBe('merged');
  });

  test('a second merge arriving after the first committed the destination but before retirement adds nothing', async () => {
    const { dest, src } = await setup();
    const coll = carts();
    const upd = coll.updateOne.bind(coll);
    const rep = coll.replaceOne.bind(coll);
    let second;
    const restore = () => { coll.updateOne = upd; coll.replaceOne = rep; };
    const interject = async () => { restore(); second = await merge(src, dest); };
    coll.updateOne = async (f, u, o) => { if (f.id === src && u.$set?.status === 'merged') await interject(); return upd(f, u, o); };
    coll.replaceOne = async (f, d, o) => { if (d?.id === src && d.status === 'merged') await interject(); return rep(f, d, o); };
    const first = await merge(src, dest);
    [first, second].filter((r) => r.errors).forEach((r) => expect(r.errors[0].extensions.code).toBe('CART_CHANGED'));
    expect(await qty(dest, cheap.sku)).toBe(2);
    expect(await status(src)).toBe('merged');
  });

  test('concurrent merges of two sources into one destination keep both', async () => {
    const dest = await customerCartId();
    const a = await guestCart([[cheap.sku, 1]]);
    const b = await guestCart([[extra.sku, 1]]);
    const results = await Promise.all([merge(a, dest), merge(b, dest)]);
    results.forEach((r) => expect(r.errors).toBeUndefined());
    expect(await qty(dest, cheap.sku)).toBe(1);
    expect(await qty(dest, extra.sku)).toBe(1);
  });

  test('retirement failure is an explicit error; the repeated request completes without duplicates', async () => {
    const { dest, src } = await setup();
    beforeUpdate((f, u) => f.id === src && u.$set?.status === 'merged', async () => { throw new Error('db unavailable'); });
    const first = await merge(src, dest);
    expect(first.errors).toBeDefined();
    expect(await qty(dest, cheap.sku)).toBe(2);
    expect(await status(src)).toBe('merging');
    const second = await merge(src, dest);
    expect(second.errors).toBeUndefined();
    expect(await qty(dest, cheap.sku)).toBe(2);
    expect(await status(src)).toBe('merged');
  });

  test('a failed destination write keeps the claim (never reactivated); the repeat merges once', async () => {
    const { dest, src } = await setup();
    const coll = carts();
    const original = coll.replaceOne.bind(coll);
    coll.replaceOne = async (filter, doc, o) => { coll.replaceOne = original; if (filter.id === dest) throw new Error('db unavailable'); return original(filter, doc, o); };
    const first = await merge(src, dest);
    expect(first.errors).toBeDefined();
    expect(await status(src)).toBe('merging');
    expect(await qty(dest, cheap.sku)).toBe(0);
    expect((await gql(ADD, { id: src, sku: extra.sku, qty: 1 }, { auth: false })).errors[0].message).toMatch(/isn't active/);
    expect((await merge(src, dest)).errors).toBeUndefined();
    expect(await qty(dest, cheap.sku)).toBe(2);
    expect(await qty(dest, extra.sku)).toBe(0);
    expect(await status(src)).toBe('merged');
  });

  test('a destination write that committed but then threw (uncertain outcome): the repeat adds nothing', async () => {
    const { dest, src } = await setup();
    const coll = carts();
    const original = coll.replaceOne.bind(coll);
    coll.replaceOne = async (filter, doc, o) => {
      if (filter.id !== dest) return original(filter, doc, o);
      coll.replaceOne = original;
      await original(filter, doc, o);
      throw new Error('timeout after commit');
    };
    expect((await merge(src, dest)).errors).toBeDefined();
    expect(await qty(dest, cheap.sku)).toBe(2);
    expect(await status(src)).toBe('merging');
    expect((await merge(src, dest)).errors).toBeUndefined();
    expect(await qty(dest, cheap.sku)).toBe(2);
    expect(await status(src)).toBe('merged');
  });

  test('A fails its destination write while B (paused before its write) resumes; a source edit then is refused, nothing lost', async () => {
    const { dest, src } = await setup();
    const coll = carts();
    const original = coll.replaceOne.bind(coll);
    let destWrites = 0;
    let bPromise;
    let releaseB;
    let bAtWrite;
    const bReady = new Promise((r) => { bAtWrite = r; });
    coll.replaceOne = async (filter, doc, o) => {
      if (filter.id !== dest) return original(filter, doc, o);
      destWrites += 1;
      if (destWrites === 1) {
        // A's write: let B load the (same) claim and destination and stop just before its write.
        bPromise = merge(src, dest);
        await bReady;
        throw new Error('db unavailable');
      }
      if (destWrites === 2) {
        bAtWrite();
        await new Promise((r) => { releaseB = r; });
      }
      return original(filter, doc, o);
    };
    const a = await merge(src, dest);
    expect(a.errors).toBeDefined();
    const statusAfterA = await status(src);
    const edit = await gql(ADD, { id: src, sku: extra.sku, qty: 1 }, { auth: false });
    releaseB();
    const b = await bPromise;
    coll.replaceOne = original;
    const repeat = await merge(src, dest);
    const srcDoc = await carts().findOne({ id: src });
    const editAccepted = !edit.errors;
    // never reactivated, so the edit is refused; and nothing accepted is ever lost or duplicated
    expect(statusAfterA).toBe('merging');
    expect(editAccepted).toBe(false);
    expect(b.errors).toBeUndefined();
    expect(repeat.errors).toBeUndefined();
    expect(await qty(dest, cheap.sku)).toBe(2);
    const sourceExtra = srcDoc.items.find((i) => i.sku === extra.sku)?.quantity || 0;
    expect(await qty(dest, extra.sku)).toBe(sourceExtra);
    expect(srcDoc.status).toBe('merged');
  });

  test('a merge abandoned on a destination that was ordered is reclaimed by the new destination', async () => {
    const { dest, src } = await setup();
    await carts().updateOne({ id: src }, { $set: { status: 'merging', mergingInto: dest, mergeId: 'stale' } });
    await carts().updateOne({ id: dest }, { $set: { status: 'ordered' } });
    const next = await customerCartId();
    expect(next).not.toBe(dest);
    expect((await merge(src, next)).errors).toBeUndefined();
    expect(await qty(next, cheap.sku)).toBe(2);
    expect(await status(src)).toBe('merged');
  });
});
