/**
 * admin — IMS-protected RPC for the WKND Commerce admin (ExC Shell UI, seed script, Assets panel).
 * POST { op: 'products.list', ...args }. Writes return `affected` parent SKUs; those PDPs are
 * re-rendered asynchronously by the `prerender` action.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const admin = require('../../lib/admin');
const linking = require('../../lib/linking');
const { decodeBody } = require('../../lib/http');
const { triggerPrerender } = require('../../lib/invoke');

const OPS = {
  'stats.get': (s) => admin.stats(s),
  'categories.list': (s) => admin.listCategories(s),
  'catalog.import': (s, a) => admin.importAll(s, a),
  'products.list': (s, a) => admin.listProducts(s, a),
  'products.get': (s, a) => admin.getProduct(s, String(a.sku || '').toUpperCase()),
  'products.create': (s, a) => admin.saveProduct(s, a.product, { create: true }),
  'products.save': (s, a) => admin.saveProduct(s, a.product),
  'products.setStatus': (s, a) => admin.setStatus(s, String(a.sku || '').toUpperCase(), a.status),
  'products.delete': (s, a) => admin.deleteProduct(s, String(a.sku || '').toUpperCase()),
  'inventory.list': (s, a) => admin.listInventory(s, a),
  'inventory.update': (s, a) => admin.updateInventory(s, a.items),
  'prices.update': (s, a) => admin.updatePrices(s, a.items),
  'prices.bulk': (s, a) => admin.bulkPrice(s, a),
  'orders.list': (s, a) => admin.listOrders(s, a),
  'orders.get': (s, a) => admin.getOrder(s, a.number),
  'images.list': (s, a) => linking.listLinks(s, a),
  'images.rematch': (s, a, p) => linking.productToAsset(s, p, { skus: a.skus }),
  'images.unlink': (s, a) => linking.unlink(s, a),
  'images.reorder': (s, a) => linking.reorder(s, a),
};

async function main(params) {
  const logger = logging('admin', { level: params.LOG_LEVEL || 'info' });
  const headers = params.__ow_headers || {};
  const org = headers['x-gw-ims-org-id'];
  if (params.ADMIN_IMS_ORG && org !== params.ADMIN_IMS_ORG) {
    return { statusCode: 403, body: { error: 'This IMS organisation cannot manage the WKND store.' } };
  }
  // web:'yes' actions receive the JSON body merged into params (raw actions get __ow_body)
  const body = params.__ow_body ? decodeBody(params) : params;
  const op = body.op || params.op;
  const handler = OPS[op];
  if (!handler) return { statusCode: 400, body: { error: `Unknown op ${op}`, ops: Object.keys(OPS) } };

  let store;
  try {
    store = await getStore(params);
    const result = await handler(store, body, params);
    if (result?.affected?.length) {
      await triggerPrerender(params, result.affected).catch((e) => logger.warn(`prerender trigger failed: ${e.message}`));
    }
    return { statusCode: 200, body: result };
  } catch (e) {
    if (e instanceof admin.AdminError || e.status) {
      return { statusCode: e.status || 400, body: { error: e.message } };
    }
    logger.error(e);
    return { statusCode: 500, body: { error: 'Server error', ...(params.LOG_LEVEL === 'debug' ? { detail: String(e.stack || e) } : {}) } };
  } finally {
    if (store) await store.close().catch(() => {});
  }
}

exports.main = main;
