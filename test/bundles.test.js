const crypto = require('node:crypto');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { loadCatalog, resetCatalogCache } = require('../lib/catalog');
const { bundleOpportunities, bundleId } = require('../lib/bundles');
const { createPromotionService, migrateLegacyPromotions } = require('../lib/promotions');
const { createPromotionsAdmin } = require('../lib/promotions-admin');
const { evaluatePromotions } = require('../lib/promotion-evaluation');
const CATALOG = require('../data/catalog.json');

const NOW = Date.parse('2026-11-23T00:00:00.000Z');
const clock = () => NOW;
const ctx = () => ({ actor: { kind: 'ims-operator', subject: 'operator', orgId: 'ORG@AdobeOrg' }, correlationId: crypto.randomUUID() });
let store;
let cat;
let opportunity;
let service;

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
  await migrateLegacyPromotions(store);
  cat = await loadCatalog(store, { fresh: true });
  service = createPromotionService({ store, clock, loadCatalog: async () => cat });
  [opportunity] = (await bundleOpportunities(store, {}, { clock, catalog: async () => cat })).opportunities;
});

const targetOf = (o) => ({
  kind: 'bundle', bundleId: o.bundleId, experimentId: null, currency: 'AUD',
  quoteExpiresAt: o.quoteExpiresAt, safetyBuffer: o.safetyBuffer,
  components: o.components.map(({ sku, quantity, unitPriceMinor }) => ({ sku, quantity, unitPriceMinor })),
});
const definition = () => ({
  name: 'Test disabled kit', enabled: false, mode: 'automatic', code: null,
  discount: { kind: 'percentage', basisPoints: 1000 }, maxDiscountMinor: null, minimumMerchandiseMinor: null,
  target: targetOf(opportunity), startsAt: null, endsAt: null, audienceRestriction: null,
});
const lineOf = (c, i) => ({
  id: `L${i}`, sku: c.sku, parentSku: 'PARENT', quantity: c.quantity, unitPriceMinor: c.unitPriceMinor,
  grossMinor: c.quantity * c.unitPriceMinor, currency: 'AUD', availableQuantity: 100, sellable: true,
});
const evaluate = (lines, extra = {}) => evaluatePromotions({
  nowMs: NOW, promotions: [{ ...definition(), id: 'bundle', enabled: true }], lines, ...extra,
});

test('bounded dated unit demand/co-purchase is aggregate-only, excludes malformed/non-AUD/out-of-window records and reports truncation', async () => {
  const [a, b] = opportunity.components;
  const order = (number, extra = {}) => ({
    number, status: 'Processing (demo)', demo: true, createdAt: new Date(NOW - 1000).toISOString(),
    email: 'do-not-return@example.com', customerSub: 'private-customer',
    items: [{ sku: a.sku, quantity: 2 }, { sku: b.sku, quantity: 3 }, { sku: a.sku, quantity: 1 }], ...extra,
  });
  await store.collection('orders').insertOne(order('one'));
  await store.collection('orders').insertOne(order('two', { currency: 'USD' }));
  await store.collection('orders').insertOne(order('outside', { createdAt: '2026-01-01T00:00:00.000Z' }));
  await store.collection('orders').insertOne(order('cancelled', { status: 'cancelled' }));
  const result = await bundleOpportunities(store, {}, { clock, catalog: async () => cat });
  expect(result.evidence).toMatchObject({
    ordersMatched: 2, ordersScanned: 2, truncated: false, unusableLines: 3,
    stockAge: null, margin: null, surplus: null,
    unitDemand: expect.arrayContaining([{ sku: a.sku, unitsSold: 3 }, { sku: b.sku, unitsSold: 3 }]),
    coPurchase: [{ skus: [a.sku, b.sku].sort(), orders: 1 }],
  });
  expect(JSON.stringify(result)).not.toMatch(/do-not-return|private-customer|customerSub|"number"/);
  const limited = await bundleOpportunities(store, { orderLimit: 1 }, { clock, catalog: async () => cat });
  expect(limited.evidence).toMatchObject({ ordersMatched: 2, ordersScanned: 1, truncated: true });
  await expect(bundleOpportunities(store, { startsAt: '2020-01-01T00:00:00.000Z' }, { clock })).rejects.toThrow(/Invalid/);
});

test('cold-start kits are thematic, buffered exact variants and never approved or atomic Aero reservations', () => {
  expect(opportunity).toMatchObject({
    classification: 'thematic', score: 0, financiallyApproved: false, shippingIncluded: false,
    aero: { separatePurchase: true, atomicReservation: false, routeHint: null, quoteValidity: null },
  });
  expect(opportunity.components.every((c) => c.availableQuantity >= c.quantity + opportunity.safetyBuffer)).toBe(true);
});

