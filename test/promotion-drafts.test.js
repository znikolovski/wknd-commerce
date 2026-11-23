const { randomUUID } = require('node:crypto');
const { createMemoryStore } = require('../lib/store');
const { createPromotionDraftService, COLLECTION, schemas, draftTools } = require('../lib/promotion-drafts');
const { createPromotionService, migrateLegacyPromotions, loadPromotionRuntime } = require('../lib/promotions');
const { createPromotionsAdmin } = require('../lib/promotions-admin');

const ctx = { actor: { kind: 'ims-operator', subject: 'author', orgId: 'test-org' }, correlationId: randomUUID() };
const promotion = (overrides = {}) => ({
  name: ' Climbing draft ', mode: 'automatic', enabled: false,
  discount: { kind: 'percentage', basisPoints: 1000 }, target: { kind: 'all' },
  audienceRestriction: { environment: 'stage', key: 'climbing-interest', version: 1 },
  ...overrides,
});
let store;
let service;
beforeEach(() => {
  store = createMemoryStore();
  service = createPromotionDraftService({ store });
});

test('persisted CRUD roundtrip, create replay, full replacement and revision-aware deletion', async () => {
  const args = { idempotencyKey: randomUUID(), promotion: promotion() };
  const created = await service.create(ctx, args);
  expect(created).toMatchObject({
    apiVersion: 'wknd.promotion-drafts/v2', ok: true, persisted: true, financialAuthorization: false,
    activation: { blocked: true, reason: 'PROVIDER_NOT_VERIFIED' },
    draft: { revision: 1, state: 'draft', promotion: { name: 'Climbing draft', enabled: false, audienceRestriction: args.promotion.audienceRestriction } },
  });
  expect((await service.create(ctx, args)).replayed).toBe(true);
  expect(await store.collection(COLLECTION).countDocuments({})).toBe(1);
  expect((await service.create(ctx, { ...args, promotion: promotion({ name: 'Different terms' }) })).error.code).toBe('IDEMPOTENCY_CONFLICT');
  const anotherRequest = createPromotionDraftService({ store });
  expect((await anotherRequest.get(ctx, { id: created.draft.id })).draft).toEqual(created.draft);
  expect(JSON.stringify(created)).not.toMatch(/test-org|createdBy|updatedBy|creationHash/);
  expect((await service.update(ctx, { id: created.draft.id, expectedRevision: 1, promotion: { name: 'Patch only' } })).error.code).toBe('INVALID_DRAFT');
  const replacement = { ...created.draft.promotion, audienceRestriction: { environment: 'stage', key: 'climbing-planner', version: 1 } };
  const updated = await service.update(ctx, { id: created.draft.id, expectedRevision: 1, promotion: replacement });
  expect(updated.draft).toMatchObject({ revision: 2, promotion: { audienceRestriction: replacement.audienceRestriction } });
  expect((await service.list(ctx)).items).toEqual([updated.draft]);
  expect((await service.delete(ctx, { id: created.draft.id, expectedRevision: 1 })).error.code).toBe('REVISION_CONFLICT');
  expect(await service.delete(ctx, { id: created.draft.id, expectedRevision: 2 })).toMatchObject({ ok: true, deleted: true, revision: 3 });
  expect((await service.list(ctx)).items).toEqual([]);
  expect((await service.get(ctx, { id: created.draft.id })).error.code).toBe('DRAFT_NOT_FOUND');
  expect((await service.create(ctx, args)).error.code).toBe('DRAFT_DELETED');
});

test('concurrent updates use CAS and separate orgs cannot read/update/delete/list each other', async () => {
  const { draft } = await service.create(ctx, { idempotencyKey: randomUUID(), promotion: promotion() });
  const saves = await Promise.all(['First', 'Second'].map((name) => service.update(ctx, {
    id: draft.id, expectedRevision: 1, promotion: { ...draft.promotion, name },
  })));
  expect(saves.filter((r) => r.ok)).toHaveLength(1);
  expect(saves.find((r) => !r.ok).error.code).toBe('REVISION_CONFLICT');
  const other = { ...ctx, actor: { ...ctx.actor, orgId: 'other-org' } };
  expect((await service.get(other, { id: draft.id })).error.code).toBe('DRAFT_NOT_FOUND');
  expect((await service.update(other, { id: draft.id, expectedRevision: 2, promotion: draft.promotion })).error.code).toBe('DRAFT_NOT_FOUND');
  expect((await service.delete(other, { id: draft.id, expectedRevision: 2 })).error.code).toBe('DRAFT_NOT_FOUND');
  expect((await service.list(other)).items).toEqual([]);
});

