/**
 * Trusted shopper audience evidence: contract `wknd.audience-evidence/v1-draft`. INERT.
 *
 * Nothing in the store calls this module. No authoritative Audience Manager membership
 * provider is configured or verified, so every lookup returns `unavailable` and no
 * audience-restricted benefit can apply. These are never membership evidence:
 * - browser segment arrays, cookies or ECIDs
 * - caller-supplied segment or trait IDs
 * - Target offers or model statements
 * - public DCS reads, administrative DPIDs or merge rules
 * - Analytics segment definitions
 *
 * Contract:
 * - Identity. The shopper binding is the existing canonical recovery
 *   `shopperKey(AUTH0_ISSUER, verified sub)`. It is derived here, server-side only, from the
 *   verified Auth0 identity (web token or verified delegated assertion). Callers never supply
 *   it.
 * - Segments. Callers name a canonical registry key only. The registry, configured on the
 *   server, maps the key to the environment, segment version and AAM source, merge rule and
 *   segment IDs. Only entries whose activation gates are attested `verified` can resolve.
 * - Evidence. `qualified` or `notQualified` requires complete, fresh evidence that matches the
 *   binding, environment, key and version, and the registry's trusted provenance (transport,
 *   source DPID, merge rule, segment ID). Anything missing, stale, malformed or mismatched,
 *   or any provider error, is `unavailable`. That fails closed and is never read as a
 *   negative.
 * - Freshness. The limits have no defaults and are not frozen. They must be measured for both
 *   qualification and withdrawal against the next-page / 60-second goal. Validity is capped
 *   at the earlier of the source expiry and the age limit, never extended.
 * - Output. Results carry an opaque `evidenceRef` that points at access-controlled provenance
 *   storage. They never carry the binding, raw provider responses, person IDs or tokens. The
 *   ref pattern only limits shape; it does not verify provenance.
 * - Labels. Matching labels (for example the wkndCustomerId namespace and the Auth0 sub) do
 *   not prove an activated mapping. An entry may be attested only after integration proof of
 *   ingestion, the merge rule, membership, account switch, logout and withdrawal.
 */
const { shopperKey } = require('./recovery-policy');

const CONTRACT = 'wknd.audience-evidence/v1-draft';
const ENVS = new Set(['stage', 'prod']);
const KEY = /^[a-z][a-z0-9-]{1,63}$/;
const EVIDENCE_REF = /^[A-Za-z0-9._:-]{8,128}$/;
const NUMERIC_ID = /^\d{1,12}$/;

const unavailable = (reason) => Object.freeze({ status: 'unavailable', reason });
const positiveMs = (n) => Number.isFinite(n) && n > 0;

/** Activation gates every registry entry must attest before it can resolve. */
const ACTIVATION_GATES = Object.freeze([
  'identityIngestion', // verified Auth0 sub reaches AAM through the bound source (not label equality)
  'mergeRule', // the dedicated authenticated-only merge rule is the one evaluated
  'membership', // genuine qualification observed through the trusted transport
  'accountSwitch', // a different signed-in shopper never inherits membership
  'logout', // signed-out requests never resolve membership
  'withdrawal', // dequalification is observed within the measured freshness limits
  'provenance', // responses identify the evaluated profile/merge rule/segment and are server-side
  'transport', // a supported, entitled path whose side effects (e.g. event-call trait realisation) are understood
]);

function validEntry(e) {
  return e && typeof e === 'object'
    && KEY.test(e.key) && ENVS.has(e.env) && Number.isInteger(e.version) && e.version > 0
    && e.provider === 'aam' && typeof e.transport === 'string' && e.transport.length > 0
    && NUMERIC_ID.test(String(e.sourceDpid)) && NUMERIC_ID.test(String(e.mergeRuleId))
    && NUMERIC_ID.test(String(e.segmentId));
}

const attested = (e) => e.status === 'verified'
  && ACTIVATION_GATES.every((g) => typeof e.attestation?.[g] === 'string' && EVIDENCE_REF.test(e.attestation[g]));

/**
 * Canonical server-side registry of audience segments. Entries are frozen. An invalid entry is
 * rejected when the registry is built, never silently skipped.
 * @param {Array<object>} entries
 */
function createAudienceRegistry(entries = []) {
  const byKey = new Map();
  entries.forEach((raw) => {
    if (!validEntry(raw)) throw new Error(`Invalid audience registry entry: ${raw?.key ?? '(unknown)'}`);
    const id = `${raw.env}:${raw.key}`;
    if (byKey.has(id)) throw new Error(`Duplicate audience registry entry: ${id}`);
    byKey.set(id, Object.freeze({ ...raw, attestation: Object.freeze({ ...(raw.attestation || {}) }) }));
  });
  return Object.freeze({
    contract: CONTRACT,
    get: (env, key) => byKey.get(`${env}:${key}`) || null,
    isActive: (env, key) => {
      const e = byKey.get(`${env}:${key}`);
      return Boolean(e && attested(e));
    },
  });
}

/**
 * Draft Stage pilot bindings reported by the coordinator. These are administrative IDs only:
 * every entry is status `draft` with no attestations, so it cannot resolve.
 */
