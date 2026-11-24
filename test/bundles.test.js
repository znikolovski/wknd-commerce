const crypto = require('node:crypto');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { loadCatalog, resetCatalogCache } = require('../lib/catalog');
const { bundleOpportunities, bundleId, QUOTE_MS } = require('../lib/bundles');
const { createPromotionService, migrateLegacyPromotions, loadPromotionRuntime } = require('../lib/promotions');
const { createPromotionsAdmin } = require('../lib/promotions-admin');
const { evaluatePromotions } = require('../lib/promotion-evaluation');
const { createCart, computeTotals } = require('../lib/cart');
const { bundleOffers } = require('../lib/bundle-offers');
const { runGraphQL } = require('../lib/graphql-server');
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

test('enabled approval survives the proposal quote expiry by re-quoting fresh catalog facts, without changing stored approval or weakening stock/date checks', async () => {
  const promotion = {
    ...definition(), discount: { kind: 'percentage', basisPoints: 5000 },
    endsAt: new Date(NOW + 86400000).toISOString(),
  };
  const created = await service.createPromotion(ctx(), { idempotencyKey: crypto.randomUUID(), promotion });
  const enabled = await service.updatePromotion(ctx(), {
    id: created.promotion.id, expectedRevision: 1, idempotencyKey: crypto.randomUUID(),
    promotion: { ...promotion, enabled: true },
  });
  const expiredAt = NOW + QUOTE_MS + 1000;
  // Reproduces the original defect: evaluating the stored proposal directly loses the discount.
  expect(evaluatePromotions({
    promotions: [enabled.promotion], lines: opportunity.components.map(lineOf), nowMs: expiredAt,
  }).discountMinor).toBe(0);
  const cart = await createCart(store);
  await store.collection('carts').updateOne({ id: cart.id }, { $set: {
    items: opportunity.components.map((c, i) => ({
      uid: `L${i}`, sku: c.sku, quantity: c.quantity,
      parentSku: (cat.byVariantSku.get(c.sku)?.parent || cat.bySku.get(c.sku)).sku,
    })),
  } });
  const time = jest.spyOn(Date, 'now').mockReturnValue(expiredAt);
  try {
    const query = 'query($id:String!){cart(cart_id:$id){prices{discounts{label amount{value}}}}wkndBundleOffers(cart_id:$id){quote_expires_at}}';
    const read = () => runGraphQL({ query, variables: { id: cart.id } }, { store });
    expect((await read()).body.data.cart.prices.discounts[0].label).toBe(promotion.name);
    const saved = await store.collection('carts').findOne({ id: cart.id });
    const runtime = await loadPromotionRuntime(store, { cart: saved, clock: () => expiredAt });
    const selected = runtime.definitions.find((p) => p.id === enabled.promotion.id);
    expect(Date.parse(selected.target.quoteExpiresAt)).toBe(expiredAt + QUOTE_MS);
    expect((await store.collection('promotions').findOne({ id: selected.id })).target.quoteExpiresAt).toBe(opportunity.quoteExpiresAt);
    await store.collection('carts').updateOne({ id: cart.id }, { $set: { items: saved.items.slice(0, 1) } });
    expect((await read()).body.data.wkndBundleOffers[0].quote_expires_at).toBe(new Date(expiredAt + QUOTE_MS).toISOString());
    await store.collection('carts').updateOne({ id: cart.id }, { $set: { items: saved.items } });
    const component = opportunity.components[0];
    const price = cat.priceBySku.get(component.sku);
    await store.collection('prices').updateOne({ sku: component.sku }, { $set: { regular: price.regular + 10, special: null } });
    const repriced = await loadPromotionRuntime(store, { cart: saved, clock: () => expiredAt });
    expect(repriced.definitions.find((p) => p.id === selected.id).enabled).toBe(false);
    expect(computeTotals(repriced.catalogSnapshot, saved, repriced).discountTotal).toBe(0);
    expect((await read()).body.data.cart.prices.discounts).toEqual([]);
    await store.collection('prices').updateOne({ sku: component.sku }, { $set: price });
    await store.collection('inventory').updateOne({ sku: component.sku }, { $set: { qty: component.quantity + promotion.target.safetyBuffer - 1 } });
    expect((await read()).body.data.cart.prices.discounts).toEqual([]);
    await store.collection('inventory').updateOne({ sku: component.sku }, { $set: { qty: 100 } });
    time.mockReturnValue(NOW + 86400001);
    expect((await read()).body.data.cart.prices.discounts).toEqual([]);
  } finally {
    time.mockRestore();
  }
});

