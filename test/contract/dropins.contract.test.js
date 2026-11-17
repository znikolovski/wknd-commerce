/**
 * Contract tests: every storefront drop-in operation we support (extracted verbatim from the
 * pinned @dropins/* bundles into dropin-operations.json) must validate against the mock schema
 * and execute without GraphQL errors through a realistic shopper journey.
 *
 * Refresh fixtures after bumping drop-in versions:
 *   node scripts/extract-dropin-operations.mjs   (see README)
 */
const fs = require('node:fs');
const path = require('node:path');
const { parse, validate } = require('graphql');
const { createMemoryStore } = require('../../lib/store');
const { importCatalog } = require('../../lib/importer');
const { runGraphQL, getSchema } = require('../../lib/graphql-server');
const { resetCatalogCache, optionUid } = require('../../lib/catalog');

const OPS = JSON.parse(fs.readFileSync(path.join(__dirname, 'dropin-operations.json'), 'utf8'));
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/catalog.json'), 'utf8'));

/** Adobe Commerce Optimizer-only operations the WKND store does not target. */
const NOT_TARGETED = [
  'storefront-recommendations/GetRecommendationsByUnits',
  'storefront-recommendations/GetRecommendationsByUnitsWithCurrentProduct',
  'storefront-auth/GET_ADOBE_COMMERCE_OPTIMIZER_DATA',
];

const PAGING = { pageSize: 100, currentPage: 1, itemsSortInput: { field: 'CREATED_AT', order: 'DESC' } };
const ADDRESS = {
  firstname: 'Ava', lastname: 'Nguyen', street: ['12 Harbour St'], city: 'Sydney', region_id: 2, postcode: '2000', country_code: 'AU', telephone: '0400000000',
};
const { region_id: _regionId, ...CUSTOMER_ADDRESS } = ADDRESS;
const CUSTOMER_TOKEN = 'test-customer-token';
const verify = async (token) => {
  if (token !== CUSTOMER_TOKEN) throw new Error('bad token');
  return { sub: 'auth0|wknd-test', email: 'ava@example.com', given_name: 'Ava', family_name: 'Nguyen' };
};

let store;
async function run(name, variables = {}, { auth } = {}) {
  const { body } = await runGraphQL({
    query: OPS[name], variables, headers: auth ? { authorization: `Bearer ${CUSTOMER_TOKEN}` } : {},
  }, { store, params: { AUTH0_ISSUER: 'https://example.auth0.com/', AUTH0_AUDIENCE: 'test' }, verify });
  return body;
}
async function ok(name, variables, opts) {
  const body = await run(name, variables, opts);
  if (body.errors) throw new Error(`${name} failed: ${JSON.stringify(body.errors, null, 1)}`);
  return body.data;
}

const configurable = CATALOG.products.find((p) => p.type === 'configurable' && p.categories[0] === 'apparel/jackets');
const simple = CATALOG.products.find((p) => p.type === 'simple');
const stocked = (p) => p.variants.find((v) => CATALOG.inventory.find((i) => i.sku === v.sku).qty > 5);

beforeAll(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
});

describe('schema contract', () => {
  test.each(Object.keys(OPS).filter((k) => !NOT_TARGETED.includes(k)))('%s validates', (name) => {
    expect(validate(getSchema(), parse(OPS[name]))).toEqual([]);
  });
});

