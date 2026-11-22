/**
 * wknd.audience-evidence/v1-draft (inert): offline contract tests. Freshness values here are
 * test values only; production limits are not frozen and must be measured.
 */
const {
  CONTRACT, ACTIVATION_GATES, DRAFT_STAGE_ENTRIES, createAudienceRegistry, createAudienceResolver,
} = require('../lib/shopper-audiences');
const { shopperKey } = require('../lib/recovery-policy');
const { sha256, canonicalJson } = require('../lib/promotion-schema');

const ISSUER = 'https://example.auth0.com/';
const SUB = 'auth0|aud-shopper';
const NOW = Date.parse('2026-11-21T00:00:00Z');
const S = 1000;
const FRESH = {
  maxQualifiedAgeMs: 60 * S, maxNotQualifiedAgeMs: 120 * S, maxFetchAgeMs: 30 * S, maxClockSkewMs: 5 * S,
};
const at = (d) => new Date(NOW + d).toISOString();
const attestation = Object.fromEntries(ACTIVATION_GATES.map((g) => [g, `proof_${g}_0001`]));
const ENTRY = {
  key: 'climbing-planner', env: 'stage', version: 2, provider: 'aam', transport: 'transport-under-validation', sourceDpid: '1547309', mergeRuleId: '1547344', segmentId: '27507404', status: 'verified', attestation,
};
const registry = (entries = [ENTRY]) => createAudienceRegistry(entries);
const customer = { sub: SUB };

function evidence(o = {}) {
  return {
    status: 'qualified',
    complete: true,
    shopperBinding: shopperKey(ISSUER, SUB),
    env: 'stage',
    segment: { key: 'climbing-planner', version: 2 },
    provenance: {
      transport: 'transport-under-validation', sourceDpid: '1547309', mergeRuleId: '1547344', segmentId: '27507404',
    },
    source: 'aam',
    evaluatedAt: at(-20 * S),
    fetchedAt: at(-10 * S),
    expiresAt: at(10 * 60 * S),
    evidenceRef: 'prov_0123456789abcdef',
    ...o,
  };
}

function resolver(ev, options = {}) {
  const calls = [];
  const provider = async (input) => { calls.push(input); if (ev instanceof Error) throw ev; return ev; };
  const r = createAudienceResolver({
    provider, verified: true, issuer: ISSUER, env: 'stage', registry: registry(), freshness: FRESH, clock: () => NOW, ...options,
  });
  return { r, calls };
}
const run = (ev, input = {}, options = {}) => resolver(ev, options).r.resolve({ customer, key: 'climbing-planner', ...input });

describe('canonical registry', () => {
  test('draft Stage pilot bindings are registered but cannot resolve (no attestations)', () => {
    const reg = createAudienceRegistry(DRAFT_STAGE_ENTRIES);
    expect(reg.get('stage', 'climbing-planner')).toMatchObject({ segmentId: '27507404', sourceDpid: '1547309', mergeRuleId: '1547344', status: 'draft' });
    expect(reg.isActive('stage', 'climbing-planner')).toBe(false);
    expect(reg.isActive('stage', 'climbing-interest')).toBe(false);
    expect(reg.get('prod', 'climbing-planner')).toBeNull();
  });

  test('an entry is active only with every activation gate attested', () => {
    expect(registry().isActive('stage', 'climbing-planner')).toBe(true);
    ACTIVATION_GATES.forEach((g) => {
      const partial = { ...ENTRY, attestation: { ...attestation, [g]: undefined } };
      expect(registry([partial]).isActive('stage', 'climbing-planner')).toBe(false);
    });
    expect(registry([{ ...ENTRY, status: 'draft' }]).isActive('stage', 'climbing-planner')).toBe(false);
  });

  test.each([
    ['bad key', { key: 'Planner!' }],
    ['unknown env', { env: 'dev' }],
    ['non-integer version', { version: 1.5 }],
    ['other provider', { provider: 'target' }],
    ['non-numeric segment id', { segmentId: 'abc' }],
    ['missing merge rule', { mergeRuleId: undefined }],
  ])('rejects an invalid entry (%s) instead of skipping it', (_, o) => {
    expect(() => createAudienceRegistry([{ ...ENTRY, ...o }])).toThrow(/Invalid audience registry entry/);
  });

  test('rejects duplicate env/key entries', () => {
    expect(() => createAudienceRegistry([ENTRY, ENTRY])).toThrow(/Duplicate/);
  });
});

describe('resolver activation (inert by default)', () => {
  test('default construction is unavailable and calls nothing', async () => {
    const r = createAudienceResolver();
    expect(r.contract).toBe(CONTRACT);
    expect(r.verified).toBe(false);
    expect(await r.resolve({ customer, key: 'climbing-planner' })).toEqual({ status: 'unavailable', reason: 'PROVIDER_NOT_VERIFIED' });
  });

  test.each([
    ['not verified', { verified: false }],
    ['truthy non-boolean verified', { verified: 'true' }],
    ['no issuer', { issuer: '' }],
    ['unknown env', { env: 'dev' }],
    ['no registry', { registry: null }],
    ['no freshness limits (not frozen)', { freshness: null }],
    ['partial freshness limits', { freshness: { ...FRESH, maxFetchAgeMs: undefined } }],
  ])('%s: inactive, provider never called', async (_, o) => {
    const { r, calls } = resolver(evidence(), o);
    expect(r.verified).toBe(false);
    expect((await r.resolve({ customer, key: 'climbing-planner' })).reason).toBe('PROVIDER_NOT_VERIFIED');
    expect(calls).toHaveLength(0);
  });

  test('a registered but unattested segment never reaches the provider', async () => {
    const { r, calls } = resolver(evidence(), { registry: registry([{ ...ENTRY, status: 'draft' }]) });
    expect(await r.resolve({ customer, key: 'climbing-planner' })).toEqual({ status: 'unavailable', reason: 'SEGMENT_NOT_ATTESTED' });
    expect(calls).toHaveLength(0);
  });
});

