const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { AdminError } = require('../../lib/admin');
const panel = require('../../lib/asset-panel');
const { decodeBody } = require('../../lib/http');
const { triggerPrerender } = require('../../lib/invoke');

const OPS = { 'products.search': panel.searchProducts, 'asset.get': panel.getAsset, 'asset.save': panel.saveAsset };

async function main(params) {
  const logger = logging('commerce-assets', { level: params.LOG_LEVEL || 'info' });
  const response = (statusCode, body) => ({
    statusCode, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }, body,
  });
  if (params.__ow_method?.toLowerCase() !== 'post') return response(405, { error: 'Use POST.' });
  const headers = params.__ow_headers || {};
  const authorization = headers.authorization || headers.Authorization || '';
  const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
  if (!token) return response(401, { error: 'Sign in to AEM Assets.' });
  if (!params.ADMIN_IMS_ORG || headers['x-gw-ims-org-id'] !== params.ADMIN_IMS_ORG) {
    return response(403, { error: 'This IMS organisation cannot manage WKND commerce assets.' });
  }
  let store;
  try {
    const input = params.__ow_body ? decodeBody(params) : params;
    const operation = Object.hasOwn(OPS, input.op) ? OPS[input.op] : null;
    if (!operation) throw new AdminError('Choose products.search, asset.get or asset.save.');
    const configured = new URL(params.AEM_AUTHOR_URL);
    if (configured.protocol !== 'https:' || configured.username || configured.password
      || configured.pathname !== '/' || configured.search || configured.hash
      || input.authorUrl !== configured.origin) throw new AdminError('This panel is configured for a different AEM author.', 403);
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || !/^[a-z0-9_-]{1,256}$/i.test(input.apiKey))) {
      throw new AdminError('The Assets host API key is invalid.');
    }
    store = await getStore(params);
    const userParams = { ...params, AEM_ACCESS_TOKEN: token, AEM_API_KEY: input.apiKey };
    const result = input.op === 'products.search'
      ? await operation(store, input) : await operation(store, userParams, input);
    if (result.affected?.length) {
      try { await triggerPrerender(params, result.affected); } catch (error) {
        logger.error(error);
        result.warning = [result.warning, 'Links saved, but storefront page refresh could not be scheduled. Retry the product refresh in Commerce admin.'].filter(Boolean).join(' ');
      }
    }
    return response(200, result);
  } catch (error) {
    logger.error(error);
    return response(error instanceof AdminError ? error.status : 500, {
      error: error instanceof AdminError ? error.message : 'Commerce asset management failed. Retry or contact the store administrator.',
    });
  } finally {
    if (store) await store.close().catch((error) => logger.error(error));
  }
}

exports.main = main;