describe('catalog operations', () => {
  test('store configuration & reference data', async () => {
    for (const name of ['storefront-cart/STORE_CONFIG_QUERY', 'storefront-checkout/getStoreConfig', 'storefront-order/STORE_CONFIG_QUERY', 'storefront-auth/GET_STORE_CONFIG', 'storefront-account/GET_STORE_CONFIG', 'storefront-cart/COUNTRIES_QUERY', 'storefront-account/GET_COUNTRIES_QUERY', 'storefront-checkout/GET_CHECKOUT_AGREEMENTS', 'storefront-order/GET_ATTRIBUTES_FORM_SHORT', 'storefront-account/GET_ATTRIBUTES_FORM_SHORT']) {
      // eslint-disable-next-line no-await-in-loop
      await ok(name);
    }
    const regions = await ok('storefront-cart/REGIONS_QUERY', { id: 'AU' });
    expect(regions.country.available_regions.map((r) => r.code)).toContain('NSW');
    await ok('storefront-account/GET_REGIONS', { countryCode: 'AU' });
    const form = await ok('storefront-order/GET_ATTRIBUTES_FORM', { formCode: 'customer_register_address' });
    expect(form.attributesForm.items.map((i) => i.code)).toEqual(expect.arrayContaining(['firstname', 'street', 'postcode', 'country_id']));
    await ok('storefront-auth/GET_ATTRIBUTES_FORM', { formCode: 'customer_account_create' });
    await ok('storefront-order/GET_ATTRIBUTES_LIST', { entityType: 'CUSTOMER_ADDRESS' });
  });

  test('PDP queries & refinement', async () => {
    const data = await ok('storefront-pdp/GET_PRODUCT_DATA', { skus: [configurable.sku] });
    const [view] = data.products;
    expect(view.__typename).toBe('ComplexProductView');
    expect(view.options.map((o) => o.id)).toEqual(['color', 'size']);
    expect(view.priceRange.minimum.final.amount.currency).toBe('AUD');
    await ok('storefront-pdp/GET_PRODUCTS_DATA', { skus: [configurable.sku, simple.sku] });
    const variant = stocked(configurable);
    const ids = Object.entries(variant.selections).map(([o, v]) => optionUid(o, v));
    const refined = await ok('storefront-pdp/REFINE_PRODUCT_QUERY', { sku: configurable.sku, optionIds: ids });
    expect(refined.refineProduct.sku).toBe(variant.sku);
    expect(refined.refineProduct.__typename).toBe('SimpleProductView');
  });

  test('product search with facets, filters and sorting', async () => {
    const data = await ok('storefront-product-discovery/productSearch', {
      phrase: 'jacket',
      pageSize: 8,
      currentPage: 1,
      filter: [{ attribute: 'visibility', in: ['Search', 'Catalog, Search'] }, { attribute: 'categoryPath', eq: 'apparel' }],
      sort: [{ attribute: 'price', direction: 'ASC' }],
    });
    const res = data.productSearch;
    expect(res.total_count).toBeGreaterThan(3);
    expect(res.facets.map((f) => f.attribute)).toEqual(expect.arrayContaining(['categoryPath', 'price', 'color']));
    const prices = res.items.map((i) => i.productView.price?.final.amount.value
      ?? i.productView.priceRange.minimum.final.amount.value);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
    const plp = await ok('storefront-product-discovery/productSearch', { phrase: '', filter: [{ attribute: 'categoryPath', eq: 'accessories/packs' }] });
    expect(plp.productSearch.items.every((i) => i.productView.urlKey)).toBe(true);
  });

  test('recommendations by unit id', async () => {
    const data = await ok('storefront-recommendations/GetRecommendationsByUnitIds', {
      unitIds: ['wknd-pdp-more-like-this', 'wknd-pdp-complete-kit', 'wknd-of1-gear'], currentSku: configurable.sku, cartSkus: [],
    });
    const [similar, kit, gear] = data.recommendationsByUnitIds.results;
    expect(similar.productsView.length).toBeGreaterThan(0);
    expect(similar.productsView.map((p) => p.sku)).not.toContain(configurable.sku);
    expect(kit.productsView.length).toBeGreaterThan(0);
    expect(gear.productsView[0].sku).toBe(configurable.sku);
    await ok('storefront-recommendations/GetRecommendationsByUnitIdsWithCurrentProduct', { unitIds: ['wknd-trending'], currentSku: '' });
  });
});

