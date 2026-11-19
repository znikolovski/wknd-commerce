const fs = require('node:fs');
const path = require('node:path');
const { createMemoryStore, getStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { loadCatalog, resetCatalogCache } = require('../lib/catalog');
const panel = require('../lib/asset-panel');
const aem = require('../lib/aem');
const { main } = require('../actions/assets-panel');
const { triggerPrerender } = require('../lib/invoke');

jest.mock('../lib/store', () => ({ ...jest.requireActual('../lib/store'), getStore: jest.fn() }));
jest.mock('../lib/aem', () => ({ ...jest.requireActual('../lib/aem'), aemFetch: jest.fn() }));
jest.mock('../lib/invoke', () => ({ triggerPrerender: jest.fn() }));

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
const root = '/content/dam/wknd-adventures/products';
const assetPath = `${root}/apparel/jackets/product.jpg`;
const assetId = 'urn:aaid:aem:12345678-1234-1234-1234-123456789012';
const params = {
  __ow_method: 'post', __ow_headers: { authorization: 'Bearer test-user-token', 'x-gw-ims-org-id': 'test-org' },
  AEM_AUTHOR_URL: 'https://author-p1-e2.adobeaemcloud.com', AEM_PRODUCTS_ROOT: root,
  ADMIN_IMS_ORG: 'test-org', authorUrl: 'https://author-p1-e2.adobeaemcloud.com',
};
let store;
let metadata;
let saved;

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, catalog, { replace: true });
  metadata = { 'dc:title': 'Keep this title', 'dam:status': 'approved' };
  saved = false;
  getStore.mockReset().mockResolvedValue(store);
  triggerPrerender.mockReset().mockResolvedValue({});
  aem.aemFetch.mockReset().mockImplementation(async (_params, requestPath, options = {}) => {
    if (options.method === 'POST') {
      if (requestPath !== assetPath) throw new Error('Unexpected metadata write path');
      const fields = new URLSearchParams(options.body);
      ['commerce:isCommerce', 'commerce:skus', 'commerce:roles', 'commerce:positions'].forEach((key) => {
        const field = `./jcr:content/metadata/${key}`;
        if (fields.has(`${field}@Delete`)) delete metadata[key];
        if (fields.has(field)) metadata[key] = key === 'commerce:isCommerce' ? fields.get(field) : fields.getAll(field);
      });
      saved = true;
      return new Response('{}');
    }
    if (requestPath !== `${assetPath}.2.json`) throw new Error('Unexpected metadata read path');
    return new Response(JSON.stringify({
      'jcr:primaryType': 'dam:Asset', 'jcr:uuid': assetId.slice('urn:aaid:aem:'.length),
      'jcr:content': { metadata },
    }));
  });
});

async function saveArgs(changes = {}) {
  const asset = await panel.getAsset(store, params, { assetPath });
  return {
    assetPath, revision: asset.revision, isCommerce: true,
    skus: ['WKND-JKT-001'], roles: ['image', 'thumbnail'], positions: [2], ...changes,
  };
}

test('searches parent and variant SKUs in the actual catalog, with bounded results', async () => {
  const variant = catalog.products.find((product) => product.sku === 'WKND-JKT-001').variants[0].sku;
  const result = await panel.searchProducts(store, { q: variant });
  expect(result).toMatchObject({ total: 1, items: [{ sku: variant, type: 'variant', parentSku: 'WKND-JKT-001' }] });
  const all = await panel.searchProducts(store);
  expect(all.total).toBeGreaterThan(50);
  expect(all.items).toHaveLength(50);
});

test('writes verified commerce metadata and immediately updates the storefront gallery', async () => {
  const result = await panel.saveAsset(store, params, await saveArgs());
  expect(saved).toBe(true);
  expect(metadata['dc:title']).toBe('Keep this title');
  expect(metadata['commerce:skus']).toEqual(['WKND-JKT-001']);
  expect(metadata['commerce:positions']).toEqual(['2']);
  expect(result.links).toEqual([{ sku: 'WKND-JKT-001', position: 2, roles: ['image', 'thumbnail'] }]);
  expect(result.affected).toEqual(['WKND-JKT-001']);
  const cat = await loadCatalog(store);
  expect(cat.imagesBySku.get('WKND-JKT-001')[0].url).toContain(`/adobe/assets/${assetId}`);
});

test('supports variants, multiple SKUs with different positions, relinking and permanent unlinking', async () => {
  const variant = catalog.products.find((product) => product.sku === 'WKND-JKT-001').variants[0].sku;
  await panel.saveAsset(store, params, await saveArgs({ skus: ['WKND-JKT-001', variant], positions: [1, 3] }));
  let links = await store.collection('asset_links').find({ assetId });
  expect(links.map((link) => link.position)).toEqual([1, 3]);
  const moved = await panel.saveAsset(store, params, await saveArgs({ skus: ['WKND-PCK-001'] }));
  expect(moved.affected.sort()).toEqual(['WKND-JKT-001', 'WKND-PCK-001']);
  const removed = await panel.saveAsset(store, params, await saveArgs({ isCommerce: false, skus: [], roles: [], positions: [] }));
  links = await store.collection('asset_links').find({ assetId });
  expect(links).toEqual([]);
  expect(removed.isCommerce).toBe(false);
  expect(metadata['commerce:skus']).toBeUndefined();
  expect(metadata['commerce:roles']).toBeUndefined();
});

