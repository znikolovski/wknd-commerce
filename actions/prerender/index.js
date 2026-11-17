/**
 * prerender — previews + publishes (or unpublishes) product detail pages on Edge Delivery
 * Services via the Admin API after catalog, pricing, stock or image changes.
 * Content comes from the `pdp-markup` BYOM overlay configured on the site.
 * Requires HLX_ADMIN_API_KEY (site admin API key); without it the action is a no-op.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { loadCatalog } = require('../../lib/catalog');
const { pdpPath } = require('../../lib/pdp');

const ADMIN = 'https://admin.hlx.page';

async function admin(params, method, route, body) {
  const res = await fetch(`${ADMIN}${route}`, {
    method,
    headers: { Authorization: `token ${params.HLX_ADMIN_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${res.headers.get('x-error') || text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function main(params) {
  const logger = logging('prerender', { level: params.LOG_LEVEL || 'info' });
  if (!params.HLX_ADMIN_API_KEY) return { skipped: 'HLX_ADMIN_API_KEY not configured' };
  const site = `${params.HLX_ORG}/${params.HLX_SITE}/${params.HLX_REF || 'main'}`;
  let store;
  try {
    store = await getStore(params);
    const cat = await loadCatalog(store);
    const skus = [...new Set((params.skus || []).map((s) => String(s).toUpperCase()))];
    const publish = [];
    const unpublish = [];
    skus.forEach((sku) => {
      const product = cat.allProducts.find((p) => p.sku === sku);
      if (!product) return;
      (product.status === 'disabled' ? unpublish : publish).push(pdpPath(product));
    });
    if (params.removed?.urlKey) unpublish.push(`/shop/products/${params.removed.urlKey}`);
    if (params.all) cat.products.forEach((p) => publish.push(pdpPath(p)));

    const results = { published: [], unpublished: [], errors: [] };
    if (publish.length === 1) {
      await admin(params, 'POST', `/preview/${site}${publish[0]}`);
      await admin(params, 'POST', `/live/${site}${publish[0]}`);
      results.published.push(publish[0]);
    } else if (publish.length > 1) {
      await admin(params, 'POST', `/preview/${site}/*`, { paths: publish, forceUpdate: true });
      // bulk jobs run asynchronously; publish after preview has been queued
      await admin(params, 'POST', `/live/${site}/*`, { paths: publish, forceUpdate: true });
      results.published.push(...publish);
    }
    for (let i = 0; i < unpublish.length; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await admin(params, 'DELETE', `/live/${site}${unpublish[i]}`);
        results.unpublished.push(unpublish[i]);
      } catch (e) {
        results.errors.push(e.message);
      }
    }
    logger.info(JSON.stringify(results));
    return results;
  } catch (e) {
    logger.error(e);
    return { error: e.message };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
