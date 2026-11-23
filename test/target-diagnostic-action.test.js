/**
 * actions/target-diagnostic handler: gates, identity, consent ops and the inert decide flow. Offline:
 * memory store, injected fetch (ID Service + Target), real Auth0 RS256 verification against a local JWKS.
 */
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');
const { createMemoryStore } = require('../lib/store');
const { shopperKey } = require('../lib/recovery-policy');
const { verifyToken } = require('../lib/auth');
const { BINDING_COLLECTION } = require('../lib/target-binding-store');
const { MBOX, PRODUCTION_MBOX, REQUEST_SCHEMA } = require('../lib/target-diagnostic');
const { createTargetDiagnosticHandler, CONFIG_KEYS } = require('../lib/target-diagnostic-action');

const ISSUER = 'https://example.auth0.com/';
const AUDIENCE = 'https://api.wknd.example';
const SUB = 'auth0|pilot-shopper';
const OTHER_SUB = 'auth0|other-shopper';
const KEY = shopperKey(ISSUER, SUB);
const STAGE_NS = '00000-example-stage';
// Deliberately no inferred "-prod" suffix.
const PRODUCTION_NS = '00000-example';
const ECID = '1'.repeat(38);
const BLOB = 'issued-blob-value';
const T0 = Date.UTC(2026, 10, 23);

const BASE = {
  AUTH0_ISSUER: ISSUER,
  AUTH0_AUDIENCE: AUDIENCE,
  TARGET_DIAG_ENABLED: 'true',
  TARGET_DIAG_ENVIRONMENT: 'stage',
  TARGET_DIAG_STAGE_NAMESPACE: STAGE_NS,
  TARGET_DIAG_PRODUCTION_NAMESPACE: PRODUCTION_NS,
  TARGET_DIAG_SHOPPER_KEYS: KEY,
  TARGET_DIAG_ALLOWED_ORIGINS: 'https://stage.wknd.example',
};
const LIVE = {
  ...BASE,
  TARGET_CLIENT_CODE: 'exampleclient',
  TARGET_PROPERTY_TOKEN: '11111111-2222-4333-8444-555555555555',
  TARGET_ID_LINKAGE_ENABLED: 'true',
  TARGET_ID_LINKAGE_WORDING_VERSIONS: 'idl-2026-11',
  TARGET_ID_BINDING_STORE_APPROVED: 'true',
  TARGET_ID_SERVICE_ENABLED: 'true',
  TARGET_ID_ORG_ID: '28260E2056581D3B7F000101@AdobeOrg',
  TARGET_ID_DPID: '1547309',
};

let privateKey;
let jwks;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] });
});
const auth0Token = (sub = SUB, over = {}) => new SignJWT({ ...over })
  .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(sub).setIssuer(ISSUER).setAudience(AUDIENCE)
  .setIssuedAt().setExpirationTime('5m')
  .sign(privateKey);

const offerBody = (marker, environment = 'stage', mbox = MBOX) => ({
  execute: {
    mboxes: [{
      name: mbox,
      options: [{
        type: 'json',
        content: {
          schema: REQUEST_SCHEMA, environment, marker, financialAuthorization: false,
        },
      }],
    }],
  },
});

