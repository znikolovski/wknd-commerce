/**
 * promotions — IMS-protected RPC for the admin UI's Promotions screen.
 * POST { op: 'promotions.list' | ... , ...args }. Every call runs as the individually verified
 * IMS operator (see lib/promotions-admin.js); recovery-email runs can be approved but not sent here.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { decodeBody } = require('../../lib/http');
const { createPromotionsAdmin, imsOperatorFrom, OperatorError } = require('../../lib/promotions-admin');
const { CONFIG_KEYS } = require('../../lib/target-diagnostic-action');

const RUNTIME_INPUT_KEYS = new Set([
  ...CONFIG_KEYS,
  'ADMIN_IMS_ORG', 'AEM_AUTHOR_URL', 'AEM_PRODUCTS_ROOT', 'CONTENT_AI_URL', 'CONTENT_AI_SOURCE',
  'PRERENDER_ACTION', 'PROMOTION_CURSOR_KEY', 'PROMOTION_SELECTION', 'RECOVERY_REDEMPTION_VERIFIED',
  'BREVO_RECOVERY_TEMPLATE_ID', 'RECOVERY_EMAIL_ALLOWLIST', 'RECOVERY_EMAIL_DAILY_BUDGET',
  'STAGE_AAM_GENERAL_OFFERS_ENABLED',
]);

function operationBody(params) {
  if (Object.hasOwn(params, '__ow_body')) return decodeBody(params);
  // Non-raw Runtime calls merge final action inputs and transport fields into request parameters.
  return Object.fromEntries(Object.entries(params).filter(([key]) => !RUNTIME_INPUT_KEYS.has(key)
    && !/^__(?:ow|ims)_/.test(key) && key !== '__OW_NAMESPACE'));
}

async function main(params) {
  const logger = logging('promotions-admin', { level: params.LOG_LEVEL || 'info' });
  let actor;
  try {
    actor = imsOperatorFrom(params.__ow_headers || {}, params);
  } catch (e) {
    return { statusCode: e.status || 401, body: { error: e.message } };
  }
  const body = operationBody(params);
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