const DRAFT_STAGE_ENTRIES = Object.freeze([
  {
    key: 'climbing-interest', env: 'stage', version: 1, provider: 'aam', transport: 'unverified', sourceDpid: '1547309', mergeRuleId: '1547344', segmentId: '27507403', status: 'draft',
  },
  {
    key: 'climbing-planner', env: 'stage', version: 1, provider: 'aam', transport: 'unverified', sourceDpid: '1547309', mergeRuleId: '1547344', segmentId: '27507404', status: 'draft',
  },
]);

/**
 * Provider interface, transport-neutral until a supported path is validated (e.g. DCS `d_cts=2`
 * is optional, must be enabled by Adobe, and is event-call based). Implemented later by the
 * single AAM adapter (server-side only). The adapter asserts `complete: true` only for a
 * successful, complete, trusted evaluation; a segment merely absent from a response is never
 * reported as `notQualified`.
 *   provider({ shopperBinding, env, segment: { key, version, segmentId, sourceDpid,
 *     mergeRuleId, transport } }) => Promise<{
 *       status: 'qualified'|'notQualified', complete: true, shopperBinding, env,
 *       segment: { key, version }, provenance: { transport, sourceDpid, mergeRuleId, segmentId },
 *       source, evaluatedAt, fetchedAt, expiresAt, evidenceRef }>
 *
 * @param {object} options
 * @param {Function} [options.provider]
 * @param {boolean} [options.verified] whole-provider attestation from reviewed integration
 *   proof. Must be the boolean `true`; never set from configuration alone.
 * @param {string} [options.issuer] AUTH0_ISSUER the binding is scoped to
 * @param {'stage'|'prod'} [options.env]
 * @param {ReturnType<typeof createAudienceRegistry>} [options.registry]
 * @param {{ maxQualifiedAgeMs: number, maxNotQualifiedAgeMs: number, maxFetchAgeMs: number,
 *   maxClockSkewMs: number }} [options.freshness] measured limits; no defaults
 */
function createAudienceResolver({
  provider = null, verified = false, issuer = '', env = '', registry = null, freshness = null,
  clock = Date.now,
} = {}) {
  const f = freshness || {};
  const freshnessSet = ['maxQualifiedAgeMs', 'maxNotQualifiedAgeMs', 'maxFetchAgeMs'].every((k) => positiveMs(f[k]))
    && Number.isFinite(f.maxClockSkewMs) && f.maxClockSkewMs >= 0;
  const active = Boolean(typeof provider === 'function' && verified === true && issuer && ENVS.has(env)
    && registry?.contract === CONTRACT && freshnessSet);
  return {
    contract: CONTRACT,
    verified: active,
    /**
     * @param {{ customer: { sub: string }, key: string }} input `customer` must come from
     *   server-side Auth0 verification. Any other input (segment IDs, ECIDs, cookies, bindings)
     *   is ignored.
     * @returns {Promise<{status:'qualified'|'notQualified'|'unavailable', reason?:string,
     *   env?:string, segment?:{key:string,version:number}, source?:string, evaluatedAt?:string,
     *   fetchedAt?:string, validUntil?:string, evidenceRef?:string}>}
     */
    async resolve({ customer, key } = {}) {
      if (!active) return unavailable('PROVIDER_NOT_VERIFIED');
      const entry = registry.get(env, key);
      if (!entry) return unavailable('SEGMENT_NOT_CONFIGURED');
      if (!registry.isActive(env, key)) return unavailable('SEGMENT_NOT_ATTESTED');
      if (typeof customer?.sub !== 'string' || !customer.sub.trim()) return unavailable('NO_VERIFIED_IDENTITY');
      const shopperBinding = shopperKey(issuer, customer.sub);
      const segment = {
        key: entry.key, version: entry.version, segmentId: entry.segmentId, sourceDpid: entry.sourceDpid, mergeRuleId: entry.mergeRuleId, transport: entry.transport,
      };
      let ev;
      try {
        ev = await provider({ shopperBinding, env, segment });
      } catch (e) {
        return unavailable('PROVIDER_ERROR');
      }
      if (!ev || typeof ev !== 'object') return unavailable('INVALID_EVIDENCE');
      if (ev.shopperBinding !== shopperBinding) return unavailable('BINDING_MISMATCH');
      if (ev.env !== env || ev.segment?.key !== entry.key || ev.segment?.version !== entry.version) {
        return unavailable('SCOPE_MISMATCH');
      }
      const p = ev.provenance || {};
      if (p.transport !== entry.transport || String(p.sourceDpid) !== entry.sourceDpid
        || String(p.mergeRuleId) !== entry.mergeRuleId || String(p.segmentId) !== entry.segmentId) {
        return unavailable('PROVENANCE_MISMATCH');
      }
      if (ev.complete !== true) return unavailable('INCOMPLETE_EVALUATION');
      if (!['qualified', 'notQualified'].includes(ev.status) || typeof ev.source !== 'string'
        || !/^[A-Za-z0-9._:-]{1,64}$/.test(ev.source) || typeof ev.evidenceRef !== 'string'
        || !EVIDENCE_REF.test(ev.evidenceRef)) {
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
        env,
        segment: Object.freeze({ key: entry.key, version: entry.version }),
        source: ev.source,
        evaluatedAt: new Date(evaluated).toISOString(),
        fetchedAt: new Date(fetched).toISOString(),
        validUntil: new Date(validUntil).toISOString(),
        evidenceRef: ev.evidenceRef,
      });
    },
  };
}

module.exports = {
  CONTRACT, ACTIVATION_GATES, DRAFT_STAGE_ENTRIES, createAudienceRegistry, createAudienceResolver,
};
