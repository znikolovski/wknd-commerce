/**
 * ID-linkage consent purpose, the CAS binding-store adapter and the Brevo withdraw-all hook, against
 * the repo's memory store (same surface as App Builder Database Storage). No network.
 */
const { createMemoryStore } = require('../lib/store');
const { sha256 } = require('../lib/promotion-schema');
const { shopperKey } = require('../lib/recovery-policy');
const {
  IdLinkageError, PENDING_LEASE_MS, linkageConfig, setIdLinkageConsent, withdrawIdLinkageForEmail, createIdLinkageConsentSource,
} = require('../lib/id-linkage-consent');
const { BINDING_COLLECTION, createBindingStore, removeBindingsForSubject } = require('../lib/target-binding-store');
const { createIdServiceBindingProvider } = require('../lib/target-id-binding');
const { handleBrevoWebhook, setMarketingConsent, CONSENT_PURPOSES } = require('../lib/recovery-email');

const ISSUER = 'https://example.auth0.com/';
const SUB = 'auth0|pilot-shopper';
const KEY = shopperKey(ISSUER, SUB);
const EMAIL = 'Pilot@Example.com';
const CONFIG = linkageConfig({ TARGET_ID_LINKAGE_ENABLED: 'true', TARGET_ID_LINKAGE_WORDING_VERSIONS: 'idl-2026-11' });
const T0 = Date.UTC(2026, 10, 23);
const ECID_A = '1'.repeat(38);
const ECID_B = '2'.repeat(38);

async function seeded(extra = {}) {
  const store = createMemoryStore();
  await store.collection('customers').insertOne({
    _id: SUB, sub: SUB, id: SUB, email: EMAIL, marketing: {}, ...extra,
  });
  return store;
}
const customer = (store) => store.collection('customers').findOne({ sub: SUB });
const events = (store) => store.collection('marketing_consent_events').find({ purpose: 'idLinkage' });
const grant = (store, over = {}) => setIdLinkageConsent(store, { sub: SUB }, true, {
  wordingVersion: 'idl-2026-11', config: CONFIG, clock: () => T0, ...over,
});
const lookup = (store) => createIdLinkageConsentSource(store, { issuer: ISSUER }).lookup({ shopperKey: KEY, sub: SUB });
const code = async (p) => p.then(() => 'resolved', (e) => (e instanceof IdLinkageError ? e.code : `other:${e.message}`));

