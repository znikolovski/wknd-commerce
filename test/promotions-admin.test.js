/**
 * Admin Promotions surface: individually verified IMS operator, promotion lifecycle through the
 * shared service, protected recovery bounds, and two-person approval of recovery-email runs.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { resetCatalogCache, loadCatalog } = require('../lib/catalog');
const { migrateLegacyPromotions } = require('../lib/promotions');
const { bootstrapRecoveryPromotion, promotionIdFor, DEFAULT_CAMPAIGN } = require('../lib/recovery-policy');
const { createPromotionsAdmin, imsOperatorFrom } = require('../lib/promotions-admin');
jest.mock('../lib/store', () => ({ ...jest.requireActual('../lib/store'), getStore: jest.fn() }));

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
const ORG = 'ORG@AdobeOrg';
const PARAMS = { ADMIN_IMS_ORG: ORG, RECOVERY_REDEMPTION_VERIFIED: 'true', BREVO_RECOVERY_TEMPLATE_ID: '1' };
const tokenFor = (claims) => ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');
const headersFor = (userId, org = ORG) => ({ authorization: ['Bearer', tokenFor({ user_id: userId, type: 'access_token' })].join(' '), 'x-gw-ims-org-id': org });

let store;
let api;
const ava = { kind: 'ims-operator', subject: 'AVA123@AdobeID', orgId: ORG };
const ben = { kind: 'ims-operator', subject: 'BEN456@AdobeID', orgId: ORG };
const draft = (overrides = {}) => ({
  name: 'Climbing planner 10%',
  enabled: false,
  mode: 'automatic',
  code: null,
  discount: { kind: 'percentage', basisPoints: 1000 },
  maxDiscountMinor: 2500,
  minimumMerchandiseMinor: null,
  target: { kind: 'all' },
  startsAt: null,
  endsAt: null,
  audienceRestriction: null,
  ...overrides,
});

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
  await migrateLegacyPromotions(store);
  await bootstrapRecoveryPromotion(store);
  api = createPromotionsAdmin({ store, params: PARAMS, catalog: () => loadCatalog(store) });
});

describe('operator identity', () => {
  test('an individual IMS user in the configured org becomes an ims-operator actor', () => {
    expect(imsOperatorFrom(headersFor('AVA123@AdobeID'), PARAMS)).toEqual(ava);
  });

  test('wrong org, technical accounts and missing tokens are refused', () => {
    expect(() => imsOperatorFrom(headersFor('AVA123@AdobeID', 'OTHER@AdobeOrg'), PARAMS)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => imsOperatorFrom(headersFor('ABC@techacct.adobe.com'), PARAMS)).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => imsOperatorFrom({ 'x-gw-ims-org-id': ORG }, PARAMS)).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => imsOperatorFrom({ authorization: 'Bearer x' }, PARAMS)).toThrow(expect.objectContaining({ status: 401 }));
  });
});

describe('promotions', () => {
  test('action boundary preserves flattened original request UUID for read-only reconciliation', async () => {
    const idempotencyKey = crypto.randomUUID();
    const created = await api.handle(ava, 'promotions.create', { promotion: draft(), idempotencyKey });
    require('../lib/store').getStore.mockResolvedValue(store);
    const { main } = require('../actions/promotions-admin');
    const response = await main({
      ...PARAMS, __ow_headers: headersFor(ava.subject),
      __ow_body: JSON.stringify({ op: 'promotions.get', request: { operation: 'create', idempotencyKey } }),
    });
    expect(response).toMatchObject({
      statusCode: 200, body: {
        apiVersion: 'wknd.promotions/v1', ok: true, committed: true,
        promotion: { id: created.promotion.id },
        request: { operation: 'create', idempotencyKey },
      },
    });
    expect(await store.collection('promotions').countDocuments({ id: created.promotion.id })).toBe(1);
  });

  test('create as a disabled draft, list, then enable with a revision check', async () => {
    const created = await api.handle(ava, 'promotions.create', { promotion: draft() });
    expect(created).toMatchObject({ ok: true, promotion: { enabled: false, revision: 1, mode: 'automatic' } });
    const listed = await api.handle(ava, 'promotions.list', {});
    expect(listed.items.map((p) => p.name)).toContain('Climbing planner 10%');

    const stale = await api.handle(ava, 'promotions.setEnabled', { id: created.promotion.id, expectedRevision: 5, enabled: true });
    expect(stale.error.code).toBe('REVISION_CONFLICT');
    const enabled = await api.handle(ava, 'promotions.setEnabled', { id: created.promotion.id, expectedRevision: 1, enabled: true });
    expect(enabled.promotion).toMatchObject({ enabled: true, revision: 2 });
    const disabled = await api.handle(ben, 'promotions.setEnabled', { id: created.promotion.id, expectedRevision: 2, enabled: false });
    expect(disabled.promotion).toMatchObject({ enabled: false, revision: 3 });
  });

  test('protected recovery terms cannot be changed from the admin screen', async () => {
    const id = promotionIdFor(DEFAULT_CAMPAIGN.campaignId);
    const { promotion } = await api.handle(ava, 'promotions.get', { id });
    const r = await api.handle(ava, 'promotions.update', {
      id, expectedRevision: promotion.revision, promotion: draft({ name: promotion.name, mode: 'coupon', code: 'RECOVER10', maxDiscountMinor: 5000 }),
    });
    expect(r.error.code).toBe('PROTECTED_POLICY_VIOLATION');
    const on = await api.handle(ava, 'promotions.setEnabled', { id, expectedRevision: promotion.revision, enabled: true });
    expect(on.promotion).toMatchObject({ enabled: true, code: 'RECOVER10', maxDiscountMinor: 2500 });
  });

  test('unknown operations are rejected', async () => {
    await expect(api.handle(ava, 'email.executeRun', {})).rejects.toMatchObject({ status: 400 });
  });
});

describe('recovery email runs', () => {
  test('a different individual must approve; run listing never exposes recipients', async () => {
    const run = await api.handle(ava, 'email.requestRun', { maxRecipients: 5 });
    expect(run).toMatchObject({ state: 'requested', templateId: '1', maxRecipients: 5 });
    await expect(api.handle(ava, 'email.approveRun', { runId: run.runId, templateId: '1', maxRecipients: 5 }))
      .rejects.toMatchObject({ status: 409, message: 'A different person must approve this run.' });
    await expect(api.handle(ben, 'email.approveRun', { runId: run.runId, templateId: '1', maxRecipients: 10 }))
      .rejects.toMatchObject({ status: 409 });
    expect(await api.handle(ben, 'email.approveRun', { runId: run.runId, templateId: '1', maxRecipients: 5 })).toEqual({ runId: run.runId, state: 'approved' });
    const runs = await api.handle(ava, 'email.runs', {});
    expect(runs[0]).toMatchObject({
      runId: run.runId, state: 'approved', requestedBy: ava.subject, approvedBy: ben.subject, sent: 0,
    });
    expect(Object.keys(runs[0]).sort()).toEqual(['approvedAt', 'approvedBy', 'expiresAt', 'maxRecipients', 'requestedAt', 'requestedBy', 'runId', 'sent', 'state', 'templateId']);
  });

  test('status is aggregate and pause/resume work', async () => {
    const status = await api.handle(ava, 'email.status', {});
    expect(status).toMatchObject({ paused: true, templateConfigured: true });
    expect(await api.handle(ava, 'email.resume', {})).toEqual({ paused: false });
    expect(await api.handle(ava, 'email.pause', {})).toEqual({ paused: true });
  });
});
