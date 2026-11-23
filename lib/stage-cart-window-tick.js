const { stageWorkerParams, stageWindowEnabled } = require('./stage-planner-release');
const { createStageCartFactService } = require('./stage-cart-fact-publisher');
const { shopperKey } = require('./recovery-policy');

async function refreshStageCartWindows({
  store, params, namespace = process.env.__OW_NAMESPACE, fetchImpl, now, report,
  enabled = stageWindowEnabled(namespace),
}) {
  if (!enabled) return { state: 'disabled' };
  const config = stageWorkerParams(params, namespace);
  const allowed = String(config.TARGET_DIAG_SHOPPER_KEYS || '').split(',').map((key) => key.trim()).filter(Boolean);
  const customers = await store.collection('customers').find({ 'idLinkage.state': 'granted' });
  const counts = { state: 'complete', acknowledged: 0, unavailable: 0 };
  /* eslint-disable no-await-in-loop */
  for (const customer of customers) {
    if (!customer.sub || !allowed.includes(shopperKey(config.AUTH0_ISSUER, customer.sub))) continue;
    const service = createStageCartFactService({
      enabled: true, windowEnabled: true, store, params: config,
      claims: { sub: customer.sub }, namespace, fetchImpl, now, report,
    });
    const receipt = await service.refreshWindow();
    if (receipt.status === 'acknowledged') counts.acknowledged += 1;
    else counts.unavailable += 1;
  }
  /* eslint-enable no-await-in-loop */
  return counts;
}

module.exports = { refreshStageCartWindows };