test('disabled create reuses standard receipts, full revision updates and admin request reconciliation', async () => {
  const idempotencyKey = crypto.randomUUID();
  const created = await service.createPromotion(ctx(), { idempotencyKey, promotion: definition() });
  expect(created).toMatchObject({ ok: true, committed: true, promotion: { enabled: false, target: targetOf(opportunity) } });
  const admin = createPromotionsAdmin({ store, clock, catalog: async () => cat });
  const lookedUp = await admin.handle(ctx().actor, 'promotions.get', { request: { operation: 'create', idempotencyKey } });
  expect(lookedUp).toMatchObject({ ok: true, committed: true, promotion: { id: created.promotion.id } });
  const update = { id: created.promotion.id, expectedRevision: created.promotion.revision, idempotencyKey: crypto.randomUUID(), promotion: { ...definition(), enabled: true } };
  expect(await service.updatePromotion(ctx(), update)).toMatchObject({ ok: true, promotion: { enabled: true } });
  expect(await service.updatePromotion(ctx(), { ...update, idempotencyKey: crypto.randomUUID() })).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
  const expired = { ...definition(), target: { ...targetOf(opportunity), quoteExpiresAt: new Date(NOW).toISOString() } };
  expect(await service.createPromotion(ctx(), { idempotencyKey: crypto.randomUUID(), promotion: expired })).toMatchObject({ ok: false, committed: false });
});

test('bundle proposals start disabled and only individual IMS approval can activate them', async () => {
  expect(await service.createPromotion(ctx(), {
    idempotencyKey: crypto.randomUUID(), promotion: { ...definition(), enabled: true },
  })).toMatchObject({ ok: false, committed: false, error: { code: 'VALIDATION_ERROR' } });
  const integration = { ...ctx(), actor: { kind: 'integration', subject: 'shared-key', orgId: 'ORG@AdobeOrg' } };
  const created = await service.createPromotion(integration, { idempotencyKey: crypto.randomUUID(), promotion: definition() });
  expect(created.ok).toBe(true);
  expect(await service.updatePromotion(integration, {
    id: created.promotion.id, expectedRevision: 1, idempotencyKey: crypto.randomUUID(),
    promotion: { ...definition(), enabled: true },
  })).toMatchObject({ ok: false, committed: false, error: { code: 'VALIDATION_ERROR' } });
});

test('all exact components required; only one kit quantity discounted, not excess or unrelated merchandise', () => {
  const lines = opportunity.components.map(lineOf);
  expect(evaluate(lines.slice(0, 1)).discountMinor).toBe(0);
  const extra = { ...lines[0], id: 'EXTRA', sku: 'OTHER-SKU', grossMinor: 50000, quantity: 1 };
  const doubled = lines.map((l) => ({ ...l, quantity: l.quantity * 2, grossMinor: l.grossMinor * 2 }));
  const result = evaluate([...doubled, extra]);
  expect(result.discountMinor).toBe(Math.floor(opportunity.merchandiseMinor / 10 + 0.5));
  expect(result.allocations.EXTRA).toBeUndefined();
  expect(Object.values(result.allocations).reduce((sum, n) => sum + n, 0)).toBe(result.discountMinor);
});

test.each(['quantity', 'price', 'currency', 'stock', 'expired', 'parent'])('fails closed on %s mismatch', (kind) => {
  const lines = opportunity.components.map(lineOf);
  const extra = {};
  if (kind === 'quantity') lines[0].quantity = 0;
  if (kind === 'price') lines[0].unitPriceMinor += 1;
  if (kind === 'currency') lines[0].currency = 'USD';
  if (kind === 'stock') lines[0].availableQuantity = lines[0].quantity;
  if (kind === 'expired') extra.nowMs = NOW + 15 * 60 * 1000;
  if (kind === 'parent') lines[0].sku = 'PARENT';
  expect(evaluate(lines, extra).discountMinor).toBe(0);
});

test('required quantity is honored and one best offer wins overlapping bundle benefits', () => {
  const d = definition();
  d.target.components[0].quantity = 2;
  d.target.bundleId = bundleId(d.target.components);
  const lines = opportunity.components.map(lineOf);
  expect(evaluate(lines, { promotions: [{ ...d, id: 'b', enabled: true }] }).discountMinor).toBe(0);
  lines[0].quantity = 2;
  lines[0].grossMinor *= 2;
  const larger = { ...d, id: 'other', enabled: true, discount: { kind: 'percentage', basisPoints: 2000 } };
  expect(evaluate(lines, { promotions: [{ ...d, id: 'b', enabled: true }, larger] }).selected.id).toBe('other');
});
