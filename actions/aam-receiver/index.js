const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { createReceiver } = require('../../lib/aam-outbound');

exports.main = async (params) => {
  const logger = logging('aam-receiver', { level: params.LOG_LEVEL || 'info' });
  return createReceiver({ getStore, report: (event) => logger.error(event.code) })(params);
};
