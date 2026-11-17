/**
 * Server-rendered product detail page markup for Edge Delivery Services (BYOM content overlay).
 * The `product-details` block is hydrated by the PDP drop-in on the client; the static content
 * here (name, price, SKU/stock, gallery, description, specs, promises and recommendations)
 * keeps everything a shopper sees readable by crawlers and LLM agents that don't run JavaScript,
 * Content AI and OF1; the metadata block carries SEO + JSON-LD. The blocks replace it on render.
 */
const {
  priceRangeFor, imagesFor, productInStock, csAttributes,
} = require('./catalog');
const { renditionUrl } = require('./aem');

// Mirrors SHOP_PROMISES (shipping, warranty, tested) in the storefront's scripts/shop-promises.js
const PDP_PROMISES = [
  ['Free standard shipping', 'Australia-wide on orders over $150'],
  ['3-year Trail Promise', 'Repairs or replacement on every WKND product'],
  ['Guide tested', 'Proven by WKND guides on real expeditions'],
];
const REC_UNITS = ['wknd-pdp-complete-kit', 'wknd-pdp-more-like-this'];

/** Optimised Dynamic Media OpenAPI rendition (falls back to the URL for non-DM placeholders). */
const rendition = (img, width = 1200) => renditionUrl(img.url, img.alias, { width, format: 'jpg' });

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const aud = (n) => `A$${Number(n).toFixed(2)}`;

/** Allow only the small tag set our catalog descriptions use. */
function safeHtml(html = '') {
  return String(html)
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<(?!\/?(p|ul|ol|li|strong|em|br|b|i)\b)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function row(key, value) {
  return `<div><div>${esc(key)}</div><div>${value}</div></div>`;
}

function jsonLd(cat, product, url, images) {
  const range = priceRangeFor(cat, product);
  const inStock = productInStock(cat, product);
  const offer = range.min.final === range.max.final
    ? {
      '@type': 'Offer', price: range.min.final.toFixed(2), priceCurrency: 'AUD', availability: `https://schema.org/${inStock ? 'InStock' : 'OutOfStock'}`, url,
    }
    : {
      '@type': 'AggregateOffer', lowPrice: range.min.final.toFixed(2), highPrice: range.max.final.toFixed(2), priceCurrency: 'AUD', offerCount: (product.variants || []).length || 1, availability: `https://schema.org/${inStock ? 'InStock' : 'OutOfStock'}`,
    };
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    sku: product.sku,
    name: product.name,
    description: product.shortDescription || product.metaDescription || '',
    image: images.map((i) => rendition(i)),
    brand: { '@type': 'Brand', name: product.attributes?.brand || 'WKND' },
    category: (product.categories || [])[0],
    url,
    offers: offer,
    ...(product.attributes?.material ? { material: product.attributes.material } : {}),
  };
}

function recommendationRows(cat, recommendations, unitId) {
  const rec = recommendations.find((r) => r.unit.unitId === unitId);
  if (!rec?.products.length) return '';
  const items = rec.products.map((p) => {
    const r = priceRangeFor(cat, p);
    const from = r.min.final === r.max.final ? aud(r.min.final) : `From ${aud(r.min.final)}`;
    return `<li><a href="/shop/products/${esc(p.urlKey)}">${esc(p.name)}</a> (${esc(p.sku)}) — ${esc(from)}</li>`;
  }).join('');
  return row('products', `<h2>${esc(rec.unit.storefrontLabel)}</h2><ul>${items}</ul>`);
}

/**
 * @param {{ siteOrigin?: string, recommendations?: Array<{ unit: object, products: object[] }> }} [opts]
 *   recommendations from productsForUnits(); rendered as plain product lists for agents
 */