function harness({
  config = LIVE, ns = STAGE_NS, store = createMemoryStore(), onTarget, targetBody, retirementBody,
} = {}) {
  const lines = [];
  const logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  const fetchImpl = jest.fn(async (url) => {
    if (String(url).startsWith('https://dpm.demdex.net/id')) {
      return {
        ok: true,
        json: async () => ({
          d_mid: ECID, dcs_region: '9', id_sync_ttl: '604800', d_blob: BLOB,
        }),
      };
    }
    if (String(url).startsWith('https://ags050.demdex.net/')) {
      return { ok: true, json: async () => retirementBody || { errors: [{ code: 171 }], dcs_region: 9 } };
    }
    if (onTarget) await onTarget(store);
    const environment = config.TARGET_DIAG_ENVIRONMENT;
    return {
      ok: true,
      json: async () => targetBody || offerBody('climbing-planner', environment, environment === 'stage' ? MBOX : PRODUCTION_MBOX),
    };
  });
  const getStore = jest.fn(async () => store);
  const verify = jest.fn((token, cfg) => verifyToken(token, cfg, { jwks }));
  const handle = createTargetDiagnosticHandler({
    getStore, verify, fetchImpl, logger, namespace: () => ns, now: () => T0,
  });
  const call = async (body, { token, headers = {}, method = 'post', extra = {} } = {}) => handle({
    ...config,
    ...extra,
    __ow_method: method,
    __ow_headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), origin: 'https://stage.wknd.example', ...headers },
    ...(body === undefined ? {} : { __ow_body: Buffer.from(JSON.stringify(body)).toString('base64') }),
  });
  return {
    call, store, fetchImpl, getStore, verify, lines,
  };
}
async function seedCustomer(store, sub = SUB) {
  await store.collection('customers').insertOne({
    _id: sub, sub, id: sub, email: `${sub.replace(/\W/g, '')}@example.com`,
  });
}
const expectUntouched = (h) => {
  expect(h.getStore).not.toHaveBeenCalled();
  expect(h.fetchImpl).not.toHaveBeenCalled();
};