test.each([
  { environment: 'prod', key: 'climbing-interest', version: 1 },
  { environment: 'stage', key: '27507403', version: 1 },
  { environment: 'stage', key: 'climbing-planner', version: 2 },
  { environment: 'stage', key: 'climbing-planner', version: 1, segmentId: '27507404', complete: true },
])('invalid restriction fails schema/service validation before storage: %j', async (audienceRestriction) => {
  const args = { idempotencyKey: randomUUID(), promotion: promotion({ audienceRestriction }) };
  expect(schemas.create.safeParse(args).success).toBe(false);
  expect((await service.create(ctx, args)).error.code).toBe('INVALID_DRAFT');
  expect(await store.collection(COLLECTION).countDocuments({})).toBe(0);
});

test('disabled authoring needs no provider; enabling is blocked and draft records never become runtime offers', async () => {
  await migrateLegacyPromotions(store);
  const args = { idempotencyKey: randomUUID(), promotion: promotion({ mode: 'coupon', code: 'DRAFT_CLIMB' }) };
  const created = await service.create(ctx, args);
  expect(created.ok).toBe(true);
  const enabled = { ...created.draft.promotion, enabled: true };
  expect((await service.create(ctx, { ...args, idempotencyKey: randomUUID(), promotion: enabled })).error.code).toBe('RESTRICTED_ACTIVATION_BLOCKED');
  expect((await service.update(ctx, { id: created.draft.id, expectedRevision: 1, promotion: enabled })).error.code).toBe('RESTRICTED_ACTIVATION_BLOCKED');
  const live = createPromotionService({ store });
  expect((await live.createPromotion(ctx, { idempotencyKey: randomUUID(), promotion: created.draft.promotion })).error.code).toBe('UNSUPPORTED_AUDIENCE_RESTRICTION');
  const runtime = await loadPromotionRuntime(store, { codes: ['DRAFT_CLIMB'] });
  expect(runtime.definitions.some((d) => d.id === created.draft.id || d.code === 'DRAFT_CLIMB')).toBe(false);
  expect(await store.collection('promotion_effects').countDocuments({})).toBe(0);
  expect(draftTools().some((tool) => /enable|apply/.test(tool.name))).toBe(false);
});

test('admin and MCP use the same service, validation and storage; invalid context and storage errors are explicit', async () => {
  const api = createPromotionsAdmin({ store });
  const tools = draftTools();
  const context = { ...ctx, logger: { error: jest.fn() } };
  const args = { idempotencyKey: randomUUID(), promotion: promotion() };
  const tool = tools.find((t) => t.name === 'create_audience_promotion_draft');
  const created = await tool.run(store, args, context);
  expect((await api.handle(ctx.actor, 'promotions.drafts.get', { id: created.draft.id })).draft).toEqual(created.draft);
  expect((await api.handle(ctx.actor, 'promotions.drafts.create', args)).draft).toEqual(created.draft);
  expect((await service.create({}, args)).error.code).toBe('DRAFT_CONTEXT_INVALID');
  const db = createPromotionDraftService({ store: { collection() { throw new Error('Database unavailable'); } } });
  await expect(db.create(ctx, args)).rejects.toThrow('Database unavailable');
});

test('Production drafts preserve unavailable financial state and isolate Stage records and replay identities', async () => {
  const production = { ...ctx, authoringEnvironment: 'production' };
  const idempotencyKey = randomUUID();
  const stage = await service.create(ctx, { idempotencyKey, promotion: promotion() });
  const terms = promotion({ audienceRestriction: { environment: 'production', key: 'climbing-planner', version: 1 } });
  const validation = await service.validate(production, { promotion: terms });
  expect(validation).toMatchObject({
    ok: true, persisted: false, financialAuthorization: false,
    activation: { blocked: true }, availability: { status: 'unavailable' },
  });
  const created = await service.create(production, { idempotencyKey, promotion: terms });
  expect(created.draft.id).not.toBe(stage.draft.id);
  expect((await service.list(production)).items).toEqual([created.draft]);
  expect((await service.get(production, { id: stage.draft.id })).error.code).toBe('DRAFT_NOT_FOUND');
  expect((await service.validate(production, { promotion: promotion() })).error.code).toBe('INVALID_DRAFT');
  expect((await service.update(production, { id: created.draft.id, expectedRevision: 1,
    promotion: { ...terms, enabled: true } })).error.code).toBe('RESTRICTED_ACTIVATION_BLOCKED');
});
