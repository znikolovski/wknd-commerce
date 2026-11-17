const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const {
  loadCatalog, resetCatalogCache, refine, b64,
} = require('../lib/catalog');

const uid = (option, value) => b64(`configurable/${option}/${value}`);
const link = (sku, assetId, position = 1) => ({
  sku, assetId, url: `https://delivery.example/adobe/assets/urn:aaid:aem:${assetId}`, alias: assetId, position, roles: [],
});

const CATALOG = {
  categories: [{ id: 'gear', name: 'Gear', urlPath: 'gear' }],
  products: [{
    sku: 'WKND-TST-PCK',
    type: 'configurable',
    name: 'Test Pack',
    urlKey: 'test-pack',
    status: 'enabled',
    visibility: 'Catalog, Search',
    categories: ['gear'],
    options: [
      { id: 'color', title: 'Colour', values: [{ id: 'red', title: 'Red' }, { id: 'blue', title: 'Blue' }, { id: 'black', title: 'Black' }] },
      { id: 'size', title: 'Size', values: [{ id: 's', title: 'S' }, { id: 'l', title: 'L' }] },
    ],
    variants: ['red', 'blue', 'black'].flatMap((c) => ['s', 'l'].map((sz) => ({
      sku: `WKND-TST-PCK-${c.toUpperCase()}-${sz.toUpperCase()}`, selections: { color: c, size: sz },
    }))),
  }],
  prices: [{ sku: 'WKND-TST-PCK', regular: 100, currency: 'AUD' }],
  inventory: ['RED', 'BLUE', 'BLACK'].flatMap((c) => ['S', 'L'].map((sz) => ({ sku: `WKND-TST-PCK-${c}-${sz}`, qty: 5 }))),
};

let cat;

beforeAll(async () => {
  resetCatalogCache();
  const store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
  await store.collection('asset_links').insertMany([
    link('WKND-TST-PCK', 'red-studio', 1), // parent hero = red colour shot
    link('WKND-TST-PCK', 'lifestyle', 2), // shared
    link('WKND-TST-PCK-RED-S', 'red-studio'), link('WKND-TST-PCK-RED-L', 'red-studio'),
    link('WKND-TST-PCK-BLUE-S', 'blue-studio'), link('WKND-TST-PCK-BLUE-L', 'blue-studio'),
    link('WKND-TST-PCK-BLUE-L', 'blue-detail', 2),
  ]);
  cat = await loadCatalog(store);
});

const assets = (view) => view.allImages.map((i) => i.assetId);

test('default product shows the full parent gallery', () => {
  expect(assets(refine(cat, 'WKND-TST-PCK', []))).toEqual(['red-studio', 'lifestyle']);
});

test('a fully selected variant keeps the shared lifestyle images after its colour shots', () => {
  const view = refine(cat, 'WKND-TST-PCK', [uid('color', 'blue'), uid('size', 'l')]);
  expect(view.sku).toBe('WKND-TST-PCK-BLUE-L');
  expect(assets(view)).toEqual(['blue-studio', 'blue-detail', 'lifestyle']);
  expect(view.allImages[0].roles).toEqual(expect.arrayContaining(['image', 'small_image', 'thumbnail']));
  expect(view.allImages.map((i) => i.position)).toEqual([0, 1, 2]);
});

test('choosing only a colour already swaps to that colour gallery', () => {
  expect(assets(refine(cat, 'WKND-TST-PCK', [uid('color', 'blue')]))).toEqual(['blue-studio', 'lifestyle']);
  expect(assets(refine(cat, 'WKND-TST-PCK', [uid('color', 'red')]))).toEqual(['red-studio', 'lifestyle']);
});

test('a variant without colour images falls back to the parent gallery', () => {
  expect(assets(refine(cat, 'WKND-TST-PCK', [uid('color', 'black'), uid('size', 's')])))
    .toEqual(['red-studio', 'lifestyle']);
});