describe('ID-linkage consent purpose (separate, optional, explicit)', () => {
  test('config is OFF with no approved wording by default', () => {
    expect(linkageConfig({})).toEqual({ enabled: false, wordingVersions: [] });
    expect(linkageConfig({ TARGET_ID_LINKAGE_ENABLED: 'TRUE', TARGET_ID_LINKAGE_WORDING_VERSIONS: 'Bad Value,ok-1' }))
      .toEqual({ enabled: false, wordingVersions: ['ok-1'] });
  });

  test('an explicit first-party grant reserves a generation, records evidence, then conditionally activates', async () => {
    const store = await seeded();
    const updates = jest.spyOn(store.collection('customers'), 'updateOne');
    expect(await grant(store)).toEqual({ state: 'granted', changed: true });
    expect(updates).toHaveBeenCalledTimes(2);
    expect(updates.mock.calls[0][1].$set.idLinkage.state).toBe('pending');
    const { idLinkage } = await customer(store);
    expect(idLinkage).toEqual({
      state: 'granted', grantId: expect.stringMatching(/^[0-9a-f-]{36}$/), source: 'account-settings', wordingVersion: 'idl-2026-11', updatedAt: new Date(T0).toISOString(),
    });
    expect(await events(store)).toEqual([expect.objectContaining({
      subject: sha256(SUB), subjectKind: 'customer', purpose: 'idLinkage', optIn: true, grantId: idLinkage.grantId, wordingVersion: 'idl-2026-11',
    })]);
    expect(await lookup(store)).toEqual({ state: 'granted', grantId: idLinkage.grantId });
  });

  test('email purposes and their opt-ins never grant ID linkage', async () => {
    const store = await seeded();
    await setMarketingConsent(store, { sub: SUB }, 'audience', true, { wordingVersion: 'news-1' });
    await setMarketingConsent(store, { sub: SUB }, 'recovery', true);
    expect(await lookup(store)).toEqual({ state: 'absent' });
    expect(Object.keys(CONSENT_PURPOSES)).not.toContain('idLinkage');
  });

  test.each([
    ['a delegated agent', { sub: SUB, delegated: true }, {}, 'DIRECT_SIGN_IN_REQUIRED'],
    ['no verified sub', {}, {}, 'SIGN_IN_REQUIRED'],
    ['feature off', { sub: SUB }, { config: linkageConfig({}) }, 'DISABLED'],
    ['unapproved wording', { sub: SUB }, { wordingVersion: 'idl-draft' }, 'WORDING_NOT_APPROVED'],
    ['no wording', { sub: SUB }, { wordingVersion: null }, 'WORDING_NOT_APPROVED'],
    ['a system source', { sub: SUB }, { source: 'brevo-unsubscribe' }, 'INVALID'],
  ])('%s cannot grant, and nothing is written', async (_, who, over, expected) => {
    const store = await seeded();
    const updates = jest.spyOn(store.collection('customers'), 'updateOne');
    expect(await code(setIdLinkageConsent(store, who, true, {
      wordingVersion: 'idl-2026-11', config: CONFIG, ...over,
    }))).toBe(expected);
    expect(updates).not.toHaveBeenCalled();
    expect(await lookup(store)).toEqual({ state: 'absent' });
  });

  test('granting again while granted keeps the same grant (no ECID churn)', async () => {
    const store = await seeded();
    await grant(store);
    const { grantId } = (await customer(store)).idLinkage;
    expect(await grant(store)).toEqual({ state: 'granted', changed: false });
    expect((await customer(store)).idLinkage.grantId).toBe(grantId);
    expect(await events(store)).toHaveLength(1);
  });

  test('no customer record (never signed in on the website) is refused', async () => {
    expect(await code(grant(createMemoryStore()))).toBe('NO_CUSTOMER');
  });

  test('a grant whose evidence cannot be recorded is reverted (fail closed)', async () => {
    const store = await seeded();
    jest.spyOn(store.collection('marketing_consent_events'), 'insertOne').mockRejectedValueOnce(new Error('db'));
    expect(await code(grant(store))).toBe('EVIDENCE_FAILED');
    expect((await customer(store)).idLinkage).toMatchObject({ state: 'withdrawn', grantId: null, source: 'evidence-failure' });
    expect(await lookup(store)).toEqual({ state: 'withdrawn' });
  });

  test('withdrawal is always allowed (even with the feature off), removes bindings and is idempotent', async () => {
    const store = await seeded();
    await grant(store);
    const { grantId } = (await customer(store)).idLinkage;
    await store.collection(BINDING_COLLECTION).insertOne({ _id: KEY, etag: 'e1', record: { subject: sha256(SUB), consentGrantId: grantId, state: 'bound' } });
    await store.collection(BINDING_COLLECTION).insertOne({ _id: 'other', etag: 'e2', record: { subject: sha256('auth0|other') } });
    expect(await setIdLinkageConsent(store, { sub: SUB }, false, { config: linkageConfig({}) }))
      .toEqual({ state: 'withdrawn', changed: true });
    expect(await store.collection(BINDING_COLLECTION).find({})).toEqual([expect.objectContaining({ etag: 'e2' })]);
    expect(await lookup(store)).toEqual({ state: 'withdrawn' });
    expect(await setIdLinkageConsent(store, { sub: SUB }, false)).toEqual({ state: 'withdrawn', changed: false });
    expect((await events(store)).map((e) => e.optIn)).toEqual([true, false]);
  });

  test('reconsent after withdrawal issues a NEW grantId (the generation token)', async () => {
    const store = await seeded();
    await grant(store);
    const first = (await customer(store)).idLinkage.grantId;
    await setIdLinkageConsent(store, { sub: SUB }, false);
    await grant(store);
    expect((await customer(store)).idLinkage.grantId).not.toBe(first);
  });

  test.each(['success', 'rejection'])('an old pending grant (%s) cannot resurrect or overwrite a withdrawn/regranted generation', async (outcome) => {
    const store = await seeded();
    const evidence = store.collection('marketing_consent_events');
    const insert = evidence.insertOne.bind(evidence);
    let entered;
    let finish;
    const started = new Promise((resolve) => { entered = resolve; });
    jest.spyOn(evidence, 'insertOne').mockImplementationOnce((doc) => {
      entered();
      return new Promise((resolve, reject) => {
        finish = () => {
          if (outcome === 'rejection') reject(new Error('evidence unavailable'));
          else resolve(insert(doc));
        };
      });
    });
    const oldGrant = code(grant(store));
    await started;
    expect(await lookup(store)).toEqual({ state: 'unknown' });
    expect(await code(grant(store))).toBe('CONFLICT');
    const pendingId = (await customer(store)).idLinkage.grantId;
    expect(await setIdLinkageConsent(store, { sub: SUB }, false)).toMatchObject({ changed: true });
    expect(await lookup(store)).toEqual({ state: 'withdrawn' });
    await grant(store);
    const newGrant = (await customer(store)).idLinkage;
    expect(newGrant.grantId).not.toBe(pendingId);
    await store.collection(BINDING_COLLECTION).insertOne({
      _id: KEY, etag: 'new', record: { subject: sha256(SUB), consentGrantId: newGrant.grantId },
    });
    finish();
    expect(await oldGrant).toBe(outcome === 'rejection' ? 'EVIDENCE_FAILED' : 'CONFLICT');
    expect((await customer(store)).idLinkage).toEqual(newGrant);
    expect(await lookup(store)).toEqual({ state: 'granted', grantId: newGrant.grantId });
    expect(await store.collection(BINDING_COLLECTION).find({})).toHaveLength(1);
  });

  test('withdrawal during pending evidence is not resurrected when evidence succeeds', async () => {
    const store = await seeded();
    const evidence = store.collection('marketing_consent_events');
    const insert = evidence.insertOne.bind(evidence);
    let entered;
    let finish;
    const started = new Promise((resolve) => { entered = resolve; });
    jest.spyOn(evidence, 'insertOne').mockImplementationOnce((doc) => {
      entered();
      return new Promise((resolve) => { finish = () => resolve(insert(doc)); });
    });
    const oldGrant = code(grant(store));
    await started;
    await setIdLinkageConsent(store, { sub: SUB }, false);
    finish();
    expect(await oldGrant).toBe('CONFLICT');
    expect(await lookup(store)).toEqual({ state: 'withdrawn' });
  });
});

