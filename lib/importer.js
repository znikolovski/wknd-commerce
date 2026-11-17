/**
 * Catalog import used by the admin API (seed / CSV-ish bulk import) and tests.
 */
const { bumpCatalogVersion } = require('./catalog');

/** Batched upsert: two round trips per collection instead of one per document. */
async function upsertAll(coll, docs, key) {
  if (!docs.length) return;
  await coll.deleteMany({ [key]: { $in: docs.map((d) => d[key]) } });
  await coll.insertMany(docs);
}

/**
 * @param {object} store
 * @param {{categories, products, prices, inventory, assetLinks?}} catalog
 * @param {{ replace?: boolean, keepInventory?: boolean }} options
 */
async function importCatalog(store, catalog, { replace = false, keepInventory = false } = {}) {
  const c = (n) => store.collection(n);
  if (replace) {
    await Promise.all(['products', 'categories', 'prices'].map((n) => c(n).deleteMany({})));
    if (!keepInventory) await c('inventory').deleteMany({});
  }
  if (replace) {
    if (catalog.categories?.length) await c('categories').insertMany(catalog.categories);
    if (catalog.products?.length) await c('products').insertMany(catalog.products);
    if (catalog.prices?.length) await c('prices').insertMany(catalog.prices);
    if (catalog.inventory?.length && !keepInventory) await c('inventory').insertMany(catalog.inventory);
  } else {
    await upsertAll(c('categories'), catalog.categories || [], 'urlPath');
    await upsertAll(c('products'), catalog.products || [], 'sku');
    await upsertAll(c('prices'), catalog.prices || [], 'sku');
    if (!keepInventory) await upsertAll(c('inventory'), catalog.inventory || [], 'sku');
  }
  if (catalog.assetLinks?.length) {
    for (let i = 0; i < catalog.assetLinks.length; i += 1) {
      const l = catalog.assetLinks[i];
      // eslint-disable-next-line no-await-in-loop
      await c('asset_links').replaceOne({ sku: l.sku, assetId: l.assetId }, l, { upsert: true });
    }
  }
  await bumpCatalogVersion(store);
  return {
    categories: catalog.categories?.length || 0,
    products: catalog.products?.length || 0,
    prices: catalog.prices?.length || 0,
    inventory: keepInventory ? 0 : catalog.inventory?.length || 0,
  };
}

module.exports = { importCatalog };
