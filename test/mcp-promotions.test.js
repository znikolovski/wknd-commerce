const { randomUUID } = require('node:crypto');
const { createMain } = require('../actions/commerce-mcp');
const { createMemoryStore } = require('../lib/store');
const { resetCatalogCache } = require('../lib/catalog');
const { migrateLegacyPromotions } = require('../lib/promotions');
const { definitionOf } = require('../lib/promotion-schema');

let store;
let main;
const config = {
  MCP_SHARED_SECRET: 's'.repeat(43), MCP_ORG_ID: 'test-org',
  PROMOTION_CURSOR_KEY: Buffer.alloc(32, 1).toString('base64'),
  MCP_PROMOTION_WRITES_ENABLED: 'true',
};
const definition = () => ({
  name: ' Gear deal ', mode: 'coupon', code: ' gear20 ',
  discount: { kind: 'percentage', basisPoints: 2000 }, target: { kind: 'skus', values: ['gear-one'] },
});

async function call(name, args, extra = {}) {
  const result = await main({
    ...config, ...extra, __ow_method: 'post',
    __ow_headers: { 'x-wknd-mcp-key': config.MCP_SHARED_SECRET, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    __ow_body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).toString('base64'),
  });
  const tool = JSON.parse(result.body).result;
  return { tool, body: JSON.parse(tool.content[0].text) };
}

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await store.collection('products').insertOne({ sku: 'GEAR-ONE', name: 'Gear', type: 'simple', status: 'enabled', categories: ['gear'] });
  await store.collection('categories').insertOne({ id: '1', name: 'Gear', urlPath: 'gear' });
  await migrateLegacyPromotions(store);
  main = createMain({ openStore: async () => store, logger: { error: jest.fn(), warn: jest.fn() } });
});

test('deployment gate is off by default, but promotion reads remain available', async () => {
  const blocked = await call('create_promotion', { idempotencyKey: randomUUID(), promotion: definition() }, { MCP_PROMOTION_WRITES_ENABLED: undefined });
  expect(blocked.tool.isError).toBe(true);
  expect(blocked.body.error.code).toBe('PROMOTION_WRITES_DISABLED');
  expect(await store.collection('promotion_requests').countDocuments({})).toBe(0);
  expect((await call('list_promotions', {})).body).toMatchObject({ apiVersion: 'wknd.promotions/v1', ok: true });
});

test('shared envelopes, normalization, replay, receipt reconciliation and identity are preserved', async () => {
  const key = randomUUID();
  const args = { idempotencyKey: key, promotion: definition() };
  const { body: created } = await call('create_promotion', args);
  expect(created).toMatchObject({
    apiVersion: 'wknd.promotions/v1', ok: true, committed: true, replayed: false,
    promotion: { name: 'Gear deal', code: 'GEAR20', enabled: false, revision: 1, managementClass: 'standard' },
    affected: { scope: 'skus', parentSkus: ['GEAR-ONE'], sellableSkus: ['GEAR-ONE'] },
    effects: { status: 'complete' }, request: { operation: 'create', idempotencyKey: key },
  });
  const { body: replayed } = await call('create_promotion', args);
  expect(replayed).toMatchObject({ replayed: true, promotion: created.promotion, affected: created.affected, mutationCorrelationId: created.mutationCorrelationId });
  expect(replayed.correlationId).not.toBe(created.correlationId);
  const reconciled = await call('get_promotion', { request: { operation: 'create', idempotencyKey: key } });
  expect(reconciled.body).toMatchObject({ committed: true, promotion: created.promotion });
  const receipt = await store.collection('promotion_requests').findOne({ idempotencyKey: key });
  expect(receipt.actor).toEqual({ kind: 'integration', subject: 'cx-coworker' });
  expect(JSON.stringify(created)).not.toMatch(/cx-coworker|test-org|integration/);
  expect(await store.collection('promotion_effects').countDocuments({})).toBe(1);
});