describe('owned retirement operation remains separately gated and identifier-free', () => {
  test.each([
    ['OFF default', {}, { op: 'retirement', step: 'submit' }, 'TARGET_ID_RETIREMENT_ENABLED'],
    ['wrong organization', { TARGET_ID_RETIREMENT_ENABLED: 'true', TARGET_ID_ORG_ID: '0'.repeat(24) + '@AdobeOrg' }, { op: 'retirement', step: 'submit' }, 'TARGET_ID_ORG_ID'],
    ['caller ECID', { TARGET_ID_RETIREMENT_ENABLED: 'true' }, { op: 'retirement', step: 'submit', ecid: ECID }, null],
  ])('%s is refused before store or upstream calls', async (_, over, body, gate) => {
    const h = harness({ config: { ...LIVE, ...over } });
    const response = await h.call(body, { token: await auth0Token() });
    expect(response.statusCode).toBe(gate ? 503 : 400);
    expect(response.body).toMatchObject(gate ? { gate } : { reason: 'invalid-request' });
    expectUntouched(h);
  });

  test('submit and observe use only the withdrawn server-issued MID with ID issuance OFF', async () => {
    const config = { ...LIVE, TARGET_ID_RETIREMENT_ENABLED: 'true' };
    const h = harness({ config });
    await seedCustomer(h.store);
    const token = await auth0Token();
    await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token });
    await h.call({ op: 'decide' }, { token });
    await h.call({ op: 'consent', optIn: false }, { token });
    config.TARGET_ID_SERVICE_ENABLED = 'false';
    const submitted = await h.call({ op: 'retirement', step: 'submit' }, { token });
    expect(submitted).toMatchObject({ statusCode: 200, body: { environment: 'stage', submission: 'submitted', observation: 'not-observed' } });
    const observed = await h.call({ op: 'retirement', step: 'observe' }, { token });
    expect(observed).toMatchObject({
      statusCode: 200, body: { environment: 'stage', observation: 'opt-out-observed', coverage: 'incomplete', financialAuthorization: false },
    });
    const record = (await h.store.collection(BINDING_COLLECTION).find({}))[0].record;
    expect(record).toMatchObject({ state: 'retiring', ecid: ECID, ecidSource: 'server-issued', retirement: { state: 'pending' } });
    [ECID, SUB, KEY, token, BLOB].forEach((id) => {
      expect(JSON.stringify(observed.body)).not.toContain(id);
      expect(h.lines.join('\n')).not.toContain(id);
    });
  });

  test('absent-purpose status, withdrawal and retirement remain read-only', async () => {
    const h = harness({ config: { ...LIVE, TARGET_ID_RETIREMENT_ENABLED: 'true' } });
    await seedCustomer(h.store);
    const collection = jest.spyOn(h.store, 'collection');
    const update = jest.spyOn(h.store.collection('customers'), 'updateOne');
    const token = await auth0Token();
    expect((await h.call({ op: 'consent-status' }, { token })).body.consent).toBe('absent');
    expect((await h.call({ op: 'consent', optIn: false }, { token })).body.changed).toBe(false);
    expect((await h.call({ op: 'retirement', step: 'submit' }, { token })).body.reason).toBe('consent-absent');
    expect(update).not.toHaveBeenCalled();
    expect(collection.mock.calls.every(([name]) => name === 'customers')).toBe(true);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Production preparation remains inert and isolated', () => {
  const production = {
    ...LIVE, TARGET_DIAG_ENVIRONMENT: 'production', TARGET_DIAG_TARGET_CONFIG_APPROVED: 'true',
  };

  test('off defaults and unverified Target configuration refuse before any effects', async () => {
    const off = harness({ ns: PRODUCTION_NS, config: {} });
    expect((await off.call({ op: 'decide' })).body).toMatchObject({ reason: 'disabled', environment: null });
    expectUntouched(off);
    const unverified = harness({ ns: PRODUCTION_NS, config: { ...production, TARGET_DIAG_TARGET_CONFIG_APPROVED: '' } });
    expect(await unverified.call({ op: 'decide' }, { token: await auth0Token() })).toMatchObject({
      statusCode: 503, body: { environment: 'production', gate: 'TARGET_DIAG_TARGET_CONFIG_APPROVED' },
    });
    expectUntouched(unverified);
  });

  test.each(['environment', 'TARGET_DIAG_PRODUCTION_NAMESPACE', '__OW_NAMESPACE'])(
    'a caller cannot select Production through body field %s',
    async (field) => {
      const h = harness({ ns: PRODUCTION_NS, config: production });
      expect((await h.call({ op: 'decide', [field]: 'production' }, { token: await auth0Token() })).statusCode).toBe(400);
      expectUntouched(h);
    },
  );

  test('separate stores do not reuse Stage consent or bindings; Production uses its own mbox and response', async () => {
    const stage = harness();
    const prod = harness({ ns: PRODUCTION_NS, config: production });
    const token = await auth0Token();
    await seedCustomer(stage.store);
    await seedCustomer(prod.store);
    await stage.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token });
    await stage.call({ op: 'decide' }, { token });
    expect((await prod.call({ op: 'consent-status' }, { token })).body).toMatchObject({ environment: 'production', consent: 'absent' });
    expect((await prod.call({ op: 'decide' }, { token })).body.bindingReason).toBe('consent-absent');
    expect(prod.fetchImpl).not.toHaveBeenCalled();
    await prod.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token });
    const result = await prod.call({ op: 'decide' }, { token });
    expect(result.body).toMatchObject({ environment: 'production', status: 'decided', marker: 'climbing-planner', financialAuthorization: false });
    expect(JSON.parse(prod.fetchImpl.mock.calls[2][1].body).execute.mboxes[0].name).toBe(PRODUCTION_MBOX);
    await prod.call({ op: 'consent', optIn: false }, { token });
    expect(await prod.store.collection(BINDING_COLLECTION).find({})).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ state: 'retiring', ecid: ECID }) }),
    ]);
    expect(await stage.store.collection(BINDING_COLLECTION).find({})).toHaveLength(1);
    expect((await stage.call({ op: 'consent-status' }, { token })).body).toMatchObject({ environment: 'stage', consent: 'granted' });
  });

  test.each([
    ['Stage mbox', MBOX, 'no-decision'],
    ['Stage offer in Production mbox', PRODUCTION_MBOX, 'unexpected-offer'],
  ])('%s is never accepted as a Production result', async (_, mbox, reason) => {
    const h = harness({
      ns: PRODUCTION_NS, config: production, targetBody: offerBody('climbing-planner', 'stage', mbox),
    });
    await seedCustomer(h.store);
    const token = await auth0Token();
    await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token });
    const r = await h.call({ op: 'decide' }, { token });
    expect(r.body).toMatchObject({ environment: 'production', status: 'unavailable', reason, financialAuthorization: false });
    expect(r.body.marker).toBeUndefined();
  });

  test.each([false, true])('Production withdrawal during Target (reconsent=%s) suppresses the old decision', async (reconsent) => {
    const token = await auth0Token();
    const h = harness({
      ns: PRODUCTION_NS,
      config: production,
      onTarget: async () => {
        await h.call({ op: 'consent', optIn: false }, { token });
        if (reconsent) await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token });
      },
    });
    await seedCustomer(h.store);
    await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token });
    const before = await h.store.collection('customers').findOne({ sub: SUB });
    const r = await h.call({ op: 'decide' }, { token });
    expect(r.body).toMatchObject({ environment: 'production', reason: 'consent-changed' });
    expect(r.body.marker).toBeUndefined();
    const after = await h.store.collection('customers').findOne({ sub: SUB });
    expect(after.idLinkage.grantId).not.toBe(before.idLinkage.grantId);
    expect(await h.store.collection(BINDING_COLLECTION).find({})).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ state: 'retiring', ecid: ECID, consentGrantId: before.idLinkage.grantId }) }),
    ]);
  });
});

