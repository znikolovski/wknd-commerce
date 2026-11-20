const { createMemoryStore } = require('../lib/store');
const { resetCatalogCache } = require('../lib/catalog');
const reads = require('../lib/mcp-reads');
const { changeSale } = require('../lib/mcp-sales');

let store;
let context;

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  context = {
    actor: { kind: 'integration', subject: 'cx-coworker', orgId: 'test-org' },
    correlationId: 'test-correlation',
    logger: { error: jest.fn(), warn: jest.fn() },
    prerender: jest.fn().mockResolvedValue({ activationId: 'render-job' }),
  };
  await store.collection('categories').insertMany([
    { id: '1', name: 'Gear', urlPath: 'gear', private: 'do-not-project' },
    { id: '2', name: 'Other', urlPath: 'gearbox' },
  ]);
  await store.collection('products').insertMany([
    { sku: 'GEAR-ONE', name: 'One', categories: ['gear/boots'], tags: [], status: 'enabled', type: 'simple', internal: 'do-not-project' },
    { sku: 'GEAR-TWO', name: 'Two', categories: ['gearbox'], status: 'enabled', type: 'simple' },
  ]);
  await store.collection('prices').insertMany([
    { sku: 'GEAR-ONE', regular: 100, currency: 'AUD' },
    { sku: 'GEAR-TWO', regular: 50, currency: 'AUD' },
  ]);
});

test('read projections and category boundaries are explicit', async () => {
  const list = await reads.listProducts(store, { category: 'gear' });
  expect(list.total).toBe(1);
  expect(list.items[0].sku).toBe('GEAR-ONE');
  expect(JSON.stringify(await reads.getProduct(store, { sku: 'GEAR-ONE' }))).not.toContain('do-not-project');
  expect(JSON.stringify(await reads.listCategories(store, {}))).not.toContain('do-not-project');
});

test('orders never expose customer, address, payment, cart, token or internal fields', async () => {
  await store.collection('orders').insertOne({
    number: 'WKND-DEMO-261120-ABC123', status: 'Processing (demo)', createdAt: '2026-11-20T00:00:00.000Z',
    email: 'private-email', customerSub: 'private-customer', token: 'private-token', cartId: 'private-cart',
    shippingAddress: { street: 'private-address' }, billingAddress: 'private-billing', payment: { reference: 'private-payment' },
    items: [{ sku: 'GEAR-ONE', quantity: 2, price: 90, privateNote: 'private-note' }],
    totals: { grandTotal: 180, discountTotal: 20, secret: 'private-total' },
  });
  const result = await reads.getOrder(store, { number: 'WKND-DEMO-261120-ABC123' });
  expect(result.itemCount).toBe(2);
  expect(result.totals.grandTotal).toBe(180);
  expect(JSON.stringify(result)).not.toContain('private-');
  expect(JSON.stringify(await reads.listOrders(store, {}))).not.toContain('private-');
});

test('sale changes touch only special fields and invalidate/render exact parents once', async () => {
  const result = await changeSale(store, { selection: { category: 'gear' }, percent: 25 }, context);
  expect(result).toMatchObject({ ok: true, committed: true, affected: ['GEAR-ONE'], warnings: [] });
  expect(await store.collection('prices').findOne({ sku: 'GEAR-ONE' })).toMatchObject({ regular: 100, special: 75 });
  expect(await store.collection('prices').findOne({ sku: 'GEAR-TWO' })).not.toHaveProperty('special');
  expect(await store.collection('counters').findOne({ key: 'catalog_version' })).toMatchObject({ value: 1 });
  expect(context.prerender).toHaveBeenCalledTimes(1);
  expect(context.prerender).toHaveBeenCalledWith(['GEAR-ONE']);
  expect(await store.collection('events').find({ type: 'mcp.sale-price' })).toHaveLength(1);
  await changeSale(store, { sku: 'GEAR-ONE', clear: true }, context);
  expect(await store.collection('prices').findOne({ sku: 'GEAR-ONE' })).toEqual({ sku: 'GEAR-ONE', regular: 100, currency: 'AUD' });
});

test('configured parents expand all variant price records', async () => {
  await store.collection('products').insertOne({
    sku: 'CFG-ONE', type: 'configurable', categories: ['gear'], variants: [{ sku: 'CFG-ONE-S' }, { sku: 'CFG-ONE-L' }],
  });
  await store.collection('prices').insertMany(['CFG-ONE', 'CFG-ONE-S', 'CFG-ONE-L'].map((sku) => ({ sku, regular: 99.95, currency: 'AUD' })));
  const result = await changeSale(store, { sku: 'CFG-ONE', amountMinor: 8000 }, context);
  expect(result.items).toHaveLength(3);
  expect(result.affected).toEqual(['CFG-ONE']);
  const prices = await store.collection('prices').find({ sku: { $in: result.items.map((i) => i.sku) } });
  expect(prices.every((p) => p.regular === 99.95 && p.special === 80)).toBe(true);
});

test('all prices validated before the first write', async () => {
  await expect(changeSale(store, { selection: { skus: ['GEAR-ONE', 'GEAR-TWO'] }, amountMinor: 7500 }, context))
    .rejects.toMatchObject({ code: 'INVALID_SALE_PRICE' });
  expect(await store.collection('prices').findOne({ sku: 'GEAR-ONE' })).not.toHaveProperty('special');
  expect(context.prerender).not.toHaveBeenCalled();
});

