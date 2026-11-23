/**
 * Order placement (WKND Demo Pay — no payment is ever taken) and Core `CustomerOrder` mapping.
 */
const crypto = require('node:crypto');
const {
  money, round, gstPortion, PAYMENT_METHOD, GST_RATE, getCountries,
} = require('./config');
const {
  CartError, computeTotals, saveCart,
} = require('./cart');
const {
  toCoreProduct, imagesFor, b64, bumpCatalogVersion, productInStock,
} = require('./catalog');
const { recordSale } = require('./recommendations');
const { staticRuntime } = require('./promotions');

const ORDER_STATUS = 'Processing (demo)';

function orderNumber() {
  const d = new Date();
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `WKND-DEMO-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function validateForOrder(cat, cart) {
  if (!cart.items.length) throw new CartError('Unable to place order: A server error stopped your order from being placed. Please try to place your order again', 'UNABLE_TO_PLACE_ORDER');
  if (!cart.email) throw new CartError('Guest email for cart is missing.', 'GUEST_EMAIL_MISSING');
  if (!cart.shippingAddress) throw new CartError('Some addresses can\'t be used due to the configurations for specific countries.', 'UNABLE_TO_PLACE_ORDER');
  if (!cart.shippingMethod) throw new CartError('The shipping method is missing. Select the shipping method and try again.', 'UNABLE_TO_PLACE_ORDER');
  if (!cart.billingAddress) throw new CartError('Please check the billing address information.', 'UNABLE_TO_PLACE_ORDER');
  if (cart.paymentMethod !== PAYMENT_METHOD.code) throw new CartError('The payment method you requested is not available.', 'UNABLE_TO_PLACE_ORDER');
}

/** Decrement stock with conditional updates; roll back on the first failure. */
async function reserveStock(store, items) {
  const inventory = store.collection('inventory');
  const done = [];
  for (let i = 0; i < items.length; i += 1) {
    const { sku, quantity } = items[i];
    // eslint-disable-next-line no-await-in-loop
    const res = await inventory.updateOne({ sku, qty: { $gte: quantity } }, { $inc: { qty: -quantity } });
    if (!res || (res.matchedCount ?? res.modifiedCount ?? 0) === 0) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(done.map((d) => inventory.updateOne({ sku: d.sku }, { $inc: { qty: d.quantity } })));
      throw new CartError(`Not all of your products are available in the requested quantity (${sku}).`, 'INSUFFICIENT_STOCK');
    }
    done.push({ sku, quantity });
  }
}

/**
 * A delegated (ChatGPT) order carries the reviewed lines and total in its signed assertion; the
 * cart being ordered must match them exactly.
 */
function assertReviewed(totals, expected) {
  if (!expected) return;
  const key = (items) => JSON.stringify([...items].sort(([a], [b]) => (a < b ? -1 : 1)));
  const actual = totals.lines.map((l) => [l.item.sku, l.item.quantity]);
  const items = Array.isArray(expected.items) ? expected.items : null;
  if (!items || key(items) !== key(actual)
    || Math.abs(Number(expected.grand_total) - totals.grandTotal) > 0.005) {
    throw new CartError('Your cart changed after you reviewed it. Review the cart and try again.', 'UNABLE_TO_PLACE_ORDER');
  }
}

/**
 * Places an order. Both order mutation paths (placeOrder, setPaymentMethodAndPlaceOrder) call
 * this with the per-request promotion runtime, so the stored coupon/automatic promotion is
 * revalidated and totals recomputed before the cart claim, inventory and reviewed-total guards.
 */
async function placeOrder(store, cat, cart, customer, runtime = staticRuntime()) {
  validateForOrder(cat, cart);
  const totals = computeTotals(cat, cart, runtime);
  if (totals.promotion.error) throw new CartError(totals.promotion.error.message, 'UNABLE_TO_PLACE_ORDER');
  const unavailable = totals.lines.find((l) => (cat.stockBySku.get(l.item.sku)?.qty ?? 0) < l.item.quantity);
  if (unavailable) throw new CartError(`Not all of your products are available in the requested quantity (${unavailable.item.sku}).`, 'INSUFFICIENT_STOCK');
  assertReviewed(totals, customer?.orderExpect);

  // Claim exactly the cart state validated above (status + revision): concurrent or replayed
  // placements (website tab + ChatGPT, retries) and edits racing the order cannot slip through.
  const carts = store.collection('carts');
  const claim = await carts.updateOne(
    { id: cart.id, status: 'active', revision: cart.revision ?? { $exists: false } },
    { $set: { status: 'ordering' } },
  );
  if (!claim || (claim.matchedCount ?? claim.modifiedCount ?? 0) === 0) {
    const latest = await carts.findOne({ id: cart.id });
    if (latest?.status === 'active') {
      throw new CartError('Your cart changed while the order was being placed. Review the cart and try again.', 'UNABLE_TO_PLACE_ORDER');
    }
    throw new CartError('The cart isn\'t active.', 'CART_NOT_ACTIVE');
  }
  const reopen = () => carts.updateOne({ id: cart.id, status: 'ordering' }, { $set: { status: 'active' } }).catch(() => {});

  // Protected recovery: one redemption per verified shopper per stable campaign, reserved with a
  // unique key before stock so a second cart/path cannot also redeem it.
  const selected = totals.promotion.selected;
  let redemption = null;
  if (selected?.managementClass === 'protected-recovery') {
    try {
      if (!runtime.recovery || !customer?.sub) throw Object.assign(new Error('Coupon is not available for this shopper.'), { code: 'COUPON_SHOPPER_INELIGIBLE' });
      redemption = await runtime.recovery.reserveRedemption({ customer, promotion: selected, cartId: cart.id });
    } catch (e) {
      await reopen();
      throw new CartError(e.message, 'UNABLE_TO_PLACE_ORDER');
    }
  }
  try {
    await reserveStock(store, cart.items.map((i) => ({ sku: i.sku, quantity: i.quantity })));
  } catch (e) {
    // No order exists yet, so releasing the reservation cannot lose a redemption.
    if (redemption) await redemption.release().catch(() => {});
    await reopen();
    throw e;
  }

  const createdAt = new Date().toISOString();
  const order = {
    id: b64(`order/${crypto.randomUUID()}`),
    number: orderNumber(),
    token: crypto.randomBytes(24).toString('base64url'),
    customerSub: customer?.sub || null,
    email: cart.email,
    status: ORDER_STATUS,
    demo: true,
    createdAt,
    cartId: cart.id,
    items: totals.lines.map((l) => {
      const hit = cat.byVariantSku.get(l.item.sku);
      const parent = hit?.parent || cat.bySku.get(l.item.parentSku);
      return {
        id: b64(`order-item/${crypto.randomUUID()}`),
        sku: l.item.sku,
        parentSku: parent?.sku || l.item.parentSku,
        name: parent?.name || l.item.sku,
        urlKey: parent?.urlKey || null,
        quantity: l.item.quantity,
        price: l.final,
        regularPrice: l.regular,
        rowTotal: l.rowIncl,
        discount: l.discount,
        image: imagesFor(cat, l.item.sku, parent?.sku)[0]?.url || null,
        options: hit ? (hit.parent.options || []).map((o) => ({
          label: o.title, value: o.values.find((v) => v.id === hit.variant.selections[o.id])?.title || '',
        })) : [],
      };
    }),
    shippingAddress: cart.shippingAddress,
    billingAddress: cart.billingAddress,
    shippingMethod: totals.shippingMethod
      ? { ...cart.shippingMethod, title: `${totals.shippingMethod.carrier_title} - ${totals.shippingMethod.method_title}`, amount: totals.shipping }
      : null,
    payment: { code: PAYMENT_METHOD.code, title: 'WKND Demo Pay (demo — no charge)', reference: `DEMO-${crypto.randomBytes(4).toString('hex').toUpperCase()}` },
    coupons: cart.coupons || [],
    promotion: selected ? {
      id: selected.id, revision: selected.revision, code: selected.code, managementClass: selected.managementClass || 'standard',
    } : null,
    totals: {
      subtotalIncl: totals.subtotalIncl,
      subtotalExcl: totals.subtotalExcl,
      discountTotal: totals.discountTotal,
      discounts: totals.discounts.map((d) => ({ label: d.label, amount: d.amount.value })),
      shipping: totals.shipping,
      grandTotal: totals.grandTotal,
      grandTotalExcl: totals.grandTotalExcl,
      tax: totals.tax,
    },
  };
  // If the order insert outcome is unknown the redemption stays reserved (no blind release).
  await store.collection('orders').insertOne(order);
  if (redemption) await redemption.confirm(order.number).catch(() => {});
  if (runtime.onOrderRecorded) {
    try { await runtime.onOrderRecorded(); } catch {
      console.warn('Stage cart fact handoff unavailable after recorded order');
    }
  }
  await saveCart(store, { ...cart, status: 'ordered', orderNumber: order.number }, { from: 'ordering' });
  await recordSale(store, order.items.map((i) => i.parentSku));
  await bumpCatalogVersion(store);
  return order;
}

/**
 * Parent SKUs an order sells out (in stock before, no sellable SKU left after), so their
 * server-rendered PDPs (stock line, JSON-LD availability) can be re-rendered.
 * @param {object} cat catalog snapshot from before the order
 * @param {Array<{ sku: string, quantity: number }>} items
 */
function soldOutBy(cat, items) {
  const sold = new Map();
  items.forEach((i) => sold.set(i.sku, (sold.get(i.sku) || 0) + i.quantity));
  const after = new Map(cat.stockBySku);
  sold.forEach((qty, sku) => {
    const s = after.get(sku);
    if (s) after.set(sku, { ...s, qty: s.qty - qty });
  });
  const parents = new Set([...sold.keys()]
    .map((sku) => cat.bySku.get(sku) || cat.byVariantSku.get(sku)?.parent).filter(Boolean));
  const afterCat = { ...cat, stockBySku: after };
  return [...parents].filter((p) => productInStock(cat, p) && !productInStock(afterCat, p)).map((p) => p.sku);
}

function orderAddress(addr) {
  if (!addr) return null;
  return {
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
    region: addr.region_label,
    region_id: addr.region_id ? String(addr.region_id) : null,
    country_code: addr.country_code,
    custom_attributesV2: [],
  };
}

function orderItemShape(cat, order, item) {
  const hit = cat.byVariantSku.get(item.sku);
  const parent = hit?.parent || cat.bySku.get(item.parentSku);
  const product = parent ? toCoreProduct(cat, parent, hit?.variant) : null;
  return {
    __typename: hit ? 'ConfigurableOrderItem' : 'OrderItem',
    id: item.id,
    status: 'Ordered',
    product_sku: item.sku,
    product_name: item.name,
    product_url_key: item.urlKey,
    product_type: hit ? 'configurable' : 'simple',
    parent_sku: item.parentSku,
    quantity_ordered: item.quantity,
    quantity_shipped: 0,
    quantity_canceled: 0,
    quantity_invoiced: item.quantity,
    quantity_refunded: 0,
    quantity_returned: 0,
    quantity_return_requested: 0,
    eligible_for_return: false,
    free_gift_label: null,
    gift_message: null,
    gift_wrapping: null,
    product_sale_price: money(item.price),
    selected_options: item.options,
    entered_options: [],
    discounts: item.discount ? [{ amount: money(item.discount), label: 'Discount' }] : [],
    prices: {
      price: money(item.price),
      price_including_tax: money(item.price),
      original_price: money(item.regularPrice),
      original_price_including_tax: money(item.regularPrice),
      row_total: money(item.rowTotal - gstPortion(item.rowTotal)),
      row_total_including_tax: money(item.rowTotal),
      total_item_discount: money(item.discount || 0),
      discounts: [],
      fixed_product_taxes: [],
    },
    product: product || {
      __typename: 'SimpleProduct', uid: b64(`product/${item.sku}`), sku: item.sku, name: item.name, url_key: item.urlKey, canonical_url: null, stock_status: 'OUT_OF_STOCK', thumbnail: { url: item.image || '', label: item.name }, price_range: null, gift_wrapping_available: false, gift_wrapping_price: money(0), only_x_left_in_stock: null,
    },
  };
}

function orderShape(cat, order) {
  const t = order.totals;
  const items = order.items.map((i) => orderItemShape(cat, order, i));
  const shippingTax = gstPortion(t.shipping);
  return {
    id: order.id,
    number: order.number,
    order_number: order.number,
    increment_id: order.number,
    email: order.email,
    order_date: order.createdAt.replace('T', ' ').slice(0, 19),
    created_at: order.createdAt,
    order_status_change_date: order.createdAt.slice(0, 10),
    status: order.status,
    state: 'processing',
    token: order.token,
    carrier: order.shippingMethod ? 'WKND Shipping' : null,
    shipping_method: order.shippingMethod?.title || null,
    is_virtual: false,
    // the order drop-in shows "placed by an administrator" for any non-null value
    admin_assisted_order: null,
    available_actions: [],
    comments: [{ message: 'Demo order — no payment was taken and nothing will ship.', timestamp: order.createdAt }],
    payment_methods: [{ name: order.payment.title, type: order.payment.code, additional_data: [{ name: 'reference', value: order.payment.reference }] }],
    applied_coupons: order.coupons.map((code) => ({ code })),
    applied_gift_cards: [],
    gift_message: null,
    gift_wrapping: null,
    gift_receipt_included: false,
    printed_card_included: false,
    shipping_address: orderAddress(order.shippingAddress),
    billing_address: orderAddress(order.billingAddress),
    items,
    items_eligible_for_return: [],
    shipments: [],
    invoices: [],
    credit_memos: [],
    returns: { items: [], page_info: { current_page: 1, page_size: 0, total_pages: 0 }, total_count: 0 },
    customer_info: {
      firstname: order.billingAddress?.firstname, lastname: order.billingAddress?.lastname, email: order.email,
    },
    total: {
      grand_total: money(t.grandTotal),
      grand_total_excl_tax: money(t.grandTotalExcl),
      base_grand_total: money(t.grandTotal),
      subtotal: money(t.subtotalIncl),
      subtotal_incl_tax: money(t.subtotalIncl),
      subtotal_excl_tax: money(t.subtotalExcl),
      total_tax: money(t.tax),
      taxes: t.tax ? [{ amount: money(t.tax), rate: GST_RATE * 100, title: 'GST (incl.)' }] : [],
      total_shipping: money(t.shipping),
      shipping_handling: {
        amount_including_tax: money(t.shipping),
        amount_excluding_tax: money(t.shipping - shippingTax),
        total_amount: money(t.shipping),
        taxes: shippingTax ? [{ amount: money(shippingTax), rate: GST_RATE * 100, title: 'GST (incl.)' }] : [],
        discounts: [],
      },
      discounts: t.discounts.map((d) => ({ amount: money(d.amount), label: d.label })),
      total_giftcard: money(0),
      gift_options: {
        gift_wrapping_for_items: money(0),
        gift_wrapping_for_items_incl_tax: money(0),
        gift_wrapping_for_order: money(0),
        gift_wrapping_for_order_incl_tax: money(0),
        printed_card: money(0),
        printed_card_incl_tax: money(0),
      },
    },
    country: getCountries().find((c) => c.id === order.shippingAddress?.country_code)?.full_name_english,
    demo: true,
  };
}

async function customerOrders(store, cat, customer, {
  pageSize = 10, currentPage = 1, filter = {}, sort,
} = {}) {
  const all = await store.collection('orders').find({ customerSub: customer.sub }, { sort: { createdAt: sort?.sort_direction === 'ASC' ? 1 : -1 } });
  const number = filter?.number?.eq || filter?.number?.match;
  const filtered = number ? all.filter((o) => o.number.includes(number)) : all;
  const size = Math.max(1, pageSize);
  const page = Math.max(1, currentPage);
  return {
    items: filtered.slice((page - 1) * size, page * size).map((o) => orderShape(cat, o)),
    total_count: filtered.length,
    page_info: { current_page: page, page_size: size, total_pages: Math.max(1, Math.ceil(filtered.length / size)) },
    date_of_first_order: all.length ? all[all.length - 1].createdAt : null,
  };
}

async function findGuestOrder(store, { number, email, lastname }) {
  const order = await store.collection('orders').findOne({ number });
  if (!order || String(order.email).toLowerCase() !== String(email || '').toLowerCase()
    || String(order.billingAddress?.lastname || '').toLowerCase() !== String(lastname || '').toLowerCase()) {
    throw new CartError('Please make sure the information you entered is correct.', 'UNDEFINED', 'graphql-no-such-entity');
  }
  return order;
}

/**
 * Guest order by its token. The order drop-in treats any orderRef longer than 20 characters as a
 * guest token, so signed-in customers' order numbers (WKND-DEMO-…, 23 chars) arrive here too:
 * a customer may open their own order by number.
 * @param {{ sub?: string } | null} [customer] signed-in customer
 */
async function findOrderByToken(store, token, customer = null) {
  const orders = store.collection('orders');
  let order = token ? await orders.findOne({ token }) : null;
  if (!order && token && customer?.sub) {
    order = await orders.findOne({ number: token, customerSub: customer.sub });
  }
  if (!order) throw new CartError('We couldn\'t locate an order with the information provided.', 'UNDEFINED', 'graphql-no-such-entity');
  return order;
}

module.exports = {
  placeOrder, orderShape, customerOrders, findGuestOrder, findOrderByToken, ORDER_STATUS, round, soldOutBy,
};
