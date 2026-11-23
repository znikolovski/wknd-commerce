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
const { normalizeCode } = require('./promotion-schema');
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

/** Opaque concurrency token for one cart state: changes on every cart write (saveCart). */
const cartVersion = (cart) => `v${cart.revision || 0}`;

/**
 * Fails with CART_CHANGED unless the caller reviewed exactly this cart state. Paired with
 * saveCart({ expectRevision }) the write then applies only to that reviewed state.
 */
function assertCartVersion(cart, expected) {
  if (typeof expected !== 'string' || expected !== cartVersion(cart)) {
    throw new CartError('Your cart changed since it was reviewed. Review the cart and try again.', 'CART_CHANGED');
  }
}

/**
 * Saves an existing cart only while it still has the status it was loaded with (default active),
 * so a write racing an order placement can never reopen a claimed ('ordering') cart.
 * The write also requires the exact revision that was loaded (the same guard placeOrder uses;
 * default on for every caller): a stale read can never overwrite a concurrent change or reset
 * the revision, so revisions (and wknd_cart_version) only ever increase. Raises CART_CHANGED.
 */
async function saveCart(store, cart, { from = 'active', expectRevision = true } = {}) {
  const next = { ...cart, revision: (cart.revision || 0) + 1, updatedAt: now() };
  const carts = store.collection('carts');
  const filter = { id: cart.id, status: from };
  if (expectRevision) filter.revision = cart.revision ?? { $exists: false };
  const res = await carts.replaceOne(filter, next);
  if (!res || (res.matchedCount ?? res.modifiedCount ?? 0) === 0) {
    if (expectRevision && (await carts.findOne({ id: cart.id }))?.status === from) {
      throw new CartError('Your cart changed while this was being updated. Review the cart and try again.', 'CART_CHANGED');
    }
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

const MERGE_ATTEMPTS = 3;
const markMerged = (id) => ({ status: 'merged', mergedInto: id });

/**
 * Claims a source cart for merging into `destinationId` with a revision compare-and-set, so the
 * merged snapshot is exactly the claimed state: a claimed ('merging') cart is inactive and no
 * other writer can change it afterwards. Returns null when there is nothing to merge.
 * Resumes this destination's own unfinished merge; reclaims a merge abandoned on a destination
 * that is no longer active and never received the source.
 */
async function claimMergeSource(store, { sourceId, destinationId, ownerSub }) {
  const carts = store.collection('carts');
  /* eslint-disable no-await-in-loop */
  for (let attempt = 1; attempt <= MERGE_ATTEMPTS; attempt += 1) {
    const src = await carts.findOne({ id: sourceId });
    if (!src || src.id === destinationId || (src.customerSub && src.customerSub !== ownerSub)) return null;
    let filter = null;
    if (src.status === 'active') {
      filter = { id: src.id, status: 'active', revision: src.revision ?? { $exists: false } };
    } else if (src.status === 'merging' && src.mergingInto === destinationId) {
      return src;
    } else if (src.status === 'merging') {
      const other = await carts.findOne({ id: src.mergingInto });
      if (other?.mergedSources?.includes(src.id)) {
        await carts.updateOne({ id: src.id, status: 'merging', mergeId: src.mergeId }, { $set: markMerged(other.id), $inc: { revision: 1 } });
        return null;
      }
      if (other?.status === 'active') return null; // another destination's merge is in flight
      filter = { id: src.id, status: 'merging', mergeId: src.mergeId };
    } else {
      return null;
    }
    const claim = { status: 'merging', mergingInto: destinationId, mergeId: maskedId() };
    const res = await carts.updateOne(filter, { $set: claim, $inc: { revision: 1 } });
    if ((res?.matchedCount ?? 0) === 1) return { ...src, ...claim, revision: (src.revision || 0) + 1 };
  }
  /* eslint-enable no-await-in-loop */
  throw new CartError('The cart changed while it was being merged. Try again.', 'CART_CHANGED');
}

/**
 * Merges a source cart into a destination exactly once (no multi-document transactions needed):
 * 1. claim the source (revision CAS; it becomes inactive and immutable),
 * 2. add the claimed snapshot to the destination once, recorded in `mergedSources` (revision CAS
 *    with bounded retry; a repeat finds the marker and adds nothing),
 * 3. retire the source (CAS on the claim).
 * Failures surface as errors and never reactivate a claimed source: after a failed or uncertain
 * step 2 or 3 the claim stays, and a repeated request completes it exactly once. A claim left on
 * a destination that is no longer active is reclaimed by the shopper's next cart.
 * @returns {Promise<object>} the destination cart after the merge
 */
async function mergeCarts(store, cat, { sourceId, destination, ownerSub }) {
  const carts = store.collection('carts');
  const src = await claimMergeSource(store, { sourceId, destinationId: destination.id, ownerSub });
  if (!src) return destination;
  // A failing or uncertain destination write (it may even have committed) keeps the claim: the
  // source is never reactivated while another resumer of the same claim could still commit its
  // snapshot. A repeated merge resumes idempotently via the destination's mergedSources marker.
  let saved = null;
  /* eslint-disable no-await-in-loop */
  for (let attempt = 1; !saved; attempt += 1) {
    const dest = await loadCart(store, destination.id, ownerSub ? { sub: ownerSub } : null);
    if (dest.mergedSources?.includes(src.id)) {
      saved = dest;
    } else {
      mergeInto(cat, src, dest);
      dest.mergedSources = [...(dest.mergedSources || []), src.id];
      try {
        saved = await saveCart(store, dest);
      } catch (e) {
        if (e.code !== 'CART_CHANGED' || attempt >= MERGE_ATTEMPTS) throw e;
      }
    }
  }
  /* eslint-enable no-await-in-loop */
  const retired = await carts.updateOne(
    { id: src.id, status: 'merging', mergeId: src.mergeId },
    { $set: markMerged(saved.id), $inc: { revision: 1 } },
  );
  if ((retired?.matchedCount ?? 0) !== 1) {
    const now2 = await carts.findOne({ id: src.id });
    if (!(now2?.status === 'merged' && now2.mergedInto === saved.id)) {
      throw new CartError('The cart changed while it was being merged. Try again.', 'CART_CHANGED');
    }
  }
  return saved;
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
      quantity: l.item.quantity,
      unitPriceMinor: toMinor(l.final),
      currency: cat.priceBySku.get(l.item.sku)?.currency || 'AUD',
      availableQuantity: cat.stockBySku.get(l.item.sku)?.qty ?? 0,
      sellable: Boolean(hit || parent?.type === 'simple'),
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
    selection: runtime.selection,
  });
}