test('partial suggestions suppress full/no-overlap kits, invalid fresh facts, denied audiences, date/minimum failures and a better competing promotion', () => {
  const p = { ...definition(), id: 'approved', enabled: true };
  const component = opportunity.components[0];
  const parent = cat.byVariantSku.get(component.sku)?.parent || cat.bySku.get(component.sku);
  const cart = { items: [{ uid: 'A', sku: component.sku, parentSku: parent.sku, quantity: component.quantity }], coupons: [] };
  const runtime = { definitions: [p], nowMs: NOW, trust: () => ({ ok: true }), selection: 'best-saving' };
  expect(bundleOffers(cat, cart, runtime)).toHaveLength(1);
  expect(bundleOffers(cat, { items: [], coupons: [] }, runtime)).toEqual([]);
  for (const patch of [
    { enabled: false }, { startsAt: new Date(NOW + 1).toISOString() },
    { endsAt: new Date(NOW - 1).toISOString() }, { minimumMerchandiseMinor: 100000000 },
    { target: { ...p.target, quoteExpiresAt: new Date(NOW).toISOString() } },
    { target: { ...p.target, components: p.target.components.map((c) => ({ ...c, unitPriceMinor: c.unitPriceMinor + 1 })) } },
  ]) {
    expect(bundleOffers(cat, cart, { ...runtime, definitions: [{ ...p, ...patch }] })).toEqual([]);
  }
  expect(bundleOffers(cat, cart, { ...runtime, trust: () => ({ ok: false }) })).toEqual([]);
  const better = { ...p, id: 'better', target: { kind: 'all' }, discount: { kind: 'percentage', basisPoints: 5000 } };
  expect(bundleOffers(cat, cart, { ...runtime, definitions: [p, better] })).toEqual([]);
  const coupon = { ...better, mode: 'coupon', code: 'BETTER' };
  expect(bundleOffers(cat, { ...cart, coupons: ['BETTER'] }, { ...runtime, definitions: [p, coupon] })).toEqual([]);
});

test('GraphQL partial kit uses exact variant SKU/quantity-only additions and automatically discounts one complete kit without leaking private evidence', async () => {
  const time = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  try {
    const configurable = cat.products.find((p) => p.type === 'configurable');
    const simple = cat.products.find((p) => p.type === 'simple');
    const component = (sku, quantity) => ({
      sku, quantity, unitPriceMinor: Math.round(cat.priceBySku.get(sku).regular * 100),
    });
    const components = [component(configurable.variants[0].sku, 3), component(simple.sku, 2)];
    const promotion = {
      ...definition(), name: 'Approved exact variant completion',
      discount: { kind: 'percentage', basisPoints: 5000 },
      target: { ...targetOf(opportunity), bundleId: bundleId(components), components },
    };
    const created = await service.createPromotion(ctx(), { idempotencyKey: crypto.randomUUID(), promotion });
    expect(created.ok).toBe(true);
    const enabled = await service.updatePromotion(ctx(), {
      id: created.promotion.id, expectedRevision: 1, idempotencyKey: crypto.randomUUID(),
      promotion: { ...promotion, enabled: true },
    });
    expect(enabled.ok).toBe(true);
    const cart = await createCart(store, { customerSub: 'auth0|kit-owner' });
    await store.collection('carts').updateOne({ id: cart.id }, { $set: {
      items: [
        { uid: 'A', sku: components[0].sku, parentSku: configurable.sku, quantity: 1 },
        { uid: 'B', sku: components[0].sku, parentSku: configurable.sku, quantity: 1 },
      ],
    } });
    const query = `query($id:String!){wkndBundleOffers(cart_id:$id){
      promotion_id bundle_id name quote_expires_at saving{value currency}
      components{sku name required_quantity cart_quantity missing_quantity unit_price{value currency}}
    }}`;
    const deps = { store, params: {}, verify: async () => ({ sub: 'auth0|kit-owner' }) };
    const read = () => runGraphQL({ query, variables: { id: cart.id }, headers: { authorization: 'Bearer offline' } }, deps);
    const result = await read();
    expect(result.body.errors).toBeUndefined();
    expect(result.cacheable).toBe(false);
    const [offer] = result.body.data.wkndBundleOffers;
    expect(offer).toMatchObject({ promotion_id: enabled.promotion.id, saving: { currency: 'AUD' } });
    expect(offer.components.find((c) => c.sku === components[0].sku)).toMatchObject({ cart_quantity: 2, missing_quantity: 1, required_quantity: 3 });
    expect(JSON.stringify(offer)).not.toMatch(/private|lastResolved|affected|evidence|orgId/);
    expect((await store.collection('carts').findOne({ id: cart.id })).revision).toBeUndefined();
    const added = await runGraphQL({
      query: `mutation($id:String!,$items:[CartItemInput!]!){
        addProductsToCart(cartId:$id,cartItems:$items){user_errors{code message}
        cart{prices{discounts{label amount{value currency}}}}}}`,
      variables: { id: cart.id, items: offer.components.filter((c) => c.missing_quantity > 0)
        .map((c) => ({ sku: c.sku, quantity: c.missing_quantity })) },
      headers: { authorization: 'Bearer offline' },
    }, deps);
    expect(added.body.errors).toBeUndefined();
    expect(added.body.data.addProductsToCart.user_errors).toEqual([]);
    expect(added.body.data.addProductsToCart.cart.prices.discounts).toEqual([{
      label: promotion.name, amount: offer.saving,
    }]);
    const saved = await store.collection('carts').findOne({ id: cart.id });
    expect(saved.items.filter((i) => i.sku === components[0].sku).reduce((n, i) => n + i.quantity, 0)).toBe(3);
    expect(saved.items.find((i) => i.sku === components[1].sku).quantity).toBe(2);
    expect((await read()).body.data.wkndBundleOffers).toEqual([]);
    const denied = await runGraphQL({ query, variables: { id: cart.id } }, { store });
    expect(denied.body.errors[0].extensions.category).toBe('graphql-authorization');
  } finally {
    time.mockRestore();
  }
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
