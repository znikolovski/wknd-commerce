/**
 * Cross-channel recovery regression (synthetic, in-memory): a website Auth0 sign-in and a
 * delegated LLM-app assertion for the same verified shopper share one customer, one entitlement
 * and one redemption per campaign, through the existing auth, cart, claim and order paths.
 * Negative cases keep issuers and accounts isolated. No live auth, API or data.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SignJWT } = require('jose');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { runGraphQL } = require('../lib/graphql-server');
const { resetCatalogCache, loadCatalog } = require('../lib/catalog');
const { sha256, canonicalJson } = require('../lib/promotion-schema');
const { migrateLegacyPromotions, createPromotionService } = require('../lib/promotions');
const {
  bootstrapRecoveryPromotion, promotionIdFor, shopperKey, redemptionKey, DEFAULT_CAMPAIGN,
} = require('../lib/recovery-policy');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
const AUTH0_ISSUER = 'https://example.auth0.com/';
const MCP_ISSUER = 'https://example.adobeio-static.net/api/v1/web/llm-apps/mcp';
const SECRET = 'test-only-mcp-delegation-secret-of-32-bytes+';
const SUB_A = 'auth0|fixture-a';
const SUB_B = 'auth0|fixture-b';
const WEB = { 'web-a': SUB_A, 'web-b': SUB_B };
const PARAMS = {
  AUTH0_ISSUER,
  AUTH0_AUDIENCE: 'test',
  RECOVERY_REDEMPTION_VERIFIED: 'true',
  MCP_DELEGATION_ISSUER: MCP_ISSUER,
  MCP_DELEGATION_SECRET: SECRET,
};
const verify = async (token) => {
  if (!WEB[token]) throw new Error('bad token');
  return { sub: WEB[token], email: `${WEB[token].split('|')[1]}@example.com`, given_name: 'Sam' };
};
const HOUR = 3600 * 1000;
const RID = promotionIdFor(DEFAULT_CAMPAIGN.campaignId);
const priceOf = (sku) => CATALOG.prices.find((p) => p.sku === sku);
const inStock = (sku) => (CATALOG.inventory.find((i) => i.sku === sku)?.qty || 0) > 5;
const pricey = CATALOG.products.find((p) => p.type === 'simple' && inStock(p.sku)
  && priceOf(p.sku)?.special == null && priceOf(p.sku).regular >= 300);

const CART = 'query($id: String!) { cart(cart_id: $id) { id applied_coupons { code } prices { grand_total { value } } items { quantity product { sku } } } }';
const MY_CART = 'query { customerCart { id } }';
const ADD = 'mutation($id: String!, $sku: String!) { addProductsToCart(cartId: $id, cartItems: [{ sku: $sku, quantity: 2 }]) { cart { id } } }';
const APPLY = 'mutation($id: String!, $code: String!) { applyCouponToCart(input: { cart_id: $id, coupon_code: $code }) { cart { applied_coupons { code } } } }';
const OFFER = 'query($id: String!) { wkndRecoveryOffer(cart_id: $id) { status coupon_code } }';
const CLAIM = 'mutation($id: String!) { claimWkndRecoveryOffer(cart_id: $id) { status coupon_code } }';
const PLACE = 'mutation($id: String!) { placeOrder(input: { cart_id: $id }) { errors { code message } orderV2 { number } } }';
const VERSION = 'query($id: String!) { cart(cart_id: $id) { wknd_cart_version } }';
const APPLY_OFFER = 'mutation($id: String!, $v: String!) { applyWkndRecoveryOffer(cart_id: $id, expected_cart_version: $v) { outcome cart { applied_coupons { code } } } }';

let store;

async function assertion(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: SUB_A, identity_issuer: AUTH0_ISSUER, scope: 'shop:cart', jti: crypto.randomUUID(), ...claims,
  }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer(MCP_ISSUER)
    .setAudience('urn:wknd-commerce:storefront').setIssuedAt(now).setExpirationTime(now + 60)
    .sign(new TextEncoder().encode(SECRET));
}

async function call(query, variables, headers) {
  const { body } = await runGraphQL({ query, variables, headers }, { store, params: PARAMS, verify });
  return body;
}
const web = (query, variables = {}, token = 'web-a') => call(query, variables, { authorization: ['Bearer', token].join(' ') });
const chat = async (query, variables = {}, claims = {}) => call(query, variables, {
  authorization: ['Bearer', await assertion(claims)].join(' '), 'x-wknd-delegation': 'mcp',
});

async function enableRecovery() {
  const svc = createPromotionService({ store, loadCatalog: () => loadCatalog(store), params: PARAMS });
  const current = await store.collection('promotions').findOne({ id: RID });
  const r = await svc.updatePromotion({ actor: { kind: 'ims-operator', subject: 'op', orgId: 'ORG@AdobeOrg' }, correlationId: crypto.randomUUID() }, {
    id: RID,
    expectedRevision: current.revision,
    idempotencyKey: crypto.randomUUID(),
    promotion: {
      name: current.name, enabled: true, mode: 'coupon', code: 'RECOVER10', discount: { kind: 'percentage', basisPoints: 1000 }, maxDiscountMinor: 2500, minimumMerchandiseMinor: null, target: { kind: 'all' }, startsAt: null, endsAt: null, audienceRestriction: null,
    },
  });
  expect(r.ok).toBe(true);
}

const age = (id, hours = 30) => store.collection('carts').updateOne({ id }, { $set: { activityAt: new Date(Date.now() - hours * HOUR).toISOString() } });

/** The shopper's current cart with items, made inactive (30h) via the given channel. */
async function idleCart(via) {
  const id = (await via(MY_CART)).data.customerCart.id;
  expect((await via(ADD, { id, sku: pricey.sku })).errors).toBeUndefined();
  await age(id);
  return id;
}