function renderPdp(cat, product, { siteOrigin, recommendations = [] } = {}) {
  const origin = (siteOrigin || cat.siteOrigin).replace(/\/$/, '');
  const url = `${origin}/shop/products/${product.urlKey}`;
  const images = imagesFor(cat, product.sku);
  const range = priceRangeFor(cat, product);
  const price = range.min.final === range.max.final ? aud(range.min.final) : `From ${aud(range.min.final)}`;
  const onSale = range.min.final < range.min.regular;
  const category = cat.categories.find((c) => c.urlPath === (product.categories || [])[0]);
  // only top-level categories have pages (/shop/apparel); sub-categories are listing filters
  const top = cat.categories.find((c) => c.urlPath === ((product.categories || [])[0] || '').split('/')[0]);
  const specs = csAttributes(product).filter((a) => a.name !== 'adventure_tags')
    .map((a) => `<li><strong>${esc(a.label)}:</strong> ${esc(a.value)}</li>`).join('');
  const options = (product.options || []).map((o) => `<p><strong>${esc(o.title)}:</strong> ${o.values.map((v) => esc(v.title)).join(', ')}</p>`).join('');
  // Images stay on Dynamic Media OpenAPI: links (not <picture>) so EDS never ingests them into the
  // media bus; product-details renders responsive DM renditions from these on the client.
  const gallery = images.length ? `<ul>${images.slice(0, 8).map((img, i) => `<li><a href="${esc(rendition(img, 2000))}">${esc(img.label || `${product.name} — image ${i + 1}`)}</a></li>`).join('')}</ul>` : '';
  const ld = JSON.stringify(jsonLd(cat, product, url, images));

  const metadata = [
    row('title', esc(product.metaTitle || `${product.name} | WKND Adventures Shop`)),
    row('description', esc(product.metaDescription || product.shortDescription)),
    row('keywords', esc(product.metaKeyword || (product.tags || []).join(', '))),
    row('sku', esc(product.sku)),
    row('template', 'product'),
    row('product-category', esc((product.categories || [])[0] || '')),
    row('adventurecategory', esc((product.tags || [])[0] || '')),
    row('og:type', 'product'),
    images[0] ? row('og:image', esc(rendition(images[0], 1200))) : '',
    images[0] ? row('twitter:image', esc(rendition(images[0], 1200))) : '',
    row('json-ld', esc(ld)),
    row('canonical', esc(url)),
  ].join('');

  // Title and canonical live only in the metadata block: a <head> <title> makes EDS append a
  // second, title-only metadata block to the body.
  return `<!DOCTYPE html>
<html>
<head></head>
<body>
<header></header>
<main>
<div>
<p><a href="/shop/">Shop</a> › ${top ? `<a href="/shop/${esc(top.urlPath)}">${esc(top.name)}</a>` : 'Gear'}${category && category !== top ? ` › ${esc(category.name)}` : ''}</p>
<div class="product-details">
<div><div>
<h1>${esc(product.name)}</h1>
<p><strong>${esc(price)}</strong>${onSale ? ` <em>Sale — was ${esc(aud(range.min.regular))}</em>` : ''} Includes GST · Free standard shipping in Australia over $150</p>
<p>${esc(product.shortDescription)}</p>
<p>SKU: ${esc(product.sku)} · ${productInStock(cat, product) ? 'In stock' : 'Out of stock'}</p>
${gallery}
${options}
<h3>Details</h3>
${safeHtml(product.description)}
<h2>Specifications</h2>
<ul>${specs}</ul>
${product.tags?.length ? `<h3>Made for</h3><p>${product.tags.map((t) => esc(t.replace(/-/g, ' '))).join(', ')}</p>` : ''}
<h3>The WKND promise</h3>
<ul>${PDP_PROMISES.map(([title, caption]) => `<li><strong>${esc(title)}</strong> — ${esc(caption)}</li>`).join('')}</ul>
</div></div>
</div>
<div class="metadata">${metadata}</div>
</div>
<div>
${REC_UNITS.map((id) => `<div class="product-recommendations">${row('unit-id', id)}${recommendationRows(cat, recommendations, id)}</div>`).join('\n')}
</div>
</main>
<footer></footer>
</body>
</html>`;
}

/** Path helpers shared by the overlay and the publisher. */
const PDP_PREFIX = '/shop/products/';
const pdpPath = (product) => `${PDP_PREFIX}${product.urlKey}`;
function urlKeyFromPath(path = '') {
  const clean = String(path).replace(/\.(plain\.)?html$/, '').replace(/\.md$/, '').replace(/\/$/, '');
  if (!clean.startsWith(PDP_PREFIX)) return null;
  const key = clean.slice(PDP_PREFIX.length);
  return /^[a-z0-9-]+$/.test(key) ? key : null;
}

module.exports = {
  renderPdp, jsonLd, pdpPath, urlKeyFromPath, safeHtml, PDP_PREFIX, REC_UNITS,
};
