/**
 * Catalog snapshot + mapping to Catalog Service (ProductView) and Core (ProductInterface) shapes.
 *
 * The full catalog (~100 parents, a few hundred sellable SKUs) is small enough to hold in
 * memory, so each warm container caches one snapshot and reloads only when the
 * `counters.catalog_version` document changes (bumped by every admin/linking write).
 */
const { money, round, CURRENCY } = require('./config');

const VERSION_KEY = 'catalog_version';
const SNAPSHOT_TTL_MS = 15000;
// Other containers' writes become visible within this window (own writes are immediate).
const VERSION_CHECK_MS = 3000;
const ROLE_DEFAULTS = ['image', 'small_image', 'thumbnail'];

let cached = null;

const b64 = (s) => Buffer.from(String(s)).toString('base64');
const unb64 = (s) => {
  try { return Buffer.from(String(s), 'base64').toString('utf8'); } catch { return ''; }
};

/** Magento-style configurable option uid. */
const optionUid = (optionId, valueId) => b64(`configurable/${optionId}/${valueId}`);
function parseOptionUid(uid) {
  const [kind, optionId, valueId] = unb64(uid).split('/');
  return kind === 'configurable' ? { optionId, valueId } : null;
}

async function getCatalogVersion(store) {
  const doc = await store.collection('counters').findOne({ key: VERSION_KEY });
  return doc?.value || 0;
}

async function bumpCatalogVersion(store) {
  await store.collection('counters').updateOne({ key: VERSION_KEY }, { $inc: { value: 1 } }, { upsert: true });
  cached = null;
}

function isActiveSpecial(price, now = Date.now()) {
  if (price?.special == null) return false;
  const from = price.specialFrom ? Date.parse(price.specialFrom) : -Infinity;
  const to = price.specialTo ? Date.parse(price.specialTo) : Infinity;
  return now >= from && now <= to;
}

function buildSnapshot({
  products, categories, prices, inventory, assetLinks, version,
}, options = {}) {
  const priceBySku = new Map(prices.map((p) => [p.sku, p]));
  const stockBySku = new Map(inventory.map((i) => [i.sku, i]));
  const imagesBySku = new Map();
  assetLinks
    .filter((l) => l.status !== 'removed' && l.url)
    .forEach((l) => {
      const list = imagesBySku.get(l.sku) || [];
      list.push(l);
      imagesBySku.set(l.sku, list);
    });
  imagesBySku.forEach((list) => list.sort((a, b) => (a.position ?? 99) - (b.position ?? 99)));

  const visible = products.filter((p) => p.status !== 'disabled');
  const bySku = new Map();
  const byVariantSku = new Map();
  const byUrlKey = new Map();
  visible.forEach((p) => {
    bySku.set(p.sku, p);
    byUrlKey.set(p.urlKey, p);
    (p.variants || []).forEach((v) => byVariantSku.set(v.sku, { parent: p, variant: v }));
  });

  return {
    version,
    loadedAt: Date.now(),
    placeholderImage: options.placeholderImage,
    siteOrigin: (options.siteOrigin || 'https://wknd-adventures.run.place').replace(/\/$/, ''),
    products: visible,
    allProducts: products,
    categories: [...categories].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    bySku,
    byVariantSku,
    byUrlKey,
    priceBySku,
    stockBySku,
    imagesBySku,
  };
}

const SNAPSHOT_COLLECTIONS = ['products', 'categories', 'prices', 'inventory', 'asset_links'];
const READ_ATTEMPTS = 3;
// Default cursor batches made a cold snapshot ~20 s of DB round trips from a distant region.
const SNAPSHOT_BATCH_SIZE = 1000;

class IncompleteReadError extends Error {}

/**
 * Reads a whole collection and verifies it against countDocuments, so a cursor that dies
 * part-way (which the DB SDK can surface as an empty/short result) never becomes the catalog.
 */