/**
 * Savings (integer cents) of the cart's current promotion versus `code` replacing it, both from
 * the shared engine. `candidateTrust` decides only the candidate (e.g. a not-yet-claimed
 * recovery entitlement); it is an estimate for display and never grants the discount.
 */
function compareCoupon(cat, cart, runtime, code, candidateTrust) {
  const current = evaluateCart(cat, cart, runtime, cart.coupons?.[0] ?? null);
  const target = normalizeCode(String(code));
  const trust = (p) => (p.mode === 'coupon' && p.code === target && candidateTrust ? candidateTrust(p) : runtime.trust(p));
  const candidate = evaluateCart(cat, cart, { ...runtime, trust }, code);
  return {
    currentMinor: current.error ? 0 : current.discountMinor,
    candidateMinor: candidate.error ? 0 : candidate.discountMinor,
  };
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
    selection: runtime.selection,
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
      wknd_bundle_id: p.target.kind === 'bundle' ? p.target.bundleId : null,
      wknd_experiment_id: p.target.kind === 'bundle' ? p.target.experimentId : null,
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
    wknd_cart_version: cartVersion(cart),
    wknd_planner_offer: plannerOfferShape(cat, cart, runtime, totals),
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

function plannerOfferShape(cat, cart, runtime, totals) {
  const base = {
    kind: 'climbing_planner', status: 'UNAVAILABLE', coupon_code: null, percent_off: null,
    max_discount: null, saving: null, current_saving: null, expires_at: null,
    message: 'A climbing planner benefit is not currently available for this cart.',
  };
  if (!runtime?.planner) return base;
  const candidate = computeTotals(cat, { ...cart, coupons: [] }, {
    ...runtime, definitions: [runtime.planner],
  });
  if (candidate.discountTotal <= 0) return { ...base, message: 'Add selected climbing gear to see the planner benefit.' };
  const applied = totals.promotion.selected?.id === runtime.planner.id;
  return {
    ...base, status: applied ? 'CLAIMED' : 'ELIGIBLE', percent_off: 10,
    max_discount: money(25), saving: money(candidate.discountTotal), current_saving: money(totals.discountTotal),
    message: applied ? 'Your climbing planner gear benefit is included in the totals.'
      : 'Your current offer saves as much or more; the climbing planner benefit is available automatically.',
  };
}

module.exports = {
  CartError,
  createCart,
  saveCart,
  cartVersion,
  assertCartVersion,
  loadCart,
  getCustomerCart,
  addItem,
  updateItems,
  removeItem,
  mergeInto,
  mergeCarts,
  normalizeAddress,
  addressFromCustomer,
  availableShippingMethods,
  applyCoupons,
  compareCoupon,
  computeTotals,
  cartShape,
  addressShape,
  isDomestic,
};
