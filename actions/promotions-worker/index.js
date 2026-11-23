/**
 * promotions-worker — scheduled (e.g. every 5 minutes). Resolves stale promotion mutation
 * requests, retries unsettled promotion effects, marks crashed recovery-email claims as
 * unknown (never resent), sends durable order receipts and executes at most one approved
 * or explicitly enabled automatic recovery-email run. No customer data in its output.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { loadCatalog } = require('../../lib/catalog');
const { createPromotionService } = require('../../lib/promotions');
const { createRecoveryEmail, executeNextApprovedRun } = require('../../lib/recovery-email');
const { refreshStageCartWindows } = require('../../lib/stage-cart-window-tick');
const { sendOrderConfirmations, receiptConfigured } = require('../../lib/order-email');
const { emailParams } = require('../../lib/email-config');
const { createBrevoClient } = require('../../lib/brevo');

async function main(params) {
  params = emailParams(params);
  const logger = logging('promotions-worker', { level: params.LOG_LEVEL || 'info' });
  let store;
  try {
    store = await getStore(params);
    const emailService = createRecoveryEmail({ store, params });
    // Private namespace-authenticated operational surface; never exposed as a web action.
    if (params.emailStatusOnly === true) {
      return {
        email: await emailService.status(),
        receiptsConfigured: receiptConfigured(params),
        automaticRecovery: params.RECOVERY_EMAIL_AUTOMATION_ENABLED === 'true',
        cartUrl: params.SHOP_CART_URL || null,
        provider: params.BREVO_API_KEY
          ? await createBrevoClient({ apiKey: params.BREVO_API_KEY }).readiness() : { status: 'not-configured' },
      };
    }
    if (typeof params.emailPaused === 'boolean') {
      await (params.emailPaused ? emailService.pause() : emailService.resume());
      return { paused: params.emailPaused };
    }
    let receipts;
    try {
      receipts = await sendOrderConfirmations({ store, params });
    } catch {
      logger.error('Order confirmation processing unavailable');
      receipts = { state: 'error' };
    }
    let cartWindow;
    try {
      cartWindow = await refreshStageCartWindows({
        store, params, report: () => logger.warn('Stage cart window handoff unavailable'),
      });
    } catch {
      cartWindow = { state: 'unavailable' };
    }
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
    const result = { promotions, staleEmailClaims, email, receipts, cartWindow };
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
