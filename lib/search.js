/**
 * Live Search / Catalog Service style productSearch over the in-memory catalog snapshot.
 */
const {
  toProductView, toCoreProduct, priceRangeFor, productInStock, b64, optionUid, toSimpleView,
} = require('./catalog');

const FACET_ATTRIBUTES = [
  { attribute: 'categoryPath', label: 'Category', numeric: false },
  { attribute: 'price', label: 'Price', numeric: true },
  { attribute: 'activity', label: 'Activity', numeric: false },
  { attribute: 'adventure', label: 'Adventure', numeric: false },
  { attribute: 'color', label: 'Colour', numeric: false },
  { attribute: 'size', label: 'Size', numeric: false },
  { attribute: 'gender', label: 'Fit', numeric: false },
  { attribute: 'brand', label: 'Brand', numeric: false },
];

const SORTABLE = [
  { attribute: 'relevance', label: 'Most relevant', numeric: false },
  { attribute: 'position', label: 'Featured', numeric: true },
  { attribute: 'price', label: 'Price', numeric: true },
  { attribute: 'name', label: 'Name', numeric: false },
  { attribute: 'newest', label: 'Newest', numeric: false },
];

const PRICE_BUCKETS = [[0, 50], [50, 100], [100, 200], [200, 400], [400, null]];

function attributeMetadata() {
  return {
    sortable: SORTABLE.map((s) => ({ ...s, frontendInput: s.numeric ? 'price' : 'text' })),
    filterableInSearch: FACET_ATTRIBUTES.map((f) => ({ ...f, frontendInput: f.numeric ? 'price' : 'select' })),
  };
}

const norm = (s) => String(s || '').toLowerCase();
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 1);

function optionTitles(product, optionId) {
  const opt = (product.options || []).find((o) => o.id === optionId);
  return opt ? opt.values.map((v) => v.title) : [];
}

/** Values of a facet attribute for one product (arrays allowed). */
function facetValues(cat, product, attribute) {
  switch (attribute) {
    case 'categoryPath': {
      const paths = new Set();
      (product.categories || []).forEach((p) => {
        const parts = p.split('/');
        parts.forEach((_, i) => paths.add(parts.slice(0, i + 1).join('/')));
      });
      return [...paths];
    }
    case 'categoryIds': return product.categories || [];
    case 'adventure': return product.tags || [];
    case 'color': return optionTitles(product, 'color');
    case 'size': return optionTitles(product, 'size');
    case 'price': return [priceRangeFor(cat, product).min.final];
    case 'sku': return [product.sku, ...(product.variants || []).map((v) => v.sku)];
    case 'visibility': return [product.visibility || 'Catalog, Search'];
    case 'inStock': return [String(productInStock(cat, product))];
    default: {
      const v = product.attributes?.[attribute];
      if (v == null) return [];
      return Array.isArray(v) ? v.map(String) : [String(v)];
    }
  }
}

function matchesClause(cat, product, clause) {
  const values = facetValues(cat, product, clause.attribute);
  const lower = values.map(norm);
  if (clause.eq != null) return lower.includes(norm(clause.eq));
  if (clause.in) return clause.in.some((v) => lower.includes(norm(v)));
  if (clause.contains != null) return lower.some((v) => v.includes(norm(clause.contains)));
  if (clause.startsWith != null) return lower.some((v) => v.startsWith(norm(clause.startsWith)));
  if (clause.range) {
    const { from, to } = clause.range;
    return values.some((v) => Number(v) >= (from ?? -Infinity) && Number(v) <= (to ?? Infinity));
  }
  return true;
}

function score(cat, product, phraseTokens) {
  if (!phraseTokens.length) return 1;
  const fields = [
    [product.name, 6], [product.sku, 8], [(product.tags || []).join(' '), 4],
    [(product.categories || []).join(' '), 3], [Object.values(product.attributes || {}).join(' '), 2],
    [product.shortDescription, 2], [product.description, 1],
    [(product.options || []).flatMap((o) => o.values.map((v) => v.title)).join(' '), 2],
  ];
  let total = 0;
  let matchedTokens = 0;
  phraseTokens.forEach((t) => {
    let hit = false;
    fields.forEach(([text, weight]) => {
      const words = tokens(text);
      if (words.includes(t)) { total += weight; hit = true; } else if (words.some((w) => w.startsWith(t) || (t.length > 3 && w.startsWith(t.slice(0, -1))))) {
        total += weight / 2; hit = true;
      }
    });
    if (hit) matchedTokens += 1;
  });
  // require at least half of the query tokens to match
  return matchedTokens >= Math.ceil(phraseTokens.length / 2) ? total : 0;
}

