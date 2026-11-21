/**
 * Consented cart-recovery email pilot: explicit opt-in, pause/allowlist defaults, human approval
 * separation, one email per episode, no blind resend, webhook suppression.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemoryStore } = require('../lib/store');
const { importCatalog } = require('../lib/importer');
const { runGraphQL } = require('../lib/graphql-server');
const { resetCatalogCache, loadCatalog } = require('../lib/catalog');
const { migrateLegacyPromotions, createPromotionService } = require('../lib/promotions');
const { bootstrapRecoveryPromotion, promotionIdFor, DEFAULT_CAMPAIGN } = require('../lib/recovery-policy');
const { createRecoveryEmail, handleBrevoWebhook } = require('../lib/recovery-email');
const { BrevoError } = require('../lib/brevo');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog.json'), 'utf8'));
const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-20T04:00:00.000Z');
const PARAMS = {
  AUTH0_ISSUER: 'https://example.auth0.com/',
  AUTH0_AUDIENCE: 'test',
  RECOVERY_REDEMPTION_VERIFIED: 'true',
  RECOVERY_EMAIL_ALLOWLIST: 'ava@example.com,ben@example.com',
  BREVO_RECOVERY_TEMPLATE_ID: '12',
  BREVO_WEBHOOK_TOKEN: 'hook-secret-token',
};
const sku = CATALOG.products.find((p) => p.type === 'simple').sku;

let store;
let sent;
let brevo;
let blocked;
const withBlocked = (client) => ({ listBlockedContacts: async () => ({ contacts: blocked, count: blocked.length }), ...client });
const clock = () => NOW;
const operator = (subject) => ({ actor: { kind: 'ims-operator', subject, orgId: 'ORG@AdobeOrg' }, correlationId: crypto.randomUUID() });

async function shopper(sub, email, { optIn = true, idleHours = 30 } = {}) {
  await store.collection('customers').insertOne({
    sub, id: sub, email, firstname: sub, addresses: [], ...(optIn === null ? {} : { marketing: { recoveryEmail: { optIn } } }),
  });
  await store.collection('carts').insertOne({
    id: `cart-${sub}`, customerSub: sub, items: [{ uid: 'u', sku, parentSku: sku, quantity: 1 }], coupons: [], status: 'active', activityAt: new Date(NOW - idleHours * HOUR).toISOString(), createdAt: new Date(NOW - 40 * HOUR).toISOString(), updatedAt: new Date(NOW - idleHours * HOUR).toISOString(),
  });
}

async function enableOffer() {
  const id = promotionIdFor(DEFAULT_CAMPAIGN.campaignId);
  const svc = createPromotionService({ store, loadCatalog: () => loadCatalog(store), params: PARAMS });
  const r = await svc.updatePromotion(operator('op'), {
    id,
    expectedRevision: 1,
    idempotencyKey: crypto.randomUUID(),
    promotion: {
      name: DEFAULT_CAMPAIGN.name, enabled: true, mode: 'coupon', code: 'RECOVER10', discount: { kind: 'percentage', basisPoints: 1000 }, maxDiscountMinor: 2500, minimumMerchandiseMinor: null, target: { kind: 'all' }, startsAt: null, endsAt: null, audienceRestriction: null,
    },
  });
  expect(r.ok).toBe(true);
}

async function approvedRun(svc, max = 10) {
  const { runId } = await svc.requestRun(operator('marketer'), { maxRecipients: max });
  await svc.approveRun(operator('approver'), { runId, templateId: '12', maxRecipients: max });
  return runId;
}

beforeEach(async () => {
  resetCatalogCache();
  store = createMemoryStore();
  await importCatalog(store, CATALOG, { replace: true });
  await migrateLegacyPromotions(store);
  await bootstrapRecoveryPromotion(store);
  sent = [];
  blocked = [];
  brevo = withBlocked({ sendTemplate: async (msg) => { sent.push(msg); return { messageId: `<m${sent.length}@brevo>` }; } });
});

describe('preference', () => {
  test('opt-in is explicit and off by default', async () => {
    await shopper('auth0|ava', 'ava@example.com', { optIn: null });
    const verify = async () => ({ sub: 'auth0|ava', email: 'ava@example.com' });
    const gql = async (query) => (await runGraphQL({ query, headers: { authorization: 'Bearer t' } }, { store, params: PARAMS, verify })).body;
    expect((await gql('{ customer { wknd_recovery_email_opt_in } }')).data.customer.wknd_recovery_email_opt_in).toBe(false);
    expect((await gql('mutation { setWkndRecoveryEmailOptIn(opt_in: true) }')).data.setWkndRecoveryEmailOptIn).toBe(true);
    expect((await gql('{ customer { wknd_recovery_email_opt_in } }')).data.customer.wknd_recovery_email_opt_in).toBe(true);
    const guest = (await runGraphQL({ query: 'mutation { setWkndRecoveryEmailOptIn(opt_in: true) }' }, { store, params: PARAMS })).body;
    expect(guest.errors[0].extensions.category).toMatch(/graphql-auth/);
  });
});

describe('operator workflow', () => {
  test('status is aggregate only and paused by default', async () => {
    await shopper('auth0|ava', 'ava@example.com');
    await shopper('auth0|cara', 'cara@example.com');
    await shopper('auth0|dan', 'dan@example.com', { optIn: false });
    const status = await createRecoveryEmail({ store, params: PARAMS, clock }).status();
    expect(status).toMatchObject({
      paused: true, allowlistEnabled: true, allowlistSize: 2, offerReady: false, templateConfigured: true,
      audience: {
        inactiveCarts: 3, optedIn: 2, notAllowlisted: 1, eligible: 1, suppressed: 0, alreadyEmailed: 0,
      },
    });
    expect(JSON.stringify(status)).not.toMatch(/@example\.com|auth0\|/);
  });

  test('runs are bounded and cannot be self-approved or altered at approval', async () => {
    const svc = createRecoveryEmail({ store, params: PARAMS, clock });
    await expect(svc.requestRun(operator('m'), { maxRecipients: 51 })).rejects.toMatchObject({ code: 'INVALID' });
    const { runId } = await svc.requestRun(operator('m'), { maxRecipients: 5 });
    await expect(svc.approveRun(operator('m'), { runId, templateId: '12', maxRecipients: 5 })).rejects.toMatchObject({ code: 'SELF_APPROVAL' });
    await expect(svc.approveRun(operator('a'), { runId, templateId: '12', maxRecipients: 50 })).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    await expect(svc.executeRun({ runId })).rejects.toMatchObject({ code: 'NOT_APPROVED' });
    const integration = { actor: { kind: 'integration', subject: 'coworker-mcp', orgId: 'ORG@AdobeOrg' }, correlationId: crypto.randomUUID() };
    await expect(svc.approveRun(integration, { runId, templateId: '12', maxRecipients: 5 })).rejects.toMatchObject({ code: 'HUMAN_APPROVAL_REQUIRED' });
    expect(await svc.approveRun(operator('a'), { runId, templateId: '12', maxRecipients: 5 })).toEqual({ runId, state: 'approved' });
  });
});

describe('execution', () => {
  beforeEach(async () => {
    await shopper('auth0|ava', 'ava@example.com');
    await shopper('auth0|ben', 'ben@example.com');
    await shopper('auth0|cara', 'cara@example.com');
    await shopper('auth0|early', 'ava2@example.com', { idleHours: 10 });
  });

  test('requires resume and a ready offer', async () => {
    const svc = createRecoveryEmail({
      store, params: PARAMS, clock, brevo,
    });
    const runId = await approvedRun(svc);
    await expect(svc.executeRun({ runId })).rejects.toMatchObject({ code: 'PAUSED' });
    await svc.resume();
    await expect(svc.executeRun({ runId })).rejects.toMatchObject({ code: 'OFFER_NOT_READY' });
    expect(sent).toHaveLength(0);
  });

  test('sends once per episode to allowlisted opted-in shoppers only', async () => {
    await enableOffer();
    const svc = createRecoveryEmail({
      store, params: PARAMS, clock, brevo,
    });
    await svc.resume();
    const first = await svc.executeRun({ runId: await approvedRun(svc) });
    expect(first).toMatchObject({ sent: 2, failed: 0, unknown: 0 });
    expect(sent.map((m) => m.to.email).sort()).toEqual(['ava@example.com', 'ben@example.com']);
    expect(sent[0]).toMatchObject({ templateId: '12', tags: [DEFAULT_CAMPAIGN.campaignId] });
    expect(sent[0].params.CART_URL).not.toMatch(/cart-auth0|auth0|%7C|@/);
    await expect(svc.executeRun({ runId: (await approvedRun(svc)) })).resolves.toMatchObject({ sent: 0 });
    expect(sent).toHaveLength(2);
  });

  test('respects the approved run size', async () => {
    await enableOffer();
    const svc = createRecoveryEmail({
      store, params: PARAMS, clock, brevo,
    });
    await svc.resume();
    expect(await svc.executeRun({ runId: await approvedRun(svc, 1) })).toMatchObject({ sent: 1 });
  });

  test('ambiguous provider outcomes are never resent; rate limits defer', async () => {
    await enableOffer();
    brevo = withBlocked({ sendTemplate: async () => { throw new BrevoError('timeout', { ambiguous: true }); } });
    let svc = createRecoveryEmail({
      store, params: PARAMS, clock, brevo,
    });
    await svc.resume();
    expect(await svc.executeRun({ runId: await approvedRun(svc) })).toMatchObject({ unknown: 2, sent: 0 });
    brevo = withBlocked({ sendTemplate: async (m) => { sent.push(m); return { messageId: 'x' }; } });
    svc = createRecoveryEmail({
      store, params: PARAMS, clock, brevo,
    });
    expect(await svc.executeRun({ runId: await approvedRun(svc) })).toMatchObject({ sent: 0 });
    expect(sent).toHaveLength(0);
  });

  test('429 releases the claim so a later run can retry', async () => {
    await enableOffer();
    let calls = 0;
    brevo = withBlocked({
      sendTemplate: async (m) => {
        calls += 1;
        if (calls === 1) throw new BrevoError('rate limited', { status: 429, ambiguous: false });
        sent.push(m);
        return { messageId: 'x' };
      },
    });
    const svc = createRecoveryEmail({
      store, params: PARAMS, clock, brevo,
    });
    await svc.resume();
    expect(await svc.executeRun({ runId: await approvedRun(svc) })).toMatchObject({ deferred: 1, sent: 0 });
    expect(await svc.executeRun({ runId: await approvedRun(svc) })).toMatchObject({ sent: 2 });
  });

  test('Brevo unsubscribes/bounces are synced before sending (no webhook needed)', async () => {
    await enableOffer();
    blocked = [
      { email: 'Ava@example.com', reason: { code: 'unsubscribedViaEmail' } },
      { email: 'nobody@example.com', reason: { code: 'hardBounce' } },
    ];
    const svc = createRecoveryEmail({
      store, params: PARAMS, clock, brevo,
    });
    await svc.resume();
    await svc.executeRun({ runId: await approvedRun(svc) });
    expect(sent.map((m) => m.to.email)).toEqual(['ben@example.com']);
    expect((await store.collection('customers').findOne({ sub: 'auth0|ava' })).marketing.recoveryEmail.optIn).toBe(false);
    expect(await store.collection('email_suppressions').countDocuments({})).toBe(2);
  });

  test('fails closed when Brevo suppression state cannot be read', async () => {
    await enableOffer();
    brevo = { ...brevo, listBlockedContacts: async () => { throw new BrevoError('down', { ambiguous: false }); } };
    const svc = createRecoveryEmail({
      store, params: PARAMS, clock, brevo,
    });
    await svc.resume();
    const runId = await approvedRun(svc);
    await expect(svc.executeRun({ runId })).rejects.toMatchObject({ code: 'SUPPRESSION_SYNC_FAILED' });
    expect(sent).toHaveLength(0);
    expect((await store.collection('recovery_email_runs').findOne({ runId })).state).toBe('approved');
  });

  test('purchase since the cart activity suppresses the email', async () => {
    await enableOffer();
    await store.collection('orders').insertOne({ customerSub: 'auth0|ava', createdAt: new Date(NOW - 2 * HOUR).toISOString() });
    const svc = createRecoveryEmail({
      store, params: PARAMS, clock, brevo,
    });
    await svc.resume();
    await svc.executeRun({ runId: await approvedRun(svc) });
    expect(sent.map((m) => m.to.email)).toEqual(['ben@example.com']);
  });
});

describe('Brevo webhook', () => {
  test('authenticates and suppresses idempotently', async () => {
    await shopper('auth0|ava', 'ava@example.com');
    const body = { event: 'unsubscribed', email: 'Ava@Example.com' };
    expect(await handleBrevoWebhook(store, { headers: { authorization: 'Bearer wrong' }, body, params: PARAMS })).toEqual({ status: 401 });
    const headers = { authorization: `Bearer ${PARAMS.BREVO_WEBHOOK_TOKEN}` };
    expect(await handleBrevoWebhook(store, { headers, body: { event: 'unsubscribed', email: 'ava@example.com' }, params: PARAMS })).toEqual({ status: 200, suppressed: true });
    expect(await handleBrevoWebhook(store, { headers, body, params: PARAMS })).toEqual({ status: 200, suppressed: true });
    expect(await store.collection('email_suppressions').countDocuments({})).toBe(1);
    expect((await store.collection('customers').findOne({ sub: 'auth0|ava' })).marketing.recoveryEmail.optIn).toBe(false);
    const status = await createRecoveryEmail({ store, params: PARAMS, clock }).status();
    expect(status.audience.optedIn).toBe(0);
  });
});

describe('marketing consent purposes (Spam Act express consent)', () => {
  const BEARER = ['Bearer', 'shopper-token'].join(' ');
  const verify = async () => ({ sub: 'auth0|ava', email: 'ava@example.com' });
  const gql = async (query) => (await runGraphQL({ query, headers: { authorization: BEARER } }, { store, params: PARAMS, verify })).body;
  const events = () => store.collection('marketing_consent_events').find({});

  test('news & offers consent is separate, explicit and evidenced with its wording version', async () => {
    await shopper('auth0|ava', 'ava@example.com', { optIn: null });
    expect((await gql('{ customer { wknd_recovery_email_opt_in wknd_marketing_email_opt_in } }')).data.customer)
      .toEqual({ wknd_recovery_email_opt_in: false, wknd_marketing_email_opt_in: false });
    await gql('mutation { setWkndRecoveryEmailOptIn(opt_in: true, wording_version: "recovery-2026-11") }');
    expect((await gql('{ customer { wknd_marketing_email_opt_in } }')).data.customer.wknd_marketing_email_opt_in).toBe(false);

    const missing = await gql('mutation { setWkndMarketingEmailOptIn(opt_in: true) }');
    expect(missing.errors[0].message).toBe('Consent wording version is required.');
    expect((await gql('mutation { setWkndMarketingEmailOptIn(opt_in: true, wording_version: "news-offers-2026-11", source: IOS) }')).data.setWkndMarketingEmailOptIn).toBe(true);
    const record = (await store.collection('customers').findOne({ sub: 'auth0|ava' })).marketing.audienceEmail;
    expect(record).toMatchObject({ optIn: true, source: 'ios', wordingVersion: 'news-offers-2026-11' });
    const log = await events();
    expect(log.map((e) => [e.purpose, e.optIn, e.source])).toEqual([['recovery', true, 'account-settings'], ['audience', true, 'ios']]);
    expect(log.every((e) => e.subjectKind === 'customer' && !String(e.subject).includes('auth0'))).toBe(true);

    expect((await gql('mutation { setWkndMarketingEmailOptIn(opt_in: false) }')).data.setWkndMarketingEmailOptIn).toBe(false);
    expect(await store.collection('marketing_consent_events').countDocuments({})).toBe(3);
  });

  test('delegated agents (LLM app) cannot give or withdraw consent', async () => {
    const { setMarketingConsent } = require('../lib/recovery-email');
    await shopper('auth0|ava', 'ava@example.com', { optIn: null });
    await expect(setMarketingConsent(store, { sub: 'auth0|ava', delegated: true }, 'audience', true, { wordingVersion: 'v1' }))
      .rejects.toMatchObject({ code: 'DIRECT_SIGN_IN_REQUIRED' });
    expect(await store.collection('marketing_consent_events').countDocuments({})).toBe(0);
  });

  test('a Brevo unsubscribe withdraws every marketing purpose and is evidenced', async () => {
    await shopper('auth0|ava', 'ava@example.com');
    await store.collection('customers').updateOne({ sub: 'auth0|ava' }, { $set: { 'marketing.audienceEmail': { optIn: true } } });
    const headers = { authorization: ['Bearer', PARAMS.BREVO_WEBHOOK_TOKEN].join(' ') };
    expect(await handleBrevoWebhook(store, { headers, body: [{ event: 'unsubscribed', email: 'Ava@Example.com' }], params: PARAMS }))
      .toEqual({ status: 200, suppressed: true });
    const { marketing } = await store.collection('customers').findOne({ sub: 'auth0|ava' });
    expect([marketing.recoveryEmail.optIn, marketing.audienceEmail.optIn]).toEqual([false, false]);
    const log = await events();
    expect(log.map((e) => [e.purpose, e.optIn, e.source, e.subjectKind]).sort()).toEqual([
      ['audience', false, 'brevo-unsubscribe', 'email'], ['recovery', false, 'brevo-unsubscribe', 'email'],
    ]);
  });
});
