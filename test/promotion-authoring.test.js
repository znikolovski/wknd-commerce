const { z } = require('zod');
const { authoringCatalogue, previewAudienceDraft, previewSchema } = require('../lib/promotion-authoring');
const { createPromotionsAdmin } = require('../lib/promotions-admin');
const { validateDefinition } = require('../lib/promotion-schema');
const { promotionTools } = require('../lib/mcp-promotions');

const draft = (overrides = {}) => ({
  environment: 'stage', audienceKey: 'climbing-interest',
  promotion: { name: ' Climbing demo ', mode: 'automatic', discount: { kind: 'percentage', basisPoints: 1000 }, target: { kind: 'all' } },
  ...overrides,
});

test.each([
  ['climbing-interest', '27507403'],
  ['climbing-planner', '27507404'],
])('canonical %s produces a disabled, labelled fixture without membership evidence', (key, segmentId) => {
  const output = previewAudienceDraft(draft({ audienceKey: key }));
  expect(output).toMatchObject({
    schema: 'wknd.promotion-authoring/fixture-v1', mode: 'fixture', ok: true,
    persisted: false, financialAuthorization: false,
    activation: { blocked: true, reason: 'PROVIDER_NOT_VERIFIED' },
    fixturePreview: {
      audience: { key, env: 'stage', version: 1, provider: 'aam', segmentId, status: 'draft', transport: 'unverified', sourceDpid: '1547309', mergeRuleId: '1547344' },
      promotion: { name: 'Climbing demo', enabled: false, audienceRestriction: null },
    },
  });
  expect(JSON.stringify(output)).not.toMatch(/qualified|complete|evidenceRef|evaluatedAt|expiresAt|shopperBinding/);
});

test.each([
  ['wrong environment', { environment: 'prod' }],
  ['raw ID', { audienceKey: '27507403' }],
  ['unknown key', { audienceKey: 'toString' }],
  ['caller IDs', { segmentId: '27507404' }],
  ['caller evidence', { complete: true }],
  ['enable', { promotion: { ...draft().promotion, enabled: true } }],
  ['restriction', { promotion: { ...draft().promotion, audienceRestriction: { key: 'climbing-interest' } } }],
  ['invalid basis points', { promotion: { ...draft().promotion, discount: { kind: 'percentage', basisPoints: 10001 } } }],
])('%s is rejected by both published schema and authoritative preview', (_label, overrides) => {
  const input = draft(overrides);
  expect(previewSchema.safeParse(input).success).toBe(false);
  expect(previewAudienceDraft(input)).toMatchObject({ ok: false, persisted: false, error: { code: 'INVALID_DRAFT' } });
});

test.each([
  { name: ' ' },
  { startsAt: '2026-11-24T00:00:00.000Z', endsAt: '2026-11-23T00:00:00.000Z' },
  { target: { kind: 'skus', values: ['GEAR-ONE', 'gear-one'] } },
  { code: 'FORGED' },
])('reuses frozen semantic validation rather than duplicating it: %j', (override) => {
  const promotion = { ...draft().promotion, ...override };
  const expected = validateDefinition(promotion, 'create');
  expect(expected.fields.length).toBeGreaterThan(0);
  expect(previewAudienceDraft(draft({ promotion })).error.fields).toEqual(expected.fields);
});

test('argument bounds, JSON validity and absent inputs fail explicitly', () => {
  const oversized = draft({ padding: 'x'.repeat(16384) });
  expect(previewAudienceDraft(oversized).error.fields[0].code).toBe('REQUEST_TOO_LARGE');
  const deep = draft({ a: { b: { c: { d: { e: { f: { g: {} } } } } } } });
  deep.a.b.c.d.e.f.g.h = {};
  expect(previewAudienceDraft(deep).error.fields[0].code).toBe('REQUEST_TOO_LARGE');
  expect(previewAudienceDraft(undefined).ok).toBe(false);
  expect(previewAudienceDraft(draft({ promotion: { ...draft().promotion, maxDiscountMinor: NaN } })).ok).toBe(false);
});

test('admin and MCP use exactly the same catalogue, validator and input schema with zero collection/catalog access', async () => {
  const collection = jest.fn(() => { throw new Error('No storage allowed'); });
  const catalog = jest.fn(() => { throw new Error('No live catalog required'); });
  const store = { collection };
  const api = createPromotionsAdmin({ store, catalog });
  const tools = promotionTools();
  const tool = tools.find((t) => t.name === 'preview_audience_promotion_draft');
  const list = tools.find((t) => t.name === 'list_promotion_authoring_audiences');
  expect(z.toJSONSchema(tool.schema)).toEqual(z.toJSONSchema(previewSchema));
  expect(tool.readOnly).toBe(true);
  expect(await api.handle({}, 'promotions.authoringAudiences')).toEqual(authoringCatalogue());
  expect(await list.run()).toEqual(authoringCatalogue());
  const context = { logger: { error: jest.fn() } };
  for (const args of [draft(), draft({ environment: 'prod' }), draft({ promotion: { ...draft().promotion, name: '' } })]) {
    const expected = previewAudienceDraft(args);
    // eslint-disable-next-line no-await-in-loop
    expect(await api.handle({}, 'promotions.previewAudienceDraft', args)).toEqual(expected);
    // eslint-disable-next-line no-await-in-loop
    expect(await tool.run(store, args, context)).toEqual(expected);
  }
  expect(collection).not.toHaveBeenCalled();
  expect(catalog).not.toHaveBeenCalled();
  expect(context.logger.error).toHaveBeenCalledWith('mcp.authoring.rejected', expect.objectContaining({ code: 'INVALID_DRAFT' }));
});
