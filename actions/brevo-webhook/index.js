/**
 * brevo-webhook — Brevo transactional webhook (unsubscribed, hard_bounce, spam, blocked…).
 * Authenticated with `Authorization: Bearer <BREVO_WEBHOOK_TOKEN>`; idempotent suppression.
 * Web action (raw), no IMS: Brevo cannot present Adobe credentials.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { handleBrevoWebhook } = require('../../lib/recovery-email');

function parseBody(params) {
  if (params.__ow_body) {
    try {
      const raw = Buffer.from(params.__ow_body, 'base64').toString('utf8');
      return JSON.parse(raw);
    } catch (e) {
      try {
        return JSON.parse(params.__ow_body);
      } catch (err) {
        return null;
      }
    }
  }
  return params.event ? { event: params.event, email: params.email } : null;
}

async function main(params) {
  const logger = logging('brevo-webhook', { level: params.LOG_LEVEL || 'info' });
  if ((params.__ow_method || 'post').toLowerCase() !== 'post') return { statusCode: 405 };
  const body = parseBody(params);
  if (!body) return { statusCode: 400 };
  let store;
  try {
    store = await getStore(params);
    const res = await handleBrevoWebhook(store, { headers: params.__ow_headers || {}, body, params });
    return { statusCode: res.status, body: { ok: res.status === 200 } };
  } catch (e) {
    logger.error(e.message);
    return { statusCode: 500, body: { ok: false } };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
