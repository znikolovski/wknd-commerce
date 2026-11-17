const fs = require('node:fs');
const path = require('node:path');

const invoked = [];
jest.mock('openwhisk', () => () => ({ actions: { invoke: async (req) => { invoked.push(req); return {}; } } }));

const { createMemoryStore, getStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { loadCatalog, resetCatalogCache } = require('../lib/catalog');
const { soldOutBy } = require('../lib/orders');
const { priceWindowChanges } = require('../lib/pdp-schedule');
const { triggerPrerender } = require('../lib/invoke');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
let cat;

beforeAll(async () => {
  process.env.__OW_API_KEY = 'k';
  process.env.__OW_NAMESPACE = 'ns';
  resetCatalogCache();
  const store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
  cat = await loadCatalog(store);
});

afterAll(() => {
  delete process.env.__OW_API_KEY;
  delete process.env.__OW_NAMESPACE;
});

beforeEach(() => { invoked.length = 0; });

describe('orders that sell out a product', () => {
  const simple = () => cat.products.find((p) => p.type !== 'configurable' && cat.stockBySku.get(p.sku)?.qty > 0);

  test('selling the last units of a product flags it for re-render', () => {
    const p = simple();
    const { qty } = cat.stockBySku.get(p.sku);
    expect(soldOutBy(cat, [{ sku: p.sku, quantity: qty }])).toEqual([p.sku]);
  });

  test('stock left, or other variants in stock → no re-render', () => {
    const p = cat.products.find((x) => x.type !== 'configurable' && cat.stockBySku.get(x.sku)?.qty > 1);
    expect(soldOutBy(cat, [{ sku: p.sku, quantity: 1 }])).toEqual([]);
    const configurable = cat.products.find((x) => x.type === 'configurable'
      && x.variants.filter((v) => cat.stockBySku.get(v.sku)?.qty > 0).length > 1);
    const variant = configurable.variants.find((v) => cat.stockBySku.get(v.sku)?.qty > 0);
    expect(soldOutBy(cat, [{ sku: variant.sku, quantity: cat.stockBySku.get(variant.sku).qty }])).toEqual([]);
  });
});

describe('scheduled special prices', () => {
  test('re-renders parents whose window opened or closed since the last run', () => {
    const p = cat.products.find((x) => x.type !== 'configurable');
    const start = Date.parse('2026-12-01T00:00:00Z');
    const end = Date.parse('2026-12-08T00:00:00Z');
    const snapshot = {
      ...cat,
      priceBySku: new Map([[p.sku, {
        sku: p.sku, regular: 100, special: 80, specialFrom: new Date(start).toISOString(), specialTo: new Date(end).toISOString(),
      }]]),
    };
    const q = 15 * 60 * 1000;
    expect(priceWindowChanges(snapshot, start - q, start)).toEqual([p.sku]);
    expect(priceWindowChanges(snapshot, start, start + q)).toEqual([]);
    expect(priceWindowChanges(snapshot, end - 1, end + q)).toEqual([p.sku]);
  });
});

describe('prerender triggers', () => {
  test('deletes and full refreshes are passed to prerender', async () => {
    await triggerPrerender({}, [], { removed: { urlKey: 'gone' } });
    await triggerPrerender({}, undefined, { all: true });
    await triggerPrerender({}, []);
    expect(invoked.map((i) => i.params)).toEqual([
      { skus: [], removed: { urlKey: 'gone' } },
      { skus: [], all: true },
    ]);
  });

  test('pdp-scheduler does a daily full refresh, then only window changes', async () => {
    const { main } = require('../actions/pdp-scheduler/index');
    await importCatalog(await getStore({ STORE: 'memory' }), CATALOG, { replace: true });
    const first = await main({ STORE: 'memory' });
    expect(first).toEqual({ full: true, mode: 'publish', rerendered: 'all' });
    expect(invoked.at(-1).params).toEqual({ skus: [], all: true });
    invoked.length = 0;
    const next = await main({ STORE: 'memory' });
    expect(next.full).toBe(false);
    expect(invoked).toHaveLength(next.rerendered.length ? 1 : 0);
    // switching PDP_PUBLISH (go-live) re-renders everything on the next tick
    expect(await main({ STORE: 'memory', PDP_PUBLISH: 'false' })).toMatchObject({ full: true, mode: 'preview' });
    expect(await main({ STORE: 'memory', PDP_PUBLISH: 'false' })).toMatchObject({ full: false });
    expect(await main({ STORE: 'memory', PDP_PUBLISH: 'true' })).toMatchObject({ full: true, mode: 'publish' });
  });
});
