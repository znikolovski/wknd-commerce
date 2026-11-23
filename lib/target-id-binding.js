/**
 * Trusted ECID binding provider for the environment-bound Target AAM diagnostic (INERT — reached only from
 * actions/target-diagnostic when every live gate is approved). See docs/TARGET-AAM-DIAGNOSTIC.md,
 * "Binding provider lifecycle".
 *
 * Issues `{ source:'server-issued', ecid, locationHint, blob, consentGrantId }` for an Auth0-verified
 * shopper using the documented Experience Cloud ID Service direct integration (`dpm.demdex.net/id`,
 * `d_ver=2`). The only declared ID sent is the verified `sub` under the registry DPID with authenticated
 * state 1. No traits, callbacks, cookies, browser identifiers or caller input. Anything not proven
 * returns `{ source:'unavailable', reason }` with a reason from BINDING_REASONS (never identifiers).
 * `confirm()` re-reads the authoritative consent so callers refuse to send or expose a result after a
 * withdrawal or reconsent: the consent grant ID is the generation token.
 *
 * Injected contracts:
 * - consent.lookup({ shopperKey, sub }) → { state:'granted', grantId } | { state:'withdrawn' } |
 *   { state:'absent' }. Anything else, or a throw, is "unknown": deny and change nothing.
 *   (lib/id-linkage-consent.js)
 * - store, compare-and-set on opaque etags never reused for a key, even after removal
 *   (lib/target-binding-store.js):
 *   get(key) → { etag, record } | null
 *   put(key, record, { ifMatch: etag | null }) → newEtag | null   (null ifMatch = create-if-absent)
 *   remove(key, { ifMatch? }) → boolean                             (no ifMatch = unconditional)
 */
const { sha256 } = require('./promotion-schema');

const ID_SERVICE = 'https://dpm.demdex.net/id';
const ORG_ID = /^[0-9A-F]{24}@AdobeOrg$/;
const DPID = /^\d{1,10}$/;
const ECID = /^\d{38}$/;
const GRANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DECIMAL = /^\d{1,10}$/;
// ID Service documents d_blob as "512 bytes or less"; Target's Delivery API accepts up to 1024.
// The provider enforces the issuer's own limit; the Target adapter keeps the Delivery API limit.
const MAX_ISSUED_BLOB_BYTES = 512;
const MAX_TTL_S = 30 * 24 * 3600;
const DEFAULT_TIMEOUT_MS = 2000;
// An issuing lease must outlive the post-claim consent lookup plus the ID Service timeout, so a live
// holder is never pre-empted; a crashed holder's lease simply lapses. Configured, bounded, not an SLA.
const DEFAULT_LEASE_MS = 10000;
const TIMEOUT_BOUNDS = Object.freeze([250, 10000]);
const LEASE_BOUNDS = Object.freeze([1000, 60000]);

/** Categorized, identifier-free reasons a binding is not issued. */
const BINDING_REASONS = Object.freeze([
  'unconfigured', 'invalid-input', 'store-error', 'foreign-record', 'consent-unknown', 'consent-absent',
  'consent-withdrawn', 'consent-changed', 'issuing-in-progress', 'cas-conflict', 'id-service-error',
  'id-service-unreachable', 'id-service-invalid',
]);
const unavailable = (reason) => ({ source: 'unavailable', reason });

/** Documented wire types only: a JSON integer or a decimal digit string. Booleans/arrays/floats are rejected. */
function wireInt(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : NaN;
  if (typeof v === 'string' && DECIMAL.test(v)) return Number(v);
  return NaN;
}

/** Builds the ID Service request URL. Only org, version, optional stored ECID and the declared ID. */
function idServiceUrl({
  orgId, dpid, sub, ecid,
}) {
  const q = [`d_orgid=${encodeURIComponent(orgId)}`, 'd_ver=2'];
  if (ecid) q.push(`d_mid=${ecid}`);
  q.push(`d_cid=${encodeURIComponent(`${dpid}\u0001${sub}\u00011`)}`);
  return `${ID_SERVICE}?${q.join('&')}`;
}