describe('evidence contract', () => {
  test('qualified: binding derived server-side from the existing recovery shopperKey; caller inputs ignored', async () => {
    const { r, calls } = resolver(evidence());
    const out = await r.resolve({
      customer, key: 'climbing-planner', shopperBinding: 'caller', segmentId: '999', ecid: '123', cookies: 'demdex=1',
    });
    expect(shopperKey(ISSUER, SUB)).toBe(sha256(canonicalJson(['auth0', ISSUER, SUB])));
    expect(calls[0]).toEqual({
      shopperBinding: shopperKey(ISSUER, SUB),
      env: 'stage',
      segment: {
        key: 'climbing-planner', version: 2, segmentId: '27507404', sourceDpid: '1547309', mergeRuleId: '1547344', transport: 'transport-under-validation',
      },
    });
    expect(out).toEqual({
      status: 'qualified', env: 'stage', segment: { key: 'climbing-planner', version: 2 }, source: 'aam', evaluatedAt: at(-20 * S), fetchedAt: at(-10 * S), validUntil: at(40 * S), evidenceRef: 'prov_0123456789abcdef',
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain(SUB);
    expect(json).not.toContain(shopperKey(ISSUER, SUB));
  });

  test('qualified ages out before its source expiry (safe withdrawal); a shorter expiry wins', async () => {
    expect(await run(evidence({ evaluatedAt: at(-61 * S), fetchedAt: at(-1 * S) }))).toEqual({ status: 'unavailable', reason: 'STALE_EVIDENCE' });
    expect((await run(evidence({ status: 'notQualified', evaluatedAt: at(-61 * S), fetchedAt: at(-1 * S) }))).status).toBe('notQualified');
    expect((await run(evidence({ expiresAt: at(5 * S) }))).validUntil).toBe(at(5 * S));
  });

  test('account switch: the same evidence never applies to a different signed-in shopper', async () => {
    expect(await run(evidence(), { customer: { sub: 'auth0|someone-else' } })).toEqual({ status: 'unavailable', reason: 'BINDING_MISMATCH' });
  });

  test('logout / no verified identity never resolves', async () => {
    for (const c of [undefined, null, {}, { sub: '' }, { sub: '   ' }]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await run(evidence(), { customer: c })).toEqual({ status: 'unavailable', reason: 'NO_VERIFIED_IDENTITY' });
    }
  });

  test('a segment missing from an incomplete or unconfirmed evaluation is never notQualified', async () => {
    for (const complete of [undefined, false, 'true', 1]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await run(evidence({ status: 'notQualified', complete }))).toEqual({ status: 'unavailable', reason: 'INCOMPLETE_EVALUATION' });
      // eslint-disable-next-line no-await-in-loop
      expect(await run(evidence({ complete }))).toEqual({ status: 'unavailable', reason: 'INCOMPLETE_EVALUATION' });
    }
  });

  test('notQualified only from complete valid evidence', async () => {
    expect((await run(evidence({ status: 'notQualified' }))).status).toBe('notQualified');
    for (const missing of ['source', 'evidenceRef', 'evaluatedAt', 'fetchedAt', 'expiresAt', 'provenance']) {
      const ev = evidence({ status: 'notQualified' });
      delete ev[missing];
      // eslint-disable-next-line no-await-in-loop
      expect((await run(ev)).status).toBe('unavailable');
    }
  });

  test.each([
    ['unknown registry key', evidence(), { key: 'climbing-planner-v2' }, 'SEGMENT_NOT_CONFIGURED'],
    ['caller segment id instead of key', evidence(), { key: '27507404' }, 'SEGMENT_NOT_CONFIGURED'],
    ['other issuer', evidence({ shopperBinding: shopperKey('https://other/', SUB) }), {}, 'BINDING_MISMATCH'],
    ['other environment', evidence({ env: 'prod' }), {}, 'SCOPE_MISMATCH'],
    ['older segment version', evidence({ segment: { key: 'climbing-planner', version: 1 } }), {}, 'SCOPE_MISMATCH'],
    ['other segment', evidence({ segment: { key: 'climbing-interest', version: 2 } }), {}, 'SCOPE_MISMATCH'],
    ['untrusted transport (e.g. browser/DCS public read)', evidence({ provenance: { ...evidence().provenance, transport: 'dcs-public' } }), {}, 'PROVENANCE_MISMATCH'],
    ['other source DPID', evidence({ provenance: { ...evidence().provenance, sourceDpid: '1' } }), {}, 'PROVENANCE_MISMATCH'],
    ['default merge rule', evidence({ provenance: { ...evidence().provenance, mergeRuleId: '86579' } }), {}, 'PROVENANCE_MISMATCH'],
    ['other AAM segment id', evidence({ provenance: { ...evidence().provenance, segmentId: '27507403' } }), {}, 'PROVENANCE_MISMATCH'],
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
