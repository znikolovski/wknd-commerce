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
 * - Results carry an opaque `evidenceRef` for access-controlled provenance; never the binding,
 *   raw provider responses, person IDs or tokens.
 */
const { shopperKey } = require('./recovery-policy');

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const EVIDENCE_REF = /^[A-Za-z0-9._:-]{8,128}$/;
const SOURCE = /^[A-Za-z0-9._:-]{1,64}$/;

const unavailable = (reason) => Object.freeze({ status: 'unavailable', reason });

/**
 * @param {object} [options]
 * @param {Function} [options.provider] server-side provider
 *   ({ shopperBinding, segmentRef, env }) => evidence; used only when `verified` is true
 * @param {boolean} [options.verified] capability verified by integration tests against the real
 *   provider (identity, provenance, dequalification). Never enable from configuration alone.
 * @param {string} [options.issuer] AUTH0_ISSUER the binding is scoped to
 * @param {string} [options.env] environment the evidence must be for (e.g. 'stage', 'prod')
 * @param {string[]} [options.segmentRefs] canonical configured segment refs that may be resolved
 * @param {number} [options.maxAgeMs] maximum evidence age at use
 */
function createAudienceResolver({
  provider = null, verified = false, issuer = '', env = '', segmentRefs = [],
  maxAgeMs = DEFAULT_MAX_AGE_MS, clock = Date.now,
} = {}) {
  const allowed = new Set(segmentRefs);
  const active = Boolean(provider && verified && issuer && env && allowed.size);
  return {
    verified: active,
    /**
     * @param {{ customer: { sub: string }, segmentRef: string }} input `customer` must come from
     *   server-side Auth0 verification (web token or verified delegated assertion)
     * @returns {Promise<{status:'qualified'|'notQualified'|'unavailable', reason?:string,
     *   segmentRef?:string, env?:string, source?:string, evaluatedAt?:string,
     *   expiresAt?:string, evidenceRef?:string}>}
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
      const expires = Date.parse(ev.expiresAt);
      if (!Number.isFinite(evaluated) || !Number.isFinite(expires) || expires <= evaluated) {
        return unavailable('INVALID_EVIDENCE');
      }
      if (evaluated > now + CLOCK_SKEW_MS || now - evaluated > maxAgeMs || expires <= now) {
        return unavailable('STALE_EVIDENCE');
      }
      return Object.freeze({
        status: ev.status,
        segmentRef,
        env,
        source: ev.source,
        evaluatedAt: new Date(evaluated).toISOString(),
        expiresAt: new Date(expires).toISOString(),
        evidenceRef: ev.evidenceRef,
      });
    },
  };
}

module.exports = { createAudienceResolver, DEFAULT_MAX_AGE_MS };