/** Validates an ID Service response; returns the binding fields or null. */
function parseIdServiceResponse(body, { expectedEcid } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const ecid = body.d_mid;
  const locationHint = wireInt(body.dcs_region);
  const blob = body.d_blob;
  if (typeof ecid !== 'string' || !ECID.test(ecid) || (expectedEcid && ecid !== expectedEcid)) return null;
  if (!Number.isInteger(locationHint) || locationHint < 1) return null;
  if (typeof blob !== 'string' || !blob || Buffer.byteLength(blob, 'utf8') > MAX_ISSUED_BLOB_BYTES) return null;
  // id_sync_ttl is the re-synchronization interval, never membership expiry.
  const ttl = wireInt(body.id_sync_ttl);
  const ttlS = Number.isInteger(ttl) && ttl > 0 && ttl <= MAX_TTL_S ? ttl : 0;
  return {
    ecid, locationHint, blob, ttlS,
  };
}

/** Normalizes an authoritative consent answer; anything malformed is 'unknown'. */
function consentState(answer) {
  if (answer?.state === 'granted') {
    return typeof answer.grantId === 'string' && GRANT_ID.test(answer.grantId)
      ? { state: 'granted', grantId: answer.grantId } : { state: 'unknown' };
  }
  if (answer?.state === 'withdrawn' || answer?.state === 'absent') return { state: answer.state };
  return { state: 'unknown' };
}

const issued = (r) => ({
  source: 'server-issued',
  ecid: r.ecid,
  locationHint: r.locationHint,
  blob: r.blob,
  consentGrantId: r.consentGrantId,
});
const inBounds = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * @param {object} deps
 * @param {string} deps.orgId IMS org (server config)
 * @param {string} deps.dpid declared-ID data source (registry; e.g. the wkndCustomerId source)
 * @param {{ lookup: Function }} deps.consent authoritative server-side consent (no default)
 * @param {{ get: Function, put: Function, remove: Function }} deps.store CAS binding store (no default)
 */
