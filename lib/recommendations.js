/**
 * Rules-based stand-in for Adobe Commerce Product Recommendations (Sensei).
 * Units are addressed by unitId (recommendationsByUnitIds) or by pageType (recommendations).
 * Signals: category/tag affinity, complementary categories, co-purchase and sales counts
 * (maintained in `counters` by placeOrder), cart contents and view/purchase history.
 */
const { toProductView, priceRangeFor, productInStock } = require('./catalog');

const UNITS = [
  {
    unitId: 'wknd-pdp-more-like-this', unitName: 'PDP — More like this', storefrontLabel: 'More like this', typeId: 'more-like-this', pageType: 'Product', displayOrder: 1,
  },
  {
    unitId: 'wknd-pdp-complete-kit', unitName: 'PDP — Complete your kit', storefrontLabel: 'Complete your kit', typeId: 'bought-bought', pageType: 'Product', displayOrder: 2,
  },
  {
    unitId: 'wknd-cart-addons', unitName: 'Cart — Add before you go', storefrontLabel: 'Add before you go', typeId: 'trending', pageType: 'Cart', displayOrder: 1,
  },
  {
    unitId: 'wknd-trending', unitName: 'Home — Trending gear', storefrontLabel: 'Trending gear', typeId: 'most-purchased', pageType: 'CMS', displayOrder: 1,
  },
  {
    unitId: 'wknd-recently-viewed', unitName: 'Recently viewed', storefrontLabel: 'Recently viewed', typeId: 'recently-viewed', pageType: 'CMS', displayOrder: 2,
  },
  {
    unitId: 'wknd-of1-gear', unitName: 'OF1 — Gear for this adventure', storefrontLabel: 'Gear for this adventure', typeId: 'adventure-gear', pageType: 'CMS', displayOrder: 3,
  },
  {
    unitId: 'wknd-category-top', unitName: 'Category — Top sellers', storefrontLabel: 'Top sellers', typeId: 'most-purchased', pageType: 'Category', displayOrder: 1,
  },
];

/** Category → categories that complete the kit. Keys/values are top-two path segments. */
const COMPLEMENTS = {
  'apparel/jackets': ['apparel/base-layers', 'accessories/packs', 'apparel/headwear'],
  'apparel/base-layers': ['apparel/jackets', 'apparel/pants', 'apparel/socks'],
  'apparel/pants': ['apparel/base-layers', 'apparel/socks', 'accessories/packs'],
  'apparel/headwear': ['apparel/gloves', 'apparel/jackets', 'accessories/hydration'],
  'apparel/gloves': ['apparel/headwear', 'apparel/jackets'],
  'apparel/socks': ['apparel/pants', 'apparel/base-layers'],
  'apparel/tees': ['apparel/headwear', 'accessories/hydration'],
  'accessories/packs': ['accessories/hydration', 'accessories/lighting', 'accessories/packing'],
  'accessories/duffels': ['accessories/packing', 'accessories/travel-tech'],
  'accessories/packing': ['accessories/duffels', 'accessories/travel-tech'],
  'accessories/hydration': ['accessories/packs', 'apparel/headwear'],
  'accessories/lighting': ['accessories/packs', 'accessories/travel-tech'],
  'accessories/travel-tech': ['accessories/packing', 'accessories/lighting'],
};

const MAX_PRODUCTS = 8;
const leaf = (p) => (p.categories || [])[0] || '';
const overlap = (a = [], b = []) => a.filter((x) => b.includes(x)).length;

async function loadSignals(store) {
  const [sales, copurchase] = await Promise.all([
    store.collection('counters').findOne({ key: 'sales' }),
    store.collection('counters').findOne({ key: 'copurchase' }),
  ]);
  return { sales: sales?.value || {}, copurchase: copurchase?.value || {} };
}

function parentOf(cat, sku) {
  return cat.bySku.get(sku) || cat.byVariantSku.get(sku)?.parent || null;
}