test('invalid catalog SKUs reject before any sale write', async () => {
  await store.collection('products').insertOne({ sku: 'invalid_sku', categories: ['gear'], type: 'simple' });
  await expect(changeSale(store, { selection: { category: 'gear' }, percent: 10 }, context))
    .rejects.toMatchObject({ code: 'INVALID_CATALOG_SKU' });
  expect(await store.collection('prices').findOne({ sku: 'GEAR-ONE' })).not.toHaveProperty('special');
  expect(context.prerender).not.toHaveBeenCalled();
});

test('100-parent scope is accepted and 101 parents reject before writing', async () => {
  const skus = Array.from({ length: 99 }, (_, i) => `TEST-${String(i).padStart(3, '0')}`);
  await store.collection('products').insertMany(skus.map((sku) => ({ sku, categories: ['gear'], type: 'simple' })));
  await store.collection('prices').insertMany(skus.map((sku) => ({ sku, regular: 100, currency: 'AUD' })));
  expect((await changeSale(store, { selection: { category: 'gear' }, percent: 10 }, context)).items).toHaveLength(100);
  await store.collection('products').insertOne({ sku: 'TEST-EXTRA', categories: ['gear'], type: 'simple' });
  await expect(changeSale(store, { selection: { category: 'gear' }, percent: 20 }, context))
    .rejects.toMatchObject({ code: 'SELECTION_TOO_LARGE' });
  expect(context.prerender).toHaveBeenCalledTimes(1);
});

test('1000-price scope fits output budget and 1001 records reject before writing', async () => {
  const variants = Array.from({ length: 999 }, (_, i) => ({ sku: `CFG-${String(i).padStart(4, '0')}` }));
  await store.collection('products').insertOne({ sku: 'CFG-MAX', categories: ['gear'], type: 'configurable', variants });
  await store.collection('prices').insertMany([{ sku: 'CFG-MAX' }, ...variants].map(({ sku }) => ({ sku, regular: 100, currency: 'AUD' })));
  const result = await changeSale(store, { sku: 'CFG-MAX', percent: 10 }, context);
  expect(result.items).toHaveLength(1000);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1048576);
  await store.collection('products').updateOne({ sku: 'CFG-MAX' }, { $set: { variants: [...variants, { sku: 'CFG-EXTRA' }] } });
  await expect(changeSale(store, { sku: 'CFG-MAX', percent: 20 }, context))
    .rejects.toMatchObject({ code: 'SELECTION_TOO_LARGE' });
  expect(context.prerender).toHaveBeenCalledTimes(1);
});

test('database exceptions report unknown/partial persistence and stop, without blind retry', async () => {
  const prices = store.collection('prices');
  const update = prices.updateOne.bind(prices);
  jest.spyOn(prices, 'updateOne').mockImplementation(async (filter, patch) => {
    const result = await update(filter, patch);
    if (filter.sku === 'GEAR-TWO') throw new Error('sensitive database diagnostics');
    return result;
  });
  const result = await changeSale(store, { selection: { skus: ['GEAR-ONE', 'GEAR-TWO'] }, percent: 10 }, context);
  expect(result).toMatchObject({ ok: false, committed: null, error: { code: 'SALE_OUTCOME_UNKNOWN', retryable: false } });
  expect(result.items.map((i) => i.status)).toEqual(['updated', 'unknown']);
  expect(JSON.stringify(result)).not.toContain('sensitive');
  expect(prices.updateOne).toHaveBeenCalledTimes(2);
  expect(context.prerender).toHaveBeenCalledWith(['GEAR-ONE', 'GEAR-TWO']);
  expect(context.logger.error).toHaveBeenCalled();
});

test('conditional price conflict reports known noncommit and leaves prices alone', async () => {
  jest.spyOn(store.collection('prices'), 'updateOne').mockResolvedValue({ matchedCount: 0 });
  const result = await changeSale(store, { sku: 'GEAR-ONE', amountMinor: 7000 }, context);
  expect(result).toMatchObject({ ok: false, committed: false, items: [{ sku: 'GEAR-ONE', status: 'conflict' }] });
  expect(context.prerender).not.toHaveBeenCalled();
});

test('postcommit catalog, render and audit failures remain committed with explicit warnings', async () => {
  jest.spyOn(store.collection('counters'), 'updateOne').mockRejectedValue(new Error('private-error'));
  jest.spyOn(store.collection('events'), 'insertOne').mockRejectedValue(new Error('private-error'));
  context.prerender.mockRejectedValue(new Error('private-error'));
  const result = await changeSale(store, { sku: 'GEAR-ONE', amountMinor: 7000 }, context);
  expect(result).toMatchObject({ ok: true, committed: true });
  expect(result.warnings.map((w) => w.code)).toEqual(['CATALOG_INVALIDATION_FAILED', 'PRERENDER_FAILED', 'SALE_AUDIT_FAILED']);
  expect(JSON.stringify(result)).not.toContain('private-error');
  expect(context.logger.error).toHaveBeenCalledTimes(3);
});
