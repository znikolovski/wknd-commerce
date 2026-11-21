/**
 * Trusted shopper audience evidence (wknd.audience-evidence target contract; NOT activated).
 *
 * No authoritative Audience Manager membership provider is configured or verified for this
 * store: browser segment arrays, cookies, Target offers, model statements, public DCS reads,
 * administrative DPIDs and Analytics segment definitions (e.g. AAM "Cart Abandoners" 27504716)
 * are NOT membership evidence. Until a server-verified provider exists every lookup returns
 * `unavailable` and no audience-restricted benefit can apply.
 *
 * Contract:
 * - The shopper binding is derived here, server-side only, from the verified Auth0 identity
 *   (same canonical key as cart recovery). Callers never supply it.
 * - `qualified` / `notQualified` only from complete, fresh, binding-matched evidence for a
 *   configured canonical segment ref in this environment. Anything missing, stale, malformed or
 *   mismatched is `unavailable` (fail closed; never treated as a negative).
 * - Results carry an opaque `evidenceRef` pointing at access-controlled provenance storage;
 *   never the binding, raw provider responses, person IDs or tokens. The ref pattern only limits
 *   shape; it does not verify provenance. Refs, raw audit and PII never reach logs or any
 *   shopper-, operator- or MCP-facing response.
 * - Binding/namespace equality here is only a consistency check. Matching labels (e.g. the AAM
 *   wkndCustomerId namespace and the Auth0 sub) do not prove an activated mapping: a provider may
 *   be marked verified only after proving that the source profile it read is bound to this
 *   verified shopper (ingestion, merge rule, account switch, dequalification).
 */
const { shopperKey } = require('./recovery-policy');

const EVIDENCE_REF = /^[A-Za-z0-9._:-]{8,128}$/;
const SOURCE = /^[A-Za-z0-9._:-]{1,64}$/;

const unavailable = (reason) => Object.freeze({ status: 'unavailable', reason });
const positiveMs = (n) => Number.isFinite(n) && n > 0;

/**
 * Freshness limits are NOT frozen: they must be measured against the source's real
 * qualification AND withdrawal latency and supplied by the reviewed integration. With any limit
 * missing the resolver stays inactive.
 *
 * Timestamps:
 * - evaluatedAt: when the source evaluated membership (source clock)
 * - fetchedAt: when the provider retrieved that answer (server clock)
 * - expiresAt: the source's own validity end
 * Validity is never extended: usable until min(expiresAt, evaluatedAt + maxQualifiedAgeMs /
 * maxNotQualifiedAgeMs) and only while fetchedAt is within maxFetchAgeMs.
 *
 * @param {object} [options]
 * @param {Function} [options.provider] server-side provider
 *   ({ shopperBinding, segmentRef, env }) => evidence; used only when `verified` is true
 * @param {boolean} [options.verified] attestation from reviewed integration proof (identity,
 *   provenance, account switch, dequalification). Never from configuration, public DCS signals
 *   or a self-asserting provider.
 * @param {string} [options.issuer] AUTH0_ISSUER the binding is scoped to
 * @param {string} [options.env] environment the evidence must be for (e.g. 'stage', 'prod')
 * @param {string[]} [options.segmentRefs] canonical segment refs configured server-side only
 * @param {{ maxQualifiedAgeMs: number, maxNotQualifiedAgeMs: number, maxFetchAgeMs: number,
 *   maxClockSkewMs: number }} [options.freshness] measured limits (no defaults)
 */
function createAudienceResolver({
  provider = null, verified = false, issuer = '', env = '', segmentRefs = [], freshness = null,
  clock = Date.now,
} = {}) {
  const allowed = new Set(segmentRefs);
  const f = freshness || {};
  const freshnessSet = ['maxQualifiedAgeMs', 'maxNotQualifiedAgeMs', 'maxFetchAgeMs'].every((k) => positiveMs(f[k]))
    && Number.isFinite(f.maxClockSkewMs) && f.maxClockSkewMs >= 0;
  const active = Boolean(provider && verified === true && issuer && env && allowed.size && freshnessSet);
  return {
    verified: active,
    /**
     * @param {{ customer: { sub: string }, segmentRef: string }} input `customer` must come from
     *   server-side Auth0 verification (web token or verified delegated assertion)
     * @returns {Promise<{status:'qualified'|'notQualified'|'unavailable', reason?:string,
     *   segmentRef?:string, env?:string, source?:string, evaluatedAt?:string, fetchedAt?:string,
     *   validUntil?:string, evidenceRef?:string}>}
     */
    async resolve({ customer, segmentRef } = {}) {
      if (!active) return unavailable('PROVIDER_NOT_VERIFIED');
      if (!allowed.has(segmentRef)) return unavailable('SEGMENT_NOT_CONFIGURED');
      if (typeof customer?.sub !== 'string' || !customer.sub) return unavailable('NO_VERIFIED_IDENTITY');
      const shopperBinding = shopperKey(issuer, customer.sub);
      let ev;
      try {
        ev = await provider({ shopperBinding, segmentRef, env });
      } catch (e) {
        return unavailable('PROVIDER_ERROR');
      }
      if (!ev || typeof ev !== 'object') return unavailable('INVALID_EVIDENCE');
      if (ev.shopperBinding !== shopperBinding) return unavailable('BINDING_MISMATCH');
      if (ev.segmentRef !== segmentRef || ev.env !== env) return unavailable('SCOPE_MISMATCH');
      if (!['qualified', 'notQualified'].includes(ev.status)
        || typeof ev.source !== 'string' || !SOURCE.test(ev.source)
        || typeof ev.evidenceRef !== 'string' || !EVIDENCE_REF.test(ev.evidenceRef)) {
        return unavailable('INVALID_EVIDENCE');
      }
      const now = clock();
      const evaluated = Date.parse(ev.evaluatedAt);
      const fetched = Date.parse(ev.fetchedAt);
      const expires = Date.parse(ev.expiresAt);
      if (![evaluated, fetched, expires].every(Number.isFinite) || expires <= evaluated
        || fetched + f.maxClockSkewMs < evaluated) {
        return unavailable('INVALID_EVIDENCE');
      }
      if (evaluated > now + f.maxClockSkewMs || fetched > now + f.maxClockSkewMs) return unavailable('CLOCK_SKEW');
      const maxAge = ev.status === 'qualified' ? f.maxQualifiedAgeMs : f.maxNotQualifiedAgeMs;
      const validUntil = Math.min(expires, evaluated + maxAge);
      if (now - fetched > f.maxFetchAgeMs || now >= validUntil) return unavailable('STALE_EVIDENCE');
      return Object.freeze({
        status: ev.status,
        segmentRef,
        env,
        source: ev.source,
        evaluatedAt: new Date(evaluated).toISOString(),
        fetchedAt: new Date(fetched).toISOString(),
        validUntil: new Date(validUntil).toISOString(),
        evidenceRef: ev.evidenceRef,
      });
    },
  };
}

module.exports = { createAudienceResolver };
