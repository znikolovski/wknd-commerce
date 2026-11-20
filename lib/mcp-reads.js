const admin = require('./admin');
const { loadCatalog, priceFor, sellableSkus } = require('./catalog');

class McpToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function pageOf(items, { page = 1, pageSize = 20 }) {
  return { total: items.length, page, pageSize, items: items.slice((page - 1) * pageSize, page * pageSize) };
}

function inCategory(product, category) {
  return !category || (product.categories || []).some((c) => c === category || c.startsWith(`${category}/`));
}

function priceView(cat, sku, parentSku) {
  const p = cat.priceBySku.get(sku) || cat.priceBySku.get(parentSku);
  if (!p) throw new McpToolError('PRICE_NOT_FOUND', 'A catalog price is unavailable.');
  const price = priceFor(cat, sku, parentSku);
  return {
    sku, currency: 'AUD', regular: price.regular, final: price.final,
    special: p.special ?? null, startsAt: p.specialFrom ?? null, endsAt: p.specialTo ?? null,
  };
}

async function listProducts(store, args) {
  const cat = await loadCatalog(store);
  const needle = (args.q || '').toLowerCase();
  const items = cat.allProducts
    .filter((p) => inCategory(p, args.category) && (!args.status || p.status === args.status)
      && (!needle || `${p.sku} ${p.name} ${(p.tags || []).join(' ')}`.toLowerCase().includes(needle)))
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .map((p) => ({
      sku: p.sku, name: p.name, type: p.type, status: p.status,
      urlKey: p.urlKey, categories: p.categories, tags: p.tags || [],
      prices: sellableSkus(p).map((sku) => priceView(cat, sku, p.sku)),
    }));
  return pageOf(args.onSaleOnly ? items.filter((p) => p.prices.some((v) => v.final < v.regular)) : items, args);
}

async function getProduct(store, { sku }) {
  const cat = await loadCatalog(store);
  const p = cat.allProducts.find((v) => v.sku === sku);
  if (!p) throw new McpToolError('PRODUCT_NOT_FOUND', 'Product not found.');
  return {
    sku: p.sku, name: p.name, type: p.type, status: p.status,
    urlKey: p.urlKey, categories: p.categories, tags: p.tags || [],
    shortDescription: p.shortDescription,
    variants: (p.variants || []).map((v) => ({ sku: v.sku, selections: v.selections })),
    prices: [p.sku, ...sellableSkus(p).filter((s) => s !== p.sku)].map((s) => priceView(cat, s, p.sku)),
  };
}

async function listCategories(store, args) {
  const cat = await loadCatalog(store);
  return pageOf(cat.categories.map((c) => ({
    id: c.id, name: c.name, urlPath: c.urlPath, parentId: c.parentId ?? null,
  })), args);
}

async function listInventory(store, args) {
  const result = await admin.listInventory(store, { q: args.q, lowStockOnly: args.lowStockOnly });
  return pageOf(result.items.map((r) => ({
    sku: r.sku, parentSku: r.parentSku, name: r.name, variant: r.variant,
    qty: r.qty, lowStockThreshold: r.lowStockThreshold, status: r.status,
  })), args);
}

function orderView(o, includeItems = false) {
  const totals = o.totals || {};
  return {
    number: o.number, createdAt: o.createdAt, status: o.status, currency: 'AUD',
    itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
    totals: {
      subtotalIncl: totals.subtotalIncl, discountTotal: totals.discountTotal,
      shipping: totals.shipping, tax: totals.tax, grandTotal: totals.grandTotal,
    },
    ...(includeItems ? {
      items: o.items.map((i) => ({
        sku: i.sku, parentSku: i.parentSku, name: i.name, quantity: i.quantity,
        price: i.price, regularPrice: i.regularPrice, rowTotal: i.rowTotal, discount: i.discount,
      })),
    } : {}),
  };
}

async function listOrders(store, args) {
  const { page = 1, pageSize = 20 } = args;
  const collection = store.collection('orders');
  const filter = args.number ? { number: args.number } : {};
  const [total, rows] = await Promise.all([
    collection.countDocuments(filter),
    collection.find(filter, { sort: { createdAt: -1, number: 1 }, limit: page * pageSize }),
  ]);
  return { total, page, pageSize, items: rows.slice((page - 1) * pageSize).map((o) => orderView(o)) };
}

async function getOrder(store, { number }) {
  const order = await store.collection('orders').findOne({ number });
  if (!order) throw new McpToolError('ORDER_NOT_FOUND', 'Order not found.');
  return orderView(order, true);
}

async function stats(store) {
  const s = await admin.stats(store);
  return {
    products: s.products, enabled: s.enabled, sellableSkus: s.sellableSkus,
    outOfStock: s.outOfStock, lowStock: s.lowStock, withoutImages: s.withoutImages,
    onSale: s.onSale, catalogVersion: s.catalogVersion,
    recentOrders: { count: s.orders, revenue: s.revenue, currency: 'AUD', maximumOrders: 500 },
  };
}

module.exports = {
  McpToolError, inCategory, stats, listCategories, listProducts, getProduct,
  listInventory, listOrders, getOrder,
};
