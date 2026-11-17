const fs = require('node:fs');
const path = require('node:path');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { loadCatalog, resetCatalogCache } = require('../lib/catalog');
const linking = require('../lib/linking');
const { renderPdp, urlKeyFromPath } = require('../lib/pdp');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
const ROOT = '/content/dam/wknd-adventures/products';
const params = { AEM_AUTHOR_URL: 'https://author-p1-e2.adobeaemcloud.com' };

let store;
let cat;
const jacket = CATALOG.products.find((p) => p.sku === 'WKND-JKT-001');
const asset = (id, meta, repoPath) => ({
  assetId: `urn:aaid:aem:${id.padStart(8, '0')}-0000-0000-0000-000000000000`,
  assetMetadata: { 'dam:status': 'approved', ...meta },
  repositoryMetadata: { 'repo:path': repoPath, 'repo:name': repoPath?.split('/').pop() },
});

beforeAll(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
  cat = await loadCatalog(store);
});

describe('asset-to-product matcher (Adobe custom-matcher contract)', () => {
  test('explicit commerce:skus with roles and positions', () => {
    const res = linking.matchAssetToProducts(cat, asset('1', {
      'commerce:isCommerce': 'yes', 'commerce:skus': ['WKND-JKT-001', 'NOPE'], 'commerce:roles': ['image', 'thumbnail'], 'commerce:positions': ['2', '1'],
    }, `${ROOT}/apparel/jackets/x.jpg`));
    expect(res.rule).toBe('metadata');
    expect(res.product_matches).toEqual([{ product_sku: 'WKND-JKT-001', asset_roles: ['image', 'thumbnail'], asset_position: 2 }]);
    expect(res.unmatched).toEqual(['NOPE']);
    expect(res).toHaveProperty('skip', false);
  });

  test('not eligible or not approved → no matches (unlink)', () => {
    expect(linking.matchAssetToProducts(cat, asset('2', { 'commerce:skus': 'WKND-JKT-001' }, '')).product_matches).toEqual([]);
    expect(linking.matchAssetToProducts(cat, asset('3', { 'commerce:isCommerce': 'yes', 'commerce:skus': 'WKND-JKT-001', 'dam:status': 'rejected' }, '')).rule).toBe('not-approved');
  });

  test('folder rule infers the SKU from …/products/<category>/<SKU>/', () => {
    const res = linking.matchAssetToProducts(cat, asset('4', { 'commerce:isCommerce': true }, `${ROOT}/apparel/jackets/WKND-JKT-001/hero.jpg`));
    expect(res.rule).toBe('folder');
    expect(res.product_matches[0]).toEqual({ product_sku: 'WKND-JKT-001', asset_roles: ['image', 'small_image', 'thumbnail'], asset_position: 1 });
  });

  test('colour filename rule links to all variants of that colour with swatch role', () => {
    const res = linking.matchAssetToProducts(cat, asset('5', { 'commerce:isCommerce': 'yes' }, `${ROOT}/apparel/jackets/WKND-JKT-001/WKND-JKT-001__glacier__1.jpg`));
    const expected = jacket.variants.filter((v) => v.selections.color === 'glacier').map((v) => v.sku);
    expect(res.rule).toBe('filename-colour');
    expect(res.product_matches.map((m) => m.product_sku)).toEqual(expected);
    expect(res.product_matches[0].asset_roles).toContain('swatch_image');
  });

  test('product-to-asset returns Adobe asset_matches sorted by position', () => {
    const assets = [
      asset('6', { 'commerce:isCommerce': 'yes', 'commerce:skus': 'WKND-JKT-001', 'commerce:positions': '2' }, `${ROOT}/a.jpg`),
      asset('7', { 'commerce:isCommerce': 'yes', 'commerce:skus': 'WKND-JKT-001', 'commerce:positions': '1' }, `${ROOT}/b.jpg`),
      asset('8', { 'commerce:isCommerce': 'yes', 'commerce:skus': 'WKND-PCK-001' }, `${ROOT}/c.jpg`),
    ];
    const res = linking.matchProductToAssets(cat, 'WKND-JKT-001', assets);
    expect(res.product_sku).toBe('WKND-JKT-001');
    expect(res.asset_matches.map((m) => m.asset_position)).toEqual([1, 2]);
    expect(res.asset_matches[0]).toMatchObject({ asset_format: 'image', asset_roles: expect.any(Array) });
  });
});