function createIdServiceBindingProvider({
  orgId, dpid, consent, store, fetchImpl = fetch, now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS, leaseMs = DEFAULT_LEASE_MS,
} = {}) {
  const configured = ORG_ID.test(orgId || '') && DPID.test(dpid || '')
    && typeof consent?.lookup === 'function'
    && ['get', 'put', 'remove'].every((m) => typeof store?.[m] === 'function')
    && inBounds(timeoutMs, TIMEOUT_BOUNDS) && inBounds(leaseMs, LEASE_BOUNDS) && leaseMs >= 2 * timeoutMs;

  async function lookupConsent(shopperKey, sub) {
    try {
      return consentState(await consent.lookup({ shopperKey, sub }));
    } catch {
      return { state: 'unknown' };
    }
  }
  const validInput = (shopperKey, sub) => typeof shopperKey === 'string' && Boolean(shopperKey)
    && typeof sub === 'string' && Boolean(sub.trim()) && sub.length <= 256;

  /** Withdrawal/erasure hook: unconditional, idempotent removal. False only on store failure. */
  async function invalidate(shopperKey) {
    if (!configured || typeof shopperKey !== 'string' || !shopperKey) return false;
    return store.remove(shopperKey).then(() => true, () => false);
  }

  /**
   * True only while consent is still granted under the same grant the binding was issued for.
   * Call immediately before sending and again before exposing any downstream result.
   */
  async function confirm({ shopperKey, sub, binding } = {}) {
    if (!configured || !validInput(shopperKey, sub) || typeof binding?.consentGrantId !== 'string') return false;
    const c = await lookupConsent(shopperKey, sub);
    return c.state === 'granted' && c.grantId === binding.consentGrantId;
  }

  async function resolve({ shopperKey, sub } = {}) {
    if (!configured) return unavailable('unconfigured');
    if (!validInput(shopperKey, sub)) return unavailable('invalid-input');
    let cur;
    try {
      cur = await store.get(shopperKey);
    } catch {
      return unavailable('store-error');
    }
    const rec = cur?.record;
    // A record must belong to this shopper; anything else is never reused, sent or overwritten.
    if (rec && rec.shopperKey !== shopperKey) return unavailable('foreign-record');

    const pre = await lookupConsent(shopperKey, sub);
    if (pre.state === 'unknown') return unavailable('consent-unknown');
    if (pre.state !== 'granted') {
      if (cur) await store.remove(shopperKey, { ifMatch: cur.etag }).catch(() => false);
      return unavailable(pre.state === 'withdrawn' ? 'consent-withdrawn' : 'consent-absent');
    }
    const sameGrant = rec?.consentGrantId === pre.grantId;
    const t = now();
    if (rec?.state === 'bound' && sameGrant && ECID.test(rec.ecid || '') && t < rec.resyncAt) return issued(rec);
    if (rec?.state === 'issuing' && t < rec.leaseUntil) return unavailable('issuing-in-progress');

    // Continuity only within the same shopper and the same consent grant; a new grant mints afresh.
    let priorEcid = null;
    if (sameGrant && rec?.state === 'bound' && ECID.test(rec.ecid || '')) priorEcid = rec.ecid;
    if (sameGrant && rec?.state === 'issuing' && ECID.test(rec.priorEcid || '')) priorEcid = rec.priorEcid;

    const subject = sha256(sub);
    let claim;
    try {
      claim = await store.put(shopperKey, {
        state: 'issuing', shopperKey, subject, consentGrantId: pre.grantId, priorEcid, leaseUntil: t + leaseMs,
      }, { ifMatch: cur?.etag ?? null });
    } catch {
      return unavailable('store-error');
    }
    if (!claim) return unavailable('cas-conflict');

    // Authoritative check AFTER the claim: a withdrawal that lands later also removes the claim
    // (it carries `subject`), so the final conditional write below cannot resurrect a binding.
    const post = await lookupConsent(shopperKey, sub);
    if (post.state !== 'granted' || post.grantId !== pre.grantId) {
      if (post.state === 'withdrawn' || post.state === 'absent') {
        await store.remove(shopperKey, { ifMatch: claim }).catch(() => false);
      }
      return unavailable(post.state === 'unknown' ? 'consent-unknown' : 'consent-changed');
    }

    let res;
    try {
      res = await fetchImpl(idServiceUrl({
        orgId, dpid, sub, ecid: priorEcid || undefined,
      }), {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return unavailable('id-service-unreachable');
    }
    if (!res.ok) return unavailable('id-service-error');
    let parsed;
    try {
      parsed = parseIdServiceResponse(await res.json(), { expectedEcid: priorEcid || undefined });
    } catch {
      parsed = null;
    }
    if (!parsed) return unavailable('id-service-invalid');
    const record = {
      state: 'bound',
      shopperKey,
      subject,
      consentGrantId: pre.grantId,
      ecid: parsed.ecid,
      locationHint: parsed.locationHint,
      blob: parsed.blob,
      issuedAt: t,
      resyncAt: t + parsed.ttlS * 1000,
    };
    let written;
    try {
      written = await store.put(shopperKey, record, { ifMatch: claim });
    } catch {
      return unavailable('store-error');
    }
    return written ? issued(record) : unavailable('cas-conflict');
  }

  return {
    configured, resolve, confirm, invalidate,
  };
}

module.exports = {
  ID_SERVICE,
  MAX_ISSUED_BLOB_BYTES,
  DEFAULT_LEASE_MS,
  DEFAULT_TIMEOUT_MS,
  TIMEOUT_BOUNDS,
  LEASE_BOUNDS,
  BINDING_REASONS,
  idServiceUrl,
  parseIdServiceResponse,
  consentState,
  createIdServiceBindingProvider,
};
