const { randomUUID } = require('node:crypto');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { resetCatalogCache, loadCatalog } = require('../lib/catalog');
const { createPromotionsAdmin } = require('../lib/promotions-admin');
const { migrateLegacyPromotions, createPromotionService } = require('../lib/promotions');
const { createBindingStore } = require('../lib/target-binding-store');
const { shopperKey } = require('../lib/recovery-policy');
const { createCart } = require('../lib/cart');
const { runGraphQL } = require('../lib/graphql-server');
const { COLLECTION, createPromotionDraftService } = require('../lib/promotion-drafts');
const { bundleOpportunities } = require('../lib/bundles');
const { PRODUCTION_MBOX, REQUEST_SCHEMA } = require('../lib/target-diagnostic');
const { SUB, ISSUER, NS, GRANT, params } = require('./fixtures/demo-audience');
const CATALOG = require('../data/catalog.json');

const actor = { kind: 'ims-operator', subject: 'offline-operator', orgId: 'offline-org' };
let store;
let api;
let cart;
let marker;
let fetchImpl;
let draft;
beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
  await migrateLegacyPromotions(store);
  await store.collection('customers').insertOne({
    sub: SUB, idLinkage: { state: 'granted', grantId: GRANT },
  });
  const key = shopperKey(ISSUER, SUB);
  await createBindingStore(store).put(key, {
    state: 'bound', shopperKey: key, orgId: params.TARGET_ID_ORG_ID, dpid: params.TARGET_ID_DPID,
    ecid: '1'.repeat(38), ecidSource: 'server-issued', locationHint: 9, blob: 'offline-blob',
    consentGrantId: GRANT, resyncAt: Date.now() + 60000,
  }, { ifMatch: null });
  cart = await createCart(store, { customerSub: SUB });
  await store.collection('carts').updateOne({ id: cart.id }, { $set: {
    items: [{ uid: 'line-1', sku: 'WKND-LGT-001', parentSku: 'WKND-LGT-001', quantity: 2 }],
  } });
  marker = 'climbing-interest';
  fetchImpl = jest.fn(async () => ({
    ok: true, json: async () => ({ execute: { mboxes: [{ name: PRODUCTION_MBOX, options: [{
      type: 'json', content: { schema: REQUEST_SCHEMA, environment: 'production', marker, financialAuthorization: false },
    }] }] } }),
  }));
  api = createPromotionsAdmin({ store, params, namespace: NS });
  const created = await api.handle(actor, 'promotions.drafts.create', {
    idempotencyKey: randomUUID(), promotion: {
      name: 'Interest DEMO approval', enabled: false, mode: 'automatic',
      discount: { kind: 'percentage', basisPoints: 5000 }, target: { kind: 'all' },
      audienceRestriction: { environment: 'production', key: 'climbing-interest', version: 1 },
    },
  });
  draft = created.draft;
});
const activateArgs = () => ({
  id: draft.id, expectedRevision: draft.revision, idempotencyKey: randomUUID(),
  confirmation: 'Activate Target-backed DEMO offer',
});
const activate = (args = activateArgs(), caller = actor) => api.handle(caller, 'promotions.drafts.activate', args);
const read = (options = {}) => runGraphQL({
  query: 'query($id:String!){cart(cart_id:$id){prices{discounts{label amount{value currency}}}}}',
  variables: { id: cart.id }, headers: { authorization: 'Bearer offline' },
}, { store, params, namespace: NS, audienceFetchImpl: fetchImpl, verify: async () => ({ sub: SUB }), ...options });