describe('guest checkout journey', () => {
  let cartId;
  let order;

  test('cart', async () => {
    cartId = (await ok('storefront-cart/CREATE_GUEST_CART_MUTATION')).createGuestCart.cart.id;
    const variant = stocked(configurable);
    const added = await ok('storefront-cart/ADD_PRODUCTS_TO_CART_MUTATION', {
      cartId,
      ...PAGING,
      cartItems: [
        { sku: configurable.sku, quantity: 1, selected_options: Object.entries(variant.selections).map(([o, v]) => optionUid(o, v)) },
        { sku: simple.sku, quantity: 2 },
        { sku: 'NOPE', quantity: 1 },
      ],
    });
    expect(added.addProductsToCart.user_errors[0].code).toBe('PRODUCT_NOT_FOUND');
    const cart = added.addProductsToCart.cart;
    expect(cart.total_quantity).toBe(3);
    const configured = cart.itemsV2.items.find((i) => i.__typename === 'ConfigurableCartItem');
    expect(configured.configured_variant.sku).toBe(variant.sku);
    const updated = await ok('storefront-cart/UPDATE_PRODUCTS_FROM_CART_MUTATION', {
      cartId, ...PAGING, cartItems: [{ cart_item_uid: configured.uid, quantity: 2 }],
    });
    expect(updated.updateCartItems.cart.total_quantity).toBe(4);
    const couponed = await ok('storefront-cart/APPLY_COUPONS_TO_CART_MUTATION', {
      cartId, ...PAGING, couponCodes: ['WKND10'], type: 'REPLACE',
    });
    expect(couponed.applyCouponsToCart.cart.prices.discounts[0].coupon.code).toBe('WKND10');
    await ok('storefront-cart/GUEST_CART_QUERY', { cartId, ...PAGING });
    await ok('storefront-cart/GUEST_AVAILABLE_FREE_GIFTS_QUERY', { cartId });
    const est = await ok('storefront-cart/ESTIMATE_SHIPPING_METHODS_MUTATION', { cartId, address: { country_code: 'AU', postcode: '2000' } });
    expect(est.estimateShippingMethods.length).toBeGreaterThan(0);
    await ok('storefront-cart/GET_ESTIMATED_TOTALS_MUTATION', {
      cartId, ...PAGING, address: { country_code: 'AU', postcode: '2000' }, shipping_method: { carrier_code: 'wknd', method_code: 'express' },
    });
  });

  test('checkout', async () => {
    await ok('storefront-checkout/getCart', { cartId });
    await ok('storefront-checkout/isEmailAvailable', { email: 'ava@example.com' });
    await ok('storefront-checkout/estimateShippingMethods', { cartId, address: { country_code: 'AU' } });
    await ok('storefront-checkout/setGuestEmail', { cartId, email: 'ava@example.com' });
    await ok('storefront-checkout/setShippingAddressOnCartAndUseAsBilling', { cartId, shippingAddress: { address: ADDRESS } });
    await ok('storefront-checkout/setShippingAddressOnCart', { cartId, shippingAddress: { address: ADDRESS } });
    await ok('storefront-checkout/setBillingAddress', { cartId, billingAddress: { same_as_shipping: true } });
    await ok('storefront-checkout/setShippingMethodsOnCart', { cartId, shippingMethods: [{ carrier_code: 'wknd', method_code: 'express' }] });
    const paid = await ok('storefront-checkout/setPaymentMethodOnCart', { cartId, input: { code: 'wknd_demo_pay' } });
    expect(paid.setPaymentMethodOnCart.cart.selected_payment_method.code).toBe('wknd_demo_pay');
    const rejected = await run('storefront-checkout/setPaymentMethodOnCart', { cartId, input: { code: 'checkmo' } });
    expect(rejected.errors[0].message).toMatch(/not available/);
  });

  test('place order decrements stock and is retrievable', async () => {
    const variant = stocked(configurable);
    const before = (await store.collection('inventory').findOne({ sku: variant.sku })).qty;
    const placed = await ok('storefront-order/PLACE_ORDER_MUTATION', { cartId });
    order = placed.placeOrder.orderV2;
    expect(placed.placeOrder.errors).toEqual([]);
    expect(order.number).toMatch(/^WKND-DEMO-/);
    expect(order.payment_methods[0].type).toBe('wknd_demo_pay');
    expect(order.total.grand_total.currency).toBe('AUD');
    expect((await store.collection('inventory').findOne({ sku: variant.sku })).qty).toBe(before - 2);
    const again = await ok('storefront-order/PLACE_ORDER_MUTATION', { cartId }).catch((e) => e);
    expect(String(again.message || JSON.stringify(again))).toMatch(/isn't active|CART_NOT_ACTIVE/);
    await ok('storefront-order/ORDER_BY_TOKEN', { token: order.token });
    await ok('storefront-order/GET_GUEST_ORDER', { input: { number: order.number, email: 'ava@example.com', lastname: 'Nguyen' } });
  });
});

describe('signed-in customer journey (Auth0)', () => {
  test('profile, cart merge, addresses, orders and reorder', async () => {
    const auth = { auth: true };
    const guestCartId = (await ok('storefront-cart/CREATE_GUEST_CART_MUTATION')).createGuestCart.cart.id;
    await ok('storefront-cart/ADD_PRODUCTS_TO_CART_MUTATION', { cartId: guestCartId, ...PAGING, cartItems: [{ sku: simple.sku, quantity: 1 }] });

    const customerData = await ok('storefront-auth/GET_CUSTOMER_DATA', {}, auth);
    expect(customerData.customer.email).toBe('ava@example.com');
    for (const name of ['storefront-auth/VALIDATE_TOKEN', 'storefront-auth/VALIDATE_TOKEN_WITH_GROUP', 'storefront-checkout/getCustomer', 'storefront-order/GET_CUSTOMER', 'storefront-account/GET_CUSTOMER', 'storefront-checkout/getStoredPaymentMethods', 'storefront-account/getCustomerPaymentTokens', 'storefront-cart/CUSTOMER_AVAILABLE_FREE_GIFTS_QUERY', 'storefront-auth/GET_CUSTOMER_ROLE_PERMISSIONS', 'storefront-account/GET_CUSTOMER_ROLE_PERMISSIONS']) {
      // eslint-disable-next-line no-await-in-loop
      await ok(name, {}, auth);
    }
    await ok('storefront-cart/CUSTOMER_CART_QUERY', PAGING, auth);
    const customerCartId = (await ok('storefront-checkout/getCustomerCart', {}, auth)).cart.id;
    const merged = await ok('storefront-cart/MERGE_CARTS_MUTATION', { guestCartId, customerCartId, ...PAGING }, auth);
    expect(merged.mergeCarts.total_quantity).toBeGreaterThanOrEqual(1);

    await ok('storefront-account/CREATE_CUSTOMER_ADDRESS', { input: { ...CUSTOMER_ADDRESS, region: { region_id: 2 } } }, auth);
    await ok('storefront-auth/CREATE_CUSTOMER_ADDRESS', { input: { ...CUSTOMER_ADDRESS, region: { region_id: 7 }, city: 'Melbourne' } }, auth);
    const book = await ok('storefront-account/GET_CUSTOMER_ADDRESS', {}, auth);
    expect(book.customer.addresses.length).toBe(2);
    const { id, uid } = book.customer.addresses.find((a) => a.city === 'Sydney');
    expect(Number.isInteger(id)).toBe(true);
    await ok('storefront-account/UPDATE_CUSTOMER_ADDRESS', { id, input: { city: 'Manly' } }, auth);
    await ok('storefront-account/UPDATE_CUSTOMER_V2', { input: { firstname: 'Ava-Marie' } }, auth);

    const cartId = merged.mergeCarts.id;
    await ok('storefront-checkout/getCustomerCart', {}, auth);
    await ok('storefront-checkout/setShippingAddressOnCart', { cartId, shippingAddress: { customer_address_uid: uid } }, auth);
    await ok('storefront-checkout/setBillingAddress', { cartId, billingAddress: { same_as_shipping: true } }, auth);
    await ok('storefront-checkout/setPaymentMethodOnCart', { cartId, input: { code: 'wknd_demo_pay' } }, auth);
    const placed = await ok('storefront-order/setPaymentMethodAndPlaceOrder', { cartId, paymentMethod: { code: 'wknd_demo_pay' } }, auth);
    const { number } = placed.placeOrder.orderV2;

    const list = await ok('storefront-account/GET_CUSTOMER_ORDERS_LIST', { currentPage: 1, pageSize: 10 }, auth);
    expect(list.customer.orders.items.map((o) => o.number)).toContain(number);
    await ok('storefront-order/ORDER_BY_NUMBER', { orderNumber: number, pageSize: 10 }, auth);
    await ok('storefront-order/GET_CUSTOMER_ORDERS_RETURN', { currentPage: 1, pageSize: 10 }, auth);
    const reorder = await ok('storefront-order/REORDER_ITEMS_MUTATION', { orderNumber: number }, auth);
    expect(reorder.reorderItems.userInputErrors).toEqual([]);
    const after = await ok('storefront-cart/CUSTOMER_CART_QUERY', PAGING, auth);
    expect(JSON.stringify(after)).toContain(simple.sku);
    await ok('storefront-account/REMOVE_CUSTOMER_ADDRESS', { id }, auth);
  });

  test('customer operations reject guests and other customers\' carts', async () => {
    const res = await run('storefront-account/GET_CUSTOMER');
    expect(res.errors[0].extensions.category).toBe('graphql-authorization');
    const stale = await runGraphQL({ query: OPS['storefront-auth/VALIDATE_TOKEN'], headers: { authorization: 'Bearer expired' } }, { store, params: {}, verify });
    expect(stale.body.errors[0]).toMatchObject({ path: ['customer'], extensions: { category: 'graphql-authentication' } });
    const catalogWithStaleToken = await runGraphQL({ query: OPS['storefront-cart/STORE_CONFIG_QUERY'], headers: { authorization: 'Bearer expired' } }, { store, params: {}, verify });
    expect(catalogWithStaleToken.body.errors).toBeUndefined();
    const customerCart = await ok('storefront-checkout/getCustomerCart', {}, { auth: true });
    const stolen = await run('storefront-cart/GUEST_CART_QUERY', { cartId: customerCart.cart.id, ...PAGING });
    expect(stolen.errors[0].extensions.category).toBe('graphql-authorization');
  });

  test('unsupported features fail gracefully', async () => {
    const res = await run('storefront-auth/GET_CUSTOMER_TOKEN', { email: 'a@b.c', password: 'x' });
    expect(res.errors[0].message).toMatch(/not available in the WKND demo store/);
  });
});
