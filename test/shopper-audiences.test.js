/**
 * Audience evidence target contract (inert): fail closed unless complete, fresh, binding-matched
 * evidence from a verified server-side provider. Freshness limits here are test values only;
 * production limits are not frozen and must be measured (qualification AND withdrawal).
 */
const { createAudienceResolver } = require('../lib/shopper-audiences');
const { shopperKey } = require('../lib/recovery-policy');

const ISSUER = 'https://example.auth0.com/';
const SUB = 'auth0|aud-shopper';
const SEG = 'aam:stage:climbing-planner';
const NOW = Date.parse('2026-11-21T00:00:00Z');
const S = 1000;
const FRESH = {
  maxQualifiedAgeMs: 60 * S, maxNotQualifiedAgeMs: 120 * S, maxFetchAgeMs: 30 * S, maxClockSkewMs: 5 * S,
};
const customer = { sub: SUB };
const at = (deltaMs) => new Date(NOW + deltaMs).toISOString();

function evidence(overrides = {}) {
  return {
    status: 'qualified',
    shopperBinding: shopperKey(ISSUER, SUB),
    segmentRef: SEG,
    env: 'stage',
    source: 'aam-dcs',
    evaluatedAt: at(-20 * S),
    fetchedAt: at(-10 * S),
    expiresAt: at(10 * 60 * S),
    evidenceRef: 'prov_0123456789abcdef',
    ...overrides,
  };
}

function resolver(ev, options = {}) {
  const calls = [];
  const provider = async (input) => {
    calls.push(input);
    if (ev instanceof Error) throw ev;
    return ev;
  };
  const r = createAudienceResolver({
    provider, verified: true, issuer: ISSUER, env: 'stage', segmentRefs: [SEG], freshness: FRESH, clock: () => NOW, ...options,
  });
  return { r, calls };
}
const run = (ev, input = {}, options = {}) => resolver(ev, options).r.resolve({ customer, segmentRef: SEG, ...input });

describe('audience evidence resolver (inert target contract)', () => {
  test('default construction is unavailable and calls nothing', async () => {
    const r = createAudienceResolver();
    expect(r.verified).toBe(false);
    expect(await r.resolve({ customer, segmentRef: SEG })).toEqual({ status: 'unavailable', reason: 'PROVIDER_NOT_VERIFIED' });
  });

  test.each([
    ['not verified', { verified: false }],
    ['truthy non-boolean verified', { verified: 'true' }],
    ['no issuer', { issuer: '' }],
    ['no env', { env: '' }],
    ['no configured refs', { segmentRefs: [] }],
    ['no freshness limits (not frozen)', { freshness: null }],
    ['partial freshness limits', { freshness: { ...FRESH, maxFetchAgeMs: undefined } }],
  ])('%s: inactive, provider never called', async (_, options) => {
    const { r, calls } = resolver(evidence(), options);
    expect(r.verified).toBe(false);
    expect((await r.resolve({ customer, segmentRef: SEG })).reason).toBe('PROVIDER_NOT_VERIFIED');
    expect(calls).toHaveLength(0);
  });

  test('qualified: binding derived server-side; validity capped, never extended; no binding in output', async () => {
    const { r, calls } = resolver(evidence());
    const out = await r.resolve({ customer, segmentRef: SEG, shopperBinding: 'caller-supplied' });
    expect(calls[0]).toEqual({ shopperBinding: shopperKey(ISSUER, SUB), segmentRef: SEG, env: 'stage' });
    expect(out).toEqual({
      status: 'qualified', segmentRef: SEG, env: 'stage', source: 'aam-dcs',
      evaluatedAt: at(-20 * S), fetchedAt: at(-10 * S), validUntil: at(40 * S), evidenceRef: 'prov_0123456789abcdef',
    });
    expect(JSON.stringify(out)).not.toContain(SUB);
    expect(JSON.stringify(out)).not.toContain(shopperKey(ISSUER, SUB));
  });

  test('a shorter source expiry wins over the age limit', async () => {
    expect((await run(evidence({ expiresAt: at(5 * S) }))).validUntil).toBe(at(5 * S));
  });

  test('qualified ages out faster than its source expiry (safe dequalification)', async () => {
    expect(await run(evidence({ evaluatedAt: at(-61 * S), fetchedAt: at(-1 * S) }))).toEqual({ status: 'unavailable', reason: 'STALE_EVIDENCE' });
    expect((await run(evidence({ status: 'notQualified', evaluatedAt: at(-61 * S), fetchedAt: at(-1 * S) }))).status).toBe('notQualified');
  });

  test('notQualified only from a complete valid negative', async () => {
    expect((await run(evidence({ status: 'notQualified' }))).status).toBe('notQualified');
    for (const missing of ['source', 'evidenceRef', 'evaluatedAt', 'fetchedAt', 'expiresAt']) {
      const ev = evidence({ status: 'notQualified' });
      delete ev[missing];
      // eslint-disable-next-line no-await-in-loop
      expect((await run(ev)).status).toBe('unavailable');
    }
  });

  test.each([
    ['unknown segment ref', evidence(), { segmentRef: 'aam:stage:other' }, 'SEGMENT_NOT_CONFIGURED'],
    ['no verified identity', evidence(), { customer: {} }, 'NO_VERIFIED_IDENTITY'],
    ['other shopper', evidence({ shopperBinding: shopperKey(ISSUER, 'auth0|other') }), {}, 'BINDING_MISMATCH'],
    ['other issuer', evidence({ shopperBinding: shopperKey('https://other/', SUB) }), {}, 'BINDING_MISMATCH'],
    ['other environment', evidence({ env: 'prod' }), {}, 'SCOPE_MISMATCH'],
    ['other segment', evidence({ segmentRef: 'aam:stage:other' }), {}, 'SCOPE_MISMATCH'],
    ['legacy status', evidence({ status: 'member' }), {}, 'INVALID_EVIDENCE'],
    ['raw-looking evidenceRef', evidence({ evidenceRef: 'a@b.com {"raw":1}' }), {}, 'INVALID_EVIDENCE'],
    ['fetched before evaluation', evidence({ fetchedAt: at(-30 * S) }), {}, 'INVALID_EVIDENCE'],
    ['expiry before evaluation', evidence({ expiresAt: at(-21 * S) }), {}, 'INVALID_EVIDENCE'],
    ['source expired', evidence({ expiresAt: at(-1) }), {}, 'STALE_EVIDENCE'],
    ['fetched too long ago', evidence({ evaluatedAt: at(-40 * S), fetchedAt: at(-31 * S) }), {}, 'STALE_EVIDENCE'],
    ['evaluated in the future', evidence({ evaluatedAt: at(6 * S), fetchedAt: at(6 * S) }), {}, 'CLOCK_SKEW'],
    ['fetched in the future', evidence({ fetchedAt: at(6 * S) }), {}, 'CLOCK_SKEW'],
    ['null response', null, {}, 'INVALID_EVIDENCE'],
    ['provider error', new Error('boom'), {}, 'PROVIDER_ERROR'],
  ])('%s → unavailable', async (_, ev, input, reason) => {
    expect(await run(ev, input)).toEqual({ status: 'unavailable', reason });
  });
});