describe('disabled / unapproved configuration never touches storage, Auth0, the ID Service or Target', () => {
  test.each([
    ['default (nothing configured)', {}, STAGE_NS, 'disabled'],
    ['enabled flag not exactly "true"', { ...LIVE, TARGET_DIAG_ENABLED: 'TRUE' }, STAGE_NS, 'disabled'],
    ['wrong environment', { ...LIVE, TARGET_DIAG_ENVIRONMENT: 'production' }, STAGE_NS, 'namespace-mismatch'],
    ['wrong namespace', LIVE, '28538-wkndcommerce', 'namespace-mismatch'],
    ['no namespace', LIVE, '', 'namespace-mismatch'],
    ['missing expected namespace', { ...LIVE, TARGET_DIAG_STAGE_NAMESPACE: '' }, STAGE_NS, 'namespace-not-configured'],
    ['overlapping environments', { ...LIVE, TARGET_DIAG_PRODUCTION_NAMESPACE: STAGE_NS }, STAGE_NS, 'namespace-overlap'],
    ['empty allowlist', { ...LIVE, TARGET_DIAG_SHOPPER_KEYS: '' }, STAGE_NS, 'not-configured'],
    ['no Auth0 audience', { ...LIVE, AUTH0_AUDIENCE: '' }, STAGE_NS, 'not-configured'],
  ])('%s → 404, nothing touched', async (_, config, ns, reason) => {
    const h = harness({ config, ns });
    const r = await h.call({ op: 'decide' }, { token: await auth0Token() });
    expect(r).toMatchObject({ statusCode: 404, body: { status: 'unavailable', reason } });
    expect(r.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expectUntouched(h);
    expect(h.verify).not.toHaveBeenCalled();
  });

  test.each([
    ['linkage off', { TARGET_ID_LINKAGE_ENABLED: '' }, 'TARGET_ID_LINKAGE_ENABLED'],
    ['no sanctioned wording', { TARGET_ID_LINKAGE_WORDING_VERSIONS: '' }, 'TARGET_ID_LINKAGE_WORDING_VERSIONS'],
    ['binding store not approved', { TARGET_ID_BINDING_STORE_APPROVED: 'false' }, 'TARGET_ID_BINDING_STORE_APPROVED'],
    ['ID Service calls not approved', { TARGET_ID_SERVICE_ENABLED: '' }, 'TARGET_ID_SERVICE_ENABLED'],
    ['bad org', { TARGET_ID_ORG_ID: 'org' }, 'TARGET_ID_ORG_ID'],
    ['bad DPID', { TARGET_ID_DPID: 'x' }, 'TARGET_ID_DPID'],
    ['unbounded ID timeout', { TARGET_ID_TIMEOUT_MS: '600000' }, 'TARGET_ID_TIMEOUT_MS'],
    ['lease below two timeouts', { TARGET_ID_TIMEOUT_MS: '4000', TARGET_ID_LEASE_MS: '5000' }, 'TARGET_ID_LEASE_MS'],
    ['non-numeric Target timeout', { TARGET_DIAG_TIMEOUT_MS: '2s' }, 'TARGET_DIAG_TIMEOUT_MS'],
    ['no Target client', { TARGET_CLIENT_CODE: '' }, 'TARGET_CLIENT_CODE/TARGET_PROPERTY_TOKEN'],
  ])('decide with %s → 503 not-approved naming the gate only, no store/network', async (_, change, gate) => {
    const h = harness({ config: { ...LIVE, ...change } });
    const r = await h.call({ op: 'decide' }, { token: await auth0Token() });
    expect(r).toMatchObject({ statusCode: 503, body: { reason: 'not-approved', gate } });
    expectUntouched(h);
  });

  test.each(['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty', ['decide'], null, 1])(
    'invalid or inherited operation %p is refused before any effects, even with decide gates off',
    async (op) => {
      const h = harness({
        config: {
          ...LIVE,
          TARGET_ID_LINKAGE_ENABLED: 'false',
          TARGET_ID_BINDING_STORE_APPROVED: 'false',
          TARGET_ID_SERVICE_ENABLED: 'false',
        },
      });
      await seedCustomer(h.store);
      await h.store.collection('customers').updateOne({ sub: SUB }, {
        $set: { idLinkage: { state: 'granted', grantId: '00000000-0000-4000-8000-000000000001' } },
      });
      const token = await auth0Token();
      expect((await h.call({ op: 'decide' }, { token })).statusCode).toBe(503);
      expect(await h.call({ op }, { token })).toMatchObject({
        statusCode: 400, body: { status: 'unavailable', reason: 'invalid-request' },
      });
      expectUntouched(h);
    },
  );

  test.each([
    ['linkage off', { TARGET_ID_LINKAGE_ENABLED: 'false' }, 'linkage-disabled'],
    ['no operationally approved wording', { TARGET_ID_LINKAGE_WORDING_VERSIONS: '' }, 'wording-not-approved'],
  ])('a grant with %s is refused before storage', async (_, change, reason) => {
    const h = harness({ config: { ...LIVE, ...change } });
    const r = await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token: await auth0Token() });
    expect(r).toMatchObject({ statusCode: 403, body: { reason } });
    expectUntouched(h);
  });
});