async function readComplete(store, name) {
  let last;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    /* eslint-disable no-await-in-loop */
    const [docs, count] = await Promise.all([
      store.collection(name).find({}, { batchSize: SNAPSHOT_BATCH_SIZE }),
      store.collection(name).countDocuments({}),
    ]);
    /* eslint-enable no-await-in-loop */
    if (docs.length >= count) return docs;
    last = `${name}: read ${docs.length} of ${count} documents`;
  }
  throw new IncompleteReadError(`Incomplete catalog read (${last})`);
}

async function loadCatalog(store, options = {}) {
  if (!options.fresh && cached && cached.store === store.kind && Date.now() - cached.checkedAt < VERSION_CHECK_MS) return cached;
  const version = await getCatalogVersion(store);
  if (!options.fresh && cached && cached.version === version && Date.now() - cached.loadedAt < SNAPSHOT_TTL_MS * 20) {
    cached.checkedAt = Date.now();
    return cached;
  }
  let collections;
  try {
    // sequential reads keep concurrent DB cursors per container low
    collections = [];
    for (let i = 0; i < SNAPSHOT_COLLECTIONS.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      collections.push(await readComplete(store, SNAPSHOT_COLLECTIONS[i]));
    }
  } catch (e) {
    // keep serving the last complete snapshot rather than a partial one (e.g. $0 prices)
    if (!options.fresh && e instanceof IncompleteReadError && cached && cached.store === store.kind) {
      cached.checkedAt = Date.now();
      return cached;
    }
    throw e;
  }
  const [products, categories, prices, inventory, assetLinks] = collections;
  cached = buildSnapshot({
    products, categories, prices, inventory, assetLinks, version,
  }, options);
  cached.checkedAt = Date.now();
  cached.store = store.kind;
  return cached;
}

function resetCatalogCache() {
  cached = null;
}

/* ---------- pricing & stock ---------- */

function priceFor(cat, sku, parentSku) {
  const p = cat.priceBySku.get(sku) || (parentSku && cat.priceBySku.get(parentSku));
  if (!p) return { regular: 0, final: 0 };
  const regular = round(p.regular);
  const final = isActiveSpecial(p) ? round(Math.min(p.special, p.regular)) : regular;
  return { regular, final };
}

function stockFor(cat, sku) {
  const s = cat.stockBySku.get(sku);
  const qty = s?.qty ?? 0;
  const threshold = s?.lowStockThreshold ?? 3;
  return {
    qty, inStock: qty > 0, lowStock: qty > 0 && qty <= threshold, threshold,
  };
}

function sellableSkus(product) {
  return product.type === 'configurable' ? (product.variants || []).map((v) => v.sku) : [product.sku];
}

function productInStock(cat, product) {
  return sellableSkus(product).some((sku) => stockFor(cat, sku).inStock);
}

function priceRangeFor(cat, product) {
  const list = sellableSkus(product).map((sku) => priceFor(cat, sku, product.sku));
  if (!list.length) return { min: { regular: 0, final: 0 }, max: { regular: 0, final: 0 } };
  const min = list.reduce((a, b) => (b.final < a.final ? b : a));
  const max = list.reduce((a, b) => (b.final > a.final ? b : a));
  return { min, max };
}

/* ---------- images ---------- */

function imagesFor(cat, sku, parentSku) {
  const own = cat.imagesBySku.get(sku) || [];
  const list = own.length ? own : (parentSku && cat.imagesBySku.get(parentSku)) || [];
  if (!list.length) {
    return cat.placeholderImage
      ? [{ url: cat.placeholderImage, label: '', roles: ROLE_DEFAULTS, position: 0 }]
      : [];
  }
  return list.map((l, i) => ({
    // Dynamic Media OpenAPI asset base — drop-ins derive optimised renditions from it
    url: l.url,
    alias: l.alias || 'product',
    label: l.label || '',
    roles: (l.roles && l.roles.length) ? l.roles : (i === 0 ? ROLE_DEFAULTS : []),
    position: l.position ?? i,
    assetId: l.assetId,
  }));
}

