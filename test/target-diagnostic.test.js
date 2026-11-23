/**
 * Offline contract for the Stage-only Target AAM diagnostic. No network: fetch is injected.
 */
const {
  MBOX, REQUEST_SCHEMA, RESULT_SCHEMA, MARKERS, diagnosticConfig, parseDecision, runTargetDiagnostic,
  unavailableBindingProvider,
} = require('../lib/target-diagnostic');
const { shopperKey } = require('../lib/recovery-policy');

const ISSUER = 'https://example.auth0.com/';
const SUB = 'auth0|pilot-shopper';
const KEY = shopperKey(ISSUER, SUB);
const PARAMS = {
  TARGET_DIAG_ENABLED: 'true',
  TARGET_DIAG_ENVIRONMENT: 'stage',
  __OW_NAMESPACE: '00000-example-stage',
  TARGET_CLIENT_CODE: 'exampleclient',
  TARGET_PROPERTY_TOKEN: '11111111-2222-4333-8444-555555555555',
  TARGET_DIAG_SHOPPER_KEYS: KEY,
  AUTH0_ISSUER: ISSUER,
};
const BINDING = {
  source: 'server-issued', ecid: '1'.repeat(38), locationHint: 9, blob: 'server-blob',
};
const provider = (binding = BINDING) => ({ resolve: jest.fn(async () => binding) });
const offer = (marker, extra = {}) => ({
  type: 'json',
  content: {
    schema: REQUEST_SCHEMA, environment: 'stage', marker, financialAuthorization: false, ...extra,
  },
});
const delivery = (options) => ({ execute: { mboxes: [{ index: 0, name: MBOX, options }] } });
function fakeFetch(body, { status = 200 } = {}) {
  return jest.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}
const run = (overrides = {}) => runTargetDiagnostic({
  claims: { sub: SUB }, params: PARAMS, bindingProvider: provider(), fetchImpl: fakeFetch(delivery([offer('climbing-planner')])), ...overrides,
});
const NEVER = [SUB, BINDING.ecid, BINDING.blob, KEY, PARAMS.TARGET_PROPERTY_TOKEN];