describe('interrupted grants recover without touching newer generations', () => {
  const failActivationOnce = (store) => {
    const customers = store.collection('customers');
    const update = customers.updateOne.bind(customers);
    return jest.spyOn(customers, 'updateOne').mockImplementation((filter, change) => {
      if (change.$set?.['idLinkage.state'] === 'granted' && !failActivationOnce.done) {
        failActivationOnce.done = true;
        return Promise.reject(new Error('db unavailable'));
      }
      return update(filter, change);
    });
  };
  beforeEach(() => { failActivationOnce.done = false; });

  test('activation failure after evidence is explicit, authorizes nothing, and a retry activates that generation', async () => {
    const store = await seeded();
    failActivationOnce(store);
    expect(await code(grant(store))).toBe('ACTIVATION_PENDING');
    const pending = (await customer(store)).idLinkage;
    expect(pending.state).toBe('pending');
    expect(await lookup(store)).toEqual({ state: 'unknown' });
    expect(await grant(store)).toEqual({ state: 'granted', changed: true });
    expect((await customer(store)).idLinkage).toEqual({ ...pending, state: 'granted' });
    expect(await lookup(store)).toEqual({ state: 'granted', grantId: pending.grantId });
    expect(await events(store)).toHaveLength(1);
  });

  test('an interrupted generation never overwrites a later withdrawal or regrant', async () => {
    const store = await seeded();
    failActivationOnce(store);
    expect(await code(grant(store))).toBe('ACTIVATION_PENDING');
    const stale = (await customer(store)).idLinkage.grantId;
    expect(await setIdLinkageConsent(store, { sub: SUB }, false)).toEqual({ state: 'withdrawn', changed: true });
    await grant(store);
    const newer = (await customer(store)).idLinkage;
    expect(newer.grantId).not.toBe(stale);
    await store.collection(BINDING_COLLECTION).insertOne({ _id: KEY, etag: 'new', record: { subject: sha256(SUB), consentGrantId: newer.grantId } });
    await removeBindingsForSubject(store, sha256(SUB), { grantId: stale });
    expect(await grant(store)).toEqual({ state: 'granted', changed: false });
    expect((await customer(store)).idLinkage).toEqual(newer);
    expect(await store.collection(BINDING_COLLECTION).find({})).toHaveLength(1);
  });

  test('an evidence-less reservation (failed revert) is superseded only after its lease lapses', async () => {
    const store = await seeded();
    const customers = store.collection('customers');
    const update = customers.updateOne.bind(customers);
    jest.spyOn(store.collection('marketing_consent_events'), 'insertOne').mockRejectedValueOnce(new Error('db'));
    jest.spyOn(customers, 'updateOne').mockImplementation((filter, change) => (
      change.$set?.idLinkage?.source === 'evidence-failure' ? Promise.reject(new Error('db')) : update(filter, change)));
    expect(await code(grant(store))).toBe('EVIDENCE_FAILED');
    const abandoned = (await customer(store)).idLinkage;
    expect(abandoned.state).toBe('pending');
    expect(await lookup(store)).toEqual({ state: 'unknown' });
    expect(await code(grant(store, { clock: () => T0 + PENDING_LEASE_MS - 1 }))).toBe('CONFLICT');
    expect((await customer(store)).idLinkage).toEqual(abandoned);
    expect(await grant(store, { clock: () => T0 + PENDING_LEASE_MS })).toEqual({ state: 'granted', changed: true });
    const { grantId } = (await customer(store)).idLinkage;
    expect(grantId).not.toBe(abandoned.grantId);
    expect(await lookup(store)).toEqual({ state: 'granted', grantId });
  });

  test('evidence under wording that is no longer approved is not activated by a retry', async () => {
    const store = await seeded();
    failActivationOnce(store);
    expect(await code(grant(store))).toBe('ACTIVATION_PENDING');
    const old = (await customer(store)).idLinkage.grantId;
    const v2 = linkageConfig({ TARGET_ID_LINKAGE_ENABLED: 'true', TARGET_ID_LINKAGE_WORDING_VERSIONS: 'idl-2027-01' });
    const regrant = (t) => grant(store, { wordingVersion: 'idl-2027-01', config: v2, clock: () => t });
    expect(await code(regrant(T0 + 1))).toBe('CONFLICT');
    expect(await regrant(T0 + PENDING_LEASE_MS)).toEqual({ state: 'granted', changed: true });
    expect((await customer(store)).idLinkage).toMatchObject({ state: 'granted', wordingVersion: 'idl-2027-01' });
    expect((await customer(store)).idLinkage.grantId).not.toBe(old);
  });

  test('a request whose generation a concurrent retry already activated reports granted, not a conflict', async () => {
    const store = await seeded();
    const customers = store.collection('customers');
    const update = customers.updateOne.bind(customers);
    jest.spyOn(customers, 'updateOne').mockImplementation(async (filter, change) => {
      if (change.$set?.['idLinkage.state'] === 'granted' && !failActivationOnce.done) {
        failActivationOnce.done = true;
        await update(filter, change);
        return { matchedCount: 0 };
      }
      return update(filter, change);
    });
    expect(await grant(store)).toEqual({ state: 'granted', changed: true });
  });
});