test('configured restricted-demo capability does not opt an ordinary Production build into the general planner benefit', async () => {
  marker = 'climbing-planner';
  const result = await runGraphQL({
    query: 'query($id:String!){wkndPlannerOffer(cart_id:$id){status saving{value}}cart(cart_id:$id){prices{discounts{label}}}}',
    variables: { id: cart.id }, headers: { authorization: 'Bearer offline' },
  }, { store, params, namespace: NS, audienceFetchImpl: fetchImpl, verify: async () => ({ sub: SUB }) });
  expect(result.body.errors).toBeUndefined();
  expect(result.body.data.wkndPlannerOffer.status).toBe('UNAVAILABLE');
  expect(result.body.data.cart.prices.discounts).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('configured Production route enables only confirmed IMS draft revision; retries persist one approved promotion and preserve canonical restriction', async () => {
  const catalogue = await api.handle(actor, 'promotions.authoringAudiences');
  expect(catalogue.activation).toMatchObject({ blocked: false, mode: 'target-backed-demo', evidence: false, financialAuthorization: false });
  expect(catalogue.audiences[0]).toMatchObject({ segmentId: '27507403', targetActivityId: '689041' });
  const args = activateArgs();
  const enabled = await activate(args);
  expect(enabled).toMatchObject({
    ok: true, draft: { state: 'activated-demo', revision: 2 },
    promotion: { enabled: true, revision: 2, audienceRestriction: draft.promotion.audienceRestriction },
  });
  expect(await activate(args)).toMatchObject({ ok: true, replayed: true, draft: { activation: { promotionId: enabled.promotion.id } } });
  expect(await activate({ ...args, idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
  expect(await store.collection('promotions').countDocuments({ name: draft.promotion.name })).toBe(1);
  expect(await api.handle(actor, 'promotions.get', { id: enabled.promotion.id })).toMatchObject({
    promotion: { audienceRestriction: draft.promotion.audienceRestriction },
  });
  const result = await read();
  expect(result.cacheable).toBe(false);
  expect(result.body.errors).toBeUndefined();
  expect(result.body.data.cart.prices.discounts).toEqual([{
    label: `${draft.promotion.name} (Target-backed DEMO)`, amount: { value: 69, currency: 'AUD' },
  }]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result.body)).not.toMatch(/27507403|689041|consentGrantId|demoAudienceApproval|target-aam-decision/);
  const integration = { kind: 'integration', subject: 'shared', orgId: actor.orgId };
  const service = createPromotionService({ store, params, namespace: NS, loadCatalog: () => loadCatalog(store) });
  expect(await service.updatePromotion({ actor: integration, correlationId: randomUUID() }, {
    id: enabled.promotion.id, expectedRevision: 2, idempotencyKey: randomUUID(),
    promotion: { ...draft.promotion, enabled: true, audienceRestriction: null },
  })).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_AUDIENCE_RESTRICTION' } });
});

test.each(['control', 'climbing-planner', 'withdrawn', 'unbound', 'failed'])('%s cannot receive the restricted demo discount', async (condition) => {
  expect((await activate()).ok).toBe(true);
  if (condition === 'withdrawn') await store.collection('customers').updateOne({ sub: SUB }, { $set: { 'idLinkage.state': 'withdrawn' } });
  else if (condition === 'unbound') await createBindingStore(store).remove(shopperKey(ISSUER, SUB));
  else if (condition === 'failed') fetchImpl.mockRejectedValue(new Error('offline Target unavailable'));
  else marker = condition;
  const result = await read();
  expect(result.body.errors).toBeUndefined();
  expect(result.body.data.cart.prices.discounts.some((d) => d.label.startsWith(draft.promotion.name))).toBe(false);
});

test('unconfigured, wrong namespace, stale revision, absent confirmation and integration callers cannot activate', async () => {
  const args = activateArgs();
  const unavailable = createPromotionsAdmin({ store, namespace: NS });
  expect((await unavailable.handle(actor, 'promotions.authoringAudiences')).activation.blocked).toBe(true);
  expect(await unavailable.handle(actor, 'promotions.drafts.activate', args)).toMatchObject({ ok: false, error: { code: 'RESTRICTED_ACTIVATION_BLOCKED' } });
  expect(await activate({ ...args, expectedRevision: 99 })).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
  const { confirmation: _confirmation, ...unconfirmed } = args;
  expect(await activate(unconfirmed)).toMatchObject({ ok: false, error: { code: 'INVALID_DRAFT' } });
  expect(await activate(args, { kind: 'integration', subject: 'shared', orgId: actor.orgId })).toMatchObject({ ok: false, error: { code: 'RESTRICTED_ACTIVATION_BLOCKED' } });
  const wrong = createPromotionsAdmin({ store, params, namespace: 'unknown-namespace' });
  expect((await wrong.handle(actor, 'promotions.authoringAudiences')).activation.blocked).toBe(true);
  expect(await store.collection('promotions').countDocuments({ name: draft.promotion.name })).toBe(0);
  expect(await read({ verify: async () => ({ sub: 'auth0|another-shopper' }) })).toMatchObject({ body: { errors: expect.any(Array) } });
});

test('reserved activation freezes terms across concurrent authors until the same saved revision completes', async () => {
  const args = activateArgs();
  const cat = await loadCatalog(store, { fresh: true });
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  api = createPromotionsAdmin({ store, params, namespace: NS, catalog: async () => {
    entered();
    await barrier;
    return cat;
  } });
  const pending = activate(args);
  await ready;
  expect(await api.handle(actor, 'promotions.drafts.update', {
    id: draft.id, expectedRevision: draft.revision, promotion: { ...draft.promotion, name: 'Concurrent terms' },
  })).toMatchObject({ ok: false, error: { code: 'DRAFT_ACTIVATION_LOCKED' } });
  expect(await api.handle(actor, 'promotions.drafts.delete', {
    id: draft.id, expectedRevision: draft.revision,
  })).toMatchObject({ ok: false, error: { code: 'DRAFT_ACTIVATION_LOCKED' } });
  expect(await activate({ ...args, idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } });
  release();
  expect(await pending).toMatchObject({ ok: true, promotion: { name: draft.promotion.name, enabled: true } });
  expect(await store.collection(COLLECTION).findOne({ id: draft.id })).toMatchObject({ revision: 2, promotion: { name: draft.promotion.name } });
});

test('proven no-commit activation failure releases the draft at a new revision; an uncertain write remains replay-locked', async () => {
  const context = { actor, correlationId: randomUUID(), authoringEnvironment: 'production' };
  const create = jest.fn(async () => ({ ok: false, committed: false, error: { code: 'PROMOTION_SERVICE_UNAVAILABLE' } }));
  const drafts = createPromotionDraftService({
    store, capability: { blocked: false }, promotionService: { createPromotion: create },
  });
  const args = activateArgs();
  expect(await drafts.activate(context, args)).toMatchObject({ ok: false, committed: false, draft: { state: 'draft', revision: 2 } });
  expect((await drafts.get(context, { id: draft.id })).draft.activation).toBeUndefined();
  create.mockResolvedValue({ ok: false, committed: null, error: { code: 'PROMOTION_SERVICE_UNAVAILABLE' } });
  expect(await drafts.activate(context, { ...args, expectedRevision: 2, idempotencyKey: randomUUID() })).toMatchObject({ ok: false, committed: null });
  expect((await drafts.get(context, { id: draft.id })).draft.activation).toMatchObject({ state: 'activating-demo' });
});

test('restricted partial bundle suggestions use the same authenticated Production demo eligibility and return no private registry data', async () => {
  const cat = await loadCatalog(store, { fresh: true });
  const [offer] = (await bundleOpportunities(store, {}, { catalog: async () => cat })).opportunities;
  const created = await api.handle(actor, 'promotions.drafts.create', {
    idempotencyKey: randomUUID(), promotion: {
      ...draft.promotion, target: {
        kind: 'bundle', bundleId: offer.bundleId, experimentId: null, currency: 'AUD',
        quoteExpiresAt: offer.quoteExpiresAt, safetyBuffer: offer.safetyBuffer,
        components: offer.components.map(({ sku, quantity, unitPriceMinor }) => ({ sku, quantity, unitPriceMinor })),
      },
    },
  });
  draft = created.draft;
  const enabled = await activate();
  expect(enabled.ok).toBe(true);
  const component = offer.components[0];
  await store.collection('carts').updateOne({ id: cart.id }, { $set: {
    items: [{ uid: 'B', sku: component.sku, quantity: component.quantity,
      parentSku: (cat.byVariantSku.get(component.sku)?.parent || cat.bySku.get(component.sku)).sku }],
  } });
  const query = 'query($id:String!){wkndBundleOffers(cart_id:$id){promotion_id name saving{value currency}components{sku missing_quantity}}}';
  const request = () => runGraphQL({ query, variables: { id: cart.id }, headers: { authorization: 'Bearer offline' } }, {
    store, params, namespace: NS, audienceFetchImpl: fetchImpl, verify: async () => ({ sub: SUB }),
  });
  const result = await request();
  expect(result.body.errors).toBeUndefined();
  expect(result.body.data.wkndBundleOffers).toHaveLength(1);
  expect(result.body.data.wkndBundleOffers[0].promotion_id).toBe(enabled.promotion.id);
  expect(JSON.stringify(result.body)).not.toMatch(/27507403|689041|evidence|private|orgId/);
  marker = 'control';
  expect((await request()).body.data.wkndBundleOffers).toEqual([]);
});
