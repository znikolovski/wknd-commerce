#!/usr/bin/env node
/**
 * Live smoke test: runs real drop-in operations against a deployed endpoint (action or Mesh).
 *   node scripts/smoke-live.mjs --endpoint=<graphql url> [--place-order]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const OPS = JSON.parse(fs.readFileSync(path.join(root, 'test/contract/dropin-operations.json'), 'utf8'));
const endpoint = args.endpoint;
if (!endpoint) throw new Error('--endpoint is required');
const PAGING = { pageSize: 100, currentPage: 1, itemsSortInput: { field: 'CREATED_AT', order: 'DESC' } };

async function op(name, variables = {}, method = 'POST') {
  const t = Date.now();
  const body = { query: OPS[name], variables, operationName: undefined };
  const res = method === 'GET'
    ? await fetch(`${endpoint}?${new URLSearchParams({ query: body.query, variables: JSON.stringify(variables) })}`)
    : await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Store: 'default' }, body: JSON.stringify(body) });
  const json = await res.json();
  const ms = Date.now() - t;
  if (json.errors) {
    console.log(`✕ ${name} (${ms} ms)`, JSON.stringify(json.errors).slice(0, 400));
    process.exitCode = 1;
    return null;
  }
  console.log(`✓ ${name} (${ms} ms) cache=${res.headers.get('cache-control')}`);
  return json.data;
}

const search = await op('storefront-product-discovery/productSearch', { phrase: 'waterproof jacket', pageSize: 6, filter: [{ attribute: 'visibility', in: ['Search', 'Catalog, Search'] }] }, 'GET');
console.log('  top hits:', search?.productSearch.items.map((i) => i.productView.sku).join(', '));
const sku = search.productSearch.items.find((i) => i.productView.__typename === 'ComplexProductView').productView.sku;
const pdp = await op('storefront-pdp/GET_PRODUCT_DATA', { skus: [sku] }, 'GET');
const view = pdp.products[0];
const ids = view.options.map((o) => o.values.find((v) => v.inStock)?.id).filter(Boolean);
const refined = await op('storefront-pdp/REFINE_PRODUCT_QUERY', { sku, optionIds: ids });
console.log('  refined to', refined?.refineProduct.sku, refined?.refineProduct.price?.final.amount);
await op('storefront-recommendations/GetRecommendationsByUnitIds', { unitIds: ['wknd-pdp-complete-kit'], currentSku: sku });
await op('storefront-cart/STORE_CONFIG_QUERY', {}, 'GET');
const cartId = (await op('storefront-cart/CREATE_GUEST_CART_MUTATION')).createGuestCart.cart.id;
const added = await op('storefront-cart/ADD_PRODUCTS_TO_CART_MUTATION', { cartId, ...PAGING, cartItems: [{ sku, quantity: 1, selected_options: ids }] });
console.log('  cart total', added?.addProductsToCart.cart.prices.grand_total);
if (args['place-order']) {
  const address = {
    firstname: 'Smoke', lastname: 'Test', street: ['1 Test St'], city: 'Sydney', region_id: 2, postcode: '2000', country_code: 'AU', telephone: '0400000000',
  };
  await op('storefront-checkout/setGuestEmail', { cartId, email: 'smoke-test@example.com' });
  await op('storefront-checkout/setShippingAddressOnCartAndUseAsBilling', { cartId, shippingAddress: { address } });
  await op('storefront-checkout/setShippingMethodsOnCart', { cartId, shippingMethods: [{ carrier_code: 'wknd', method_code: 'standard' }] });
  await op('storefront-checkout/setPaymentMethodOnCart', { cartId, input: { code: 'wknd_demo_pay' } });
  const placed = await op('storefront-order/PLACE_ORDER_MUTATION', { cartId });
  console.log('  order', placed?.placeOrder.orderV2?.number, placed?.placeOrder.orderV2?.total.grand_total);
}