describe('identity: only verified, first-party, allowlisted shoppers; config is server-owned', () => {
  test.each([
    ['no token', {}],
    ['a malformed bearer', { headers: { authorization: 'Bearer null' } }],
  ])('%s → 401 without verification or storage', async (_, opts) => {
    const h = harness();
    expect((await h.call({ op: 'decide' }, opts)).statusCode).toBe(401);
    expectUntouched(h);
  });

  test('a delegated agent request (LLM app) is refused before verification and can never grant', async () => {
    const h = harness();
    const r = await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, {
      token: await auth0Token(), headers: { 'X-WKND-Delegation': 'mcp' },
    });
    expect(r).toMatchObject({ statusCode: 403, body: { reason: 'delegated-not-allowed' } });
    expect(h.verify).not.toHaveBeenCalled();
    expectUntouched(h);
  });

  test.each([
    ['an HS256 delegation-style assertion', async () => new SignJWT({ scope: 'shop:cart' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(SUB).setIssuer(ISSUER).setAudience(AUDIENCE)
      .setIssuedAt().setExpirationTime('1m')
      .sign(new TextEncoder().encode('x'.repeat(32)))],
    ['a token for another audience', async () => new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(SUB).setIssuer(ISSUER).setAudience('other')
      .setIssuedAt().setExpirationTime('5m')
      .sign(privateKey)],
    ['an expired token', async () => new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject(SUB).setIssuer(ISSUER).setAudience(AUDIENCE)
      .setIssuedAt(1).setExpirationTime(2)
      .sign(privateKey)],
  ])('%s fails real Auth0 verification → 401, no storage', async (_, mint) => {
    const h = harness();
    expect((await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token: await mint() })).statusCode).toBe(401);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expectUntouched(h);
  });

  test('a verified but foreign (non-allowlisted) shopper → 403, no storage', async () => {
    const h = harness();
    const r = await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token: await auth0Token(OTHER_SUB) });
    expect(r).toMatchObject({ statusCode: 403, body: { reason: 'not-allowlisted' } });
    expectUntouched(h);
  });

  test('caller-supplied configuration (query, body, namespace param) is never honoured', async () => {
    const off = harness({ config: {} });
    const viaQuery = await off.call({ op: 'decide' }, {
      token: await auth0Token(),
      extra: { __ow_query: 'TARGET_DIAG_ENABLED=true&TARGET_DIAG_ENVIRONMENT=stage', __OW_NAMESPACE: STAGE_NS },
    });
    expect(viaQuery.body.reason).toBe('disabled');
    expectUntouched(off);
    const prod = harness({ ns: '28538-wkndcommerce' });
    expect((await prod.call({ op: 'decide' }, { token: await auth0Token(), extra: { __OW_NAMESPACE: STAGE_NS } })).body.reason).toBe('namespace-mismatch');
    const h = harness();
    const r = await h.call({ op: 'decide', TARGET_ID_SERVICE_ENABLED: 'true', ecid: ECID }, { token: await auth0Token() });
    expect(r).toMatchObject({ statusCode: 400, body: { reason: 'invalid-request' } });
    expectUntouched(h);
    expect(CONFIG_KEYS).not.toContain('__OW_NAMESPACE');
  });

  test.each([
    ['no body', undefined],
    ['an unknown op', { op: 'grant-everything' }],
    ['a non-boolean optIn', { op: 'consent', optIn: 'yes' }],
  ])('%s → 400, no storage', async (_, body) => {
    const h = harness();
    expect((await h.call(body, { token: await auth0Token() })).statusCode).toBe(400);
    expectUntouched(h);
  });

  test('a non-JSON body is a 400, never treated as {}', async () => {
    const h = harness();
    const r = await createTargetDiagnosticHandler({
      getStore: h.getStore, verify: h.verify, fetchImpl: h.fetchImpl, namespace: () => STAGE_NS,
    })({
      ...LIVE, __ow_method: 'post', __ow_headers: { authorization: `Bearer ${await auth0Token()}` }, __ow_body: 'not json',
    });
    expect(r.statusCode).toBe(400);
    expectUntouched(h);
  });

  test('CORS only for an exact configured origin; OPTIONS needs the base gate and touches nothing', async () => {
    const h = harness({ config: { ...LIVE, TARGET_DIAG_ALLOWED_ORIGINS: '*,https://stage.wknd.example' } });
    const pre = await h.call(undefined, { method: 'options' });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['Access-Control-Allow-Origin']).toBe('https://stage.wknd.example');
    const evil = await h.call(undefined, { method: 'options', headers: { origin: 'https://evil.example' } });
    expect(evil.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect((await h.call(undefined, { method: 'get' })).statusCode).toBe(405);
    expectUntouched(h);
  });
});

