/**
 * promotions — IMS-protected RPC for the admin UI's Promotions screen.
 * POST { op: 'promotions.list' | ... , ...args }. Every call runs as the individually verified
 * IMS operator (see lib/promotions-admin.js); recovery-email runs can be approved but not sent here.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { decodeBody } = require('../../lib/http');
const { createPromotionsAdmin, imsOperatorFrom, OperatorError } = require('../../lib/promotions-admin');

async function main(params) {
  const logger = logging('promotions-admin', { level: params.LOG_LEVEL || 'info' });
  let actor;
  try {
    actor = imsOperatorFrom(params.__ow_headers || {}, params);
  } catch (e) {
    return { statusCode: e.status || 401, body: { error: e.message } };
  }
  const body = params.__ow_body ? decodeBody(params) : params;
  const { op, ...args } = body || {};
  let store;
  try {
    store = await getStore(params);
    const adminApi = createPromotionsAdmin({ store, params });
    const result = await adminApi.handle(actor, op, args);
    return { statusCode: 200, body: result };
  } catch (e) {
    if (e instanceof OperatorError) return { statusCode: e.status, body: { error: e.message } };
    logger.error(e.message);
    return { statusCode: 500, body: { error: 'Server error' } };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
