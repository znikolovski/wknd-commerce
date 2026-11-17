/**
 * Admin domain operations behind the IMS-protected `admin` action (used by the ExC Shell UI,
 * the seed script and the Assets View panel). Every write bumps the catalog version so the
 * storefront snapshot reloads, and returns the SKUs whose storefront pages need re-rendering.
 */
const { bumpCatalogVersion, sellableSkus, priceFor } = require('./catalog');
const { importCatalog } = require('./importer');
const { orderShape } = require('./orders');
const { loadCatalog } = require('./catalog');

class AdminError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const SKU_RE = /^[A-Z0-9][A-Z0-9-]{2,63}$/;
const URLKEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const num = (v, field, { min = 0, allowNull = false } = {}) => {
  if ((v === null || v === undefined || v === '') && allowNull) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new AdminError(`${field} must be a number ≥ ${min}`);
  return Math.round(n * 100) / 100;
};
const isoOrNull = (v, field) => {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new AdminError(`${field} must be an ISO date`);
  return new Date(t).toISOString();
};
const clean = (s, max = 4000) => (s == null ? '' : String(s).slice(0, max));

function validateProduct(input, categories) {
  if (!input || typeof input !== 'object') throw new AdminError('product is required');
  const sku = clean(input.sku, 64).toUpperCase();
  if (!SKU_RE.test(sku)) throw new AdminError('sku must be 3–64 chars: A–Z, 0–9 and hyphens');
  const name = clean(input.name, 200).trim();
  if (!name) throw new AdminError('name is required');
  const urlKey = clean(input.urlKey || name, 120).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!URLKEY_RE.test(urlKey)) throw new AdminError('urlKey is invalid');
  const cats = (input.categories || []).filter((c) => categories.some((x) => x.urlPath === c));
  if (!cats.length) throw new AdminError('at least one valid category is required');
  const options = (input.options || []).map((o) => ({
    id: clean(o.id, 40).toLowerCase(),
    title: clean(o.title, 60),
    values: (o.values || []).map((v) => ({
      id: clean(v.id, 40).toLowerCase(), title: clean(v.title, 60), ...(v.swatch ? { swatch: clean(v.swatch, 20) } : {}),
    })).filter((v) => v.id && v.title),
  })).filter((o) => o.id && o.values.length);
  const variants = (input.variants || []).map((v) => ({
    sku: clean(v.sku, 64).toUpperCase(),
    selections: Object.fromEntries(Object.entries(v.selections || {}).map(([k, val]) => [clean(k, 40), clean(val, 40)])),
  }));
  variants.forEach((v) => {
    if (!SKU_RE.test(v.sku)) throw new AdminError(`variant sku ${v.sku} is invalid`);
    options.forEach((o) => {
      if (!o.values.some((val) => val.id === v.selections[o.id])) throw new AdminError(`variant ${v.sku} has no valid ${o.title}`);
    });
  });
  if (options.length && !variants.length) throw new AdminError('configurable products need at least one variant');
  if (new Set(variants.map((v) => v.sku)).size !== variants.length) throw new AdminError('variant SKUs must be unique');
  return {
    sku,
    type: options.length ? 'configurable' : 'simple',
    name,
    urlKey,
    status: input.status === 'disabled' ? 'disabled' : 'enabled',
    visibility: ['Catalog, Search', 'Catalog', 'Search', 'Not Visible Individually'].includes(input.visibility) ? input.visibility : 'Catalog, Search',
    position: Number.isFinite(Number(input.position)) ? Number(input.position) : 999,
    featured: Boolean(input.featured),
    categories: cats,
    tags: (input.tags || []).map((t) => clean(t, 60).toLowerCase()).filter(Boolean).slice(0, 30),
    attributes: Object.fromEntries(Object.entries(input.attributes || {}).slice(0, 30)
      .map(([k, v]) => [clean(k, 40), typeof v === 'number' ? v : clean(v, 300)])),
    shortDescription: clean(input.shortDescription, 500),
    description: clean(input.description, 20000),
    metaTitle: clean(input.metaTitle || `${name} | WKND Adventures Shop`, 200),
    metaDescription: clean(input.metaDescription, 400),
    metaKeyword: clean(input.metaKeyword, 400),
    options,
    variants,
  };
}