describe('Target AAM diagnostic: configuration gate', () => {
  test.each([
    ['disabled', { TARGET_DIAG_ENABLED: 'false' }, 'disabled'],
    ['Production environment', { TARGET_DIAG_ENVIRONMENT: 'production' }, 'not-stage'],
    ['Production namespace', { __OW_NAMESPACE: '00000-example' }, 'not-stage'],
    ['missing client code', { TARGET_CLIENT_CODE: '' }, 'not-configured'],
    ['malformed property token', { TARGET_PROPERTY_TOKEN: 'abc' }, 'not-configured'],
    ['empty allowlist', { TARGET_DIAG_SHOPPER_KEYS: '' }, 'not-configured'],
  ])('%s -> unavailable without calling Target or the binding provider', async (_, change, reason) => {
    const fetchImpl = fakeFetch({});
    const bindingProvider = provider();
    const r = await run({ params: { ...PARAMS, ...change }, fetchImpl, bindingProvider });
    expect(r).toMatchObject({ status: 'unavailable', reason });
    expect(diagnosticConfig({ ...PARAMS, ...change }).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(bindingProvider.resolve).not.toHaveBeenCalled();
  });
});

describe('Target AAM diagnostic: identity trust', () => {
  test('without a verified sub the result is unauthenticated', async () => {
    expect((await run({ claims: undefined })).reason).toBe('unauthenticated');
    expect((await run({ claims: { sub: ' ' } })).reason).toBe('unauthenticated');
  });

  test('only allowlisted pilot shoppers are diagnosed', async () => {
    const fetchImpl = fakeFetch({});
    expect(await run({ claims: { sub: 'auth0|other' }, fetchImpl })).toMatchObject({ status: 'unavailable', reason: 'not-allowlisted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('the default provider has no trusted binding, so the result is unavailable', async () => {
    const fetchImpl = fakeFetch({});
    const r = await run({ bindingProvider: unavailableBindingProvider, fetchImpl });
    expect(r).toMatchObject({ status: 'unavailable', reason: 'no-trusted-binding' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    ['not server-issued', { ...BINDING, source: 'browser' }],
    ['malformed ECID', { ...BINDING, ecid: 'abc' }],
    ['location hint below 1', { ...BINDING, locationHint: 0 }],
    ['empty blob', { ...BINDING, blob: '' }],
    ['blob over 1024 bytes', { ...BINDING, blob: 'x'.repeat(1025) }],
  ])('a binding that is %s is never used', async (_, binding) => {
    const fetchImpl = fakeFetch({});
    expect((await run({ bindingProvider: provider(binding), fetchImpl })).reason).toBe('no-trusted-binding');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a failing binding provider is unavailable, not an error', async () => {
    const bindingProvider = { resolve: async () => { throw new Error('boom'); } };
    expect((await run({ bindingProvider })).reason).toBe('no-trusted-binding');
  });

  test('the provider is asked only for the server-derived shopper key and verified sub', async () => {
    const bindingProvider = provider();
    await run({ bindingProvider });
    expect(bindingProvider.resolve).toHaveBeenCalledWith({ shopperKey: KEY, sub: SUB });
  });

  test('caller-supplied identity, location, property, mbox or offer values are ignored', async () => {
    const fetchImpl = fakeFetch(delivery([offer('climbing-interest')]));
    await runTargetDiagnostic({
      claims: { sub: SUB, ecid: '9'.repeat(38), customerIds: [{ id: 'attacker' }] },
      params: PARAMS,
      bindingProvider: provider(),
      fetchImpl,
      body: {
        ecid: '9'.repeat(38), customerIds: [{ id: 'attacker' }], locationHint: 3, blob: 'caller', mbox: 'other', property: 'x', marker: 'climbing-planner',
      },
    });
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(sent.id).toEqual({
      marketingCloudVisitorId: BINDING.ecid,
      customerIds: [{ id: SUB, integrationCode: 'wkndCustomerId', authenticatedState: 'authenticated' }],
    });
    expect(sent.experienceCloud).toEqual({ audienceManager: { locationHint: 9, blob: 'server-blob' } });
    expect(sent.execute).toEqual({ mboxes: [{ index: 0, name: MBOX }] });
    expect(sent.property).toEqual({ token: PARAMS.TARGET_PROPERTY_TOKEN });
    expect(sent.prefetch).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain('attacker');
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^https:\/\/exampleclient\.tt\.omtrdc\.net\/rest\/v1\/delivery\?client=exampleclient&sessionId=/);
  });
});

describe('Target AAM diagnostic: decisions are inert markers, never evidence', () => {
  test.each(MARKERS)('marker %s is reported as a decision', async (marker) => {
    const r = await run({ fetchImpl: fakeFetch(delivery([offer(marker)])) });
    expect(r).toMatchObject({
      schema: RESULT_SCHEMA, environment: 'stage', status: 'decided', marker, evidence: false, financialAuthorization: false,
    });
  });

  test('results carry no evidence claims or identifiers', async () => {
    const r = await run();
    ['complete', 'evaluatedAt', 'fetchedAt', 'expiresAt', 'qualified', 'notQualified', 'mergeRuleId', 'segmentVersion', 'provenance']
      .forEach((k) => expect(r).not.toHaveProperty(k));
    NEVER.forEach((v) => expect(JSON.stringify(r)).not.toContain(v));
  });

  test('control is a decided marker, not negative membership', async () => {
    const r = await run({ fetchImpl: fakeFetch(delivery([offer('control')])) });
    expect(r.marker).toBe('control');
    expect(r).not.toHaveProperty('qualified');
  });

  test.each([
    ['no mbox in the response', {}, 'no-decision'],
    ['no options', delivery([]), 'no-decision'],
    ['two options', delivery([offer('control'), offer('climbing-planner')]), 'ambiguous-decision'],
    ['an HTML offer', delivery([{ type: 'html', content: '<p>x</p>' }]), 'unexpected-offer'],
    ['an unknown marker', delivery([offer('vip')]), 'unexpected-offer'],
    ['a financial authorization', delivery([offer('climbing-planner', { financialAuthorization: true })]), 'unexpected-offer'],
    ['an extra field', delivery([offer('climbing-planner', { discount: 10 })]), 'unexpected-offer'],
    ['a Production environment', delivery([offer('climbing-planner', { environment: 'production' })]), 'unexpected-offer'],
    ['a different schema', delivery([offer('climbing-planner', { schema: 'other/v1' })]), 'unexpected-offer'],
    ['another mbox', { execute: { mboxes: [{ name: 'other', options: [offer('control')] }] } }, 'no-decision'],
  ])('%s -> unavailable, never control or not-qualified', async (_, body, reason) => {
    expect(parseDecision(body)).toEqual({ status: 'unavailable', reason });
    const r = await run({ fetchImpl: fakeFetch(body) });
    expect(r).toMatchObject({ status: 'unavailable', reason });
    expect(r.marker).toBeUndefined();
  });

  test('Target errors and timeouts are unavailable', async () => {
    expect((await run({ fetchImpl: fakeFetch({}, { status: 500 }) })).reason).toBe('target-error');
    const hang = jest.fn((url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    expect((await run({ fetchImpl: hang, timeoutMs: 20 })).reason).toBe('target-unreachable');
  });

  test('the module never touches promotions or shopper audiences', () => {
    const src = require('node:fs').readFileSync(require.resolve('../lib/target-diagnostic'), 'utf8');
    ['promotions', 'shopper-audiences', 'cart', 'orders', 'store'].forEach((m) => expect(src).not.toMatch(new RegExp(`require\\('\\./${m}'\\)`)));
  });
});
