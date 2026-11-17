const fs = require('node:fs');
const path = require('node:path');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { resetCatalogCache } = require('../lib/catalog');
const admin = require('../lib/admin');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
let store;

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
});

test('stats and listings', async () => {
  const stats = await admin.stats(store);
  expect(stats.products).toBe(CATALOG.products.length);
  expect(stats.sellableSkus).toBe(CATALOG.inventory.length);
  const list = await admin.listProducts(store, { q: 'jacket', pageSize: 5 });
  expect(list.items.length).toBeGreaterThan(0);
  expect(list.items[0]).toMatchObject({ sku: expect.any(String), minPrice: expect.any(Number) });
  const inv = await admin.listInventory(store, { lowStockOnly: true });
  expect(inv.items.every((i) => i.qty <= i.lowStockThreshold)).toBe(true);
});

test('create configurable product initialises variant price and stock', async () => {
  const res = await admin.saveProduct(store, {
    sku: 'wknd-tst-001',
    name: 'Test Hut Booties',
    categories: ['apparel/socks'],
    price: 59,
    options: [{ id: 'size', title: 'Size', values: [{ id: 's', title: 'S' }, { id: 'l', title: 'L' }] }],
    variants: [{ sku: 'WKND-TST-001-S', selections: { size: 's' } }, { sku: 'WKND-TST-001-L', selections: { size: 'l' } }],
  }, { create: true });
  expect(res).toMatchObject({ created: true, affected: ['WKND-TST-001'] });
  expect(res.product.urlKey).toBe('test-hut-booties');
  const detail = await admin.getProduct(store, 'WKND-TST-001');
  expect(detail.inventory.map((i) => i.qty)).toEqual([0, 0]);
  expect(detail.prices.find((p) => p.sku === 'WKND-TST-001-L').regular).toBe(59);
  await expect(admin.saveProduct(store, { sku: 'WKND-TST-001', name: 'x', categories: ['apparel/socks'] }, { create: true }))
    .rejects.toThrow(/already exists/);
});

test('validation rejects bad input', async () => {
  await expect(admin.saveProduct(store, { sku: 'x', name: 'a', categories: ['apparel'] })).rejects.toThrow(/sku/);
  await expect(admin.saveProduct(store, { sku: 'WKND-OK-1', name: '', categories: ['apparel'] })).rejects.toThrow(/name/);
  await expect(admin.saveProduct(store, { sku: 'WKND-OK-1', name: 'Ok', categories: ['nope'] })).rejects.toThrow(/category/);
  await expect(admin.updatePrices(store, [{ sku: 'WKND-JKT-001', regular: 100, special: 120 }])).rejects.toThrow(/must not exceed/);
  await expect(admin.updateInventory(store, [{ sku: 'WKND-HYD-002', qty: -1 }])).rejects.toThrow(/≥ 0/);
});

test('inventory, pricing and bulk sale report affected parent SKUs', async () => {
  const variant = CATALOG.products.find((p) => p.sku === 'WKND-JKT-001').variants[0].sku;
  const inv = await admin.updateInventory(store, [{ sku: variant, qty: 42 }]);
  expect(inv.affected).toEqual(['WKND-JKT-001']);
  const bulk = await admin.bulkPrice(store, { category: 'accessories/lighting', percent: 25 });
  expect(bulk.affected.length).toBe(CATALOG.products.filter((p) => p.categories[0] === 'accessories/lighting').length);
  const lamp = await admin.getProduct(store, 'WKND-LGT-001');
  const price = lamp.prices.find((p) => p.sku === 'WKND-LGT-001');
  expect(price.special).toBeCloseTo(price.regular * 0.75, 2);
  await admin.bulkPrice(store, { category: 'accessories/lighting', clear: true });
  expect((await admin.getProduct(store, 'WKND-LGT-001')).prices[0].special).toBeUndefined();
});

test('disable and delete', async () => {
  await admin.setStatus(store, 'WKND-PCK-001', 'disabled');
  expect((await admin.listProducts(store, { status: 'disabled' })).items.map((p) => p.sku)).toEqual(['WKND-PCK-001']);
  const res = await admin.deleteProduct(store, 'WKND-PCK-001');
  expect(res.removed.urlKey).toBeTruthy();
  await expect(admin.getProduct(store, 'WKND-PCK-001')).rejects.toThrow(/not found/);
});

test('recommendations accept currentProduct and dated view history', async () => {
  const { loadCatalog } = require('../lib/catalog');
  const recs = require('../lib/recommendations');
  const cat = await loadCatalog(store);
  const res = await recs.recommendationsByUnitIds(cat, store, {
    unitIds: ['wknd-pdp-more-like-this', 'wknd-recently-viewed'],
    currentProduct: { sku: 'WKND-JKT-001' },
    userViewHistory: [{ sku: 'WKND-PCK-001', date: '2026-11-01T00:00:00Z' }, { sku: 'WKND-HYD-001', date: '2026-11-02T00:00:00Z' }],
  });
  expect(res.results[0].productsView.length).toBeGreaterThan(0);
  expect(res.results[1].productsView.map((p) => p.sku)).toEqual(['WKND-HYD-001', 'WKND-PCK-001']);
});