/**
 * Gallery for a configurable product narrowed to `variants` (e.g. the chosen colour):
 * the first matching variant's own images (colour shots), then the parent's shared images —
 * parent images not linked to any variant (lifestyle, detail shots). With no colour-specific
 * images the parent gallery is used unchanged.
 */
function variantGallery(cat, product, variants) {
  const withOwn = variants.find((v) => cat.imagesBySku.get(v.sku)?.length);
  if (!withOwn) return imagesFor(cat, product.sku);
  const variantAssets = new Set((product.variants || [])
    .flatMap((v) => (cat.imagesBySku.get(v.sku) || []).map((l) => l.assetId)));
  const own = imagesFor(cat, withOwn.sku);
  const ownAssets = new Set(own.map((i) => i.assetId));
  const shared = imagesFor(cat, product.sku)
    .filter((i) => i.assetId && !variantAssets.has(i.assetId) && !ownAssets.has(i.assetId));
  return [...own, ...shared].map((img, i) => ({
    ...img,
    position: i,
    roles: i === 0 ? [...new Set([...ROLE_DEFAULTS, ...(img.roles || [])])]
      : (img.roles || []).filter((r) => !ROLE_DEFAULTS.includes(r)),
  }));
}

/* ---------- Catalog Service mapping ---------- */

const ATTRIBUTE_LABELS = {
  brand: 'Brand',
  material: 'Material',
  activity: 'Activity',
  gender: 'Fit',
  weight_g: 'Weight (g)',
  waterproof_rating: 'Waterproof rating',
  capacity_l: 'Capacity (L)',
  warranty: 'Warranty',
  care: 'Care',
  adventure: 'Adventure',
};

function productUrl(cat, product) {
  return `${cat.siteOrigin}/shop/products/${product.urlKey}`;
}

function csAttributes(product) {
  const attrs = Object.entries(product.attributes || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([name, value]) => ({
      name,
      label: ATTRIBUTE_LABELS[name] || name,
      value: Array.isArray(value) ? value.join(', ') : value,
      roles: ['visible_in_pdp', 'visible_in_plp', 'visible_in_search'],
    }));
  if (product.tags?.length) {
    attrs.push({
      name: 'adventure_tags', label: 'Adventures', value: product.tags.join(', '), roles: ['visible_in_pdp'],
    });
  }
  return attrs;
}

function csPrice({ regular, final }) {
  return {
    roles: ['visible'],
    regular: { amount: { value: regular, currency: CURRENCY }, adjustments: [] },
    final: { amount: { value: final, currency: CURRENCY }, adjustments: [] },
    tiers: [],
  };
}

function filterImages(images, roles) {
  if (!roles || !roles.length) return images;
  return images.filter((img) => img.roles?.some((r) => roles.includes(r)));
}

function baseView(cat, product, { sku, name, images }) {
  return {
    id: b64(`product/${sku}`),
    sku,
    name,
    shortDescription: product.shortDescription || '',
    description: product.description || '',
    metaTitle: product.metaTitle || product.name,
    metaDescription: product.metaDescription || product.shortDescription || '',
    metaKeyword: product.metaKeyword || (product.tags || []).join(', '),
    url: productUrl(cat, product),
    urlKey: product.urlKey,
    externalId: product.externalId || product.sku,
    categories: product.categories || [],
    visibility: product.visibility || 'Catalog, Search',
    queryType: 'primary',
    lastModifiedAt: product.updatedAt || product.createdAt || null,
    videos: [],
    gallery: [],
    inputOptions: [],
    links: [],
    addToCartAllowed: true,
    // field resolvers read these
    allImages: images,
    attributeList: csAttributes(product),
  };
}

