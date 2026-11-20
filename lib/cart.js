/**
 * Cart domain logic + mapping to the Core GraphQL `Cart` shape used by the cart/checkout drop-ins.
 * All amounts are calculated server-side from the catalog; client-supplied prices are never used.
 */
const crypto = require('node:crypto');
const {
  money, round, gstPortion, FREE_SHIPPING_THRESHOLD, SHIPPING_METHODS, PAYMENT_METHOD,
  findRegion, getCountries, GST_RATE,
} = require('./config');
const { evaluatePromotions, gstMinor } = require('./promotion-evaluation');
const { staticRuntime, toMinor } = require('./promotions');
const {
  priceFor, stockFor, resolveVariant, toCoreProduct, b64, optionUid,
} = require('./catalog');

class CartError extends Error {
  constructor(message, code = 'UNDEFINED', category = 'graphql-input') {
    super(message);
    this.code = code;
    this.extensions = { category };
  }
}

const maskedId = () => crypto.randomBytes(16).toString('hex');
const now = () => new Date().toISOString();

/* ---------------- persistence ---------------- */

async function createCart(store, { customerSub = null, id } = {}) {
  const cart = {
    id: id || maskedId(),
    customerSub,
    email: null,
    items: [],
    shippingAddress: null,
    shippingMethod: null,
    billingAddress: null,
    billingSameAsShipping: false,
    paymentMethod: null,
    coupons: [],
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
    activityAt: now(),
  };
  await store.collection('carts').insertOne(cart);
  return cart;
}

/**
 * Saves an existing cart only while it still has the status it was loaded with (default active),
 * so a write racing an order placement can never reopen a claimed ('ordering') cart.
 */
async function saveCart(store, cart, { from = 'active' } = {}) {
  const next = { ...cart, revision: (cart.revision || 0) + 1, updatedAt: now() };
  const res = await store.collection('carts').replaceOne({ id: cart.id, status: from }, next);
  if (!res || (res.matchedCount ?? res.modifiedCount ?? 0) === 0) {
    throw new CartError('The cart isn\'t active.', 'CART_NOT_ACTIVE', 'graphql-no-such-entity');
  }
  return next;
}

async function loadCart(store, cartId, customer, { allowInactive = false } = {}) {
  if (!cartId) throw new CartError('Required parameter "cart_id" is missing', 'UNDEFINED');
  const cart = await store.collection('carts').findOne({ id: cartId });
  if (!cart) throw new CartError(`Could not find a cart with ID "${cartId}"`, 'CART_NOT_FOUND', 'graphql-no-such-entity');
  if (cart.customerSub && cart.customerSub !== customer?.sub) {
    throw new CartError(`The current user cannot perform operations on cart "${cartId}"`, 'UNAUTHORIZED', 'graphql-authorization');
  }
  if (!allowInactive && cart.status !== 'active') {
    throw new CartError(`The cart isn't active.`, 'CART_NOT_ACTIVE', 'graphql-no-such-entity');
  }
  return cart;
}

async function getCustomerCart(store, customer) {
  const existing = await store.collection('carts').find(
    { customerSub: customer.sub, status: 'active' },
    { sort: { updatedAt: -1 }, limit: 1 },
  );
  return existing[0] || createCart(store, { customerSub: customer.sub });
}

/* ---------------- items ---------------- */

function lineQuantityForSku(cart, sku) {
  return cart.items.filter((i) => i.sku === sku).reduce((n, i) => n + i.quantity, 0);
}

function addItem(cat, cart, input) {
  const quantity = Number(input.quantity ?? 1);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { error: { code: 'INVALID_PARAMETER_VALUE', message: 'The quantity must be greater than 0.' } };
  }
  const resolved = resolveVariant(cat, input.sku, input.selected_options || []);
  if (!resolved) {
    return { error: { code: 'PRODUCT_NOT_FOUND', message: `Could not find a product with SKU "${input.sku}"` } };
  }
  if (resolved.incomplete) {
    return { error: { code: 'REQUIRED_PARAMETER_MISSING', message: 'You need to choose options for your item.' } };
  }
  const { parent, variant } = resolved;
  const sku = variant ? variant.sku : parent.sku;
  const stock = stockFor(cat, sku);
  const wanted = lineQuantityForSku(cart, sku) + quantity;
  if (!stock.inStock) {
    return { error: { code: 'NOT_SALABLE', message: 'Product that you are trying to add is not available.' } };
  }
  if (wanted > stock.qty) {
    return { error: { code: 'INSUFFICIENT_STOCK', message: `The requested qty is not available. Only ${stock.qty} left.` } };
  }
  const existing = cart.items.find((i) => i.sku === sku);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({
      uid: b64(`cart-item/${crypto.randomUUID()}`),
      sku,
      parentSku: parent.sku,
      quantity,
      createdAt: now(),
    });
  }
  // Meaningful shopper activity drives the recovery inactivity clock (not generic updatedAt).
  cart.activityAt = now();
  return { ok: true };
}

