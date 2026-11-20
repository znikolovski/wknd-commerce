const source = require('../data/catalog.json');
const { buildSnapshot, resetCatalogCache } = require('../lib/catalog');
const { discoverProducts } = require('../lib/of1-discovery');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { runGraphQL } = require('../lib/graphql-server');

const cat = () => buildSnapshot({ ...source, assetLinks: [], version: 1 });
const discover = (query, history = []) => discoverProducts(cat(), { query, history });

test.each([
  ['Waterproof jacket', 'product'],
  ['Jacket under $300 for Patagonia', 'product'],
  ['Compare Alpine Shell Jacket and Torrent Rain Jacket', 'product'],
  ['Alpine Shell Jacket', 'product'],
  ['WKND-PCK-005', 'product'],
  ['Plan a Patagonia trek', 'adventure'],
  ['Plan my first climbing adventure', 'adventure'],
  ['What should I pack for a Patagonia trek?', 'adventure'],
  ['What gear should I pack for a Patagonia trek?', 'adventure'],
  ['Compare Patagonia and Yosemite adventures', 'adventure'],
  ['Tell me about Ohrid', 'adventure'],
  ['Patagonia', 'clarification'],
  ['gear', 'clarification'],
  ['buy boots under USD 100', 'clarification'],
  ['jackets under zero dollars', 'clarification'],
  ['jackets under $0', 'clarification'],
])('%s routes to %s', (query, experience) => {
  expect(discover(query).experience).toBe(experience);
});

test('named comparison preserves identities and catalog specifications', () => {
  const result = discover('Compare Alpine Shell Jacket and Torrent Rain Jacket');
  expect(result.products.map((p) => p.sku)).toEqual(['WKND-JKT-001', 'WKND-JKT-003']);
  expect(result.products[0].attributeList.find((a) => a.name === 'weight_g').value).toBe(410);
  expect(result.adventureSlugs).toContain('patagonia-trek');
  expect(result.adventureSlugs).not.toContain('trekking');
});

test('hard budgets, stock and waterproofing are applied, with no padding', () => {
  const result = discover('waterproof jackets under $300');
  expect(result.products.length).toBeGreaterThan(0);
  expect(result.products.length).toBeLessThanOrEqual(3);
  expect(result.maxPrice).toBe(299.99);
  expect(result.products.every((p) => p.priceRange.minimum.final.amount.value < 300)).toBe(true);
  expect(discover('waterproof jackets under $1').products).toEqual([]);
  expect(discover('buy hiking boots').products).toEqual([]);
});

test('refinement recovers category and constraints, explicit topic resets them', () => {
  const result = discover('Show cheaper ones', ['waterproof jackets under $500', 'Show cheaper ones']);
  expect(result.experience).toBe('product');
  expect(result.maxPrice).toBeLessThan(449);
  expect(result.products.every((p) => p.priceRange.minimum.final.amount.value <= result.maxPrice)).toBe(true);
  expect(discover('Plan a kayaking trip', ['waterproof jackets']).experience).toBe('adventure');
  expect(discover('Compare backpacks', ['waterproof jackets under $10']).maxPrice).toBeNull();
  expect(discover('The second one', ['Compare jackets']).experience).toBe('clarification');
});

test('missing catalog prices cannot become a free recommendation', () => {
  const snapshot = cat();
  snapshot.priceBySku.clear();
  expect(discoverProducts(snapshot, { query: 'jackets' }).products).toEqual([]);
});

test('named-product refinements discover alternatives in its category', () => {
  const result = discover('Show cheaper ones', ['Alpine Shell Jacket', 'Show cheaper ones']);
  expect(result.products.length).toBeGreaterThan(0);
  expect(result.products.every((p) => p.sku !== 'WKND-JKT-001')).toBe(true);
});

test('activity preferences rank catalog-associated products first', () => {
  const result = discover('Recommend jackets for climbing');
  expect(result.products[0].name).toBe('Windline Softshell');
});

test('named out-of-stock products can still be compared, not purchased', () => {
  const snapshot = cat();
  snapshot.stockBySku.clear();
  const result = discoverProducts(snapshot, { query: 'Alpine Shell Jacket' });
  expect(result.products).toHaveLength(1);
  expect(result.products[0].inStock).toBe(false);
  expect(discoverProducts(snapshot, { query: 'jackets' }).products).toEqual([]);
});

test('invalid inputs fail explicitly', () => {
  expect(() => discover('')).toThrow('1–500');
  expect(() => discover('x'.repeat(501))).toThrow('1–500');
  expect(() => discover('jackets', Array(6).fill('jacket'))).toThrow('five');
});

test('new schema query executes without affecting the drop-in catalog shape', async () => {
  resetCatalogCache();
  const store = createMemoryStore();
  await importCatalog(store, source, { replace: true });
  const result = await runGraphQL({
    query: `query {
      of1Discovery(query: "Compare waterproof jackets") {
        experience heading maxPrice subject products { sku name } adventureSlugs suggestions { label query }
      }
    }`,
  }, { store });
  expect(result.body.errors).toBeUndefined();
  expect(result.body.data.of1Discovery.products).toHaveLength(3);
  expect(result.cacheable).toBe(false);
});