function toSimpleView(cat, product, variant) {
  const sku = variant ? variant.sku : product.sku;
  const stock = stockFor(cat, sku);
  const optionTitles = variant
    ? (product.options || []).map((o) => o.values.find((v) => v.id === variant.selections[o.id])?.title)
      .filter(Boolean)
    : [];
  return {
    __typename: 'SimpleProductView',
    ...baseView(cat, product, {
      sku,
      name: optionTitles.length ? `${product.name} — ${optionTitles.join(' / ')}` : product.name,
      images: variant ? variantGallery(cat, product, [variant]) : imagesFor(cat, sku),
    }),
    inStock: stock.inStock,
    lowStock: stock.lowStock,
    addToCartAllowed: stock.inStock,
    price: csPrice(priceFor(cat, sku, product.sku)),
  };
}

function csOptions(cat, product, selected = {}) {
  return (product.options || []).map((option) => ({
    id: option.id,
    title: option.title,
    required: true,
    multi: false,
    values: option.values.map((value) => {
      const candidates = (product.variants || []).filter((v) => v.selections[option.id] === value.id
        && Object.entries(selected).every(([oid, vid]) => oid === option.id || v.selections[oid] === vid));
      const inStock = candidates.some((v) => stockFor(cat, v.sku).inStock);
      const id = optionUid(option.id, value.id);
      if (value.swatch) {
        return {
          __typename: 'ProductViewOptionValueSwatch',
          id,
          title: value.title,
          type: value.swatch.startsWith('#') ? 'COLOR_HEX' : 'TEXT',
          value: value.swatch,
          inStock,
        };
      }
      return {
        __typename: 'ProductViewOptionValueSwatch', id, title: value.title, type: 'TEXT', value: value.title, inStock,
      };
    }),
  }));
}

function csPriceRange(range) {
  return { minimum: csPrice(range.min), maximum: csPrice(range.max) };
}

function toComplexView(cat, product, selected = {}) {
  const candidates = (product.variants || []).filter((v) => Object.entries(selected)
    .every(([oid, vid]) => v.selections[oid] === vid));
  const scoped = { ...product, variants: candidates };
  const inStock = productInStock(cat, scoped);
  return {
    __typename: 'ComplexProductView',
    ...baseView(cat, product, {
      sku: product.sku,
      name: product.name,
      // a partial selection (e.g. colour before size) already shows that colour's gallery
      images: Object.keys(selected).length
        ? variantGallery(cat, product, candidates) : imagesFor(cat, product.sku),
    }),
    inStock,
    lowStock: false,
    addToCartAllowed: inStock,
    options: csOptions(cat, product, selected),
    priceRange: csPriceRange(priceRangeFor(cat, scoped)),
  };
}

function toProductView(cat, product) {
  return product.type === 'configurable' ? toComplexView(cat, product) : toSimpleView(cat, product);
}

/** Look up a sellable or parent SKU and return its ProductView. */
function viewForSku(cat, sku) {
  const parent = cat.bySku.get(sku);
  if (parent) return toProductView(cat, parent);
  const hit = cat.byVariantSku.get(sku);
  return hit ? toSimpleView(cat, hit.parent, hit.variant) : null;
}

function refine(cat, sku, optionIds = []) {
  const product = cat.bySku.get(sku);
  if (!product) return null;
  if (product.type !== 'configurable') return toSimpleView(cat, product);
  const selected = {};
  optionIds.map(parseOptionUid).filter(Boolean).forEach(({ optionId, valueId }) => {
    selected[optionId] = valueId;
  });
  const allSelected = (product.options || []).every((o) => selected[o.id]);
  if (allSelected) {
    const variant = product.variants.find((v) => Object.entries(selected)
      .every(([oid, vid]) => v.selections[oid] === vid));
    if (variant) return toSimpleView(cat, product, variant);
  }
  return toComplexView(cat, product, selected);
}

function resolveVariant(cat, sku, selectedOptionUids = []) {
  const direct = cat.byVariantSku.get(sku);
  if (direct) return direct;
  const product = cat.bySku.get(sku);
  if (!product) return null;
  if (product.type !== 'configurable') return { parent: product, variant: null };
  const selected = {};
  selectedOptionUids.map(parseOptionUid).filter(Boolean).forEach(({ optionId, valueId }) => {
    selected[optionId] = valueId;
  });
  const variant = product.variants.find((v) => (product.options || [])
    .every((o) => v.selections[o.id] === selected[o.id]));
  return variant ? { parent: product, variant } : { parent: product, variant: null, incomplete: true };
}

