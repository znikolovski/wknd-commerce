/**
 * Trusted ECID binding provider for the Stage-only Target AAM diagnostic (OFFLINE DESIGN — not wired
 * to any action, store collection, consent source, manifest or deployment). See
 * docs/TARGET-AAM-DIAGNOSTIC.md, "Binding provider lifecycle".
 *
 * Issues `{ source:'server-issued', ecid, locationHint, blob }` for an Auth0-verified shopper using the
 * documented Experience Cloud ID Service direct integration (`dpm.demdex.net/id`, `d_ver=2`). The only
 * declared ID sent is the verified `sub` under the registry DPID with authenticated state 1. No traits,
 * callbacks, cookies, browser identifiers or caller input. Anything not proven returns `null`.
 *
 * Injected contracts (no implementation ships here; each needs approval):
 * - consent.lookup({ shopperKey, sub }) → { state:'granted', grantId } | { state:'withdrawn' } |
 *   { state:'absent' }. Anything else, or a throw, is "unknown": deny and change nothing.
 * - store (compare-and-set on opaque etags that are never reused for a key, even after removal):
 *   get(key) → { etag, record } | null
 *   put(key, record, { ifMatch: etag | null }) → newEtag | null   (null ifMatch = create-if-absent)
 *   remove(key, { ifMatch? }) → boolean                             (no ifMatch = unconditional)
 */
const ID_SERVICE = 'https://dpm.demdex.net/id';
const ORG_ID = /^[0-9A-F]{24}@AdobeOrg$/;
const DPID = /^\d{1,10}$/;
const ECID = /^\d{38}$/;
const GRANT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// ID Service documents d_blob as "512 bytes or less"; Target's Delivery API accepts up to 1024.
// The provider enforces the issuer's own limit; the Target adapter keeps the Delivery API limit.
const MAX_ISSUED_BLOB_BYTES = 512;
const MAX_TTL_S = 30 * 24 * 3600;
const DEFAULT_TIMEOUT_MS = 2000;
// An issuing lease must outlive the post-claim consent lookup plus the ID Service timeout, so a live
// holder is never pre-empted; a crashed holder's lease simply lapses.
const DEFAULT_LEASE_MS = 10000;

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
  if (!body || typeof body !== 'object') return null;
  const ecid = String(body.d_mid ?? '');
  const locationHint = Number(body.dcs_region);
  const blob = body.d_blob;
  if (!ECID.test(ecid) || (expectedEcid && ecid !== expectedEcid)) return null;
  if (!Number.isInteger(locationHint) || locationHint < 1) return null;
  if (typeof blob !== 'string' || !blob || Buffer.byteLength(blob, 'utf8') > MAX_ISSUED_BLOB_BYTES) return null;
  const ttl = Number(body.id_sync_ttl);
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
  source: 'server-issued', ecid: r.ecid, locationHint: r.locationHint, blob: r.blob,
});

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
    && Number.isInteger(leaseMs) && leaseMs >= 2 * timeoutMs;

  async function lookupConsent(shopperKey, sub) {
    try {
      return consentState(await consent.lookup({ shopperKey, sub }));
    } catch {
      return { state: 'unknown' };
    }
  }

  /** Withdrawal/erasure hook for the consent owner: unconditional, idempotent removal. */
  async function invalidate(shopperKey) {
    if (!configured || typeof shopperKey !== 'string' || !shopperKey) return false;
    return store.remove(shopperKey).then(() => true, () => false);
  }

  async function resolve({ shopperKey, sub } = {}) {
    if (!configured || typeof shopperKey !== 'string' || !shopperKey
      || typeof sub !== 'string' || !sub.trim() || sub.length > 256) return null;
    let cur;
    try {
      cur = await store.get(shopperKey);
    } catch {
      return null;
    }
    const rec = cur?.record;
    // A record must belong to this shopper; anything else is never reused, sent or overwritten.
    if (rec && rec.shopperKey !== shopperKey) return null;

    const pre = await lookupConsent(shopperKey, sub);
    if (pre.state === 'unknown') return null;
    if (pre.state !== 'granted') {
      if (cur) await store.remove(shopperKey, { ifMatch: cur.etag }).catch(() => false);
      return null;
    }
    const sameGrant = rec?.consentGrantId === pre.grantId;
    const t = now();
    if (rec?.state === 'bound' && sameGrant && ECID.test(rec.ecid || '') && t < rec.resyncAt) return issued(rec);
    if (rec?.state === 'issuing' && t < rec.leaseUntil) return null;

    // Continuity only within the same shopper and the same consent grant; a new grant mints afresh.
    let priorEcid = null;
    if (sameGrant && rec?.state === 'bound' && ECID.test(rec.ecid || '')) priorEcid = rec.ecid;
    if (sameGrant && rec?.state === 'issuing' && ECID.test(rec.priorEcid || '')) priorEcid = rec.priorEcid;

    const claim = await store.put(shopperKey, {
      state: 'issuing', shopperKey, consentGrantId: pre.grantId, priorEcid, leaseUntil: t + leaseMs,
    }, { ifMatch: cur?.etag ?? null }).catch(() => null);
    if (!claim) return null;

    // Authoritative check AFTER the claim: a withdrawal that lands later also removes the claim, so the
    // final conditional write below cannot resurrect a binding.
    const post = await lookupConsent(shopperKey, sub);
    if (post.state !== 'granted' || post.grantId !== pre.grantId) {
      if (post.state === 'withdrawn' || post.state === 'absent') {
        await store.remove(shopperKey, { ifMatch: claim }).catch(() => false);
      }
      return null;
    }

    let parsed;
    try {
      const res = await fetchImpl(idServiceUrl({
        orgId, dpid, sub, ecid: priorEcid || undefined,
      }), {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      parsed = parseIdServiceResponse(await res.json(), { expectedEcid: priorEcid || undefined });
    } catch {
      return null;
    }
    if (!parsed) return null;
    const record = {
      state: 'bound',
      shopperKey,
      consentGrantId: pre.grantId,
      ecid: parsed.ecid,
      locationHint: parsed.locationHint,
      blob: parsed.blob,
      issuedAt: t,
      resyncAt: t + parsed.ttlS * 1000,
    };
    const written = await store.put(shopperKey, record, { ifMatch: claim }).catch(() => null);
    return written ? issued(record) : null;
  }

  return { configured, resolve, invalidate };
}

module.exports = {
  ID_SERVICE,
  MAX_ISSUED_BLOB_BYTES,
  DEFAULT_LEASE_MS,
  idServiceUrl,
  parseIdServiceResponse,
  consentState,
  createIdServiceBindingProvider,
};
