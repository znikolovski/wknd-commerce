/**
 * reconcile — nightly drift repair between AEM product assets and the product media gallery.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { reconcile } = require('../../lib/linking');
const { triggerPrerender } = require('../../lib/invoke');

async function main(params) {
  const logger = logging('reconcile', { level: params.LOG_LEVEL || 'info' });
  let store;
  try {
    store = await getStore(params);
    const result = await reconcile(store, params);
    if (result.affected.length) await triggerPrerender(params, result.affected).catch((e) => logger.warn(e.message));
    logger.info(JSON.stringify({ ...result, affected: result.affected.length }));
    return result;
  } catch (e) {
    logger.error(e);
    return { error: e.message };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
