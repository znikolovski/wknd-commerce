const fs = require('node:fs');
const path = require('node:path');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const {
  loadCatalog, loadFinancialCatalog, resetCatalogCache, priceFor, stockFor, IncompleteReadError,
} = require('../lib/catalog');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
const SKU = CATALOG.products.find((p) => p.type === 'simple').sku;

/** Wraps a store so `prices.find` returns a truncated result for the next `times` calls. */
function flakyPrices(store, times) {
  let remaining = times;
  return {
    ...store,
    collection(name) {
      const coll = store.collection(name);
      if (name !== 'prices') return coll;
      return {
        ...coll,
        find: async (...args) => {
          const docs = await coll.find(...args);
          if (remaining > 0) {
            remaining -= 1;
            return docs.slice(0, 3);
          }
          return docs;
        },
        countDocuments: (...args) => coll.countDocuments(...args),
      };
    },
  };
}

let store;

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
});

test('a short collection read is retried instead of producing $0 prices', async () => {
  const cat = await loadCatalog(flakyPrices(store, 2));
  expect(priceFor(cat, SKU).regular).toBeGreaterThan(0);
  expect(cat.priceBySku.size).toBe(CATALOG.prices.length);
});

test('persistent short reads keep serving the last complete snapshot', async () => {
  const good = await loadCatalog(store);
  const price = priceFor(good, SKU).regular;
  // another container (e.g. the admin action) publishes a new catalog version
  await store.collection('counters').updateOne({ key: 'catalog_version' }, { $inc: { value: 1 } }, { upsert: true });
  await new Promise((r) => { setTimeout(r, 3100); });
  const cat = await loadCatalog(flakyPrices(store, 10));
  expect(cat).toBe(good);
  expect(priceFor(cat, SKU).regular).toBe(price);
});

test('without a previous snapshot an incomplete read fails loudly', async () => {
  await expect(loadCatalog(flakyPrices(store, 10))).rejects.toBeInstanceOf(IncompleteReadError);
});

test('fresh management reads bypass a warm cache and never fall back to stale data', async () => {
  const good = await loadCatalog(store);
  await expect(loadCatalog(flakyPrices(store, 10), { fresh: true })).rejects.toBeInstanceOf(IncompleteReadError);
  expect(await loadCatalog(store)).toBe(good);
  expect(good.priceBySku.size).toBe(CATALOG.prices.length);
  await store.collection('prices').updateOne({ sku: SKU }, { $set: { regular: 123.45 } });
  const fresh = await loadCatalog(store, { fresh: true });
  expect(fresh).not.toBe(good);
  expect(priceFor(fresh, SKU).regular).toBe(123.45);
});

test('snapshot reads ask for large cursor batches (each batch is a DB round trip)', async () => {
  const options = [];
  const spy = {
    ...store,
    collection(name) {
      const coll = store.collection(name);
      return {
        ...coll,
        find: (filter, opts) => { options.push(opts); return coll.find(filter, opts); },
        countDocuments: (...args) => coll.countDocuments(...args),
        findOne: (...args) => coll.findOne(...args),
      };
    },
  };
  await loadCatalog(spy);
  expect(options).toHaveLength(5);
  options.forEach((o) => expect(o.batchSize).toBeGreaterThanOrEqual(1000));
});

test('fresh snapshots overlap independent collection reads without bypassing completeness checks', async () => {
  const started = [];
  const counted = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const delayed = {
    ...store,
    collection(name) {
      const coll = store.collection(name);
      return {
        findOne: (...args) => coll.findOne(...args),
        find: async (...args) => {
          started.push(name);
          await pending;
          return coll.find(...args);
        },
        countDocuments: (...args) => {
          counted.push(name);
          return coll.countDocuments(...args);
        },
      };
    },
  };
  const loading = loadCatalog(delayed, { fresh: true });
  try {
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(started).toEqual(['products', 'categories', 'prices', 'inventory', 'asset_links']);
    expect(counted).toEqual(started);
  } finally {
    release();
    await loading;
  }
  const cat = await loading;
  expect(priceFor(cat, SKU).regular).toBeGreaterThan(0);
  expect(cat.priceBySku.size).toBe(CATALOG.prices.length);
});