function updateItems(cat, cart, updates = []) {
  const errors = [];
  if (updates.length) cart.activityAt = now();
  updates.forEach((u) => {
    const uid = u.cart_item_uid || (u.cart_item_id != null ? String(u.cart_item_id) : null);
    const item = cart.items.find((i) => i.uid === uid);
    if (!item) {
      errors.push({ code: 'COULD_NOT_FIND_CART_ITEM', message: `Could not find cart item with id: ${uid}` });
      return;
    }
    const qty = Number(u.quantity);
    if (qty <= 0) {
      cart.items = cart.items.filter((i) => i.uid !== uid);
      return;
    }
    const stock = stockFor(cat, item.sku);
    if (qty > stock.qty) {
      errors.push({ code: 'INSUFFICIENT_STOCK', message: `The requested qty is not available. Only ${stock.qty} left.` });
      item.quantity = Math.max(1, stock.qty);
      return;
    }
    item.quantity = qty;
  });
  return errors;
}

function removeItem(cart, uid) {
  const before = cart.items.length;
  cart.items = cart.items.filter((i) => i.uid !== uid);
  if (before === cart.items.length) throw new CartError(`The cart doesn't contain the item`, 'COULD_NOT_FIND_CART_ITEM', 'graphql-no-such-entity');
  cart.activityAt = now();
}

function mergeInto(cat, source, destination) {
  source.items.forEach((item) => {
    const stock = stockFor(cat, item.sku);
    const existing = destination.items.find((i) => i.sku === item.sku);
    if (existing) existing.quantity = Math.min(stock.qty || existing.quantity, existing.quantity + item.quantity);
    else destination.items.push({ ...item });
  });
  // One cart promotion: the destination's explicit coupon wins, otherwise the source's.
  destination.coupons = (destination.coupons?.length ? destination.coupons : source.coupons || []).slice(0, 1);
  if (!destination.email && source.email) destination.email = source.email;
  if (source.items.length) destination.activityAt = now();
  return destination;
}

/* ---------------- addresses / shipping / payment ---------------- */

function normalizeAddress(address = {}) {
  const country = (address.country_code || address.country_id || 'AU').toUpperCase();
  const region = findRegion(country, {
    regionId: address.region_id, regionCode: address.region_code, region: address.region,
  });
  return {
    firstname: address.firstname || '',
    lastname: address.lastname || '',
    company: address.company || null,
    street: (address.street || []).filter((s) => s != null),
    city: address.city || '',
    postcode: address.postcode || '',
    telephone: address.telephone || '',
    country_code: country,
    region_code: region.code,
    region_label: region.label,
    region_id: region.region_id,
    vat_id: address.vat_id || null,
    customer_address_uid: address.customer_address_uid || null,
  };
}

function addressFromCustomer(customer, uid) {
  const addr = (customer?.addresses || []).find((a) => a.uid === uid || String(a.id) === String(uid));
  if (!addr) throw new CartError('Could not find a address with ID', 'UNDEFINED', 'graphql-no-such-entity');
  return normalizeAddress({
    ...addr, region_id: addr.region?.region_id, region_code: addr.region?.region_code, customer_address_uid: addr.uid,
  });
}

const isDomestic = (countryCode) => (countryCode || 'AU') === 'AU';

function subtotalIncl(cat, cart) {
  return round(cart.items.reduce((sum, i) => sum + priceFor(cat, i.sku, i.parentSku).final * i.quantity, 0));
}