describe('authoritative consent source', () => {
  test.each([
    ['a malformed grantId', { state: 'granted', grantId: 'x' }, { state: 'unknown' }],
    ['an unknown state', { state: 'maybe' }, { state: 'unknown' }],
  ])('%s is unknown (deny, no mutation)', async (_, idLinkage, expected) => {
    expect(await lookup(await seeded({ idLinkage }))).toEqual(expected);
  });

  test('a shopper key that does not derive from the verified sub is unknown, without a store read', async () => {
    const store = await seeded();
    const find = jest.spyOn(store.collection('customers'), 'findOne');
    const src = createIdLinkageConsentSource(store, { issuer: ISSUER });
    expect(await src.lookup({ shopperKey: shopperKey(ISSUER, 'auth0|other'), sub: SUB })).toEqual({ state: 'unknown' });
    expect(await createIdLinkageConsentSource(store, {}).lookup({ shopperKey: KEY, sub: SUB })).toEqual({ state: 'unknown' });
    expect(find).not.toHaveBeenCalled();
  });

  test('a store failure throws (the provider maps it to unknown)', async () => {
    const store = await seeded();
    jest.spyOn(store.collection('customers'), 'findOne').mockRejectedValueOnce(new Error('db'));
    await expect(lookup(store)).rejects.toThrow('db');
  });
});

