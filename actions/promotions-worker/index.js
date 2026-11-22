/**
 * promotions-worker — scheduled (e.g. every 5 minutes). Resolves stale promotion mutation
 * requests, retries unsettled promotion effects, marks crashed recovery-email claims as
 * unknown (never resent) and, when BREVO_API_KEY is configured, executes at most one
 * human-approved recovery-email run. Not an MCP tool; no customer data in its output.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { loadCatalog } = require('../../lib/catalog');
const { createPromotionService } = require('../../lib/promotions');
const { createRecoveryEmail, executeNextApprovedRun } = require('../../lib/recovery-email');

async function main(params) {
  const logger = logging('promotions-worker', { level: params.LOG_LEVEL || 'info' });
  let store;
  try {
    store = await getStore(params);
    const svc = createPromotionService({ store, loadCatalog: () => loadCatalog(store), params });
    const promotions = await svc.recoverRequests();
    const staleEmailClaims = await createRecoveryEmail({ store, params }).reconcileStaleClaims();
    let email;
    try {
      email = await executeNextApprovedRun({ store, params });
    } catch (e) {
      logger.error(e);
      email = { state: 'error' };
    }
    const result = { promotions, staleEmailClaims, email };
    logger.info(JSON.stringify(result));
    return result;
  } catch (e) {
    logger.error(e);
    return { error: 'promotions-worker failed' };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