function availableShippingMethods(cat, cart, countryCode) {
  const domestic = isDomestic(countryCode);
  const subtotal = subtotalIncl(cat, cart);
  return SHIPPING_METHODS.filter((m) => m.domestic === domestic).map((m) => {
    const price = m.method_code === 'standard' && subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : m.price;
    return {
      carrier_code: m.carrier_code,
      carrier_title: m.carrier_title,
      method_code: m.method_code,
      method_title: price === 0 && m.price > 0 ? `${m.method_title} — free over $${FREE_SHIPPING_THRESHOLD}` : m.method_title,
      amount: money(price),
      base_amount: money(price),
      price_incl_tax: money(price),
      price_excl_tax: money(price - gstPortion(price)),
      available: cart.items.length > 0,
      error_message: '',
    };
  });
}

function selectedShipping(cat, cart) {
  if (!cart.shippingMethod || !cart.shippingAddress) return null;
  return availableShippingMethods(cat, cart, cart.shippingAddress.country_code)
    .find((m) => m.carrier_code === cart.shippingMethod.carrier_code
      && m.method_code === cart.shippingMethod.method_code) || null;
}

function evaluationLines(cat, lines) {
  return lines.map((l) => {
    const hit = cat.byVariantSku.get(l.item.sku);
    const parent = hit?.parent || cat.bySku.get(l.item.parentSku) || cat.bySku.get(l.item.sku);
    return {
      id: l.item.uid,
      sku: l.item.sku,
      parentSku: parent?.sku || l.item.parentSku,
      categories: parent?.categories || [],
      grossMinor: toMinor(l.final) * l.item.quantity,
    };
  });
}

function priceLines(cat, cart) {
  return cart.items.map((item) => {
    const { regular, final } = priceFor(cat, item.sku, item.parentSku);
    return {
      item, regular, final, rowIncl: round(final * item.quantity), rowRegular: round(regular * item.quantity),
    };
  });
}

function evaluateCart(cat, cart, runtime, explicitCode) {
  return evaluatePromotions({
    promotions: runtime.definitions,
    lines: evaluationLines(cat, priceLines(cat, cart)),
    explicitCode,
    nowMs: runtime.nowMs,
    trust: runtime.trust,
  });
}

/**
 * Validates an explicit coupon with the shared promotion engine before storing it. A rejected
 * code is never saved. At most one cart promotion (the first requested code).
 */
function applyCoupons(cart, codes = [], cat = null, runtime = staticRuntime()) {
  const requested = codes.map((c) => String(c).trim()).filter(Boolean);
  if (!requested.length) {
    cart.coupons = [];
    return;
  }
  const result = cat
    ? evaluateCart(cat, cart, runtime, requested[0])
    : evaluatePromotions({ promotions: runtime.definitions, lines: [], explicitCode: requested[0], nowMs: runtime.nowMs });
  if (result.error && (cat || result.error.code === 'COUPON_NOT_FOUND')) {
    throw new CartError(result.error.message, result.error.code);
  }
  cart.coupons = [result.coupon?.code || requested[0].toUpperCase()];
}

/* ---------------- totals ---------------- */

/**
 * Server-side totals. Sale prices first, then at most one cart promotion from the shared engine
 * (eligible explicit coupon, otherwise best automatic). Integer cents for promotion/GST maths.
 */