describe('Brevo unsubscribe (withdraw-all) never grants and conservatively withdraws linkage', () => {
  const webhook = (store) => handleBrevoWebhook(store, {
    headers: { authorization: 'Bearer hook-token' },
    body: { event: 'unsubscribed', email: EMAIL },
    params: { BREVO_WEBHOOK_TOKEN: 'hook-token' },
  }, { clock: () => T0 });

  test('withdraws an existing grant (same email matching as the email purposes) and removes its bindings', async () => {
    const store = await seeded();
    await grant(store);
    const { grantId } = (await customer(store)).idLinkage;
    await store.collection(BINDING_COLLECTION).insertOne({ _id: KEY, etag: 'e1', record: { subject: sha256(SUB), consentGrantId: grantId } });
    expect((await webhook(store)).status).toBe(200);
    expect((await customer(store)).idLinkage).toMatchObject({ state: 'withdrawn', source: 'brevo-unsubscribe' });
    expect(await store.collection(BINDING_COLLECTION).find({})).toEqual([]);
  });

  test('with no grant, nothing linkage-related is written and the binding collection is never touched', async () => {
    const store = await seeded();
    const collection = jest.spyOn(store, 'collection');
    expect((await webhook(store)).status).toBe(200);
    expect(collection.mock.calls.map(([n]) => n)).not.toContain(BINDING_COLLECTION);
    expect((await customer(store)).idLinkage).toBeUndefined();
    expect((await customer(store)).marketing.audienceEmail).toMatchObject({ optIn: false, source: 'brevo-unsubscribe' });
    expect(await events(store)).toEqual([]);
  });

  test('never grants, even for a previously withdrawn customer', async () => {
    const store = await seeded({ idLinkage: { state: 'withdrawn', grantId: null } });
    await webhook(store);
    expect(await withdrawIdLinkageForEmail(store, EMAIL)).toBe(0);
    expect(await lookup(store)).toEqual({ state: 'withdrawn' });
  });

  test.each(['all evidence', 'email evidence'])('%s failure still withdraws linkage and prevents binding reuse', async (failure) => {
    const store = await seeded();
    await grant(store);
    const fetchImpl = jest.fn(async () => ({
      ok: true, json: async () => ({ d_mid: ECID_A, dcs_region: 9, d_blob: 'blob', id_sync_ttl: '604800' }),
    }));
    const provider = createIdServiceBindingProvider({
      orgId: '28260E2056581D3B7F000101@AdobeOrg',
      dpid: '1547309',
      consent: createIdLinkageConsentSource(store, { issuer: ISSUER }),
      store: createBindingStore(store),
      fetchImpl,
      now: () => T0,
    });
    const binding = await provider.resolve({ shopperKey: KEY, sub: SUB });
    expect(binding.ecid).toBe(ECID_A);
    const evidence = store.collection('marketing_consent_events');
    const insert = evidence.insertOne.bind(evidence);
    jest.spyOn(evidence, 'insertOne').mockImplementation((doc) => {
      if (failure === 'all evidence' || doc.purpose !== 'idLinkage') {
        throw new Error(`evidence unavailable ${EMAIL}`);
      }
      return insert(doc);
    });
    await expect(webhook(store)).rejects.toMatchObject({
      code: 'EVIDENCE_FAILED',
      message: failure === 'all evidence' ? 'The setting could not be saved.' : 'Email preference evidence could not be saved.',
    });
    expect(await lookup(store)).toEqual({ state: 'withdrawn' });
    expect(await store.collection(BINDING_COLLECTION).find({})).toEqual([]);
    expect(await provider.confirm({ shopperKey: KEY, sub: SUB, binding })).toBe(false);
    expect((await provider.resolve({ shopperKey: KEY, sub: SUB })).reason).toBe('consent-withdrawn');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('Brevo withdraw-all completes every authoritative state change before reporting failures', () => {
  const optedIn = { recoveryEmail: { optIn: true }, audienceEmail: { optIn: true } };
  const unsubscribe = (store) => handleBrevoWebhook(store, {
    headers: { authorization: 'Bearer hook-token' },
    body: { event: 'unsubscribed', email: EMAIL },
    params: { BREVO_WEBHOOK_TOKEN: 'hook-token' },
  }, { clock: () => T0 });
  const allWithdrawn = async (store) => {
    const c = await customer(store);
    expect(c.idLinkage).toMatchObject({ state: 'withdrawn', grantId: null, source: 'brevo-unsubscribe' });
    expect(c.marketing.recoveryEmail).toMatchObject({ optIn: false, source: 'brevo-unsubscribe' });
    expect(c.marketing.audienceEmail).toMatchObject({ optIn: false, source: 'brevo-unsubscribe' });
    expect(await lookup(store)).toEqual({ state: 'withdrawn' });
  };

  test.each([
    ['linkage evidence', (doc) => doc.purpose === 'idLinkage', 'The setting could not be saved.'],
    ['email evidence', (doc) => doc.purpose !== 'idLinkage', 'Email preference evidence could not be saved.'],
    ['all evidence', () => true, 'The setting could not be saved.'],
  ])('%s failure: linkage and both email opt-ins are withdrawn, then EVIDENCE_FAILED', async (_, fails, message) => {
    const store = await seeded({ marketing: optedIn });
    await grant(store);
    const evidence = store.collection('marketing_consent_events');
    const insert = evidence.insertOne.bind(evidence);
    jest.spyOn(evidence, 'insertOne').mockImplementation((doc) => (fails(doc) ? Promise.reject(new Error('db')) : insert(doc)));
    await expect(unsubscribe(store)).rejects.toMatchObject({ code: 'EVIDENCE_FAILED', message });
    await allWithdrawn(store);
  });

  test('a linkage state failure still withdraws the email purposes, then is reported', async () => {
    const store = await seeded({ marketing: optedIn });
    await grant(store);
    const customers = store.collection('customers');
    const update = customers.updateOne.bind(customers);
    jest.spyOn(customers, 'updateOne').mockImplementation((filter, change) => (
      change.$set?.idLinkage ? Promise.reject(new Error('db')) : update(filter, change)));
    await expect(unsubscribe(store)).rejects.toThrow('db');
    const c = await customer(store);
    expect(c.marketing.recoveryEmail.optIn).toBe(false);
    expect(c.marketing.audienceEmail.optIn).toBe(false);
  });

  test('an email state failure still withdraws linkage, then is reported', async () => {
    const store = await seeded({ marketing: optedIn });
    await grant(store);
    const customers = store.collection('customers');
    const update = customers.updateOne.bind(customers);
    jest.spyOn(customers, 'updateOne').mockImplementation((filter, change) => (
      change.$set?.['marketing.recoveryEmail'] ? Promise.reject(new Error('email db')) : update(filter, change)));
    await expect(unsubscribe(store)).rejects.toThrow('email db');
    expect(await lookup(store)).toEqual({ state: 'withdrawn' });
  });

  test('with no linkage grant, email withdrawal still happens and no linkage evidence is written', async () => {
    const store = await seeded({ marketing: optedIn });
    expect((await unsubscribe(store)).status).toBe(200);
    expect((await customer(store)).marketing.audienceEmail.optIn).toBe(false);
    expect((await customer(store)).idLinkage).toBeUndefined();
    expect(await events(store)).toEqual([]);
  });
});

describe('CAS binding store adapter (repo store surface)', () => {
  test('create-if-absent, conditional update, conditional and unconditional removal', async () => {
    const store = createMemoryStore();
    const bs = createBindingStore(store);
    const e1 = await bs.put(KEY, { n: 1 }, { ifMatch: null });
    expect(e1).toMatch(/^[0-9a-f-]{36}$/);
    expect(await bs.put(KEY, { n: 2 }, { ifMatch: null })).toBeNull();
    expect(await bs.get(KEY)).toEqual({ etag: e1, record: { n: 1 } });
    const e2 = await bs.put(KEY, { n: 2 }, { ifMatch: e1 });
    expect(e2).not.toBe(e1);
    expect(await bs.put(KEY, { n: 3 }, { ifMatch: e1 })).toBeNull();
    expect(await bs.remove(KEY, { ifMatch: e1 })).toBe(false);
    expect(await bs.remove(KEY, { ifMatch: e2 })).toBe(true);
    expect(await bs.get(KEY)).toBeNull();
    await expect(bs.put(KEY, { n: 4 }, {})).rejects.toThrow('ifMatch');
  });

  test('etags are never reused for a key after removal, so a stale holder cannot match', async () => {
    const store = createMemoryStore();
    const bs = createBindingStore(store);
    const stale = await bs.put(KEY, { n: 1 }, { ifMatch: null });
    await bs.remove(KEY);
    await bs.put(KEY, { n: 2 }, { ifMatch: null });
    expect(await bs.put(KEY, { n: 9 }, { ifMatch: stale })).toBeNull();
    expect((await bs.get(KEY)).record).toEqual({ n: 2 });
  });

  test('a malformed stored document is an error, never a binding', async () => {
    const store = createMemoryStore();
    await store.collection(BINDING_COLLECTION).insertOne({ _id: KEY, record: { n: 1 } });
    await expect(createBindingStore(store).get(KEY)).rejects.toThrow('Malformed');
  });

  test('a missing DB collection is "nothing to remove" for withdrawal paths', async () => {
    const notFound = Object.assign(new Error('Collection not found'), { httpStatusCode: 404 });
    const store = { collection: () => ({ deleteMany: async () => { throw notFound; }, deleteOne: async () => { throw notFound; } }) };
    expect(await removeBindingsForSubject(store, 'x')).toBe(0);
    expect(await createBindingStore(store).remove(KEY)).toBe(false);
    const other = { collection: () => ({ deleteMany: async () => { throw new Error('auth'); } }) };
    await expect(removeBindingsForSubject(other, 'x')).rejects.toThrow('auth');
  });
});

describe('provider end-to-end on the real adapters (memory store, fake ID Service)', () => {
  const idResponse = (ecid) => ({
    d_mid: ecid, dcs_region: 9, id_sync_ttl: '604800', d_blob: 'blob',
  });
  const build = (store, fetchImpl) => createIdServiceBindingProvider({
    orgId: '28260E2056581D3B7F000101@AdobeOrg',
    dpid: '1547309',
    consent: createIdLinkageConsentSource(store, { issuer: ISSUER }),
    store: createBindingStore(store),
    fetchImpl,
    now: () => T0,
  });

  test('grant → bind; withdraw (removes binding) → nothing; reconsent → a fresh ECID without d_mid', async () => {
    const store = await seeded();
    const ids = [idResponse(ECID_A), idResponse(ECID_B)];
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ids.shift() }));
    const p = build(store, fetchImpl);
    expect((await p.resolve({ shopperKey: KEY, sub: SUB })).reason).toBe('consent-absent');
    expect(fetchImpl).not.toHaveBeenCalled();
    await grant(store);
    const first = await p.resolve({ shopperKey: KEY, sub: SUB });
    expect(first).toMatchObject({ source: 'server-issued', ecid: ECID_A });
    expect(await p.confirm({ shopperKey: KEY, sub: SUB, binding: first })).toBe(true);
    await setIdLinkageConsent(store, { sub: SUB }, false);
    expect(await store.collection(BINDING_COLLECTION).find({})).toEqual([]);
    expect(await p.confirm({ shopperKey: KEY, sub: SUB, binding: first })).toBe(false);
    expect((await p.resolve({ shopperKey: KEY, sub: SUB })).reason).toBe('consent-withdrawn');
    await grant(store);
    expect(await p.confirm({ shopperKey: KEY, sub: SUB, binding: first })).toBe(false);
    expect((await p.resolve({ shopperKey: KEY, sub: SUB })).ecid).toBe(ECID_B);
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.has('d_mid')).toBe(false);
  });

  test('withdrawal while the ID Service call is in flight removes the claim; the final write cannot resurrect', async () => {
    const store = await seeded();
    await grant(store);
    const fetchImpl = jest.fn(async () => {
      await setIdLinkageConsent(store, { sub: SUB }, false);
      return { ok: true, json: async () => idResponse(ECID_A) };
    });
    expect((await build(store, fetchImpl).resolve({ shopperKey: KEY, sub: SUB })).reason).toBe('cas-conflict');
    expect(await store.collection(BINDING_COLLECTION).find({})).toEqual([]);
  });

  test('delayed withdrawal cleanup never deletes a newer grant binding', async () => {
    const store = await seeded();
    await grant(store);
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => idResponse(ECID_A) }));
    const provider = build(store, fetchImpl);
    await provider.resolve({ shopperKey: KEY, sub: SUB });
    const bindings = store.collection(BINDING_COLLECTION);
    const remove = bindings.deleteMany.bind(bindings);
    let entered;
    let finish;
    const started = new Promise((resolve) => { entered = resolve; });
    jest.spyOn(bindings, 'deleteMany').mockImplementationOnce((filter) => {
      entered();
      return new Promise((resolve) => { finish = () => resolve(remove(filter)); });
    });
    const withdrawing = setIdLinkageConsent(store, { sub: SUB }, false);
    await started;
    await grant(store);
    const binding = await provider.resolve({ shopperKey: KEY, sub: SUB });
    expect(binding.source).toBe('server-issued');
    finish();
    await withdrawing;
    expect(await provider.confirm({ shopperKey: KEY, sub: SUB, binding })).toBe(true);
    expect(await bindings.find({})).toHaveLength(1);
  });
});