describe('applying matches to the product media gallery', () => {
  test('links, relinks and removes assets; storefront sees delivery URLs', async () => {
    const a = asset('9', { 'commerce:isCommerce': 'yes', 'commerce:skus': 'WKND-JKT-001', 'dc:title': 'Alpine Shell on the ridge' }, `${ROOT}/apparel/jackets/WKND-JKT-001/alpine.jpg`);
    const first = await linking.applyAssetMatches(store, params, a, linking.matchAssetToProducts(cat, a));
    expect(first).toMatchObject({ linked: 1, removed: 0, affected: ['WKND-JKT-001'] });
    const fresh = await loadCatalog(store);
    const [img] = fresh.imagesBySku.get('WKND-JKT-001');
    // DM OpenAPI asset base — drop-ins append /as/{alias}.webp?width=…&quality=… per slot
    expect(img.url).toBe(`https://delivery-p1-e2.adobeaemcloud.com/adobe/assets/${a.assetId}`);
    expect(img.alias).toBe('alpine');
    const html = renderPdp(fresh, fresh.bySku.get('WKND-JKT-001'), {});
    expect(html).toContain(`${img.url}/as/alpine.jpg?width=1200&amp;quality=80`);
    expect(html).toContain(`${img.url}/as/alpine.jpg?width=2000&amp;quality=80`);
    expect(html).not.toMatch(/<picture|<img/);
    expect(img.label).toBe('Alpine Shell on the ridge');

    a.assetMetadata['commerce:skus'] = 'WKND-PCK-001';
    const moved = await linking.applyAssetMatches(store, params, a, linking.matchAssetToProducts(cat, a));
    expect(moved.affected.sort()).toEqual(['WKND-JKT-001', 'WKND-PCK-001']);
    const removed = await linking.removeAsset(store, a.assetId);
    expect(removed).toMatchObject({ removed: 1, affected: ['WKND-PCK-001'] });
  });
});

describe('PDP markup', () => {
  test('DM OpenAPI rendition URLs', () => {
    const { renditionUrl, deliveryBaseFor, seoAlias } = require('../lib/aem');
    const base = deliveryBaseFor(params, 'urn:aaid:aem:12345678-0000-0000-0000-000000000000');
    expect(base).toBe('https://delivery-p1-e2.adobeaemcloud.com/adobe/assets/urn:aaid:aem:12345678-0000-0000-0000-000000000000');
    expect(seoAlias('WKND-JKT-001__Glacier Blue__1.JPG')).toBe('wknd-jkt-001-glacier-blue-1');
    expect(renditionUrl(`${base}/as/old.jpg?width=10`, 'alpine-shell', { width: 640, format: 'webp' }))
      .toBe(`${base}/as/alpine-shell.webp?width=640&quality=80`);
    expect(renditionUrl('https://wknd-adventures.run.place/default-meta-image.png', 'x')).toBe('https://wknd-adventures.run.place/default-meta-image.png');
  });
  test('renders crawlable content, metadata and JSON-LD', () => {
    const html = renderPdp(cat, cat.bySku.get('WKND-JKT-001'), { siteOrigin: 'https://wknd-adventures.run.place' });
    expect(html).not.toMatch(/<title>/);
    expect(html.match(/class="metadata"/g)).toHaveLength(1);
    expect(html).toContain('<div class="product-details">');
    expect(html).toContain('<h1>Alpine Shell Jacket</h1>');
    expect(html).toContain('<div>sku</div><div>WKND-JKT-001</div>');
    expect(html).toMatch(/&quot;@type&quot;:&quot;Product&quot;/);
    expect(html).toContain('https://wknd-adventures.run.place/shop/products/alpine-shell-jacket');
    expect(html).not.toMatch(/<script/i);
  });

  test('path parsing only accepts product URL keys', () => {
    expect(urlKeyFromPath('/shop/products/alpine-shell-jacket.plain.html')).toBe('alpine-shell-jacket');
    expect(urlKeyFromPath('/shop/products/../../etc')).toBeNull();
    expect(urlKeyFromPath('/blog/post')).toBeNull();
  });
});

describe('reconcile', () => {
  const aem = require('../lib/aem');
  const a1 = asset('71', { 'commerce:isCommerce': 'yes', 'commerce:skus': ['WKND-JKT-001'], 'commerce:positions': ['1'] }, `${ROOT}/apparel/r1.jpg`);
  const a2 = asset('72', { 'commerce:isCommerce': 'yes', 'commerce:skus': ['WKND-JKT-001'], 'commerce:positions': ['2'] }, `${ROOT}/apparel/r2.jpg`);
  afterEach(() => jest.restoreAllMocks());

  test('links new assets, skips unchanged ones and removes orphans', async () => {
    jest.spyOn(aem, 'queryProductAssets').mockResolvedValue([a1, a2]);
    const first = await linking.reconcile(store, params);
    expect(first.changedAssets).toBe(2);
    expect(first.affected).toContain('WKND-JKT-001');

    const replace = jest.spyOn(store.collection('asset_links').constructor.prototype, 'replaceOne');
    const again = await linking.reconcile(store, params);
    expect(again).toMatchObject({ changedAssets: 0, linked: 0, orphansRemoved: 0, affected: [] });
    expect(replace).not.toHaveBeenCalled();

    aem.queryProductAssets.mockResolvedValue([a1]);
    const pruned = await linking.reconcile(store, params);
    expect(pruned.orphansRemoved).toBe(1);
    const links = await store.collection('asset_links').find({ sku: 'WKND-JKT-001' });
    expect(links.map((l) => l.assetId)).toContain(a1.assetId);
    expect(links.map((l) => l.assetId)).not.toContain(a2.assetId);
  });
});
