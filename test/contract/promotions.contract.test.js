/**
 * wknd.promotions/v1 shared-service contract (frozen candidate.5,
 * sha256 90260e5f65ccc929ac89f95fb7f9e98296b5330e310a8ca7fa5eb7579a01419d).
 * Thin adapters (Commerce MCP) must pass these envelopes through unchanged.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemoryStore } = require('../../lib/store');
const { importCatalog } = require('../../lib/importer');
const { loadCatalog, resetCatalogCache } = require('../../lib/catalog');
const {
  createPromotionService, migrateLegacyPromotions, LEGACY_SEEDS, decodeCursor,
} = require('../../lib/promotions');
const { bootstrapRecoveryPromotion, promotionIdFor, DEFAULT_CAMPAIGN } = require('../../lib/recovery-policy');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/catalog.json'), 'utf8'));
const CURSOR_KEY = crypto.randomBytes(32).toString('base64');
const ORG = 'ORG123@AdobeOrg';
const T0 = Date.parse('2026-11-20T04:00:00.000Z');
const DAY = 86400000;

const parent = CATALOG.products.find((p) => p.type === 'configurable' && p.variants.length >= 2);
const simple = CATALOG.products.find((p) => p.type === 'simple');
const uuid = () => crypto.randomUUID();
const ctx = (overrides = {}) => ({ actor: { kind: 'ims-operator', subject: 'operator-1', orgId: ORG }, correlationId: uuid(), ...overrides });

const ROOT_OK_WRITE = ['apiVersion', 'ok', 'committed', 'promotion', 'replayed', 'affected', 'effects', 'request', 'correlationId', 'mutationCorrelationId'];
const ROOT_ERR = ['apiVersion', 'ok', 'committed', 'error', 'request', 'correlationId', 'mutationCorrelationId'];
const ERR_KEYS = ['code', 'message', 'retryable', 'retryMode', 'retryAfterSeconds', 'fields', 'fieldsTruncated', 'details'];
const DTO_KEYS = ['id', 'revision', 'managementClass', 'name', 'enabled', 'mode', 'code', 'discount', 'maxDiscountMinor',
  'minimumMerchandiseMinor', 'target', 'startsAt', 'endsAt', 'audienceRestriction', 'createdAt', 'updatedAt'];

let store;
let now;
let svc;
let catalogDown;
const clock = () => now;

function service(extra = {}) {
  return createPromotionService({
    store,
    clock,
    cursorKey: CURSOR_KEY,
    loadCatalog: async () => {
      if (catalogDown) throw new Error('catalog unavailable');
      return loadCatalog(store);
    },
    ...extra,
  });
}

const definition = (over = {}) => ({
  name: 'Weekend gear',
  enabled: true,
  mode: 'coupon',
  code: 'WKND15',
  discount: { kind: 'percentage', basisPoints: 1500 },
  maxDiscountMinor: null,
  minimumMerchandiseMinor: 10000,
  target: { kind: 'skus', values: [parent.sku] },
  startsAt: '2026-11-20T00:00:00.000Z',
  endsAt: '2026-11-30T23:59:59.999Z',
  audienceRestriction: null,
  ...over,
});

async function create(over = {}, key = uuid()) {
  return svc.createPromotion(ctx(), { idempotencyKey: key, promotion: definition(over) });
}

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
  now = T0;
  catalogDown = false;
  svc = service();
  await migrateLegacyPromotions(store, { clock });
});

describe('envelopes and validation', () => {
  test('storage must be explicitly migrated', async () => {
    store = createMemoryStore();
    svc = service();
    const r = await svc.listPromotions(ctx(), {});
    expect(r.error.code).toBe('PROMOTION_STORAGE_UNINITIALIZED');
    expect(r.committed).toBe(false);
  });

  test('unverified context is rejected, never defaulted', async () => {
    const r = await svc.listPromotions({ actor: { subject: 'x', orgId: ORG }, correlationId: uuid() }, {});
    expect(r.error.code).toBe('PROMOTION_CONFIGURATION_ERROR');
  });

  test('create: committed write envelope, default disabled, exact affected set', async () => {
    const c = ctx();
    const key = uuid();
    const r = await svc.createPromotion(c, { idempotencyKey: key.toUpperCase(), promotion: { name: ' Ten ', mode: 'coupon', code: ' ten10 ', discount: { kind: 'percentage', basisPoints: 1000 }, target: { kind: 'skus', values: [parent.sku.toLowerCase()] } } });
    expect(Object.keys(r)).toEqual(ROOT_OK_WRITE);
    expect(Object.keys(r.promotion)).toEqual(DTO_KEYS);
    expect(r).toMatchObject({
      apiVersion: 'wknd.promotions/v1', ok: true, committed: true, replayed: false, request: { operation: 'create', idempotencyKey: key }, correlationId: c.correlationId, mutationCorrelationId: c.correlationId,
    });
    expect(r.promotion).toMatchObject({
      revision: 1, managementClass: 'standard', name: 'Ten', enabled: false, code: 'TEN10', maxDiscountMinor: null, minimumMerchandiseMinor: null, startsAt: null, endsAt: null, audienceRestriction: null, createdAt: '2026-11-20T04:00:00.000Z',
    });
    expect(r.promotion.id).toMatch(/^prm_[0-9a-f]{32}$/);
    expect(r.affected).toEqual({ scope: 'skus', parentSkus: [parent.sku], sellableSkus: parent.variants.map((v) => v.sku).sort() });
    expect(r.effects).toEqual({ status: 'complete', warnings: [], retryReference: null });
  });

  test.each([
    ['invalid code char', { code: 'WKND.10' }, '/promotion/code', 'INVALID_FORMAT'],
    ['percentage out of range', { discount: { kind: 'percentage', basisPoints: 10001 } }, '/promotion/discount/basisPoints', 'OUT_OF_RANGE'],
    ['timestamp offset', { startsAt: '2026-11-20T04:00:00.000+00:00' }, '/promotion/startsAt', 'INVALID_FORMAT'],
    ['timestamp missing ms', { endsAt: '2026-11-20T04:00:00Z' }, '/promotion/endsAt', 'INVALID_FORMAT'],
    ['duplicate target after normalization', { target: { kind: 'skus', values: [parent.sku, parent.sku.toLowerCase()] } }, '/promotion/target/values', 'DUPLICATE'],
    ['automatic with code', { mode: 'automatic' }, '/promotion/code', 'INCOMPATIBLE_FIELD'],
    ['date order', { startsAt: '2026-12-01T00:00:00.000Z' }, '/promotion/endsAt', 'DATE_ORDER'],
    ['unknown private field', { managementClass: 'protected-recovery' }, '/promotion/managementClass', 'UNKNOWN_FIELD'],
    ['fixed without AUD', { discount: { kind: 'fixed', amountMinor: 100, currency: 'USD' } }, '/promotion/discount/currency', 'INVALID_FORMAT'],
  ])('validation: %s', async (_, over, field, reason) => {
    const r = await create(over);
    expect(Object.keys(r)).toEqual(ROOT_ERR);
    expect(Object.keys(r.error)).toEqual(ERR_KEYS);
    expect(r).toMatchObject({ ok: false, committed: false, request: null });
    expect(r.error).toMatchObject({
      code: 'VALIDATION_ERROR', message: 'Promotion arguments are invalid.', retryable: false, retryMode: 'none', retryAfterSeconds: null, fieldsTruncated: false, details: null,
    });
    expect(r.error.fields).toContainEqual(expect.objectContaining({ path: field, code: reason }));
  });

  test('category normalization and unknown catalog references', async () => {
    const ok = await create({ code: 'CAT10', target: { kind: 'categories', values: [' Apparel/Jackets '] } });
    expect(ok.promotion.target).toEqual({ kind: 'categories', values: ['apparel/jackets'] });
    const bad = await create({ code: 'CAT11', target: { kind: 'skus', values: ['NOPE-123'] } });
    expect(bad.error.code).toBe('VALIDATION_ERROR');
    expect(bad.error.fields).toEqual([{ path: '/promotion/target/values/0', code: 'UNKNOWN_REFERENCE', message: 'Field references an unknown catalog entry.' }]);
  });

  test('non-null audience restriction is unsupported, not stripped', async () => {
    const r = await create({ audienceRestriction: { segmentId: '27504716' } });
    expect(r.error.code).toBe('UNSUPPORTED_AUDIENCE_RESTRICTION');
    expect(await store.collection('promotions').countDocuments({ code: 'WKND15' })).toBe(0);
  });

  test('request size limit', async () => {
    const r = await create({ name: 'x'.repeat(17000) });
    expect(r.error.code).toBe('REQUEST_TOO_LARGE');
  });

  test('normalized coupon codes are unique, including legacy codes', async () => {
    expect((await create({ code: 'wknd10' })).error.code).toBe('COUPON_CODE_CONFLICT');
    expect((await create()).ok).toBe(true);
    const dup = await create({ code: ' wknd15 ' });
    expect(dup.error.code).toBe('COUPON_CODE_CONFLICT');
    expect(dup.committed).toBe(false);
  });
});

describe('idempotency', () => {
  test('identical replay returns the original snapshot without another write', async () => {
    const key = uuid();
    const first = await create({}, key);
    const replayCtx = ctx();
    const replay = await svc.createPromotion(replayCtx, { idempotencyKey: key, promotion: definition() });
    expect(replay).toMatchObject({ ok: true, replayed: true, promotion: first.promotion, affected: first.affected });
    expect(replay.correlationId).toBe(replayCtx.correlationId);
    expect(replay.mutationCorrelationId).toBe(first.mutationCorrelationId);
    expect(await store.collection('promotions').countDocuments({ code: 'WKND15' })).toBe(1);
    expect(await store.collection('promotion_audit').countDocuments({ promotionId: first.promotion.id })).toBe(1);
  });

  test('create defaults and explicit nulls hash equally', async () => {
    const key = uuid();
    const minimal = {
      name: 'n', mode: 'automatic', discount: { kind: 'fixed', amountMinor: 100, currency: 'AUD' }, target: { kind: 'all' },
    };
    await svc.createPromotion(ctx(), { idempotencyKey: key, promotion: minimal });
    const r = await svc.createPromotion(ctx(), { idempotencyKey: key, promotion: { ...minimal, code: null, enabled: false, startsAt: null } });
    expect(r.replayed).toBe(true);
  });

  test('same key with different arguments conflicts without a write', async () => {
    const key = uuid();
    const first = await create({}, key);
    const r = await svc.createPromotion(ctx(), { idempotencyKey: key, promotion: definition({ name: 'Other' }) });
    expect(r.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(r.committed).toBe(false);
    expect(r.mutationCorrelationId).toBe(first.mutationCorrelationId);
  });

  test('claimed terminal failure replays its original outcome', async () => {
    const key = uuid();
    const a = await create({ code: 'WKND10' }, key);
    const b = await create({ code: 'WKND10' }, key);
    expect(a.error.code).toBe('COUPON_CODE_CONFLICT');
    expect(b.error.code).toBe('COUPON_CODE_CONFLICT');
    expect(b.mutationCorrelationId).toBe(a.mutationCorrelationId);
  });

  test('receipt scope is the verified org, not the operator', async () => {
    const key = uuid();
    const first = await create({}, key);
    const other = await svc.createPromotion({ ...ctx(), actor: { kind: 'ims-operator', subject: 'operator-2', orgId: ORG } }, { idempotencyKey: key, promotion: definition() });
    expect(other.replayed).toBe(true);
    const otherOrg = await svc.createPromotion({ ...ctx(), actor: { kind: 'ims-operator', subject: 'operator-1', orgId: 'OTHER@AdobeOrg' } }, { idempotencyKey: key, promotion: definition() });
    expect(otherOrg.error.code).toBe('COUPON_CODE_CONFLICT');
    expect(first.ok).toBe(true);
  });
});

describe('update, disable and revisions', () => {
  test('full update replaces the definition and reports the old/new target union', async () => {
    const created = await create({ target: { kind: 'skus', values: [parent.sku] } });
    const r = await svc.updatePromotion(ctx(), {
      id: created.promotion.id, expectedRevision: 1, idempotencyKey: uuid(), promotion: definition({ target: { kind: 'skus', values: [simple.sku] } }),
    });
    expect(r.promotion.revision).toBe(2);
    expect(r.affected).toEqual({
      scope: 'skus',
      parentSkus: [parent.sku, simple.sku].sort(),
      sellableSkus: [...parent.variants.map((v) => v.sku), simple.sku].sort(),
    });
  });

  test('full update requires every key (no defaulting or merging); patch is unsupported', async () => {
    const created = await create();
    const { maxDiscountMinor, ...partial } = definition();
    const r = await svc.updatePromotion(ctx(), {
      id: created.promotion.id, expectedRevision: 1, idempotencyKey: uuid(), promotion: partial,
    });
    expect(r.error.code).toBe('VALIDATION_ERROR');
    expect(r.error.fields).toContainEqual(expect.objectContaining({ path: '/promotion/maxDiscountMinor', code: 'REQUIRED' }));
    const patch = await svc.updatePromotion(ctx(), {
      id: created.promotion.id, expectedRevision: 1, idempotencyKey: uuid(), promotion: definition(), patch: { maxDiscountMinor: null },
    });
    expect(patch.error.fields).toContainEqual(expect.objectContaining({ path: '/patch', code: 'UNKNOWN_FIELD' }));
    expect(maxDiscountMinor).toBeNull();
  });

  test('normalized no-op update increments revision with an empty affected set', async () => {
    const created = await create();
    const r = await svc.updatePromotion(ctx(), {
      id: created.promotion.id, expectedRevision: 1, idempotencyKey: uuid(), promotion: definition(),
    });
    expect(r.promotion.revision).toBe(2);
    expect(r.affected).toEqual({ scope: 'skus', parentSkus: [], sellableSkus: [] });
    expect(r.effects).toEqual({ status: 'complete', warnings: [], retryReference: null });
  });

  test('stale revision conflicts with exact details', async () => {
    const created = await create();
    await svc.updatePromotion(ctx(), {
      id: created.promotion.id, expectedRevision: 1, idempotencyKey: uuid(), promotion: definition({ name: 'B' }),
    });
    const r = await svc.updatePromotion(ctx(), {
      id: created.promotion.id, expectedRevision: 1, idempotencyKey: uuid(), promotion: definition({ name: 'C' }),
    });
    expect(r.error).toEqual({
      code: 'REVISION_CONFLICT', message: 'Promotion revision does not match.', retryable: false, retryMode: 'none', retryAfterSeconds: null, fields: [], fieldsTruncated: false, details: { expectedRevision: 1, currentRevision: 2 },
    });
    expect(r.committed).toBe(false);
  });

  test('mode/code change releases the old (non-legacy) code', async () => {
    const created = await create();
    await svc.updatePromotion(ctx(), {
      id: created.promotion.id, expectedRevision: 1, idempotencyKey: uuid(), promotion: definition({ mode: 'automatic', code: null }),
    });
    expect((await create({ name: 'Reuse' })).ok).toBe(true);
  });

  test('disable: global safety-disable scope, already-disabled no-op, stale conflict, replay', async () => {
    const created = await create();
    const key = uuid();
    const d1 = await svc.disablePromotion(ctx(), { id: created.promotion.id, expectedRevision: 1, idempotencyKey: key });
    expect(d1.promotion).toMatchObject({ revision: 2, enabled: false });
    expect(d1.affected).toEqual({ scope: 'global-promotions', reason: 'safety-disable' });
    expect(d1.effects.status).toBe('complete');
    const d2 = await svc.disablePromotion(ctx(), { id: created.promotion.id, expectedRevision: 2, idempotencyKey: uuid() });
    expect(d2.promotion.revision).toBe(3);
    expect(d2.affected).toEqual({ scope: 'skus', parentSkus: [], sellableSkus: [] });
    const stale = await svc.disablePromotion(ctx(), { id: created.promotion.id, expectedRevision: 2, idempotencyKey: uuid() });
    expect(stale.error.code).toBe('REVISION_CONFLICT');
    const replay = await svc.disablePromotion(ctx(), { id: created.promotion.id, expectedRevision: 1, idempotencyKey: key });
    expect(replay).toMatchObject({ replayed: true, promotion: { revision: 2 } });
    expect((await svc.getPromotion(ctx(), { id: created.promotion.id })).promotion.revision).toBe(3);
  });

  test('safety disable needs no catalog or live references', async () => {
    const created = await create({ target: { kind: 'skus', values: [simple.sku] } });
    await store.collection('products').deleteOne({ sku: simple.sku });
    resetCatalogCache();
    catalogDown = true;
    const r = await svc.disablePromotion(ctx(), { id: created.promotion.id, expectedRevision: 1, idempotencyKey: uuid() });
    expect(r).toMatchObject({ committed: true, promotion: { enabled: false, revision: 2 }, affected: { scope: 'global-promotions', reason: 'safety-disable' } });
  });

  test('committed disable with failing invalidation reports a bounded effect warning', async () => {
    const created = await create();
    const counters = store.collection('counters');
    const original = counters.updateOne.bind(counters);
    counters.updateOne = async () => { throw new Error('cache down'); };
    const r = await svc.disablePromotion(ctx(), { id: created.promotion.id, expectedRevision: 1, idempotencyKey: uuid() });
    counters.updateOne = original;
    expect(r.committed).toBe(true);
    expect(r.effects).toEqual({
      status: 'failed',
      warnings: [{ code: 'PROMOTION_CACHE_INVALIDATION_FAILED', message: 'Promotion was saved; cache invalidation requires recovery.' }],
      retryReference: expect.stringMatching(/^eff_[0-9a-f]{32}$/),
    });
    expect((await svc.recoverRequests()).effects).toBe(1);
  });

  test('output preflight rejects before any domain write', async () => {
    svc = service({ resultLimitBytes: 1000 });
    const r = await create();
    expect(r).toMatchObject({ committed: false, error: { code: 'OUTPUT_TOO_LARGE' } });
    expect(await store.collection('promotions').countDocuments({ code: 'WKND15' })).toBe(0);
  });
});

describe('list and cursors', () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await create({ code: `LIST${i}A`, enabled: i % 2 === 0 });
    }
  });

  test('ascending id keyset pages with an opaque bound cursor', async () => {
    const all = await svc.listPromotions(ctx(), {});
    expect(all.items.map((p) => p.id)).toEqual([...all.items.map((p) => p.id)].sort());
    expect(all.items).toHaveLength(7);
    const p1 = await svc.listPromotions(ctx(), { limit: 3 });
    expect(p1.nextCursor).toMatch(/^pc1\.[A-Za-z0-9_-]+$/);
    expect(p1.nextCursor).not.toContain(ORG);
    const p2 = await svc.listPromotions(ctx(), { limit: 3, cursor: p1.nextCursor });
    const p3 = await svc.listPromotions(ctx(), { limit: 3, cursor: p2.nextCursor });
    expect(p3.nextCursor).toBeNull();
    expect([...p1.items, ...p2.items, ...p3.items].map((p) => p.id)).toEqual(all.items.map((p) => p.id));
  });

  test('cursor rejects changed filter/limit, wrong org, tampering and expiry', async () => {
    const p1 = await svc.listPromotions(ctx(), { limit: 2 });
    expect((await svc.listPromotions(ctx(), { cursor: p1.nextCursor })).error.code).toBe('INVALID_CURSOR');
    expect((await svc.listPromotions(ctx(), { limit: 2, enabled: true, cursor: p1.nextCursor })).error.code).toBe('INVALID_CURSOR');
    const otherOrg = { ...ctx(), actor: { kind: 'ims-operator', subject: 's', orgId: 'OTHER@AdobeOrg' } };
    expect((await svc.listPromotions(otherOrg, { limit: 2, cursor: p1.nextCursor })).error.code).toBe('INVALID_CURSOR');
    const tampered = `${p1.nextCursor.slice(0, -2)}AA`;
    expect((await svc.listPromotions(ctx(), { limit: 2, cursor: tampered })).error.code).toBe('INVALID_CURSOR');
    expect(decodeCursor(Buffer.from(CURSOR_KEY, 'base64'), p1.nextCursor).exp - decodeCursor(Buffer.from(CURSOR_KEY, 'base64'), p1.nextCursor).first).toBe(900);
    now = T0 + 900 * 1000;
    expect((await svc.listPromotions(ctx(), { limit: 2, cursor: p1.nextCursor })).error.code).toBe('INVALID_CURSOR');
  });

  test('enabled filter and bounds', async () => {
    const r = await svc.listPromotions(ctx(), { enabled: false });
    expect(r.items.every((p) => p.enabled === false)).toBe(true);
    expect((await svc.listPromotions(ctx(), { limit: 51 })).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('receipts and reconciliation', () => {
  test('request lookup replays a committed mutation read-only', async () => {
    const key = uuid();
    const created = await create({}, key);
    const r = await svc.getPromotion(ctx(), { request: { operation: 'create', idempotencyKey: key } });
    expect(r).toMatchObject({ ok: true, replayed: true, promotion: created.promotion });
  });

  test('missing receipt does not claim no-commit', async () => {
    const key = uuid();
    const c = ctx();
    const r = await svc.getPromotion(c, { request: { operation: 'create', idempotencyKey: key } });
    expect(r).toEqual({
      apiVersion: 'wknd.promotions/v1',
      ok: false,
      committed: null,
      error: {
        code: 'REQUEST_NOT_FOUND', message: 'Request receipt was not found; mutation outcome is unknown.', retryable: false, retryMode: 'none', retryAfterSeconds: null, fields: [], fieldsTruncated: false, details: null,
      },
      request: { operation: 'create', idempotencyKey: key },
      correlationId: c.correlationId,
      mutationCorrelationId: null,
    });
  });

  test('get-by-id rejects both locators together', async () => {
    const r = await svc.getPromotion(ctx(), { id: LEGACY_SEEDS[0].id, request: { operation: 'create', idempotencyKey: uuid() } });
    expect(r.error.code).toBe('VALIDATION_ERROR');
  });

  test('unknown commit → reconciliation; worker fences, then the same key may retry', async () => {
    const promotions = store.collection('promotions');
    const originalInsert = promotions.insertOne.bind(promotions);
    promotions.insertOne = async () => { throw new Error('network reset'); };
    const key = uuid();
    const r = await create({}, key);
    promotions.insertOne = originalInsert;
    expect(r.error).toMatchObject({
      code: 'RECONCILIATION_REQUIRED', retryable: true, retryMode: 'lookup', retryAfterSeconds: 5,
    });
    expect(r.committed).toBeNull();
    const lookup = await svc.getPromotion(ctx(), { request: { operation: 'create', idempotencyKey: key } });
    expect(lookup.error.code).toBe('RECONCILIATION_REQUIRED');
    expect((await create({}, key)).error.code).toBe('RECONCILIATION_REQUIRED');
    now += 61000;
    expect(await svc.recoverRequests()).toMatchObject({ noCommit: 1 });
    const after = await svc.getPromotion(ctx(), { request: { operation: 'create', idempotencyKey: key } });
    expect(after).toMatchObject({ committed: false, error: { code: 'PROMOTION_SERVICE_UNAVAILABLE', retryMode: 'same-request' } });
    now += 5000;
    const retried = await create({}, key);
    expect(retried).toMatchObject({ ok: true, committed: true });
    expect(await store.collection('promotions').countDocuments({ code: 'WKND15', fenced: { $ne: true } })).toBe(1);
  });

  test('commit known but receipt not finalized → worker rolls forward without a second write', async () => {
    const requests = store.collection('promotion_requests');
    const originalUpdate = requests.updateOne.bind(requests);
    requests.updateOne = async (filter, update, opts) => {
      if (update.$set?.state === 'committed') throw new Error('receipt write lost');
      return originalUpdate(filter, update, opts);
    };
    const key = uuid();
    const r = await create({}, key);
    requests.updateOne = originalUpdate;
    expect(r.committed).toBe(true);
    const lookup = await svc.getPromotion(ctx(), { request: { operation: 'create', idempotencyKey: key } });
    expect(lookup).toMatchObject({ committed: true, replayed: true, promotion: { id: r.promotion.id } });
    now += 61000;
    expect(await svc.recoverRequests()).toMatchObject({ committed: 1 });
    expect(await store.collection('promotions').countDocuments({ code: 'WKND15' })).toBe(1);
  });

  test('public receipt expiry at day 30 keeps commitment truthful and never writes again', async () => {
    const promotions = store.collection('promotions');
    const originalInsert = promotions.insertOne.bind(promotions);
    promotions.insertOne = async () => { throw new Error('network reset'); };
    const key = uuid();
    await create({}, key);
    promotions.insertOne = originalInsert;
    now = T0 + 30 * DAY;
    const expired = await svc.getPromotion(ctx(), { request: { operation: 'create', idempotencyKey: key } });
    expect(expired).toMatchObject({ committed: null, error: { code: 'IDEMPOTENCY_RECORD_EXPIRED', retryable: false, retryMode: 'none' } });
    const again = await create({}, key);
    expect(again.error.code).toBe('IDEMPOTENCY_RECORD_EXPIRED');
    expect(await store.collection('promotions').countDocuments({ code: 'WKND15' })).toBe(0);
    const receipt = await store.collection('promotion_requests').findOne({ idempotencyKey: key });
    expect(receipt.intent.promotionId).toMatch(/^prm_/);
  });

  test('expired committed receipt reports committed:true', async () => {
    const key = uuid();
    await create({}, key);
    now = T0 + 30 * DAY;
    const r = await create({}, key);
    expect(r).toMatchObject({ committed: true, error: { code: 'IDEMPOTENCY_RECORD_EXPIRED' } });
  });
});

describe('protected recovery policy', () => {
  const RID = promotionIdFor(DEFAULT_CAMPAIGN.campaignId);
  const approved = (over = {}) => ({
    name: DEFAULT_CAMPAIGN.name,
    enabled: false,
    mode: 'coupon',
    code: 'RECOVER10',
    discount: { kind: 'percentage', basisPoints: 1000 },
    maxDiscountMinor: 2500,
    minimumMerchandiseMinor: null,
    target: { kind: 'all' },
    startsAt: null,
    endsAt: null,
    audienceRestriction: null,
    ...over,
  });
  const update = (promotion, expectedRevision = 1) => svc.updatePromotion(ctx(), {
    id: RID, expectedRevision, idempotencyKey: uuid(), promotion,
  });

  beforeEach(async () => {
    await bootstrapRecoveryPromotion(store, { clock });
  });

  test('read DTO exposes management class only', async () => {
    const r = await svc.getPromotion(ctx(), { id: RID });
    expect(r.promotion).toMatchObject({ managementClass: 'protected-recovery', enabled: false, maxDiscountMinor: 2500 });
    expect(Object.keys(r.promotion)).toEqual(DTO_KEYS);
  });

  test.each([
    ['missing cap', (d) => { const { maxDiscountMinor, ...rest } = d; return rest; }, '/promotion/maxDiscountMinor'],
    ['null cap', (d) => ({ ...d, maxDiscountMinor: null }), '/promotion/maxDiscountMinor'],
    ['raised cap', (d) => ({ ...d, maxDiscountMinor: 2501 }), '/promotion/maxDiscountMinor'],
    ['increased benefit', (d) => ({ ...d, discount: { kind: 'percentage', basisPoints: 1001 } }), '/promotion/discount'],
    ['target broadening', (d) => ({ ...d, target: { kind: 'categories', values: ['apparel'] } }), '/promotion/target'],
    ['window removed', (d) => { const { endsAt, ...rest } = d; return rest; }, '/promotion/endsAt'],
    ['audience omitted', (d) => { const { audienceRestriction, ...rest } = d; return rest; }, '/promotion/audienceRestriction'],
  ])('%s → PROTECTED_POLICY_VIOLATION', async (_, mutate, field) => {
    const r = await update(mutate(approved()));
    expect(r.error.code).toBe('PROTECTED_POLICY_VIOLATION');
    expect(r.error.fields).toContainEqual({ path: field, code: 'PROTECTED', message: 'Field is managed by the recovery policy.' });
    expect((await svc.getPromotion(ctx(), { id: RID })).promotion.revision).toBe(1);
  });

  test('unknown private keys stay validation errors', async () => {
    const r = await update({ ...approved(), campaignId: 'new' });
    expect(r.error).toMatchObject({ code: 'VALIDATION_ERROR', fields: [expect.objectContaining({ path: '/promotion/campaignId', code: 'UNKNOWN_FIELD' })] });
  });

  test('re-enable requires verified readiness; rename preserves the policy', async () => {
    const notReady = await update(approved({ enabled: true }));
    expect(notReady.error).toMatchObject({ code: 'RECOVERY_NOT_READY', retryable: true, retryMode: 'same-request', retryAfterSeconds: 5 });
    expect((await svc.getPromotion(ctx(), { id: RID })).promotion.revision).toBe(1);
    svc = service({ params: { RECOVERY_REDEMPTION_VERIFIED: 'true' } });
    const ready = await update(approved({ enabled: true, name: 'Recovery reminder' }));
    expect(ready.promotion).toMatchObject({ enabled: true, revision: 2, name: 'Recovery reminder', managementClass: 'protected-recovery' });
    const policy = await store.collection('recovery_policies').findOne({ promotionId: RID });
    expect(policy.campaignId).toBe(DEFAULT_CAMPAIGN.campaignId);
  });

  test('protected disable works while providers/catalog are down', async () => {
    svc = service({ params: { RECOVERY_REDEMPTION_VERIFIED: 'true' } });
    await update(approved({ enabled: true }));
    catalogDown = true;
    svc = service();
    const r = await svc.disablePromotion(ctx(), { id: RID, expectedRevision: 2, idempotencyKey: uuid() });
    expect(r).toMatchObject({ committed: true, promotion: { enabled: false, revision: 3 }, affected: { scope: 'global-promotions', reason: 'safety-disable' } });
  });

  test('generic create with the same copy gains no protection; recovery code is reserved', async () => {
    const r = await create({ name: DEFAULT_CAMPAIGN.name, code: 'COMEBACK10' });
    expect(r.promotion.managementClass).toBe('standard');
    expect((await create({ code: 'RECOVER10' })).error.code).toBe('COUPON_CODE_CONFLICT');
  });
});

describe('legacy migration', () => {
  test('seeds deterministic legacy promotions', async () => {
    const list = await svc.listPromotions(ctx(), {});
    const legacy = list.items.filter((p) => LEGACY_SEEDS.some((s) => s.id === p.id));
    expect(legacy.map((p) => [p.code, p.revision, p.enabled, p.discount, p.minimumMerchandiseMinor, p.target, p.maxDiscountMinor])).toEqual([
      ['WKND10', 1, true, { kind: 'percentage', basisPoints: 1000 }, null, { kind: 'all' }, null],
      ['TRAILREADY', 1, true, { kind: 'fixed', amountMinor: 2000, currency: 'AUD' }, 20000, { kind: 'all' }, null],
    ]);
  });

  test('repeat migration is a no-op and never re-enables operator changes', async () => {
    await svc.disablePromotion(ctx(), { id: LEGACY_SEEDS[0].id, expectedRevision: 1, idempotencyKey: uuid() });
    expect(await migrateLegacyPromotions(store, { clock })).toEqual({ inserted: 0, unchanged: 2 });
    expect((await svc.getPromotion(ctx(), { id: LEGACY_SEEDS[0].id })).promotion).toMatchObject({ revision: 2, enabled: false });
  });

  test('foreign record holding a legacy code fails the migration', async () => {
    const fresh = createMemoryStore();
    await fresh.collection('promotion_codes').insertOne({ _id: 'WKND10', code: 'WKND10', promotionId: 'prm_ffffffffffffffffffffffffffffffff' });
    await expect(migrateLegacyPromotions(fresh)).rejects.toMatchObject({ code: 'MIGRATION_CONFLICT' });
    expect(await fresh.collection('promotion_meta').countDocuments({})).toBe(0);
  });
});
