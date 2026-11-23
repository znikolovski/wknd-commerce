/**
 * Delegated shopper assertions (WKND LLM app / ChatGPT) and single-order cart claims.
 * A delegated shopper must reach the same customer and active cart as the website sign-in.
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
const { getCustomerCart, addItem, saveCart, computeTotals } = require('../lib/cart');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
const AUTH0_ISSUER = 'https://example.auth0.com/';
const MCP_ISSUER = 'https://example.adobeio-static.net/api/v1/web/llm-apps/mcp';
const SECRET = 'test-only-mcp-delegation-secret-of-32-bytes+';
const SUB = 'auth0|shopper-1';
const WEB_TOKEN = 'website-access-token';
const PARAMS = {
  AUTH0_ISSUER, AUTH0_AUDIENCE: 'test', MCP_DELEGATION_ISSUER: MCP_ISSUER, MCP_DELEGATION_SECRET: SECRET,
};
const verify = async (token) => {
  if (token !== WEB_TOKEN) throw new Error('bad token');
  return { sub: SUB, email: 'shopper@example.com', given_name: 'Sam' };
};

const simple = CATALOG.products.find((p) => p.type === 'simple'
  && CATALOG.inventory.find((i) => i.sku === p.sku)?.qty > 5);

async function assertion(overrides = {}, { secret = SECRET, lifetime = 60 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: SUB, identity_issuer: AUTH0_ISSUER, scope: 'shop:cart', jti: crypto.randomUUID(), ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(overrides.iss ?? MCP_ISSUER)
    .setAudience(overrides.aud ?? 'urn:wknd-commerce:storefront')
    .setIssuedAt(now)
    .setExpirationTime(now + lifetime)
    .sign(new TextEncoder().encode(secret));
}

let store;
async function gql(query, { token, delegated = false, variables = {}, params = PARAMS } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (delegated) headers['x-wknd-delegation'] = 'mcp';
  const { body } = await runGraphQL({ query, variables, headers }, { store, params, verify });
  return body;
}
const CART_QUERY = 'query { customerCart { id total_quantity items { uid quantity } } }';

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
});

describe('delegated shopper assertions', () => {
  test('resolve the same customer cart as the website sign-in', async () => {
    const web = await gql(`mutation { addProductsToCart(cartId: "${(await gql(CART_QUERY, { token: WEB_TOKEN })).data.customerCart.id}", cartItems: [{ sku: "${simple.sku}", quantity: 1 }]) { cart { id total_quantity } } }`, { token: WEB_TOKEN });
    expect(web.errors).toBeUndefined();
    const chat = await gql(CART_QUERY, { token: await assertion(), delegated: true });
    expect(chat.errors).toBeUndefined();
    expect(chat.data.customerCart.id).toBe(web.data.addProductsToCart.cart.id);
    expect(chat.data.customerCart.total_quantity).toBe(1);
  });

  test('first sign-in in ChatGPT creates the customer the website later reuses', async () => {
    const chat = await gql(CART_QUERY, { token: await assertion({ email: 'new@example.com' }), delegated: true });
    expect(chat.errors).toBeUndefined();
    const customer = await store.collection('customers').findOne({ sub: SUB });
    expect(customer.email).toBe('new@example.com');
    expect(customer.profileFetchedAt).toBe(0);
    const web = await gql(CART_QUERY, { token: WEB_TOKEN });
    expect(web.data.customerCart.id).toBe(chat.data.customerCart.id);
  });

  test('rejects a replayed assertion', async () => {
    const token = await assertion();
    expect((await gql(CART_QUERY, { token, delegated: true })).errors).toBeUndefined();
    const replay = await gql(CART_QUERY, { token, delegated: true });
    expect(replay.errors[0].extensions.category).toBe('graphql-authentication');
  });

  test.each([
    ['wrong secret', {}, { secret: 'another-secret-that-is-at-least-32-bytes!!' }],
    ['wrong audience', { aud: 'https://elsewhere.example' }, {}],
    ['wrong issuer', { iss: 'https://attacker.example/mcp' }, {}],
    ['wrong identity issuer', { identity_issuer: 'https://other.auth0.com/' }, {}],
    ['missing shop scope', { scope: 'bookings:read' }, {}],
    ['excessive lifetime', {}, { lifetime: 3600 }],
  ])('rejects %s', async (_, claims, options) => {
    const body = await gql(CART_QUERY, { token: await assertion(claims, options), delegated: true });
    expect(body.data?.customerCart ?? null).toBeNull();
    expect(body.errors[0].extensions.category).toBe('graphql-authentication');
  });

  test('refuses delegation when the backend is not configured', async () => {
    const body = await gql(CART_QUERY, {
      token: await assertion(), delegated: true, params: { ...PARAMS, MCP_DELEGATION_SECRET: '' },
    });
    expect(body.errors[0].extensions.category).toBe('graphql-authorization');
  });

  test('a delegated assertion is never treated as a website token (and vice versa)', async () => {
    const asWebToken = await gql(CART_QUERY, { token: await assertion() });
    expect(asWebToken.errors[0].extensions.category).toBe('graphql-authentication');
    const asAssertion = await gql(CART_QUERY, { token: WEB_TOKEN, delegated: true });
    expect(asAssertion.errors[0].extensions.category).toBe('graphql-authentication');
  });
});

describe('environment isolation of delegated assertions (synthetic keys only)', () => {
  // Independent synthetic keys stand in for distinct Stage and Production delegation secrets;
  // the same Auth0 tenant, MCP issuer and audience are shared, as they are live.
  const STAGE = { ...PARAMS, MCP_DELEGATION_SECRET: crypto.randomBytes(48).toString('base64url') };
  const PROD = { ...PARAMS, MCP_DELEGATION_SECRET: crypto.randomBytes(48).toString('base64url') };
  const signed = (params) => assertion({}, { secret: params.MCP_DELEGATION_SECRET });
  const query = async (token, params) => gql(CART_QUERY, { token: await token, delegated: true, params });

  test('each environment accepts only assertions signed with its own key', async () => {
    expect((await query(signed(STAGE), STAGE)).errors).toBeUndefined();
    expect((await query(signed(PROD), PROD)).errors).toBeUndefined();
  });

  test.each([
    ['a Production-signed assertion presented to Stage', PROD, STAGE],
    ['a Stage-signed assertion presented to Production', STAGE, PROD],
  ])('%s is refused with no customer or cart created', async (_, signer, target) => {
    const body = await query(signed(signer), target);
    expect(body.data?.customerCart ?? null).toBeNull();
    expect(body.errors[0].extensions.category).toBe('graphql-authentication');
    expect(await store.collection('customers').countDocuments({})).toBe(0);
    expect(await store.collection('carts').countDocuments({})).toBe(0);
    expect(await store.collection('delegation_jti').countDocuments({})).toBe(0);
  });

  test('a secret shorter than 32 bytes disables delegation instead of weakening it', async () => {
    const weak = { ...STAGE, MCP_DELEGATION_SECRET: 'too-short-secret' };
    const body = await query(assertion({}, { secret: weak.MCP_DELEGATION_SECRET }), weak);
    expect(body.errors[0].extensions.category).toBe('graphql-authorization');
  });
});

describe('delegation secret rotation overlap (synthetic keys only)', () => {
  const OLD = crypto.randomBytes(48).toString('base64url');
  const NEW = crypto.randomBytes(48).toString('base64url');
  const STAGE_KEY = crypto.randomBytes(48).toString('base64url');
  const SINGLE = { ...PARAMS, MCP_DELEGATION_SECRET: NEW };
  const OVERLAP = { ...SINGLE, MCP_DELEGATION_SECRET_PREVIOUS: OLD };
  const query = async (secret, params, claims = {}) => gql(CART_QUERY, {
    token: await assertion(claims, { secret }), delegated: true, params,
  });
  const refused = (body) => body.errors?.[0]?.extensions?.category === 'graphql-authentication'
    && (body.data?.customerCart ?? null) === null;

  test('an empty previous key keeps single-key behaviour', async () => {
    for (const params of [SINGLE, { ...SINGLE, MCP_DELEGATION_SECRET_PREVIOUS: '' }]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await query(NEW, params)).errors).toBeUndefined();
      // eslint-disable-next-line no-await-in-loop
      expect(refused(await query(OLD, params))).toBe(true);
    }
  });

  test('during the overlap both the new and the previous key are accepted', async () => {
    expect((await query(NEW, OVERLAP)).errors).toBeUndefined();
    expect((await query(OLD, OVERLAP)).errors).toBeUndefined();
  });

  test('once the previous key is cleared, the old key is refused and the new key still works', async () => {
    expect(refused(await query(OLD, SINGLE))).toBe(true);
    expect((await query(NEW, SINGLE)).errors).toBeUndefined();
  });

  test('a Stage key and an unrelated key are refused in both slots, creating nothing', async () => {
    for (const key of [STAGE_KEY, crypto.randomBytes(48).toString('base64url')]) {
      // eslint-disable-next-line no-await-in-loop
      expect(refused(await query(key, OVERLAP))).toBe(true);
    }
    expect(await store.collection('customers').countDocuments({})).toBe(0);
    expect(await store.collection('delegation_jti').countDocuments({})).toBe(0);
  });

  test('a short previous key is never accepted', async () => {
    const short = 'previous-key-too-short';
    const body = await query(short, { ...SINGLE, MCP_DELEGATION_SECRET_PREVIOUS: short });
    expect(refused(body)).toBe(true);
  });

  test('claim checks still apply to previous-key assertions', async () => {
    expect(refused(await query(OLD, OVERLAP, { aud: 'urn:other' }))).toBe(true);
    expect(refused(await query(OLD, OVERLAP, { identity_issuer: 'https://other.auth0.com/' }))).toBe(true);
    expect(refused(await query(OLD, OVERLAP, { scope: 'profile' }))).toBe(true);
  });

  test('a jti is accepted once across both keys', async () => {
    const jti = crypto.randomUUID();
    expect((await query(OLD, OVERLAP, { jti })).errors).toBeUndefined();
    expect(refused(await query(NEW, OVERLAP, { jti }))).toBe(true);
    expect(refused(await query(OLD, OVERLAP, { jti }))).toBe(true);
  });
});

describe('order placement claims the cart once', () => {
  async function readyCart() {
    const customer = { sub: SUB, email: 'shopper@example.com', addresses: [] };
    const cat = await loadCatalog(store);
    const cart = await getCustomerCart(store, customer);
    addItem(cat, cart, { sku: simple.sku, quantity: 1 });
    const address = {
      firstname: 'Sam', lastname: 'Lee', street: ['1 Trail Rd'], city: 'Sydney', postcode: '2000', telephone: '0400000000', country_code: 'AU', region_code: 'NSW', region_id: 2,
    };
    Object.assign(cart, {
      email: customer.email,
      shippingAddress: address,
      billingAddress: address,
      shippingMethod: { carrier_code: 'wknd', method_code: 'standard' },
      paymentMethod: 'wknd_demo_pay',
    });
    return { cat, customer, cart: await saveCart(store, cart) };
  }

  test('concurrent placements create exactly one order', async () => {
    const { cat, customer, cart } = await readyCart();
    const results = await Promise.allSettled([
      placeOrder(store, cat, { ...cart }, customer),
      placeOrder(store, cat, { ...cart }, customer),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('CART_NOT_ACTIVE');
    expect(await store.collection('orders').countDocuments({ cartId: cart.id })).toBe(1);
  });

  test('a stale cart write cannot reopen a claimed cart', async () => {
    const { cart } = await readyCart();
    await store.collection('carts').updateOne({ id: cart.id }, { $set: { status: 'ordering' } });
    await expect(saveCart(store, { ...cart, items: [] })).rejects.toMatchObject({ code: 'CART_NOT_ACTIVE' });
    expect((await store.collection('carts').findOne({ id: cart.id })).status).toBe('ordering');
  });

  test('an edit racing the order is not ordered', async () => {
    const { cat, customer, cart } = await readyCart();
    const raced = await saveCart(store, { ...cart, items: cart.items.map((i) => ({ ...i, quantity: 2 })) });
    expect(raced.revision).toBe(cart.revision + 1);
    await expect(placeOrder(store, cat, cart, customer)).rejects.toMatchObject({ code: 'UNABLE_TO_PLACE_ORDER', message: expect.stringMatching(/changed/) });
    expect(await store.collection('orders').countDocuments({ cartId: cart.id })).toBe(0);
  });

  test('a failed stock reservation releases the cart claim', async () => {
    const { cat, customer, cart } = await readyCart();
    await store.collection('inventory').updateOne({ sku: simple.sku }, { $set: { qty: 0 } });
    await expect(placeOrder(store, cat, cart, customer)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect((await store.collection('carts').findOne({ id: cart.id })).status).toBe('active');
  });

  describe('delegated placeOrder is bound to the reviewed cart', () => {
    const PLACE = 'mutation Place($id: String!) { placeOrder(input: { cart_id: $id }) { errors { code message } orderV2 { number } } }';
    const reviewed = (cart, cat) => {
      const totals = computeTotals(cat, cart);
      return { grand_total: totals.grandTotal, items: cart.items.map((i) => [i.sku, i.quantity]) };
    };

    test('places the order when the cart matches the review', async () => {
      const { cat, cart } = await readyCart();
      const body = await gql(PLACE, { token: await assertion({ order_expect: reviewed(cart, cat) }), delegated: true, variables: { id: cart.id } });
      expect(body.errors).toBeUndefined();
      expect(body.data.placeOrder.errors).toEqual([]);
      expect(body.data.placeOrder.orderV2.number).toMatch(/^WKND-DEMO-/);
    });

    test('refuses a cart that changed after the review', async () => {
      const { cat, cart } = await readyCart();
      const expectation = reviewed(cart, cat);
      await saveCart(store, { ...cart, items: cart.items.map((i) => ({ ...i, quantity: 2 })) });
      const body = await gql(PLACE, { token: await assertion({ order_expect: expectation }), delegated: true, variables: { id: cart.id } });
      expect(body.data.placeOrder.orderV2).toBeNull();
      expect(body.data.placeOrder.errors[0]).toMatchObject({ code: 'UNABLE_TO_PLACE_ORDER', message: expect.stringMatching(/changed/) });
      expect(await store.collection('orders').countDocuments({ cartId: cart.id })).toBe(0);
    });

    test('a malformed expectation is unauthenticated and cannot order the shopper\'s cart', async () => {
      const { cart } = await readyCart();
      const body = await gql(PLACE, { token: await assertion({ order_expect: { grand_total: 'free', items: [] } }), delegated: true, variables: { id: cart.id } });
      expect(body.data.placeOrder.orderV2).toBeNull();
      expect(body.data.placeOrder.errors[0].message).toMatch(/cannot perform operations/);
      expect(await store.collection('orders').countDocuments({ cartId: cart.id })).toBe(0);
    });
  });
});
