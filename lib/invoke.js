/**
 * Fire-and-forget invocation of sibling Runtime actions (prerender after admin/linking writes).
 */
async function invokeAction(name, params, { blocking = false } = {}) {
  if (!process.env.__OW_API_KEY || !process.env.__OW_NAMESPACE) return { skipped: 'not running in I/O Runtime' };
  // eslint-disable-next-line global-require
  const openwhisk = require('openwhisk');
  const ow = openwhisk();
  return ow.actions.invoke({ name, params, blocking, result: blocking });
}

async function triggerPrerender(params, skus, { action = 'publish' } = {}) {
  if (!skus?.length) return { skipped: 'nothing to render' };
  return invokeAction(params.PRERENDER_ACTION || 'commerce/prerender', { skus, action });
}

module.exports = { invokeAction, triggerPrerender };
