/**
 * asset-events — I/O Events consumer for AEM Assets (provider: aemassets, p115476-e1135027).
 * Mimics the Commerce "Match by SKU"/custom-matcher sync: on metadata/delivery changes the asset
 * is matched to products and the product media gallery (`asset_links`) is updated; on delete or
 * delivery removal the asset is unlinked. Affected PDPs are re-rendered.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { loadCatalog } = require('../../lib/catalog');
const linking = require('../../lib/linking');
const aem = require('../../lib/aem');
const { triggerPrerender } = require('../../lib/invoke');

const UPSERT_EVENTS = new Set([
  'aem.assets.asset.metadata_updated',
  'aem.assets.asset.ready_for_delivery',
  'aem.assets.asset.published',
  'aem.assets.asset.processing_completed',
]);
const REMOVE_EVENTS = new Set(['aem.assets.asset.deleted', 'aem.assets.asset.removed_from_delivery']);

async function main(params) {
  const logger = logging('asset-events', { level: params.LOG_LEVEL || 'info' });
  // I/O Events challenge for webhook-style registrations
  if (params.challenge) return { statusCode: 200, body: { challenge: params.challenge } };

  const event = params.event || params;
  const type = event.type || params.type;
  const assetId = aem.findUrn(event.data) || aem.findUrn(event);
  const path = event.data?.repositoryMetadata?.['repo:path'] || event.data?.path;
  const root = params.AEM_PRODUCTS_ROOT || aem.DEFAULT_PRODUCTS_ROOT;
  if (!assetId || (!UPSERT_EVENTS.has(type) && !REMOVE_EVENTS.has(type))) {
    return { statusCode: 200, body: { ignored: true, type } };
  }
  if (path && !path.startsWith(root)) return { statusCode: 200, body: { ignored: true, reason: 'outside products root' } };

  let store;
  try {
    store = await getStore(params);
    const eventId = event.id || params.id;
    if (eventId && await store.collection('events').findOne({ id: eventId })) {
      return { statusCode: 200, body: { duplicate: true } };
    }
    let result;
    if (REMOVE_EVENTS.has(type)) {
      result = await linking.removeAsset(store, assetId);
    } else {
      const cat = await loadCatalog(store);
      const asset = { assetId, ...(await aem.getAssetMetadata(params, assetId)) };
      if (asset.repositoryMetadata?.['repo:path'] && !asset.repositoryMetadata['repo:path'].startsWith(root)) {
        return { statusCode: 200, body: { ignored: true, reason: 'outside products root' } };
      }
      const match = linking.matchAssetToProducts(cat, asset, { root });
      result = { rule: match.rule, ...(await linking.applyAssetMatches(store, params, asset, match, 'event', { catalog: cat })) };
    }
    // Record only after success so I/O Events retries of failed deliveries are reprocessed.
    if (eventId) await store.collection('events').insertOne({ id: eventId, type, assetId, receivedAt: new Date().toISOString() });
    if (result.affected?.length) await triggerPrerender(params, result.affected).catch((e) => logger.warn(e.message));
    logger.info(`${type} ${assetId}: ${JSON.stringify(result)}`);
    return { statusCode: 200, body: result };
  } catch (e) {
    logger.error(e);
    // non-2xx makes I/O Events retry
    return { statusCode: 500, body: { error: e.message } };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