async function listProducts(store, {
  q = '', category, status, page = 1, pageSize = 25, lowStock,
} = {}) {
  const cat = await loadCatalog(store);
  const needle = String(q).toLowerCase();
  let rows = cat.allProducts.filter((p) => (!needle || `${p.sku} ${p.name} ${(p.tags || []).join(' ')}`.toLowerCase().includes(needle))
    && (!category || (p.categories || []).some((c) => c.startsWith(category)))
    && (!status || p.status === status));
  rows = rows.map((p) => {
    const skus = sellableSkus(p);
    const stock = skus.map((s) => cat.stockBySku.get(s)?.qty ?? 0);
    const priced = skus.map((s) => priceFor(cat, s, p.sku));
    const prices = priced.map((x) => x.final);
    const images = (cat.imagesBySku.get(p.sku) || []).length
      + (p.variants || []).reduce((n, v) => n + (cat.imagesBySku.get(v.sku) || []).length, 0);
    return {
      sku: p.sku,
      name: p.name,
      type: p.type,
      status: p.status,
      urlKey: p.urlKey,
      categories: p.categories,
      variants: (p.variants || []).length,
      stock: stock.reduce((a, b) => a + b, 0),
      outOfStock: stock.filter((s) => s <= 0).length,
      lowStock: skus.filter((s) => {
        const i = cat.stockBySku.get(s);
        return i && i.qty > 0 && i.qty <= (i.lowStockThreshold ?? 3);
      }).length,
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      regularMin: Math.min(...priced.map((x) => x.regular)),
      onSale: priced.some((x) => x.final < x.regular),
      images,
      updatedAt: p.updatedAt,
    };
  });
  if (lowStock) rows = rows.filter((r) => r.lowStock || r.outOfStock);
  const size = Math.min(Math.max(1, Number(pageSize) || 25), 200);
  const start = (Math.max(1, Number(page) || 1) - 1) * size;
  return { total: rows.length, items: rows.slice(start, start + size) };
}

async function getProduct(store, sku) {
  const product = await store.collection('products').findOne({ sku });
  if (!product) throw new AdminError(`Product ${sku} not found`, 404);
  const skus = [product.sku, ...(product.variants || []).map((v) => v.sku)];
  const [prices, inventory, images] = await Promise.all([
    store.collection('prices').find({ sku: { $in: skus } }),
    store.collection('inventory').find({ sku: { $in: skus } }),
    store.collection('asset_links').find({ sku: { $in: skus } }),
  ]);
  return {
    product, prices, inventory, images: images.sort((a, b) => (a.position ?? 99) - (b.position ?? 99)),
  };
}

async function saveProduct(store, input, { create = false } = {}) {
  const categories = await store.collection('categories').find({});
  const product = validateProduct(input, categories);
  const products = store.collection('products');
  const existing = await products.findOne({ sku: product.sku });
  if (create && existing) throw new AdminError(`Product ${product.sku} already exists`, 409);
  const clash = await products.findOne({ urlKey: product.urlKey });
  if (clash && clash.sku !== product.sku) throw new AdminError(`urlKey ${product.urlKey} is used by ${clash.sku}`, 409);
  const now = new Date().toISOString();
  const doc = { ...product, createdAt: existing?.createdAt || now, updatedAt: now };
  await products.replaceOne({ sku: product.sku }, doc, { upsert: true });

  // initialise price/stock rows for new sellable SKUs (inherit the parent price)
  const parentPrice = (await store.collection('prices').findOne({ sku: product.sku }))
    || { sku: product.sku, regular: num(input.price ?? 0, 'price'), currency: 'AUD' };
  if (!existing || input.price != null) {
    await store.collection('prices').replaceOne({ sku: product.sku }, { ...parentPrice, regular: num(input.price ?? parentPrice.regular, 'price') }, { upsert: true });
  }
  const sellable = product.type === 'configurable' ? product.variants.map((v) => v.sku) : [product.sku];
  for (let i = 0; i < sellable.length; i += 1) {
    const sku = sellable[i];
    /* eslint-disable no-await-in-loop */
    if (!(await store.collection('inventory').findOne({ sku }))) {
      await store.collection('inventory').insertOne({ sku, qty: 0, lowStockThreshold: 3 });
    }
    if (sku !== product.sku && !(await store.collection('prices').findOne({ sku }))) {
      await store.collection('prices').insertOne({ sku, regular: parentPrice.regular, currency: 'AUD' });
    }
    /* eslint-enable no-await-in-loop */
  }
  await bumpCatalogVersion(store);
  return { product: doc, created: !existing, affected: [product.sku] };
}