function buildFacets(cat, products) {
  return FACET_ATTRIBUTES.map(({ attribute, label }, position) => {
    let buckets;
    if (attribute === 'price') {
      buckets = PRICE_BUCKETS.map(([from, to]) => ({
        __typename: 'RangeBucket',
        title: to ? `$${from}–$${to}` : `$${from}+`,
        from,
        to,
        count: products.filter((p) => {
          const v = priceRangeFor(cat, p).min.final;
          return v >= from && (to == null || v < to);
        }).length,
      })).filter((b) => b.count > 0);
    } else {
      const counts = new Map();
      products.forEach((p) => new Set(facetValues(cat, p, attribute)).forEach((v) => counts.set(v, (counts.get(v) || 0) + 1)));
      buckets = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => {
        if (attribute === 'categoryPath') {
          const c = cat.categories.find((x) => x.urlPath === value);
          return {
            __typename: 'CategoryView',
            id: b64(`category/${value}`),
            title: c?.name || value,
            name: c?.name || value,
            path: value,
            urlPath: value,
            urlKey: value.split('/').pop(),
            parentId: c?.parent || '',
            level: value.split('/').length,
            roles: ['show_in_menu', 'active'],
            children: [],
            count,
          };
        }
        return {
          __typename: 'ScalarBucket', id: b64(`${attribute}/${value}`), title: value, count,
        };
      });
    }
    return {
      attribute,
      attribute_code: attribute,
      title: label,
      label,
      type: attribute === 'price' ? 'INTELLIGENT' : 'PINNED',
      position,
      count: buckets.length,
      buckets,
      options: buckets.map((b) => ({ label: b.title, value: b.title, count: b.count })),
    };
  }).filter((f) => f.buckets.length);
}

function sortProducts(cat, scored, sort = []) {
  const [first] = sort || [];
  const dir = first?.direction === 'DESC' ? -1 : 1;
  const by = first?.attribute || 'relevance';
  return [...scored].sort((a, b) => {
    switch (by) {
      case 'price': return dir * (priceRangeFor(cat, a.product).min.final - priceRangeFor(cat, b.product).min.final);
      case 'name': return dir * a.product.name.localeCompare(b.product.name);
      case 'newest': return -dir * String(a.product.createdAt || '').localeCompare(String(b.product.createdAt || ''));
      case 'position': return dir * ((a.product.position ?? 999) - (b.product.position ?? 999));
      default: return (b.score - a.score) || ((a.product.position ?? 999) - (b.product.position ?? 999));
    }
  });
}

function productSearch(cat, {
  phrase = '', filter = [], sort = [], page_size: pageSize = 12, current_page: currentPage = 1,
}) {
  const phraseTokens = tokens(phrase);
  const scored = cat.products
    .map((product) => ({ product, score: score(cat, product, phraseTokens) }))
    .filter((s) => s.score > 0)
    .filter((s) => (filter || []).every((clause) => matchesClause(cat, s.product, clause)));
  const sorted = sortProducts(cat, scored, sort);
  const size = Math.max(1, Math.min(pageSize || 12, 100));
  const page = Math.max(1, currentPage || 1);
  const items = sorted.slice((page - 1) * size, page * size).map(({ product }) => ({
    productView: toProductView(cat, product),
    product: toCoreProduct(cat, product),
    highlights: phraseTokens.length
      ? [{ attribute: 'name', value: product.name, matched_words: phraseTokens.filter((t) => norm(product.name).includes(t)) }]
      : [],
  }));
  return {
    total_count: sorted.length,
    items,
    facets: buildFacets(cat, sorted.map((s) => s.product)),
    page_info: { current_page: page, page_size: size, total_pages: Math.max(1, Math.ceil(sorted.length / size)) },
    suggestions: [],
    related_terms: [],
    warnings: [],
  };
}

function categoryViews(cat, { ids, subtree } = {}) {
  const all = cat.categories.map((c) => ({
    __typename: 'CategoryView',
    id: c.urlPath,
    name: c.name,
    title: c.name,
    path: c.urlPath,
    urlPath: c.urlPath,
    urlKey: c.urlPath.split('/').pop(),
    parentId: c.parent || '',
    level: c.urlPath.split('/').length,
    position: c.position ?? 0,
    roles: ['show_in_menu', 'active'],
    children: cat.categories.filter((x) => x.parent === c.urlPath).map((x) => x.urlPath),
    availableSortBy: SORTABLE.map((s) => s.attribute),
    defaultSortBy: 'position',
    count: cat.products.filter((p) => (p.categories || []).some((pc) => pc === c.urlPath || pc.startsWith(`${c.urlPath}/`))).length,
  }));
  if (!ids || !ids.length) return all;
  const depth = subtree?.depth ?? 0;
  return all.filter((c) => ids.some((id) => c.id === id
    || (depth > 0 && c.id.startsWith(`${id}/`) && c.level - id.split('/').length <= depth)));
}

function variants(cat, { sku, optionIds = [] }) {
  const product = cat.bySku.get(sku);
  if (!product || product.type !== 'configurable') return { variants: [], cursor: null };
  const wanted = optionIds || [];
  const list = product.variants
    .map((v) => ({
      selections: (product.options || []).map((o) => optionUid(o.id, v.selections[o.id])),
      product: toSimpleView(cat, product, v),
    }))
    .filter((v) => wanted.every((id) => v.selections.includes(id)));
  return { variants: list, cursor: null };
}

module.exports = {
  attributeMetadata, productSearch, categoryViews, variants, facetValues, tokens,
};
