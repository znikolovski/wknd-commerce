/**
 * Trusted shopper audience evidence. No authoritative Audience Manager membership provider is
 * configured or verified for this store: browser segment arrays, cookies, Target offers, model
 * statements and Analytics segment definitions (e.g. AAM "Cart Abandoners" 27504716) are NOT
 * membership evidence. Until a server-verified provider exists every lookup fails closed.
 */

const UNKNOWN = Object.freeze({ status: 'unknown', reason: 'PROVIDER_NOT_VERIFIED' });

/**
 * @param {object} [options]
 * @param {Function} [options.provider] server-side provider (shopperBinding, segmentRef) =>
 *   evidence; only used when `verified` is true
 * @param {boolean} [options.verified] capability verified by integration tests against the real
 *   provider. Never enable from configuration alone.
 */
function createAudienceResolver({ provider = null, verified = false } = {}) {
  return {
    verified: Boolean(provider && verified),
    /**
     * @returns {Promise<{status:'member'|'not-member'|'unknown', reason?:string}>}
     */
    async resolve({ shopperBinding, segmentRef, now = Date.now() } = {}) {
      if (!provider || !verified || !shopperBinding || !segmentRef) return UNKNOWN;
      try {
        const ev = await provider({ shopperBinding, segmentRef });
        const expires = Date.parse(ev?.expiresAt);
        if (!ev || ev.shopperBinding !== shopperBinding || ev.segmentRef !== segmentRef
          || !Number.isFinite(expires) || expires <= now) return UNKNOWN;
        if (ev.status === 'member' || ev.status === 'not-member') return { status: ev.status };
        return UNKNOWN;
      } catch (e) {
        return UNKNOWN;
      }
    },
  };
}

module.exports = { createAudienceResolver };