function rank(cat, candidates, scoreFn, exclude) {
  return candidates
    .filter((p) => !exclude.has(p.sku) && productInStock(cat, p))
    .map((p) => ({ p, s: scoreFn(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.p.position ?? 999) - (b.p.position ?? 999))
    .slice(0, MAX_PRODUCTS)
    .map((x) => x.p);
}

function unitProducts(cat, unit, ctx, signals) {
  const currentSku = ctx.currentSku || ctx.currentProduct?.sku;
  const current = currentSku ? parentOf(cat, currentSku) : null;
  const cart = (ctx.cartSkus || []).map((s) => parentOf(cat, s)).filter(Boolean);
  const viewed = (ctx.userViewHistory || [])
    .slice().sort((a, b) => String(b.date || b.dateTime).localeCompare(String(a.date || a.dateTime)))
    .map((v) => parentOf(cat, v.sku)).filter(Boolean);
  const exclude = new Set([current?.sku, ...cart.map((p) => p.sku)].filter(Boolean));
  const sales = (p) => signals.sales[p.sku] || 0;

  switch (unit.typeId) {
    case 'more-like-this':
      if (!current) return [];
      return rank(cat, cat.products, (p) => (leaf(p) === leaf(current) ? 5 : 0)
        + overlap(p.tags, current.tags) * 2
        + (p.attributes?.activity && p.attributes.activity === current.attributes?.activity ? 1 : 0), exclude);
    case 'bought-bought': {
      if (!current) return [];
      const co = signals.copurchase[current.sku] || {};
      const complements = COMPLEMENTS[leaf(current)] || [];
      return rank(cat, cat.products, (p) => (co[p.sku] || 0) * 3
        + (complements.includes(leaf(p)) ? 4 : 0) + overlap(p.tags, current.tags), exclude);
    }
    case 'trending': {
      const complements = new Set(cart.flatMap((p) => COMPLEMENTS[leaf(p)] || []));
      return rank(cat, cat.products, (p) => (complements.has(leaf(p)) ? 4 : 0)
        + (priceRangeFor(cat, p).min.final <= 60 ? 2 : 0) + Math.log1p(sales(p)) + 0.1, exclude);
    }
    case 'most-purchased':
      return rank(cat, cat.products, (p) => {
        const inCategory = !ctx.category || (p.categories || []).some((c) => c.startsWith(ctx.category));
        return inCategory ? 1 + sales(p) * 2 + (p.featured ? 3 : 0) : 0;
      }, exclude);
    case 'recently-viewed':
      return viewed.filter((p, i, arr) => arr.indexOf(p) === i && p.sku !== current?.sku).slice(0, MAX_PRODUCTS);
    case 'adventure-gear': {
      const seedTags = new Set([...(current?.tags || []), ...cart.flatMap((p) => p.tags || []),
        ...viewed.slice(0, 3).flatMap((p) => p.tags || [])]);
      const complements = current ? COMPLEMENTS[leaf(current)] || [] : [];
      const picks = rank(cat, cat.products, (p) => overlap(p.tags, [...seedTags]) * 3
        + (complements.includes(leaf(p)) ? 2 : 0) + (seedTags.size ? 0 : 1 + sales(p)), new Set(cart.map((p) => p.sku)));
      // keep the anchor product first for adventure recommendations
      return current && productInStock(cat, current) ? [current, ...picks.filter((p) => p.sku !== current.sku)].slice(0, MAX_PRODUCTS) : picks;
    }
    default:
      return [];
  }
}

function toUnit(cat, unit, products) {
  return {
    ...unit,
    productsView: products.map((p) => toProductView(cat, p)),
    totalProducts: products.length,
    userError: null,
  };
}

async function recommendationsByUnitIds(cat, store, args) {
  const signals = await loadSignals(store);
  const results = (args.unitIds || []).map((id) => {
    const unit = UNITS.find((u) => u.unitId === id);
    if (!unit) {
      return {
        unitId: id, unitName: id, productsView: [], totalProducts: 0, userError: `Unknown recommendation unit ${id}`,
      };
    }
    return toUnit(cat, unit, unitProducts(cat, unit, args, signals));
  });
  return { results, totalResults: results.length };
}

async function recommendations(cat, store, args) {
  const signals = await loadSignals(store);
  const pageType = args.pageType || 'CMS';
  const results = UNITS.filter((u) => u.pageType === pageType)
    .map((unit) => toUnit(cat, unit, unitProducts(cat, unit, args, signals)))
    .filter((u) => u.totalProducts > 0);
  return { results, totalResults: results.length };
}

async function recordSale(store, parentSkus) {
  const unique = [...new Set(parentSkus)];
  const salesInc = Object.fromEntries(unique.map((s) => [`value.${s}`, 1]));
  const coInc = {};
  unique.forEach((a) => unique.forEach((b) => {
    if (a !== b) coInc[`value.${a}.${b}`] = 1;
  }));
  await store.collection('counters').updateOne({ key: 'sales' }, { $inc: salesInc }, { upsert: true });
  if (Object.keys(coInc).length) {
    await store.collection('counters').updateOne({ key: 'copurchase' }, { $inc: coInc }, { upsert: true });
  }
}

module.exports = {
  UNITS, COMPLEMENTS, recommendationsByUnitIds, recommendations, recordSale,
};
