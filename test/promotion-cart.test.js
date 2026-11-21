/**
 * Shared promotion engine in the storefront cart and both order paths, plus the protected
 * cart-recovery offer (single redemption per verified shopper per campaign).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { runGraphQL } = require('../lib/graphql-server');
const { resetCatalogCache, loadCatalog } = require('../lib/catalog');
const { placeOrder } = require('../lib/orders');
const {
  migrateLegacyPromotions, createPromotionService, loadPromotionRuntime, LEGACY_SEEDS,
} = require('../lib/promotions');
const { bootstrapRecoveryPromotion, promotionIdFor, DEFAULT_CAMPAIGN } = require('../lib/recovery-policy');

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
async function gql(query, variables = {}, { auth = true } = {}) {
  const headers = auth ? { authorization: `Bearer ${TOKEN}` } : {};
  const { body } = await runGraphQL({ query, variables, headers }, { store, params, verify });
  return body;
}

const CART_FIELDS = 'id applied_coupons { code } prices { grand_total { value } discounts { amount { value } label coupon { code } } applied_taxes { amount { value } } subtotal_including_tax { value } }';
const ADD = `mutation Add($id: String!, $sku: String!, $qty: Float!) { addProductsToCart(cartId: $id, cartItems: [{ sku: $sku, quantity: $qty }]) { cart { ${CART_FIELDS} } user_errors { code message } } }`;
const APPLY = `mutation Apply($id: String!, $code: String!) { applyCouponToCart(input: { cart_id: $id, coupon_code: $code }) { cart { ${CART_FIELDS} } } }`;
const OFFER = 'query Offer($id: String!) { wkndRecoveryOffer(cart_id: $id) { status reason coupon_code percent_off max_discount { value } expires_at } }';
const CLAIM = 'mutation Claim($id: String!) { claimWkndRecoveryOffer(cart_id: $id) { status reason coupon_code percent_off max_discount { value } expires_at } }';
const PLACE = 'mutation Place($id: String!) { placeOrder(input: { cart_id: $id }) { errors { code message } orderV2 { number total { discounts { amount { value } } grand_total { value } } } } }';

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

  test('inactivity window is 24h to 7 days', async () => {
    const id = await customerCartId();
    await gql(ADD, { id, sku: pricey.sku, qty: 1 });
    await age(id, 23);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer).toMatchObject({ status: 'INELIGIBLE', reason: 'NOT_IN_RECOVERY_WINDOW' });
    await age(id, 24 * 8);
    expect((await gql(OFFER, { id })).data.wkndRecoveryOffer).toMatchObject({ status: 'INELIGIBLE', reason: 'NOT_IN_RECOVERY_WINDOW' });
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