describe('consent operations and the inert decide flow', () => {
  test.each([
    ['success', { statusCode: 200, body: { consent: 'granted', changed: true } }, { status: 'decided' }, 3, 1],
    ['rejection', { statusCode: 503, body: { reason: 'evidence-failed' } }, { status: 'unavailable', bindingReason: 'consent-withdrawn' }, 0, 0],
  ])('pending evidence (%s) cannot issue a binding or expose a marker', async (outcome, expectedGrant, expectedDecision, fetchCount, bindingCount) => {
    const h = harness();
    await seedCustomer(h.store);
    const token = await auth0Token();
    const evidence = h.store.collection('marketing_consent_events');
    const insert = evidence.insertOne.bind(evidence);
    let entered;
    let finish;
    const started = new Promise((resolve) => { entered = resolve; });
    jest.spyOn(evidence, 'insertOne').mockImplementationOnce((doc) => {
      entered();
      return new Promise((resolve, reject) => {
        finish = () => {
          if (outcome === 'rejection') reject(new Error(`evidence unavailable ${SUB}`));
          else resolve(insert(doc));
        };
      });
    });
    const granting = h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token });
    await started;
    expect((await h.call({ op: 'consent-status' }, { token })).body.consent).toBe('unknown');
    const decision = await h.call({ op: 'decide' }, { token });
    expect(decision.body).toMatchObject({ status: 'unavailable', bindingReason: 'consent-unknown' });
    expect(decision.body.marker).toBeUndefined();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(await h.store.collection(BINDING_COLLECTION).find({})).toEqual([]);
    finish();
    const result = await granting;
    expect(result).toMatchObject(expectedGrant);
    expect((await h.call({ op: 'decide' }, { token })).body).toMatchObject(expectedDecision);
    expect(h.fetchImpl).toHaveBeenCalledTimes(fetchCount);
    expect(await h.store.collection(BINDING_COLLECTION).find({})).toHaveLength(bindingCount);
    expect(h.lines.join('\n')).not.toContain(SUB);
  });

  test('grant → decide issues one binding and returns an inert marker with no identifiers', async () => {
    const h = harness();
    await seedCustomer(h.store);
    const token = await auth0Token();
    expect((await h.call({ op: 'consent-status' }, { token })).body).toMatchObject({ status: 'ok', consent: 'absent' });
    const granted = await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token });
    expect(granted).toMatchObject({ statusCode: 200, body: { status: 'ok', consent: 'granted', changed: true } });
    const r = await h.call({ op: 'decide' }, { token });
    expect(r).toMatchObject({
      statusCode: 200,
      body: {
        status: 'decided', marker: 'climbing-planner', evidence: false, financialAuthorization: false,
      },
    });
    const sent = JSON.parse(h.fetchImpl.mock.calls[2][1].body);
    expect(sent.id.marketingCloudVisitorId).toBe(ECID);
    for (const secret of [SUB, KEY, ECID, BLOB, token]) {
      expect(JSON.stringify(r.body)).not.toContain(secret);
      h.lines.forEach((l) => expect(l).not.toContain(secret));
    }
    expect(h.lines.map((l) => JSON.parse(l))).toContainEqual(expect.objectContaining({ op: 'decide', status: 'decided' }));
  });

  test('decide without consent: no ID Service or Target call, categorized reason', async () => {
    const h = harness();
    await seedCustomer(h.store);
    const r = await h.call({ op: 'decide' }, { token: await auth0Token() });
    expect(r.body).toMatchObject({ status: 'unavailable', reason: 'no-trusted-binding', bindingReason: 'consent-absent' });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  test('withdrawal during the Target request: no stale marker, bindings removed', async () => {
    const h = harness({
      onTarget: async (store) => {
        await store.collection('customers').updateOne({ sub: SUB }, { $set: { 'idLinkage.state': 'withdrawn', 'idLinkage.grantId': null } });
      },
    });
    await seedCustomer(h.store);
    const token = await auth0Token();
    await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token });
    const r = await h.call({ op: 'decide' }, { token });
    expect(r.body).toMatchObject({ status: 'unavailable', reason: 'consent-changed' });
    expect(r.body.marker).toBeUndefined();
    const w = await h.call({ op: 'consent', optIn: false }, { token });
    expect(w.body).toMatchObject({ status: 'ok', consent: 'withdrawn', changed: false });
  });

  test('reconsent during the Target request (new grantId): no stale marker', async () => {
    const h = harness({
      onTarget: async (store) => {
        await store.collection('customers').updateOne({ sub: SUB }, { $set: { 'idLinkage.grantId': '00000000-0000-4000-8000-000000000000' } });
      },
    });
    await seedCustomer(h.store);
    const token = await auth0Token();
    await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token });
    expect((await h.call({ op: 'decide' }, { token })).body).toMatchObject({ reason: 'consent-changed' });
  });

  test('withdrawal via the action retains the shopper\'s stored MID pending retirement', async () => {
    const h = harness();
    await seedCustomer(h.store);
    const token = await auth0Token();
    await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token });
    await h.call({ op: 'decide' }, { token });
    expect(await h.store.collection(BINDING_COLLECTION).find({})).toHaveLength(1);
    expect((await h.call({ op: 'consent', optIn: false }, { token })).body).toMatchObject({ status: 'ok', consent: 'withdrawn', changed: true });
    expect(await h.store.collection(BINDING_COLLECTION).find({})).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ state: 'retiring', ecid: ECID, retirement: { state: 'pending', reason: 'consent-withdrawn' } }) }),
    ]);
  });

  test('withdrawal works with linkage off (never blocked), a grant does not', async () => {
    const h = harness({ config: { ...BASE } });
    await seedCustomer(h.store);
    h.store.collection('customers').updateOne({ sub: SUB }, { $set: { idLinkage: { state: 'granted', grantId: '00000000-0000-4000-8000-000000000001' } } });
    const token = await auth0Token();
    expect((await h.call({ op: 'consent', optIn: false }, { token })).body).toMatchObject({ consent: 'withdrawn', changed: true });
    expect((await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token })).body.reason).toBe('linkage-disabled');
  });

  test('no customer record → 404 no-customer; store failure → 503 store-unavailable; both logged by category', async () => {
    const h = harness();
    const token = await auth0Token();
    expect((await h.call({ op: 'consent', optIn: true, wordingVersion: 'idl-2026-11' }, { token })).body.reason).toBe('no-customer');
    h.getStore.mockRejectedValueOnce(new Error(`connect failed for ${SUB}`));
    expect(await h.call({ op: 'consent-status' }, { token })).toMatchObject({ statusCode: 503, body: { reason: 'store-unavailable' } });
    h.lines.forEach((l) => expect(l).not.toContain(SUB));
  });

  test('an unexpected failure is a sanitized 500 (error name/code only), never success', async () => {
    const h = harness();
    await seedCustomer(h.store);
    jest.spyOn(h.store.collection('customers'), 'findOne').mockRejectedValueOnce(Object.assign(new Error(`boom ${SUB}`), { code: 'E_DB' }));
    const r = await h.call({ op: 'consent-status' }, { token: await auth0Token() });
    expect(r).toMatchObject({ statusCode: 500, body: { status: 'unavailable', reason: 'internal' } });
    const parsed = h.lines.map((l) => JSON.parse(l));
    expect(parsed).toContainEqual(expect.objectContaining({ category: 'internal', errorName: 'Error', errorCode: 'E_DB' }));
    h.lines.forEach((l) => expect(l).not.toContain('boom'));
  });
});

test('the action module never touches promotions, cart, orders or shopper audiences', () => {
  const fs = require('node:fs');
  ['../lib/target-diagnostic-action', '../lib/id-linkage-consent', '../lib/target-binding-store', '../actions/target-diagnostic/index']
    .forEach((m) => {
      const src = fs.readFileSync(require.resolve(m), 'utf8');
      ['promotions', 'promotion-evaluation', 'shopper-audiences', 'cart', 'orders'].forEach((dep) => {
        expect(src).not.toMatch(new RegExp(`require\\('(\\.\\./)+(lib/)?${dep}'\\)|require\\('\\./${dep}'\\)`));
      });
    });
});
