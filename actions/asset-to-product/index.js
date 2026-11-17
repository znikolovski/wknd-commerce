/**
 * asset-to-product — Adobe Commerce AEM Assets Integration custom-matcher endpoint.
 * Request: { assetId, eventData: { assetMetadata } }  Response: { asset_id, product_matches[], skip }
 * Pure matcher (no writes) so it can be registered with a real Commerce instance unchanged.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { loadCatalog } = require('../../lib/catalog');
const { matchAssetToProducts } = require('../../lib/linking');
const aem = require('../../lib/aem');
const { decodeBody } = require('../../lib/http');

async function main(params) {
  const logger = logging('asset-to-product', { level: params.LOG_LEVEL || 'info' });
  const input = { ...decodeBody(params), ...params };
  const assetId = input.assetId || aem.findUrn(input.eventData);
  if (!assetId) return { statusCode: 400, body: { error: 'assetId is required' } };
  let store;
  try {
    store = await getStore(params);
    const cat = await loadCatalog(store);
    let asset = {
      assetId,
      assetMetadata: input.eventData?.assetMetadata,
      repositoryMetadata: input.eventData?.repositoryMetadata || {},
    };
    if (!asset.assetMetadata) asset = { assetId, ...(await aem.getAssetMetadata(params, assetId)) };
    const { unmatched, rule, ...body } = matchAssetToProducts(cat, asset, { root: params.AEM_PRODUCTS_ROOT });
    logger.info(`${assetId}: ${body.product_matches.length} matches via ${rule}${unmatched.length ? `, unknown ${unmatched.join(',')}` : ''}`);
    return { statusCode: 200, body };
  } catch (e) {
    logger.error(e);
    return { statusCode: 500, body: { error: 'matching failed' } };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