function computeTotals(cat, cart, runtime = staticRuntime()) {
  const lines = priceLines(cat, cart);
  const evaluation = evaluatePromotions({
    promotions: runtime.definitions,
    lines: evaluationLines(cat, lines),
    explicitCode: cart.coupons?.[0] ?? null,
    nowMs: runtime.nowMs,
    trust: runtime.trust,
  });
  const subtotalMinor = evaluation.merchandiseMinor || lines.reduce((n, l) => n + toMinor(l.final) * l.item.quantity, 0);
  const subtotal = subtotalMinor / 100;
  const discountMinor = evaluation.error ? 0 : evaluation.discountMinor;
  const discountTotal = discountMinor / 100;
  const discounts = [];
  if (discountMinor > 0) {
    const p = evaluation.selected;
    discounts.push({
      amount: money(discountTotal),
      label: p.name,
      coupon: p.mode === 'coupon' ? { code: p.code } : null,
      applied_to: 'ITEM',
      is_discounting_locked: false,
      value: discountTotal,
    });
  }
  lines.forEach((l) => {
    l.discount = discountMinor ? (evaluation.allocations[l.item.uid] || 0) / 100 : 0;
  });
  const ship = selectedShipping(cat, cart);
  const shipping = ship ? ship.amount.value : 0;
  const grandMinor = subtotalMinor - discountMinor + toMinor(shipping);
  const grand = grandMinor / 100;
  const tax = gstMinor(grandMinor) / 100;
  return {
    lines,
    subtotalIncl: subtotal,
    subtotalExcl: round(subtotal - gstPortion(subtotal)),
    subtotalWithDiscountExcl: round(subtotal - discountTotal - gstPortion(subtotal - discountTotal)),
    discountTotal,
    discounts,
    shipping,
    shippingMethod: ship,
    grandTotal: grand,
    grandTotalExcl: round(grand - tax),
    tax,
    totalQuantity: cart.items.reduce((n, i) => n + i.quantity, 0),
    promotion: {
      selected: evaluation.selected,
      coupon: evaluation.coupon,
      error: evaluation.error,
    },
  };
}

/* ---------------- GraphQL mapping ---------------- */

const ZERO_GIFT_OPTIONS = () => ({
  gift_wrapping_for_items: money(0),
  gift_wrapping_for_items_incl_tax: money(0),
  gift_wrapping_for_order: money(0),
  gift_wrapping_for_order_incl_tax: money(0),
  printed_card: money(0),
  printed_card_incl_tax: money(0),
});

function cartItemShape(cat, line) {
  const { item } = line;
  const hit = cat.byVariantSku.get(item.sku);
  const parent = hit?.parent || cat.bySku.get(item.parentSku) || cat.bySku.get(item.sku);
  const stock = stockFor(cat, item.sku);
  const available = Boolean(parent) && stock.qty >= item.quantity;
  const priceExcl = round(line.final - gstPortion(line.final));
  const shape = {
    __typename: hit ? 'ConfigurableCartItem' : 'SimpleCartItem',
    uid: item.uid,
    id: item.uid,
    quantity: item.quantity,
    is_available: available,
    is_salable: stock.inStock,
    not_available_message: available ? null : `Only ${stock.qty} left in stock`,
    errors: available ? [] : [{ code: 'INSUFFICIENT_STOCK', message: `Only ${stock.qty} left in stock` }],
    is_free_gift: false,
    note_from_buyer: [],
    note_from_seller: [],
    customizable_options: [],
    available_gift_wrapping: [],
    gift_message: null,
    gift_wrapping: null,
    discount: line.discount ? [{ amount: money(line.discount), label: 'Discount' }] : [],
    prices: {
      price: money(priceExcl),
      price_including_tax: money(line.final),
      row_total: money(line.rowIncl - gstPortion(line.rowIncl)),
      row_total_including_tax: money(line.rowIncl),
      total_item_discount: money(line.discount),
      discounts: line.discount ? [{ amount: money(line.discount), label: 'Discount' }] : [],
      fixed_product_taxes: [],
      original_item_price: money(line.regular),
      original_row_total: money(line.rowRegular),
      catalog_discount: {
        amount_off: round(line.regular - line.final),
        percent_off: line.regular ? round(((line.regular - line.final) / line.regular) * 100) : 0,
      },
      row_catalog_discount: {
        amount_off: round(line.rowRegular - line.rowIncl),
        percent_off: line.regular ? round(((line.regular - line.final) / line.regular) * 100) : 0,
      },
      price_excl_tax: money(priceExcl),
    },
    product: parent ? toCoreProduct(cat, parent) : null,
  };
  if (hit) {
    shape.configurable_options = (hit.parent.options || []).map((o) => {
      const value = o.values.find((v) => v.id === hit.variant.selections[o.id]);
      return {
        id: 0,
        value_id: 0,
        configurable_product_option_uid: b64(`configurable/${o.id}`),
        configurable_product_option_value_uid: optionUid(o.id, value?.id),
        option_label: o.title,
        value_label: value?.title || '',
      };
    });
    shape.configured_variant = toCoreProduct(cat, hit.parent, hit.variant);
  }
  return shape;
}

