const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { runAudienceWorker } = require('../../lib/aam-worker');

exports.main = async (params) => {
  const logger = logging('aam-worker', { level: params.LOG_LEVEL || 'info' });
  if (params.AAM_WORKER_ENABLED !== 'true') return { status: 'disabled' };
  const store = await getStore(params);
  try {
    return await runAudienceWorker({
      store, params, namespace: process.env.__OW_NAMESPACE,
      report: (event) => logger.error(event.code),
    });
  } catch (error) {
    logger.error(error.code || 'AAM_WORKER_FAILED');
    throw error;
  } finally {
    await store.close();
  }
};
