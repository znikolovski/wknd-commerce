/**
 * storefront-graphql — the mock Adobe Commerce GraphQL backend (Core + Catalog Service).
 * Fronted by API Mesh; also callable directly for local development and contract tests.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore, resetDbClient } = require('../../lib/store');
const { runGraphQL } = require('../../lib/graphql-server');
const { parseRequest, corsHeaders, json } = require('../../lib/http');

async function main(params) {
  const logger = logging('storefront-graphql', { level: params.LOG_LEVEL || 'info' });
  const headers = params.__ow_headers || {};
  const cors = corsHeaders(params, headers.origin);
  if ((params.__ow_method || '').toLowerCase() === 'options') {
    return { statusCode: 204, headers: { ...cors, 'Access-Control-Max-Age': '600' } };
  }
  let store;
  try {
    const req = parseRequest(params);
    store = await getStore(params);
    const { body, cacheable } = await runGraphQL({ ...req, headers }, { store, params });
    if (body.errors) logger.debug(JSON.stringify(body.errors).slice(0, 2000));
    return json(200, body, {
      ...cors,
      'Cache-Control': cacheable ? `public, max-age=${params.CATALOG_MAX_AGE || 60}` : 'no-store',
    });
  } catch (e) {
    logger.error(e);
    resetDbClient();
    const detail = params.LOG_LEVEL === 'debug' ? { detail: String(e?.stack || e).slice(0, 1500) } : {};
    return json(500, { errors: [{ message: 'Internal server error', extensions: { category: 'internal', ...detail } }] }, cors);
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