async function setStatus(store, sku, status) {
  if (!['enabled', 'disabled'].includes(status)) throw new AdminError('status must be enabled or disabled');
  const res = await store.collection('products').updateOne({ sku }, { $set: { status, updatedAt: new Date().toISOString() } });
  if (!res?.matchedCount) throw new AdminError(`Product ${sku} not found`, 404);
  await bumpCatalogVersion(store);
  return { sku, status, affected: [sku] };
}

async function deleteProduct(store, sku) {
  const product = await store.collection('products').findOne({ sku });
  if (!product) throw new AdminError(`Product ${sku} not found`, 404);
  const skus = [sku, ...(product.variants || []).map((v) => v.sku)];
  await store.collection('products').deleteOne({ sku });
  await store.collection('prices').deleteMany({ sku: { $in: skus } });
  await store.collection('inventory').deleteMany({ sku: { $in: skus } });
  await bumpCatalogVersion(store);
  return { deleted: sku, removed: product };
}

/** Parent SKU for a sellable SKU (for storefront re-rendering). */
async function parentsOf(store, skus) {
  const cat = await loadCatalog(store);
  return [...new Set(skus.map((s) => (cat.bySku.has(s) ? s : cat.byVariantSku.get(s)?.parent.sku)).filter(Boolean))];
}

async function updateInventory(store, items = []) {
  if (!Array.isArray(items) || !items.length) throw new AdminError('items are required');
  const inv = store.collection('inventory');
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const sku = clean(it.sku, 64).toUpperCase();
    const set = {};
    if (it.qty !== undefined) set.qty = Math.floor(num(it.qty, `qty for ${sku}`));
    if (it.lowStockThreshold !== undefined) set.lowStockThreshold = Math.floor(num(it.lowStockThreshold, `threshold for ${sku}`));
    if (it.adjust !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      const cur = await inv.findOne({ sku });
      set.qty = Math.max(0, (cur?.qty || 0) + Math.floor(Number(it.adjust) || 0));
    }
    // eslint-disable-next-line no-await-in-loop
    await inv.updateOne({ sku }, { $set: set }, { upsert: true });
  }
  await bumpCatalogVersion(store);
  return { updated: items.length, affected: await parentsOf(store, items.map((i) => String(i.sku).toUpperCase())) };
}

async function listInventory(store, { q = '', lowStockOnly } = {}) {
  const cat = await loadCatalog(store);
  const rows = [];
  cat.allProducts.forEach((p) => {
    const sellable = p.type === 'configurable' ? p.variants : [{ sku: p.sku, selections: {} }];
    sellable.forEach((v) => {
      const s = cat.stockBySku.get(v.sku) || { qty: 0, lowStockThreshold: 3 };
      const label = (p.options || []).map((o) => o.values.find((x) => x.id === v.selections[o.id])?.title).filter(Boolean).join(' / ');
      rows.push({
        sku: v.sku, parentSku: p.sku, name: p.name, variant: label, qty: s.qty, lowStockThreshold: s.lowStockThreshold ?? 3, status: p.status,
      });
    });
  });
  const needle = String(q).toLowerCase();
  return {
    items: rows.filter((r) => (!needle || `${r.sku} ${r.name}`.toLowerCase().includes(needle))
      && (!lowStockOnly || r.qty <= r.lowStockThreshold)),
  };
}

function priceDoc(it, existing = {}) {
  const sku = clean(it.sku, 64).toUpperCase();
  const regular = num(it.regular ?? existing.regular, `regular price for ${sku}`);
  const special = num(it.special === undefined ? existing.special : it.special, `special price for ${sku}`, { allowNull: true });
  if (special != null && special > regular) throw new AdminError(`special price for ${sku} must not exceed the regular price`);
  const doc = {
    sku,
    currency: 'AUD',
    regular,
    special,
    specialFrom: isoOrNull(it.specialFrom === undefined ? existing.specialFrom : it.specialFrom, 'specialFrom'),
    specialTo: isoOrNull(it.specialTo === undefined ? existing.specialTo : it.specialTo, 'specialTo'),
  };
  if (doc.special == null) {
    delete doc.special;
    delete doc.specialFrom;
    delete doc.specialTo;
  }
  return doc;
}

async function updatePrices(store, items = []) {
  if (!Array.isArray(items) || !items.length) throw new AdminError('items are required');
  const coll = store.collection('prices');
  for (let i = 0; i < items.length; i += 1) {
    const sku = clean(items[i].sku, 64).toUpperCase();
    // eslint-disable-next-line no-await-in-loop
    const existing = await coll.findOne({ sku }) || {};
    // eslint-disable-next-line no-await-in-loop
    await coll.replaceOne({ sku }, priceDoc(items[i], existing), { upsert: true });
  }
  await bumpCatalogVersion(store);
  return { updated: items.length, affected: await parentsOf(store, items.map((i) => String(i.sku).toUpperCase())) };
}

