/**
 * Audience evidence target contract: fail closed unless complete, fresh, binding-matched
 * evidence from a verified server-side provider.
 */
const { createAudienceResolver } = require('../lib/shopper-audiences');
const { shopperKey } = require('../lib/recovery-policy');

const ISSUER = 'https://example.auth0.com/';
const SUB = 'auth0|aud-shopper';
const SEG = 'aam:stage:climbing-planner';
const NOW = Date.parse('2026-11-21T00:00:00Z');
const customer = { sub: SUB };

function evidence(overrides = {}) {
  return {
    status: 'qualified',
    shopperBinding: shopperKey(ISSUER, SUB),
    segmentRef: SEG,
    env: 'stage',
    source: 'aam-dcs',
    evaluatedAt: new Date(NOW - 60 * 1000).toISOString(),
    expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    evidenceRef: 'prov_0123456789abcdef',
    ...overrides,
  };
}

function resolver(ev, options = {}) {
  const calls = [];
  const provider = async (input) => {
    calls.push(input);
    if (ev instanceof Error) throw ev;
    return typeof ev === 'function' ? ev(input) : ev;
  };
  const r = createAudienceResolver({
    provider, verified: true, issuer: ISSUER, env: 'stage', segmentRefs: [SEG], clock: () => NOW, ...options,
  });
  return { r, calls };
}

describe('audience evidence resolver (inert target contract)', () => {
  test('default construction is unavailable and never calls anything', async () => {
    const r = createAudienceResolver();
    expect(r.verified).toBe(false);
    expect(await r.resolve({ customer, segmentRef: SEG })).toEqual({ status: 'unavailable', reason: 'PROVIDER_NOT_VERIFIED' });
  });

  test('a provider without verification is never called', async () => {
    const { r, calls } = resolver(evidence(), { verified: false });
    expect((await r.resolve({ customer, segmentRef: SEG })).status).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });

  test('qualified: binding derived server-side; result omits the binding', async () => {
    const { r, calls } = resolver(evidence());
    const out = await r.resolve({ customer, segmentRef: SEG, shopperBinding: 'caller-supplied' });
    expect(calls[0]).toEqual({ shopperBinding: shopperKey(ISSUER, SUB), segmentRef: SEG, env: 'stage' });
    expect(out).toEqual({
      status: 'qualified', segmentRef: SEG, env: 'stage', source: 'aam-dcs',
      evaluatedAt: evidence().evaluatedAt, expiresAt: evidence().expiresAt, evidenceRef: 'prov_0123456789abcdef',
    });
    expect(JSON.stringify(out)).not.toContain(SUB);
  });

  test('notQualified only from a complete valid negative', async () => {
    expect((await resolver(evidence({ status: 'notQualified' })).r.resolve({ customer, segmentRef: SEG })).status).toBe('notQualified');
    for (const missing of ['source', 'evidenceRef', 'evaluatedAt', 'expiresAt']) {
      const ev = evidence({ status: 'notQualified' });
      delete ev[missing];
      expect((await resolver(ev).r.resolve({ customer, segmentRef: SEG })).status).toBe('unavailable');
    }
  });

  test.each([
    ['unknown segment ref', evidence(), { segmentRef: 'aam:stage:other' }, 'SEGMENT_NOT_CONFIGURED'],
    ['no verified identity', evidence(), { customer: {} }, 'NO_VERIFIED_IDENTITY'],
    ['other shopper', evidence({ shopperBinding: shopperKey(ISSUER, 'auth0|other') }), {}, 'BINDING_MISMATCH'],
    ['other issuer', evidence({ shopperBinding: shopperKey('https://evil/', SUB) }), {}, 'BINDING_MISMATCH'],
    ['other environment', evidence({ env: 'prod' }), {}, 'SCOPE_MISMATCH'],
    ['other segment', evidence({ segmentRef: 'aam:stage:other' }), {}, 'SCOPE_MISMATCH'],
    ['legacy status', evidence({ status: 'member' }), {}, 'INVALID_EVIDENCE'],
    ['raw-looking evidenceRef', evidence({ evidenceRef: 'a@b.com {"raw":1}' }), {}, 'INVALID_EVIDENCE'],
    ['expired', evidence({ expiresAt: new Date(NOW - 1).toISOString() }), {}, 'STALE_EVIDENCE'],
    ['too old', evidence({ evaluatedAt: new Date(NOW - 16 * 60 * 1000).toISOString() }), {}, 'STALE_EVIDENCE'],
    ['from the future', evidence({ evaluatedAt: new Date(NOW + 5 * 60 * 1000).toISOString() }), {}, 'STALE_EVIDENCE'],
    ['expiry before evaluation', evidence({ expiresAt: new Date(NOW - 2 * 60 * 1000).toISOString() }), {}, 'INVALID_EVIDENCE'],
    ['null response', null, {}, 'INVALID_EVIDENCE'],
    ['provider error', new Error('boom'), {}, 'PROVIDER_ERROR'],
  ])('%s → unavailable', async (_, ev, input, reason) => {
    const out = await resolver(ev).r.resolve({ customer, segmentRef: SEG, ...input });
    expect(out).toEqual({ status: 'unavailable', reason });
  });

  test('missing issuer, env or segment configuration keeps it inactive', async () => {
    for (const o of [{ issuer: '' }, { env: '' }, { segmentRefs: [] }]) {
      const { r, calls } = resolver(evidence(), o);
      expect(r.verified).toBe(false);
      expect((await r.resolve({ customer, segmentRef: SEG })).reason).toBe('PROVIDER_NOT_VERIFIED');
      expect(calls).toHaveLength(0);
    }
  });
});