async function readyForCheckout(via, id) {
  const a = {
    firstname: 'Sam', lastname: 'Shopper', street: ['1 Trail St'], city: 'Sydney', postcode: '2000', telephone: '0400000000', country_code: 'AU', region: 'NSW',
  };
  const steps = [
    await via('mutation($id: String!) { setGuestEmailOnCart(input: { cart_id: $id, email: "fixture@example.com" }) { cart { id } } }', { id }),
    await via('mutation($id: String!, $a: CartAddressInput!) { setShippingAddressesOnCart(input: { cart_id: $id, shipping_addresses: [{ address: $a }] }) { cart { id } } }', { id, a }),
    await via('mutation($id: String!) { setBillingAddressOnCart(input: { cart_id: $id, billing_address: { same_as_shipping: true } }) { cart { id } } }', { id }),
    await via('mutation($id: String!) { setPaymentMethodOnCart(input: { cart_id: $id, payment_method: { code: "wknd_demo_pay" } }) { cart { id } } }', { id }),
  ];
  steps.forEach((s) => expect(s.errors).toBeUndefined());
}

/** Delegated placeOrder bound to the reviewed cart (order_expect), as the LLM app sends it. */
async function chatPlace(id, claims = {}) {
  const cart = (await web(CART, { id }, claims.sub === SUB_B ? 'web-b' : 'web-a')).data.cart;
  const orderExpect = { grand_total: cart.prices.grand_total.value, items: cart.items.map((i) => [i.product.sku, i.quantity]) };
  return chat(PLACE, { id }, { ...claims, order_expect: orderExpect });
}

const count = (name) => store.collection(name).countDocuments({});

/** The delegated channel applies the protected offer only via the reviewed-version mutation. */
async function chatApplyOffer(id) {
  const v = (await chat(VERSION, { id })).data.cart.wknd_cart_version;
  return chat(APPLY_OFFER, { id, v });
}

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
  await migrateLegacyPromotions(store);
  await bootstrapRecoveryPromotion(store);
  await enableRecovery();
});