test('financial reads refresh only scoped parents, prices and stock without changing the cached catalog', async () => {
  const cat = await loadCatalog(store);
  const reads = [];
  const scoped = {
    ...store,
    collection(name) {
      const coll = store.collection(name);
      return {
        findOne: (filter) => {
          reads.push({ name, filter });
          return coll.findOne(filter);
        },
      };
    },
  };
  await store.collection('prices').updateOne({ sku: SKU }, { $set: { regular: 123.45, special: null } });
  await store.collection('inventory').updateOne({ sku: SKU }, { $set: { qty: 2 } });
  const fresh = await loadFinancialCatalog(scoped, cat, [SKU]);
  expect(reads).toEqual(['products', 'prices', 'inventory'].map((name) => ({
    name, filter: { sku: SKU },
  })));
  expect(priceFor(fresh, SKU).final).toBe(123.45);
  expect(stockFor(fresh, SKU).qty).toBe(2);
  expect(await loadCatalog(store)).toBe(cat);
  expect(priceFor(cat, SKU).final).not.toBe(123.45);
});

test.each(['disabled-parent', 'disabled-variant', 'removed-variant', 'missing-price', 'missing-stock', 'wrong-currency'])(
  'required financial records fail closed on %s despite a warm snapshot',
  async (change) => {
    const parent = CATALOG.products.find((p) => p.type === 'configurable');
    const sku = parent.variants[0].sku;
    const cat = await loadCatalog(store);
    if (change === 'disabled-parent') await store.collection('products').updateOne({ sku: parent.sku }, { $set: { status: 'disabled' } });
    if (change === 'disabled-variant') await store.collection('products').updateOne({ sku: parent.sku }, {
      $set: { variants: parent.variants.map((v) => ({ ...v, status: 'disabled' })) },
    });
    if (change === 'removed-variant') await store.collection('products').updateOne({ sku: parent.sku }, { $set: { variants: [] } });
    if (change === 'missing-price') {
      await store.collection('prices').deleteOne({ sku });
      await store.collection('prices').deleteOne({ sku: parent.sku });
    }
    if (change === 'missing-stock') await store.collection('inventory').deleteOne({ sku });
    if (change === 'wrong-currency') await store.collection('prices').updateOne({ sku }, { $set: { currency: 'USD' } });
    await expect(loadFinancialCatalog(store, cat, [sku])).rejects.toBeInstanceOf(IncompleteReadError);
  },
);

test('filtered cursor incompleteness is retried without using warm financial data', async () => {
  const cat = await loadCatalog(store);
  const find = jest.fn(async () => []);
  const incomplete = {
    ...store,
    collection(name) {
      const coll = store.collection(name);
      return name === 'prices' ? { find, countDocuments: (filter) => coll.countDocuments(filter) } : coll;
    },
  };
  const skus = CATALOG.products.filter((p) => p.type === 'simple').slice(0, 4).map((p) => p.sku);
  await expect(loadFinancialCatalog(incomplete, cat, skus)).rejects.toBeInstanceOf(IncompleteReadError);
  expect(find).toHaveBeenCalledTimes(3);
});

test('request-scoped reuse coalesces records, but a new request observes changed financial facts', async () => {
  const cat = await loadCatalog(store);
  const prices = store.collection('prices');
  const find = jest.spyOn(prices, 'findOne');
  const request = new Map();
  await Promise.all([
    loadFinancialCatalog(store, cat, [SKU], [SKU], request),
    loadFinancialCatalog(store, cat, [SKU], [SKU], request),
  ]);
  expect(find).toHaveBeenCalledTimes(1);
  await prices.updateOne({ sku: SKU }, { $set: { regular: 111, special: null } });
  const nextRequest = await loadFinancialCatalog(store, cat, [SKU]);
  expect(priceFor(nextRequest, SKU).final).toBe(111);
  expect(find).toHaveBeenCalledTimes(2);
});
