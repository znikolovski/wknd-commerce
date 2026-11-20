const fs = require('node:fs');
const path = require('node:path');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const {
  loadCatalog, resetCatalogCache, priceFor, IncompleteReadError,
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