/** Bulk sale: set special = regular × (1 - percent/100) for a category or SKU list. */
async function bulkPrice(store, {
  category, skus, percent, specialFrom, specialTo, clear,
}) {
  const cat = await loadCatalog(store);
  const parents = cat.allProducts.filter((p) => (skus?.length ? skus.includes(p.sku)
    : (p.categories || []).some((c) => c.startsWith(category || ''))));
  if (!parents.length) throw new AdminError('no products matched');
  const pct = clear ? 0 : num(percent, 'percent', { min: 1 });
  if (!clear && pct >= 90) throw new AdminError('percent must be below 90');
  const items = parents.flatMap((p) => [p.sku, ...sellableSkus(p).filter((s) => s !== p.sku)]).map((sku) => {
    const regular = cat.priceBySku.get(sku)?.regular ?? cat.priceBySku.get(cat.byVariantSku.get(sku)?.parent.sku)?.regular ?? 0;
    return clear ? { sku, special: null } : {
      sku, regular, special: Math.round(regular * (1 - pct / 100) * 100) / 100, specialFrom, specialTo,
    };
  });
  return updatePrices(store, items);
}

async function listOrders(store, { page = 1, pageSize = 25, q = '' } = {}) {
  const all = await store.collection('orders').find({}, { sort: { createdAt: -1 } });
  const needle = String(q).toLowerCase();
  const rows = all.filter((o) => !needle || `${o.number} ${o.email}`.toLowerCase().includes(needle));
  const size = Math.min(Math.max(1, Number(pageSize) || 25), 100);
  const start = (Math.max(1, Number(page) || 1) - 1) * size;
  return {
    total: rows.length,
    items: rows.slice(start, start + size).map((o) => ({
      number: o.number,
      createdAt: o.createdAt,
      email: o.email,
      customer: o.customerSub ? 'Signed in' : 'Guest',
      items: o.items.reduce((n, i) => n + i.quantity, 0),
      total: o.totals.grandTotal,
      status: o.status,
    })),
  };
}

async function getOrder(store, number) {
  const order = await store.collection('orders').findOne({ number });
  if (!order) throw new AdminError(`Order ${number} not found`, 404);
  return { order, view: orderShape(await loadCatalog(store), order) };
}

async function stats(store) {
  const cat = await loadCatalog(store);
  const orders = await store.collection('orders').find({}, { sort: { createdAt: -1 }, limit: 500 });
  const sellable = cat.allProducts.flatMap((p) => sellableSkus(p));
  const stock = sellable.map((s) => cat.stockBySku.get(s) || { qty: 0, lowStockThreshold: 3 });
  return {
    products: cat.allProducts.length,
    enabled: cat.products.length,
    sellableSkus: sellable.length,
    outOfStock: stock.filter((s) => s.qty <= 0).length,
    lowStock: stock.filter((s) => s.qty > 0 && s.qty <= (s.lowStockThreshold ?? 3)).length,
    withoutImages: cat.allProducts.filter((p) => !cat.imagesBySku.get(p.sku)?.length
      && !(p.variants || []).some((v) => cat.imagesBySku.get(v.sku)?.length)).length,
    onSale: cat.allProducts.filter((p) => sellableSkus(p).some((s) => priceFor(cat, s, p.sku).final < priceFor(cat, s, p.sku).regular)).length,
    orders: orders.length,
    revenue: Math.round(orders.reduce((n, o) => n + o.totals.grandTotal, 0) * 100) / 100,
    catalogVersion: cat.version,
  };
}

async function listCategories(store) {
  const cat = await loadCatalog(store);
  return { items: cat.categories };
}

async function importAll(store, { catalog, replace, keepInventory }) {
  if (!catalog?.products) throw new AdminError('catalog.products is required');
  return importCatalog(store, catalog, { replace: Boolean(replace), keepInventory: Boolean(keepInventory) });
}

module.exports = {
  AdminError,
  validateProduct,
  listProducts,
  getProduct,
  saveProduct,
  setStatus,
  deleteProduct,
  listInventory,
  updateInventory,
  updatePrices,
  bulkPrice,
  listOrders,
  getOrder,
  stats,
  listCategories,
  importAll,
};
