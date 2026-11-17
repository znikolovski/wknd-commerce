/**
 * prerender — previews + publishes (or unpublishes) product detail pages on Edge Delivery
 * Services via the Admin API after catalog, pricing, stock or image changes.
 * Content comes from the `pdp-markup` BYOM overlay configured on the site.
 * Requires HLX_ADMIN_API_KEY (site API key with the publish role); without it the action is a no-op.
 * PDP_PUBLISH=false previews without publishing. `all: true` (re)renders every enabled product.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { loadCatalog } = require('../../lib/catalog');
const { pdpPath } = require('../../lib/pdp');

const ADMIN = 'https://admin.hlx.page';

async function admin(params, method, route, body) {
  const res = await fetch(`${ADMIN}${route}`, {
    method,
    // The Admin API rejects a JSON content type with an empty body (single-path preview/live).
    headers: { Authorization: `token ${params.HLX_ADMIN_API_KEY}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${res.headers.get('x-error') || text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Wait for a bulk Admin API job, then return the paths that succeeded and failed.
 * @returns {Promise<{ ok: string[], failed: string[] }>}
 */
async function waitForJob(params, job, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
  const self = job?.links?.self;
  if (!self) return { ok: [], failed: [] };
  const route = self.replace(ADMIN, '');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const status = await admin(params, 'GET', route);
    if (status.state === 'stopped') break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, intervalMs); });
  }
  const details = await admin(params, 'GET', `${route}/details`);
  const resources = details?.data?.resources || [];
  return {
    ok: resources.filter((r) => r.status === 200).map((r) => r.path),
    failed: resources.filter((r) => r.status !== 200).map((r) => r.path),
  };
}

/** Bulk preview with one retry; the first overlay calls can time out on a cold pdp-markup container. */
async function previewAll(params, site, paths) {
  const first = await waitForJob(params, await admin(params, 'POST', `/preview/${site}/*`, { paths, forceUpdate: true }));
  if (!first.failed.length) return first;
  const retry = await waitForJob(params, await admin(params, 'POST', `/preview/${site}/*`, { paths: first.failed, forceUpdate: true }));
  return { ok: [...first.ok, ...retry.ok], failed: retry.failed };
}

async function warmOverlay(params, path) {
  if (!params.PDP_MARKUP_URL || !path) return;
  await fetch(`${params.PDP_MARKUP_URL}${path}`, { signal: AbortSignal.timeout(45000) }).catch(() => {});
}

async function main(params) {
  const logger = logging('prerender', { level: params.LOG_LEVEL || 'info' });
  if (!params.HLX_ADMIN_API_KEY) return { skipped: 'HLX_ADMIN_API_KEY not configured' };
  const site = `${params.HLX_ORG}/${params.HLX_SITE}/${params.HLX_REF || 'main'}`;
  // PDP_PUBLISH=false keeps PDPs preview-only (e.g. until the storefront code is on main).
  const publishLive = String(params.PDP_PUBLISH ?? 'true') !== 'false';
  let store;
  try {
    store = await getStore(params);
    const cat = await loadCatalog(store);
    const skus = [...new Set((params.skus || []).map((s) => String(s).toUpperCase()))];
    const render = new Set();
    const remove = new Set();
    skus.forEach((sku) => {
      const product = cat.allProducts.find((p) => p.sku === sku);
      if (!product) return;
      (product.status === 'disabled' ? remove : render).add(pdpPath(product));
    });
    if (params.removed?.urlKey) remove.add(`/shop/products/${params.removed.urlKey}`);
    if (params.all) cat.products.filter((p) => p.status !== 'disabled').forEach((p) => render.add(pdpPath(p)));
    const paths = [...render];

    const results = {
      mode: publishLive ? 'publish' : 'preview', previewed: [], published: [], removed: [], errors: [],
    };
    if (paths.length) {
      await warmOverlay(params, paths[0]);
      if (paths.length === 1) {
        await admin(params, 'POST', `/preview/${site}${paths[0]}`);
        results.previewed.push(paths[0]);
      } else {
        const { ok, failed } = await previewAll(params, site, paths);
        results.previewed.push(...ok);
        failed.forEach((path) => results.errors.push(`preview failed: ${path}`));
      }
      if (publishLive && results.previewed.length === 1) {
        await admin(params, 'POST', `/live/${site}${results.previewed[0]}`);
        results.published.push(results.previewed[0]);
      } else if (publishLive && results.previewed.length > 1) {
        await admin(params, 'POST', `/live/${site}/*`, { paths: results.previewed, forceUpdate: true });
        results.published.push(...results.previewed);
      }
    }
    const removeFrom = publishLive ? ['live', 'preview'] : ['preview'];
    const toRemove = [...remove];
    for (let i = 0; i < toRemove.length; i += 1) {
      for (let j = 0; j < removeFrom.length; j += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await admin(params, 'DELETE', `/${removeFrom[j]}/${site}${toRemove[i]}`);
        } catch (e) {
          results.errors.push(e.message);
        }
      }
      results.removed.push(toRemove[i]);
    }
    logger.info(JSON.stringify({ ...results, previewed: results.previewed.length, published: results.published.length }));
    return results;
  } catch (e) {
    logger.error(e);
    return { error: e.message };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