test('does not approve assets and explains why unapproved assets are not linked', async () => {
  metadata['dam:status'] = 'rejected';
  const result = await panel.saveAsset(store, params, await saveArgs());
  expect(result.links).toEqual([]);
  expect(result.warning).toContain('not approved');
  expect(metadata['dam:status']).toBe('rejected');
});

test('rejects a stale metadata revision before writing', async () => {
  const args = await saveArgs();
  metadata['commerce:skus'] = ['WKND-PCK-001'];
  await expect(panel.saveAsset(store, params, args)).rejects.toMatchObject({ status: 409 });
  expect(saved).toBe(false);
});

test.each([
  { skus: ['NO-SUCH-PRODUCT'] }, { skus: ['WKND-JKT-001', 'WKND-JKT-001'], positions: [1, 1] },
  { skus: [] }, { roles: ['invalid-role'] }, { roles: ['image', 'image'] },
  { positions: [0] }, { positions: [1.5] }, { positions: [10000] }, { positions: [] },
  { isCommerce: 'yes' },
])('rejects invalid mapping data without changing metadata: %j', async (changes) => {
  await expect(panel.saveAsset(store, params, await saveArgs(changes))).rejects.toMatchObject({ status: 400 });
  expect(saved).toBe(false);
});

test.each([
  '/content/dam/elsewhere/image.jpg', `${root}/../secret.jpg`, `${root}/%2e%2e/secret.jpg`,
  `${root}/image.jpg?x=1`, `${root}/image.jpg;api=download`,
])('rejects out-of-scope and unsafe paths: %s', async (unsafe) => {
  await expect(panel.getAsset(store, params, { assetPath: unsafe })).rejects.toMatchObject({ status: 400 });
  expect(aem.aemFetch).not.toHaveBeenCalled();
});

test('does not claim success or change backend links when metadata read-back fails', async () => {
  const args = await saveArgs();
  const original = aem.aemFetch.getMockImplementation();
  aem.aemFetch.mockImplementation(async (...call) => {
    if (call[2]?.method === 'POST') return new Response('{}');
    return original(...call);
  });
  await expect(panel.saveAsset(store, params, args)).rejects.toThrow('could not be verified');
  expect(await store.collection('asset_links').find({ assetId })).toEqual([]);
});

test('keeps Sling field names literal and writes arrays with deletion and type hints', () => {
  const body = panel.metadataForm({ 'commerce:skus': ['ONE', 'TWO'], 'commerce:roles': [] });
  expect(body).toContain('./jcr:content/metadata/commerce:skus@TypeHint=String%5B%5D');
  const fields = new URLSearchParams(body);
  expect(fields.getAll('./jcr:content/metadata/commerce:skus')).toEqual(['ONE', 'TWO']);
  expect(fields.has('./jcr:content/metadata/commerce:roles@Delete')).toBe(true);
});

test('the action enforces host/organisation identity and sends the caller token to AEM', async () => {
  const result = await main({ ...params, op: 'asset.get', assetPath });
  expect(result.statusCode).toBe(200);
  expect(result.body).toMatchObject({ assetId, revision: expect.any(String) });
  expect(aem.aemFetch).toHaveBeenCalledWith(
    expect.objectContaining({ AEM_ACCESS_TOKEN: 'test-user-token' }), expect.any(String), expect.any(Object),
  );
  const save = await main({ ...params, ...await saveArgs(), op: 'asset.save' });
  expect(save.statusCode).toBe(200);
  expect(triggerPrerender).toHaveBeenCalledWith(expect.anything(), ['WKND-JKT-001']);
  expect(JSON.stringify(save)).not.toContain('test-user-token');
});

test.each([
  [{ __ow_method: 'get' }, 405], [{ __ow_headers: {} }, 401],
  [{ ADMIN_IMS_ORG: '' }, 403], [{ authorUrl: 'https://attacker.example' }, 403],
  [{ op: 'products.delete' }, 400],
])('rejects unauthorised or unsupported action requests: %j', async (changes, status) => {
  const result = await main({ ...params, op: 'asset.get', assetPath, ...changes });
  expect(result.statusCode).toBe(status);
  expect(result.body.error).toEqual(expect.any(String));
  expect(getStore).not.toHaveBeenCalled();
});

test('reports database failures and saved-but-not-refreshed storefront pages explicitly', async () => {
  getStore.mockRejectedValueOnce(new Error('private database failure'));
  const failed = await main({ ...params, op: 'products.search' });
  expect(failed.statusCode).toBe(500);
  expect(JSON.stringify(failed)).not.toContain('private database failure');
  triggerPrerender.mockRejectedValueOnce(new Error('scheduler unavailable'));
  const result = await main({ ...params, ...await saveArgs(), op: 'asset.save' });
  expect(result.statusCode).toBe(200);
  expect(result.body.warning).toContain('refresh could not be scheduled');
});
