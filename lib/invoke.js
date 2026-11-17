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

/**
 * Re-render PDPs for `skus`; `removed` ({ urlKey }) takes a deleted product's page down,
 * `all` re-renders every enabled product.
 */
async function triggerPrerender(params, skus, { removed, all } = {}) {
  if (!skus?.length && !removed && !all) return { skipped: 'nothing to render' };
  return invokeAction(params.PRERENDER_ACTION || 'commerce/prerender', {
    skus: skus || [], ...(removed ? { removed } : {}), ...(all ? { all: true } : {}),
  });
}

module.exports = { invokeAction, triggerPrerender };
