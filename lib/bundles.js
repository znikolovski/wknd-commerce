const crypto = require('node:crypto');
const { loadCatalog, priceFor } = require('./catalog');

const QUOTE_MS = 15 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const TARGET_KEYS = ['kind', 'bundleId', 'experimentId', 'currency', 'quoteExpiresAt', 'safetyBuffer', 'components'];
const COMPONENT_KEYS = ['sku', 'quantity', 'unitPriceMinor'];
class BundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BundleError';
    this.status = 400;
  }
}
const exactDate = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const bundleId = (components) => `bnd_${crypto.createHash('sha256').update(JSON.stringify(
  components.map(({ sku, quantity }) => [sku, quantity]).sort((a, b) => a[0].localeCompare(b[0])),
)).digest('hex').slice(0, 32)}`;

function validateBundle(raw, path, fields) {
  const bad = (p, code = 'INVALID_FORMAT') => fields.push({ path: p, code, message: 'Invalid bundle component or quote.' });
  Object.keys(raw).forEach((k) => { if (!TARGET_KEYS.includes(k)) bad(`${path}/${k}`, 'UNKNOWN_FIELD'); });
  if (!/^bnd_[a-f0-9]{32}$/.test(raw.bundleId || '')) bad(`${path}/bundleId`);
  if (raw.experimentId !== null && (typeof raw.experimentId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(raw.experimentId))) bad(`${path}/experimentId`);
  if (raw.currency !== 'AUD') bad(`${path}/currency`);
  if (!exactDate(raw.quoteExpiresAt)) bad(`${path}/quoteExpiresAt`);
  if (!Number.isInteger(raw.safetyBuffer) || raw.safetyBuffer < 0 || raw.safetyBuffer > 20) bad(`${path}/safetyBuffer`);
  if (!Array.isArray(raw.components) || raw.components.length < 2 || raw.components.length > 5) {
    bad(`${path}/components`);
    return raw;
  }
  raw.components.forEach((c, i) => {
    const p = `${path}/components/${i}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) { bad(p); return; }
    Object.keys(c).forEach((k) => { if (!COMPONENT_KEYS.includes(k)) bad(`${p}/${k}`, 'UNKNOWN_FIELD'); });
    if (typeof c.sku !== 'string' || !/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(c.sku)) bad(`${p}/sku`);
    if (!Number.isInteger(c.quantity) || c.quantity < 1 || c.quantity > 20) bad(`${p}/quantity`);
    if (!Number.isSafeInteger(c.unitPriceMinor) || c.unitPriceMinor < 1 || c.unitPriceMinor > 100000000) bad(`${p}/unitPriceMinor`);
  });
  if (new Set(raw.components.map((c) => c?.sku)).size !== raw.components.length) bad(`${path}/components`, 'DUPLICATE');
  if (!fields.length && bundleId(raw.components) !== raw.bundleId) bad(`${path}/bundleId`);
  return { ...raw, components: [...raw.components].sort((a, b) => String(a?.sku).localeCompare(String(b?.sku))) };
}

function quoteFields(cat, target, nowMs) {
  const fields = [];
  if (!exactDate(target.quoteExpiresAt) || Date.parse(target.quoteExpiresAt) <= nowMs
    || Date.parse(target.quoteExpiresAt) > nowMs + QUOTE_MS) {
    fields.push({ path: '/promotion/target/quoteExpiresAt', code: 'INVALID_FORMAT', message: 'Refresh the expired or unsupported bundle quote.' });
  }

  target.components.forEach((c, i) => {
    const hit = cat.byVariantSku.get(c.sku);
    const parent = hit?.parent || cat.bySku.get(c.sku);
    if (!parent || (!hit && parent.type !== 'simple')
      || hit?.variant.status === 'disabled' || !cat.priceBySku.has(c.sku)
      || Math.round(priceFor(cat, c.sku, parent.sku).final * 100) !== c.unitPriceMinor
      || (cat.priceBySku.get(c.sku)?.currency && cat.priceBySku.get(c.sku).currency !== target.currency)
      || (cat.stockBySku.get(c.sku)?.qty ?? 0) < c.quantity + target.safetyBuffer) {
      fields.push({ path: `/promotion/target/components/${i}`, code: 'UNKNOWN_REFERENCE', message: 'Refresh current exact-variant price and availability.' });
    }
  });
  return fields;
}

/** Approval fixes exact kit quantities, prices and discount terms, not its proposal timestamp. */
function freshBundleTarget(cat, target, nowMs) {
  const refreshed = { ...target, quoteExpiresAt: new Date(nowMs + QUOTE_MS).toISOString() };
  if (target.currency !== 'AUD' || target.components.some((c) => !Number.isSafeInteger(c.unitPriceMinor) || c.unitPriceMinor < 1)
    || quoteFields(cat, refreshed, nowMs).length) return null;
  return refreshed;
}

function readArguments(args, nowMs) {
  const allowed = ['startsAt', 'endsAt', 'limit', 'orderLimit', 'safetyBuffer', 'category'];
  const v = {
    startsAt: new Date(nowMs - 30 * DAY).toISOString(), endsAt: new Date(nowMs).toISOString(),
    limit: 5, orderLimit: 500, safetyBuffer: 2, ...args,
  };
  if (Object.keys(args).some((k) => !allowed.includes(k))
    || !exactDate(v.startsAt) || !exactDate(v.endsAt) || Date.parse(v.endsAt) > nowMs
    || Date.parse(v.endsAt) < Date.parse(v.startsAt) || Date.parse(v.endsAt) - Date.parse(v.startsAt) > 90 * DAY
    || !Number.isInteger(v.limit) || v.limit < 1 || v.limit > 10
    || !Number.isInteger(v.orderLimit) || v.orderLimit < 1 || v.orderLimit > 500
    || !Number.isInteger(v.safetyBuffer) || v.safetyBuffer < 0 || v.safetyBuffer > 20
    || (v.category !== undefined && (typeof v.category !== 'string' || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(v.category) || v.category.length > 120))) {
    throw new BundleError('Invalid bounded bundle evidence window or limits.');
  }
  return v;
}

async function bundleOpportunities(store, args = {}, { clock = Date.now, catalog } = {}) {
  const nowMs = clock();
  const v = readArguments(args, nowMs);
  const cat = catalog ? await catalog() : await loadCatalog(store, { fresh: true });
  // Demo orders have completed placement, not verified fulfilment or real commercial trading.
  const filter = { createdAt: { $gte: v.startsAt, $lte: v.endsAt }, status: { $in: ['Processing (demo)', 'complete', 'completed'] } };
  const [orders, ordersMatched] = await Promise.all([
    store.collection('orders').find(filter, { sort: { createdAt: -1, number: 1 }, limit: v.orderLimit }),
    store.collection('orders').countDocuments(filter),
  ]);
  const units = new Map();
  const pairs = new Map();
  let unusableLines = 0;
  orders.forEach((order) => {
    const seen = new Set();
    (Array.isArray(order.items) ? order.items : []).slice(0, 1000).forEach((line) => {
      if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 100000
        || (!cat.byVariantSku.has(line.sku) && cat.bySku.get(line.sku)?.type !== 'simple')
        || (order.currency && order.currency !== 'AUD') || (line.currency && line.currency !== 'AUD')) {
        unusableLines += 1;
        return;
      }
      units.set(line.sku, (units.get(line.sku) || 0) + line.quantity);
      seen.add(line.sku);
    });
    const skus = [...seen].sort();
    skus.forEach((a, i) => skus.slice(i + 1).forEach((b) => {
      const key = `${a}|${b}`;
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }));
  });
  const products = cat.products.filter((p) => !v.category || (p.categories || []).some((c) => c === v.category || c.startsWith(`${v.category}/`)));
  const variants = products.map((p) => {
    const eligible = (p.type === 'simple' ? [p.sku] : (p.variants || []).map((x) => x.sku))
      .map((sku) => ({ sku, quantity: 1, unitPriceMinor: Math.round(priceFor(cat, sku, p.sku).final * 100), availableQuantity: cat.stockBySku.get(sku)?.qty ?? 0, unitsSold: units.get(sku) || 0 }))
      .filter((c) => c.unitPriceMinor > 0 && c.availableQuantity >= 1 + v.safetyBuffer
        && (!cat.priceBySku.get(c.sku)?.currency || cat.priceBySku.get(c.sku).currency === 'AUD'))
      .sort((a, b) => b.unitsSold - a.unitsSold || a.sku.localeCompare(b.sku));
    return { parent: p, component: eligible[0] };
  }).filter((p) => p.component);
  const opportunities = [];
  variants.forEach((a, i) => variants.slice(i + 1).forEach((b) => {
    // Different categories avoid proposing two substitute variants as a kit.
    if (a.parent.categories?.[0] === b.parent.categories?.[0]) return;
    const shared = (a.parent.tags || []).filter((tag) => tag !== 'general-outdoor' && (b.parent.tags || []).includes(tag)).sort();
    if (!shared.length) return;
    const components = [a.component, b.component].sort((x, y) => x.sku.localeCompare(y.sku));
    const observed = pairs.get(components.map((c) => c.sku).join('|')) || 0;
    const demand = components.reduce((sum, c) => sum + c.unitsSold, 0);
    opportunities.push({
      bundleId: bundleId(components), experimentId: null,
      name: `${a.parent.name} + ${b.parent.name}`, classification: observed ? 'observed-co-purchase' : 'thematic',
      compatibility: { kind: 'shared-catalog-tag', value: shared[0] },
      score: observed * 1000 + demand, coPurchaseOrders: observed,
      scoreExplanation: `${observed} observed co-purchase order(s), ${demand} component units in the bounded window; catalog tag ${shared[0]}. No margin or surplus inference.`,
      components, merchandiseMinor: components.reduce((sum, c) => sum + c.unitPriceMinor * c.quantity, 0),
      shippingIncluded: false, safetyBuffer: v.safetyBuffer, quoteExpiresAt: new Date(nowMs + QUOTE_MS).toISOString(),
      financiallyApproved: false,
      aero: { separatePurchase: true, atomicReservation: false, routeHint: null, adventureHint: shared[0],
        availability: null, currency: null, seatRules: null, baggageRules: null, quoteValidity: null,
        reason: 'Catalog adventure tag only, not a route/date match. No authoritative Aero quote; separate demo booking; Commerce cancellation unsupported.' },
    });
  }));
  const ranked = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    apiVersion: 'wknd.bundling/v1', asOf: new Date(nowMs).toISOString(), currency: 'AUD',
    window: { startsAt: v.startsAt, endsAt: v.endsAt },
    evidence: {
      provenance: 'Persisted WKND mock-Commerce demo order placements; not commercial trading, fulfilment completion or experimental uplift. Inventory is seeded demo stock.',
      orderLimit: v.orderLimit, ordersMatched, ordersScanned: orders.length, truncated: ordersMatched > orders.length,
      unusableLines, unitDemand: ranked(units).slice(0, 100).map(([sku, unitsSold]) => ({ sku, unitsSold })),
      coPurchase: ranked(pairs).slice(0, 100).map(([key, orders]) => ({ skus: key.split('|'), orders })),
      unitDemandTruncated: units.size > 100, coPurchaseTruncated: pairs.size > 100,
      missingMetrics: ['stockAge', 'replenishmentTarget', 'cogs', 'margin', 'surplus'],
      stockAge: null, replenishmentTarget: null, cogs: null, margin: null, surplus: null,
    },
    opportunities: opportunities.sort((a, b) => b.score - a.score || a.bundleId.localeCompare(b.bundleId)).slice(0, v.limit),
  };
}

module.exports = { bundleOpportunities, bundleId, validateBundle, quoteFields, freshBundleTarget, TARGET_KEYS, QUOTE_MS };
