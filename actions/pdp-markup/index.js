/**
 * pdp-markup — BYOM content overlay for Edge Delivery Services.
 * EDS requests `<overlay-url>/shop/products/<url-key>` when a product page is previewed;
 * anything else returns 404 so the primary (DA) content source is used.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { loadCatalog } = require('../../lib/catalog');
const { renderPdp, urlKeyFromPath } = require('../../lib/pdp');

async function main(params) {
  const logger = logging('pdp-markup', { level: params.LOG_LEVEL || 'info' });
  const path = params.__ow_path || params.path || '';
  const urlKey = urlKeyFromPath(path);
  if (!urlKey) return { statusCode: 404, body: '' };
  let store;
  try {
    store = await getStore(params);
    const cat = await loadCatalog(store, { placeholderImage: params.PLACEHOLDER_IMAGE, siteOrigin: params.SITE_ORIGIN });
    const product = cat.byUrlKey.get(urlKey);
    if (!product) return { statusCode: 404, body: '' };
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Last-Modified': new Date(product.updatedAt || Date.now()).toUTCString() },
      body: renderPdp(cat, product, { siteOrigin: params.SITE_ORIGIN }),
    };
  } catch (e) {
    logger.error(e);
    return { statusCode: 502, body: '' };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
