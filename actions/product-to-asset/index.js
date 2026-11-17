/**
 * product-to-asset — Adobe Commerce AEM Assets Integration custom-matcher endpoint.
 * Request: { productSku }  Response: { product_sku, asset_matches[], skip }
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { loadCatalog } = require('../../lib/catalog');
const { matchProductToAssets } = require('../../lib/linking');
const aem = require('../../lib/aem');
const { decodeBody } = require('../../lib/http');

async function main(params) {
  const logger = logging('product-to-asset', { level: params.LOG_LEVEL || 'info' });
  const input = { ...decodeBody(params), ...params };
  const sku = String(input.productSku || '').toUpperCase();
  if (!sku) return { statusCode: 400, body: { error: 'productSku is required' } };
  let store;
  try {
    store = await getStore(params);
    const cat = await loadCatalog(store);
    const assets = await aem.queryProductAssets(params, { sku });
    const body = matchProductToAssets(cat, sku, assets, { root: params.AEM_PRODUCTS_ROOT });
    logger.info(`${sku}: ${body.asset_matches.length} assets`);
    return { statusCode: 200, body };
  } catch (e) {
    logger.error(e);
    return { statusCode: 500, body: { error: 'matching failed' } };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