function addressShape(addr, extra = {}) {
  if (!addr) return null;
  return {
    uid: b64(`address/${addr.country_code}/${addr.postcode}`),
    id: null,
    firstname: addr.firstname,
    lastname: addr.lastname,
    middlename: null,
    prefix: null,
    suffix: null,
    company: addr.company,
    street: addr.street,
    city: addr.city,
    postcode: addr.postcode,
    telephone: addr.telephone,
    fax: null,
    vat_id: addr.vat_id,
    region: { code: addr.region_code, label: addr.region_label, region_id: addr.region_id },
    country: {
      code: addr.country_code,
      label: getCountries().find((c) => c.id === addr.country_code)?.full_name_english || addr.country_code,
    },
    customer_address_uid: addr.customer_address_uid,
    customer_address_id: null,
    custom_attributes: [],
    custom_attributesV2: [],
    ...extra,
  };
}

function cartShape(cat, cart, runtime) {
  const totals = computeTotals(cat, cart, runtime);
  const items = totals.lines.map((l) => cartItemShape(cat, l));
  const country = cart.shippingAddress?.country_code;
  const shippingAddresses = cart.shippingAddress
    ? [addressShape(cart.shippingAddress, {
      same_as_billing: cart.billingSameAsShipping,
      available_shipping_methods: availableShippingMethods(cat, cart, country),
      selected_shipping_method: totals.shippingMethod ? {
        carrier_code: totals.shippingMethod.carrier_code,
        carrier_title: totals.shippingMethod.carrier_title,
        method_code: totals.shippingMethod.method_code,
        method_title: totals.shippingMethod.method_title,
        amount: totals.shippingMethod.amount,
        base_amount: totals.shippingMethod.amount,
        price_incl_tax: totals.shippingMethod.price_incl_tax,
        price_excl_tax: totals.shippingMethod.price_excl_tax,
      } : null,
      cart_items: [],
      cart_items_v2: [],
      items_weight: 0,
      pickup_location_code: null,
    })]
    : [];
  const payment = { code: PAYMENT_METHOD.code, title: PAYMENT_METHOD.title };
  return {
    id: cart.id,
    email: cart.email,
    is_virtual: false,
    total_quantity: totals.totalQuantity,
    items,
    itemsV2: {
      items,
      total_count: items.length,
      page_info: { current_page: 1, page_size: Math.max(items.length, 1), total_pages: 1 },
    },
    prices: {
      grand_total: money(totals.grandTotal),
      grand_total_excluding_tax: money(totals.grandTotalExcl),
      subtotal_including_tax: money(totals.subtotalIncl),
      subtotal_excluding_tax: money(totals.subtotalExcl),
      subtotal_with_discount_excluding_tax: money(totals.subtotalWithDiscountExcl),
      applied_taxes: totals.tax ? [{ label: `GST (${GST_RATE * 100}% incl.)`, amount: money(totals.tax) }] : [],
      discounts: totals.discounts,
      discount: totals.discountTotal ? { amount: money(totals.discountTotal), label: ['Discount'] } : null,
      gift_options: ZERO_GIFT_OPTIONS(),
    },
    applied_coupons: (cart.coupons || []).map((code) => ({ code })),
    applied_coupon: cart.coupons?.[0] ? { code: cart.coupons[0] } : null,
    applied_gift_cards: [],
    applied_reward_points: null,
    applied_store_credit: null,
    available_gift_wrappings: [],
    gift_message: null,
    gift_wrapping: null,
    gift_receipt_included: false,
    printed_card_included: false,
    has_available_free_gifts: false,
    shipping_addresses: shippingAddresses,
    billing_address: cart.billingAddress ? addressShape(cart.billingAddress) : null,
    available_payment_methods: cart.items.length ? [payment] : [],
    selected_payment_method: cart.paymentMethod
      ? { ...payment, purchase_order_number: null }
      : { code: '', title: '', purchase_order_number: null },
    rules: [],
  };
}

module.exports = {
  CartError,
  createCart,
  saveCart,
  loadCart,
  getCustomerCart,
  addItem,
  updateItems,
  removeItem,
  mergeInto,
  normalizeAddress,
  addressFromCustomer,
  availableShippingMethods,
  applyCoupons,
  computeTotals,
  cartShape,
  addressShape,
  isDomestic,
};