test('service validation remains authoritative including unknown fields and full-update requirements', async () => {
  const { body: created } = await call('create_promotion', { idempotencyKey: randomUUID(), promotion: definition() });
  const invalid = await call('update_promotion', {
    id: created.promotion.id, expectedRevision: 1, idempotencyKey: randomUUID(), promotion: { name: 'Only a patch' },
  });
  expect(invalid.tool.isError).toBe(true);
  expect(invalid.body).toMatchObject({ apiVersion: 'wknd.promotions/v1', ok: false, committed: false, error: { code: 'VALIDATION_ERROR' } });
  const forged = await call('create_promotion', { idempotencyKey: randomUUID(), promotion: definition(), actor: { kind: 'ims-operator' } });
  expect(forged.body.error.code).toBe('VALIDATION_ERROR');
  const update = await call('update_promotion', {
    id: created.promotion.id, expectedRevision: 1, idempotencyKey: randomUUID(),
    promotion: { ...definitionOf(created.promotion), enabled: true },
  });
  expect(update.body).toMatchObject({ ok: true, promotion: { enabled: true, revision: 2 } });
});

test('dedicated disable requires no catalog and has global promotion-only effects', async () => {
  const { body: created } = await call('create_promotion', { idempotencyKey: randomUUID(), promotion: { ...definition(), enabled: true } });
  const collection = store.collection;
  store.collection = (name) => {
    if (['products', 'categories', 'prices', 'inventory', 'asset_links'].includes(name)) throw new Error('catalog down');
    return collection(name);
  };
  const { body: disabled } = await call('disable_promotion', { id: created.promotion.id, expectedRevision: 1, idempotencyKey: randomUUID() });
  expect(disabled).toMatchObject({ ok: true, committed: true, affected: { scope: 'global-promotions', reason: 'safety-disable' } });
  expect(await collection('counters').findOne({ key: 'catalog_version' })).toBe(null);
});

test('missing receipt reports unknown outcome, never false proof of noncommit', async () => {
  const { tool, body } = await call('get_promotion', { request: { operation: 'create', idempotencyKey: randomUUID() } });
  expect(tool.isError).toBe(true);
  expect(body).toMatchObject({
    apiVersion: 'wknd.promotions/v1', ok: false, committed: null, mutationCorrelationId: null,
    error: { code: 'REQUEST_NOT_FOUND', retryable: false, retryMode: 'none', retryAfterSeconds: null },
  });
});

test('argument byte/depth bounds retain exact shared-service envelopes', async () => {
  const args = { id: 'prm_ffffffffffffffffffffffffffffffff', padding: '' };
  args.padding = 'x'.repeat(16384 - Buffer.byteLength(JSON.stringify(args)));
  expect(Buffer.byteLength(JSON.stringify(args))).toBe(16384);
  expect((await call('get_promotion', args)).body.error.code).toBe('VALIDATION_ERROR');
  args.padding += 'x';
  expect((await call('get_promotion', args)).body.error.code).toBe('REQUEST_TOO_LARGE');
  const depth8 = { a: { b: { c: { d: { e: { f: { g: {} } } } } } } };
  expect((await call('get_promotion', depth8)).body.error.code).toBe('VALIDATION_ERROR');
  depth8.a.b.c.d.e.f.g.h = {};
  expect((await call('get_promotion', depth8)).body.error.code).toBe('REQUEST_TOO_LARGE');
});

test('unmigrated service, protected inputs and disabled audience provider fail explicitly', async () => {
  const unsupported = await call('create_promotion', {
    idempotencyKey: randomUUID(), promotion: { ...definition(), audienceRestriction: { segment: 'forged' } },
  });
  expect(unsupported.body.error.code).toBe('UNSUPPORTED_AUDIENCE_RESTRICTION');
  const privateBinding = await call('create_promotion', {
    idempotencyKey: randomUUID(), promotion: { ...definition(), managementClass: 'protected-recovery' },
  });
  expect(privateBinding.body.error.code).toBe('VALIDATION_ERROR');
  store = createMemoryStore();
  expect((await call('list_promotions', {})).body.error.code).toBe('PROMOTION_STORAGE_UNINITIALIZED');
});