describe('same verified shopper across website and delegated channel', () => {
  test('one customer, one cart, one entitlement across channels', async () => {
    const id = await idleCart(web);
    expect((await chat(MY_CART)).data.customerCart.id).toBe(id);
    expect((await web(CLAIM, { id })).data.claimWkndRecoveryOffer.status).toBe('CLAIMED');
    expect((await chat(OFFER, { id })).data.wkndRecoveryOffer).toEqual({ status: 'CLAIMED', coupon_code: 'RECOVER10' });
    expect((await chat(CLAIM, { id })).data.claimWkndRecoveryOffer.status).toBe('CLAIMED');
    expect(await count('customers')).toBe(1);
    expect(await count('recovery_entitlements')).toBe(1);
  });

  test('delegated redemption is keyed by the existing recovery shopperKey and blocks the website', async () => {
    const id = await idleCart(chat);
    expect((await chat(CLAIM, { id })).data.claimWkndRecoveryOffer.status).toBe('CLAIMED');
    expect((await chatApplyOffer(id)).data.applyWkndRecoveryOffer).toEqual({ outcome: 'APPLIED', cart: { applied_coupons: [{ code: 'RECOVER10' }] } });
    await readyForCheckout(chat, id);
    const placed = await chatPlace(id);
    expect(placed.data.placeOrder.errors).toEqual([]);

    const [redemption] = await store.collection('recovery_redemptions').find({});
    const binding = shopperKey(AUTH0_ISSUER, SUB_A);
    expect(binding).toBe(sha256(canonicalJson(['auth0', AUTH0_ISSUER, SUB_A])));
    expect(redemption).toMatchObject({ key: redemptionKey(binding, DEFAULT_CAMPAIGN.campaignId), state: 'redeemed' });
    expect(redemption.key).not.toBe(redemptionKey(sha256(`${AUTH0_ISSUER}|${SUB_A}`), DEFAULT_CAMPAIGN.campaignId));

    const next = await idleCart(web);
    expect(next).not.toBe(id);
    expect((await web(OFFER, { id: next })).data.wkndRecoveryOffer.status).toBe('REDEEMED');
    expect((await chat(OFFER, { id: next })).data.wkndRecoveryOffer.status).toBe('REDEEMED');
    expect((await web(APPLY, { id: next, code: 'RECOVER10' })).errors[0].message).toBe('This offer has already been used.');
    expect(await count('recovery_redemptions')).toBe(1);
  });

  test('website redemption blocks the delegated channel on a later cart', async () => {
    const id = await idleCart(web);
    await web(CLAIM, { id });
    await web(APPLY, { id, code: 'RECOVER10' });
    await readyForCheckout(web, id);
    expect((await web(PLACE, { id })).data.placeOrder.errors).toEqual([]);

    const next = await idleCart(chat);
    expect((await chat(OFFER, { id: next })).data.wkndRecoveryOffer.status).toBe('REDEEMED');
    expect((await chat(CLAIM, { id: next })).data.claimWkndRecoveryOffer.status).toBe('REDEEMED');
    expect((await chat(APPLY, { id: next, code: 'RECOVER10' })).errors[0].extensions.code).toBe('REVIEWED_VERSION_REQUIRED');
    expect((await chatApplyOffer(next)).errors[0].extensions.code).toBe('RECOVERY_OFFER_UNAVAILABLE');
  });

  test('website and delegated checkouts racing on two carts redeem at most once', async () => {
    const first = await idleCart(web);
    const copy = await store.collection('carts').findOne({ id: first });
    const second = crypto.randomBytes(16).toString('hex');
    await store.collection('carts').insertOne({ ...copy, _id: undefined, id: second, revision: 0 });
    for (const [via, id] of [[web, first], [chat, second]]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await via(CLAIM, { id })).data.claimWkndRecoveryOffer.status).toBe('CLAIMED');
      // eslint-disable-next-line no-await-in-loop
      const applied = via === chat ? (await chatApplyOffer(id)).data.applyWkndRecoveryOffer.cart : (await via(APPLY, { id, code: 'RECOVER10' })).data.applyCouponToCart.cart;
      expect(applied.applied_coupons).toEqual([{ code: 'RECOVER10' }]);
      // eslint-disable-next-line no-await-in-loop
      await readyForCheckout(via, id);
    }
    const results = await Promise.all([web(PLACE, { id: first }), chatPlace(second)]);
    const ok = results.filter((r) => r.data.placeOrder.errors.length === 0);
    expect(ok).toHaveLength(1);
    const loser = results.find((r) => r.data.placeOrder.errors.length).data.placeOrder;
    expect(loser.errors).toEqual([{ code: 'UNABLE_TO_PLACE_ORDER', message: 'This offer has already been used.' }]);
    expect(await count('orders')).toBe(1);
    expect(await count('recovery_redemptions')).toBe(1);
  });
});

describe('issuer and account isolation', () => {
  test.each([
    ['issuer without the configured trailing slash', { identity_issuer: 'https://example.auth0.com' }],
    ['another Auth0 tenant', { identity_issuer: 'https://other.auth0.com/' }],
  ])('%s: rejected, nothing created or claimed', async (_, claims) => {
    const id = await idleCart(web);
    const before = await store.collection('carts').findOne({ id });
    const r = await chat(CLAIM, { id }, claims);
    expect(r.data?.claimWkndRecoveryOffer ?? null).toBeNull();
    expect(r.errors[0].extensions.category).toBe('graphql-authentication');
    expect(await store.collection('carts').findOne({ id })).toEqual(before);
    expect(await count('recovery_entitlements')).toBe(0);
    expect(await count('customers')).toBe(1);
  });

  test("another shopper's delegated assertion cannot read, claim or apply on this cart", async () => {
    const id = await idleCart(web);
    const other = { sub: SUB_B };
    for (const q of [[OFFER, { id }], [CLAIM, { id }], [APPLY, { id, code: 'RECOVER10' }]]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await chat(q[0], q[1], other);
      expect(r.errors[0].extensions.category).toMatch(/graphql-auth/);
    }
    expect(await count('recovery_entitlements')).toBe(0);
  });

  test("one shopper's redemption does not affect another shopper", async () => {
    const id = await idleCart(web);
    await web(CLAIM, { id });
    await web(APPLY, { id, code: 'RECOVER10' });
    await readyForCheckout(web, id);
    expect((await web(PLACE, { id })).data.placeOrder.errors).toEqual([]);

    const theirs = await idleCart((q, v) => web(q, v, 'web-b'));
    expect((await chat(OFFER, { id: theirs }, { sub: SUB_B })).data.wkndRecoveryOffer.status).toBe('ELIGIBLE');
    expect(shopperKey(AUTH0_ISSUER, SUB_B)).not.toBe(shopperKey(AUTH0_ISSUER, SUB_A));
  });
});
