const { CartError, loadCart, cartVersion } = require('./cart');
const { canonicalJson, sha256 } = require('./promotion-schema');
const { ENVIRONMENTS } = require('./target-environment');

const FACT_SCHEMA = 'wknd.server-cart-facts/v1';
const CART_STATES = ['active', 'ordering', 'ordered', 'merging', 'merged'];
const ACTIVITY_FIELDS = ['activityAt', 'updatedAt', 'createdAt'];

class CartFactsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CartFactsError';
    this.code = code;
  }
}

function timestamp(value, nowMs) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms <= nowMs && new Date(ms).toISOString() === value ? value : null;
}

function cartFacts(cart, nowMs) {
  if (!CART_STATES.includes(cart.status) || !Array.isArray(cart.items)
    || (cart.revision !== undefined && (!Number.isSafeInteger(cart.revision) || cart.revision < 0))
    || cart.items.some((item) => !Number.isFinite(item?.quantity) || item.quantity <= 0)) {
    throw new CartFactsError('INVALID_CART_RECORD', 'Server cart facts could not be read.');
  }
  const totalQuantity = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  if (totalQuantity > Number.MAX_SAFE_INTEGER) {
    throw new CartFactsError('INVALID_CART_RECORD', 'Server cart quantity is out of range.');
  }
  // Match the recovery policy's fallback order, without evaluating its inactivity window.
  const activitySource = ACTIVITY_FIELDS.find((field) => cart[field]) || null;
  return {
    state: cart.status,
    version: cartVersion(cart),
    lastActivityAt: activitySource ? timestamp(cart[activitySource], nowMs) : null,
    activitySource,
    itemCount: cart.items.length,
    totalQuantity,
  };
}

function purchaseFacts(orders, cart, nowMs) {
  if (!Array.isArray(orders)) {
    throw new CartFactsError('INVALID_ORDER_READ', 'Server order facts could not be read.');
  }
  const dated = orders.map((order) => ({
    at: timestamp(order?.createdAt, nowMs),
    state: order?.status === 'Processing (demo)' ? 'processing-demo' : 'unknown',
  }));
  const unknownRecord = dated.some((order) => !order.at || order.state === 'unknown');
  const newest = dated.filter((order) => order.at).sort((a, b) => b.at.localeCompare(a.at))[0];
  const recordedSince = cart.lastActivityAt
    && dated.some((order) => order.at && order.at >= cart.lastActivityAt);
  let sinceLastActivity = 'unknown';
  let reason = 'ACTIVITY_UNKNOWN';
  if (recordedSince) {
    sinceLastActivity = 'recorded';
    reason = null;
  } else if (cart.lastActivityAt) {
    if (unknownRecord) reason = 'ORDER_RECORD_UNKNOWN';
    else if (cart.state !== 'active') reason = 'CART_NOT_ACTIVE';
    else {
      sinceLastActivity = 'not-recorded';
      reason = null;
    }
  }
  return {
    sinceLastActivity,
    reason,
    lastOrderAt: unknownRecord ? null : newest?.at || null,
    orderState: unknownRecord ? 'unknown' : newest?.state || (cart.state === 'active' ? 'none' : 'unknown'),
  };
}

/**
 * Server-only adapter. `claims` must already be Auth0-verified; environment, store and publisher
 * are dependencies, never request fields. No endpoint, identity issuance or eligibility logic.
 * publisher(packet) must resolve exactly true to acknowledge handoff, not AAM qualification.
 */
function createServerCartFacts({
  store, claims, environment, publisher = null, clock = Date.now,
} = {}) {
  const sub = claims?.sub;
  if (typeof sub !== 'string' || !sub.trim()) {
    throw new CartFactsError('SIGN_IN_REQUIRED', 'Verified shopper claims are required.');
  }
  if (!ENVIRONMENTS.includes(environment) || typeof store?.collection !== 'function'
    || typeof clock !== 'function' || (publisher !== null && typeof publisher !== 'function')) {
    throw new CartFactsError('NOT_CONFIGURED', 'Server cart facts dependencies are not configured.');
  }

  async function ownedCart(cartId) {
    let cart;
    try {
      cart = await loadCart(store, cartId, { sub }, { allowInactive: true });
    } catch (e) {
      if (!(e instanceof CartError)) throw e;
      throw new CartFactsError('CART_UNAVAILABLE', 'An owned server cart is required.');
    }
    if (cart.customerSub !== sub) {
      throw new CartFactsError('CART_UNAVAILABLE', 'An owned server cart is required.');
    }
    return cart;
  }

  async function read(cartId) {
    if (typeof cartId !== 'string' || !cartId.trim()) {
      throw new CartFactsError('INVALID_INPUT', 'A server cart reference is required.');
    }
    const cart = await ownedCart(cartId);
    const nowMs = clock();
    if (!Number.isSafeInteger(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
      throw new CartFactsError('INVALID_CLOCK', 'Server observation time is invalid.');
    }
    const facts = cartFacts(cart, nowMs);
    // Unbounded by count: a truncated order list cannot prove absence since this episode.
    const orders = await store.collection('orders').find({ customerSub: sub });
    const current = cartFacts(await ownedCart(cartId), nowMs);
    if (canonicalJson(current) !== canonicalJson(facts)) {
      throw new CartFactsError('CART_CHANGED', 'Server cart changed during the fact read.');
    }
    return Object.freeze({
      schema: FACT_SCHEMA,
      source: 'server-records',
      environment,
      observedAt: new Date(nowMs).toISOString(),
      cart: Object.freeze(facts),
      purchase: Object.freeze(purchaseFacts(orders, facts, nowMs)),
      episode: Object.freeze({
        key: facts.lastActivityAt ? `cep_${sha256(canonicalJson([
          FACT_SCHEMA, environment, cart.id, facts.lastActivityAt,
        ]))}` : null,
        startedAt: facts.lastActivityAt,
      }),
    });
  }

  return {
    read,
    async handoff(cartId) {
      if (!publisher) {
        throw new CartFactsError('PUBLISHER_NOT_CONFIGURED', 'A server-owned fact publisher is required.');
      }
      const packet = await read(cartId);
      if (await publisher(packet) !== true) {
        throw new CartFactsError('HANDOFF_NOT_ACKNOWLEDGED', 'The fact publisher did not acknowledge handoff.');
      }
      return packet;
    },
  };
}

module.exports = { FACT_SCHEMA, CartFactsError, createServerCartFacts };