/* ---------- Core (ProductInterface) mapping, used by cart & orders ---------- */

function corePriceRange(range) {
  const pr = (p) => ({
    regular_price: money(p.regular),
    final_price: money(p.final),
    discount: {
      amount_off: round(p.regular - p.final),
      percent_off: p.regular ? round(((p.regular - p.final) / p.regular) * 100) : 0,
    },
    fixed_product_taxes: [],
  });
  return { minimum_price: pr(range.min), maximum_price: pr(range.max) };
}

function categoryRefs(cat, product) {
  return (product.categories || []).map((path) => {
    const c = cat.categories.find((x) => x.urlPath === path);
    return {
      __typename: 'CategoryTree',
      uid: b64(`category/${path}`),
      name: c?.name || path,
      url_key: path.split('/').pop(),
      url_path: path,
      breadcrumbs: [],
    };
  });
}

function toCoreProduct(cat, product, variant) {
  const sku = variant ? variant.sku : product.sku;
  const stock = variant ? stockFor(cat, sku)
    : { qty: sellableSkus(product).reduce((n, s) => n + stockFor(cat, s).qty, 0), inStock: productInStock(cat, product) };
  const image = imagesFor(cat, sku, variant ? product.sku : null)[0];
  const range = variant
    ? { min: priceFor(cat, sku, product.sku), max: priceFor(cat, sku, product.sku) }
    : priceRangeFor(cat, product);
  const thumb = { url: image?.url || cat.placeholderImage || '', label: image?.label || product.name, position: 0, disabled: false };
  return {
    __typename: variant || product.type !== 'configurable' ? 'SimpleProduct' : 'ConfigurableProduct',
    uid: b64(`product/${sku}`),
    id: 0,
    sku,
    name: product.name,
    url_key: product.urlKey,
    canonical_url: `/shop/products/${product.urlKey}`,
    url_suffix: '',
    stock_status: stock.inStock ? 'IN_STOCK' : 'OUT_OF_STOCK',
    only_x_left_in_stock: stock.qty > 0 && stock.qty <= 3 ? stock.qty : null,
    quantity: stock.qty,
    thumbnail: thumb,
    small_image: thumb,
    image: thumb,
    media_gallery: [],
    price_range: corePriceRange(range),
    price_tiers: [],
    categories: categoryRefs(cat, product),
    gift_message_available: false,
    gift_wrapping_available: false,
    gift_wrapping_price: money(0),
    custom_attributesV2: { items: [], errors: [] },
    meta_title: product.metaTitle || product.name,
    meta_description: product.metaDescription || '',
    short_description: { html: product.shortDescription || '' },
    description: { html: product.description || '' },
    type_id: variant || product.type !== 'configurable' ? 'simple' : 'configurable',
    rating_summary: 0,
    review_count: 0,
    reviews: { items: [], page_info: { current_page: 1, page_size: 0, total_pages: 0 } },
    related_products: [],
    upsell_products: [],
    crosssell_products: [],
    options_container: 'container2',
    configurable_options: [],
    variants: [],
  };
}

module.exports = {
  IncompleteReadError,
  variantGallery,
  b64,
  unb64,
  optionUid,
  parseOptionUid,
  loadCatalog,
  buildSnapshot,
  resetCatalogCache,
  bumpCatalogVersion,
  getCatalogVersion,
  priceFor,
  stockFor,
  sellableSkus,
  productInStock,
  priceRangeFor,
  imagesFor,
  filterImages,
  toProductView,
  toSimpleView,
  toComplexView,
  viewForSku,
  refine,
  resolveVariant,
  toCoreProduct,
  productUrl,
  csAttributes,
};
